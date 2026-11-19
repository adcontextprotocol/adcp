import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { registerStoryboardCandidateSchemaRoot } from '../manual/storyboard-candidate-schema-root.js';
import { childLaunchesSince, launchedBeforeExitOf } from '../helpers/child-process-launches.js';

// Pass-through recorder: the wire-witness controls run for real in fresh
// processes; the guard reads when each was launched and when it exited
// (event order, not clock readings).
vi.mock('node:child_process', async (importOriginal) =>
  (await import('../helpers/child-process-launches.js')).recordChildProcessLaunches(await importOriginal()));

const CANDIDATE_BUNDLE = '3.3.0-beta.999999';
const CANDIDATE_WIRE = '3.3-beta.999999';
const STRICT_FIXTURE_RELEASE = '3.3.0-beta.2';
const CANDIDATE_SCHEMA_PREFIX = `/schemas/${CANDIDATE_BUNDLE}/`;
const OUTPUT_PREFIX = 'CANDIDATE_SCHEMA_WITNESS ';
// The CommonJS schema loader and the CommonJS entry points. CJS leaves the
// SDK's ESM build loads itself (validation/compact-schema.js and
// validation/schema-diagnostic-origins.js) hold no schema roots or caches.
const CJS_SCHEMA_AUTHORITY = /\/@adcp\/sdk\/dist\/lib\/(?:validation\/schema-loader|(?:.+\/)?index)\.js$/;
const CJS_SCHEMA_LOADER = /\/@adcp\/sdk\/dist\/lib\/validation\/schema-loader\.js$/;

type DeclineResponse = {
  results?: Array<{ proposal_id: string; outcome: string; reason?: string }>;
  status?: string;
  task_id?: string;
  adcp_version?: string;
  adcp_error?: unknown;
};
type Witness = {
  /** Only the negative control loads a CommonJS schema loader; null otherwise. */
  commonjsCandidateSchemaVersion: string | null;
  esmCandidateSchemaVersion: string | null;
  /** require.cache entries of the CommonJS SDK build, collected after every call. */
  cjsSdkFiles: string[];
  candidate: { httpStatus: number; body: DeclineResponse };
  stable?: { httpStatus: number; body: DeclineResponse; schemaVersion: string; schemaValid: boolean; errors: unknown };
};

interface WitnessRun {
  readonly error: Error | undefined;
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Starts one wire-witness control process; settles (never rejects) when it
 * ends. `register` binds the candidate through the runner's helper. Otherwise
 * the child registers the candidate in the ESM loader only and then
 * deliberately loads the CommonJS schema loader without it: the fault the
 * SDK-bump detector must see (the pre-#3519 envelope fallback).
 */
/** Control processes still running; afterAll stops any a failed or skipped test left behind. */
const runningControls = new Set<ChildProcess>();

function startWireWitness(schemaRoot: string, register: boolean): Promise<WitnessRun> {
  // A fresh process for each control is essential: the SDK's envelope policy
  // is cached by tool and release before response validation takes place.
  const helper = pathToFileURL(path.resolve('server/tests/manual/storyboard-candidate-schema-root.ts')).href;
  const script = `
    import express from 'express';
    import http from 'node:http';
    import { randomUUID } from 'node:crypto';
    import { createRequire } from 'node:module';
    import { getCanonicalToolValidator, getToolResponseSchema } from '@adcp/sdk/schemas';
    const { registerStoryboardCandidateSchemaRoot } = await import(${JSON.stringify(helper)});
    if (${register}) {
      registerStoryboardCandidateSchemaRoot(${JSON.stringify(CANDIDATE_BUNDLE)}, ${JSON.stringify(schemaRoot)});
    } else {
      // Give the application/validator its future schema metadata through
      // the ESM loader only; the CommonJS loader is injected below.
      const { registerExternalSchemaRoot } = await import('@adcp/sdk/testing');
      registerExternalSchemaRoot(${JSON.stringify(CANDIDATE_BUNDLE)}, ${JSON.stringify(schemaRoot)});
    }
    const { createTrainingAgentRouter } = await import('./server/src/training-agent/index.ts');
    const { stopSessionCleanup } = await import('./server/src/training-agent/state.ts');
    const app = express();
    app.use(express.json({ verify: (req, _res, body) => { req.rawBody = body.toString('utf8'); } }));
    app.use('/api/training-agent', createTrainingAgentRouter({ disableRateLimit: true }));
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = 'http://127.0.0.1:' + server.address().port + '/api/training-agent/sales/mcp';
    async function call(name, args) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer future-candidate-schema-token' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
          name, arguments: args,
        } }),
      });
      const envelope = await response.json();
      return { httpStatus: response.status, body: envelope.result?.structuredContent ?? envelope };
    }
    let commonjsCandidateSchemaVersion = null;
    if (!${register}) {
      // Fault injection: a CommonJS schema loader that never saw the root.
      const cjsSchemas = createRequire(import.meta.url)('@adcp/sdk/schemas');
      try {
        commonjsCandidateSchemaVersion = cjsSchemas.getToolResponseSchema('decline_proposals', {
          adcpVersion: ${JSON.stringify(CANDIDATE_WIRE)},
        })?.resolvedVersion ?? null;
      } catch { /* An unregistered candidate has no CommonJS schema authority. */ }
    }
    const result = { commonjsCandidateSchemaVersion, candidate: await call('decline_proposals', {
      adcp_version: ${JSON.stringify(CANDIDATE_WIRE)}, idempotency_key: randomUUID(),
      declines: [{ proposal_id: 'proposal-not-visible-to-caller', reason: 'inventory_fit' }],
    }) };
    if (${register}) {
      const stable = await call('get_adcp_capabilities', { adcp_version: '3.2' });
      const validate = getCanonicalToolValidator('get_adcp_capabilities', 'sync', { adcpVersion: '3.2' });
      const schemaVersion = getToolResponseSchema('get_adcp_capabilities', { adcpVersion: '3.2' })?.resolvedVersion;
      result.stable = { ...stable, schemaVersion, schemaValid: typeof validate === 'function' && validate(stable.body), errors: validate?.errors };
    }
    // After every call: the SDK's envelope fallback loads its CommonJS
    // schema loader at response time, not at import.
    result.esmCandidateSchemaVersion = getToolResponseSchema('decline_proposals', {
      adcpVersion: ${JSON.stringify(CANDIDATE_WIRE)},
    })?.resolvedVersion ?? null;
    result.cjsSdkFiles = Object.keys(createRequire(import.meta.url).cache).filter(f => f.includes('/@adcp/sdk/dist/lib/'));
    stopSessionCleanup();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => process.stdout.write(${JSON.stringify(OUTPUT_PREFIX)} + JSON.stringify(result) + '\\n', resolve));
    process.exit(0);
  `;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        PUBLIC_TEST_AGENT_TOKEN: 'future-candidate-schema-token',
        ADCP_STORYBOARD_CANDIDATE_VERSION_MODE: '1',
        ADCP_TRAINING_CANDIDATE_VERSION: CANDIDATE_WIRE,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    runningControls.add(child);
    let stdout = '';
    let stderr = '';
    let error: Error | undefined;
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    // The same 60 s ceiling spawnSync enforced, reported the same way.
    const timer = setTimeout(() => { error = new Error('spawn ETIMEDOUT'); child.kill('SIGTERM'); }, 60_000);
    child.once('error', (cause) => { error ??= cause; });
    child.once('close', (status) => { clearTimeout(timer); runningControls.delete(child); resolve({ error, status, stdout, stderr }); });
  });
}

/** The checks spawnSync's caller made, applied to a settled control. */
function wireWitness(result: WitnessRun): Witness {
  expect(result.error, `${result.stdout}\n${result.stderr}`).toBeUndefined();
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  const line = result.stdout.split('\n').find(line => line.startsWith(OUTPUT_PREFIX));
  expect(line, `${result.stdout}\n${result.stderr}`).toBeDefined();
  return JSON.parse(line!.slice(OUTPUT_PREFIX.length)) as Witness;
}

describe('candidate server schema registration', () => {
  let schemaRoot: string;
  let validate: ValidateFunction;
  let unboundControl: Promise<WitnessRun>;
  let registeredControl: Promise<WitnessRun>;

  beforeAll(async () => {
    schemaRoot = mkdtempSync(path.join(tmpdir(), 'adcp-future-candidate-schema-'));
    // Keep this controlled strict contract independent of development schemas,
    // which may legitimately add envelope fields in a subsequent release.
    cpSync(path.resolve('dist/schemas', STRICT_FIXTURE_RELEASE), schemaRoot, { recursive: true, dereference: true });
    for (const file of readdirSync(schemaRoot, { recursive: true }) as string[]) {
      if (!file.endsWith('.json')) continue;
      const filename = path.join(schemaRoot, file);
      writeFileSync(filename, readFileSync(filename, 'utf8').replaceAll(`/schemas/${STRICT_FIXTURE_RELEASE}/`, CANDIDATE_SCHEMA_PREFIX));
    }
    const indexPath = path.join(schemaRoot, 'index.json');
    const index = JSON.parse(readFileSync(indexPath, 'utf8'));
    writeFileSync(indexPath, JSON.stringify({
      ...index, adcp_version: CANDIDATE_BUNDLE, published_version: CANDIDATE_BUNDLE,
      baseUrl: `/schemas/${CANDIDATE_BUNDLE}`,
    }));
    const ajv = new Ajv({ allErrors: true, strict: false, loadSchema: async uri => {
      const pathname = new URL(uri, 'https://adcontextprotocol.org').pathname;
      if (!pathname.startsWith(CANDIDATE_SCHEMA_PREFIX)) throw new Error(`Schema escaped the controlled candidate: ${uri}`);
      const relative = pathname.slice(CANDIDATE_SCHEMA_PREFIX.length);
      return JSON.parse(readFileSync(path.join(schemaRoot, relative), 'utf8'));
    } });
    addFormats(ajv);
    // A fresh process for each control is essential (see startWireWitness);
    // the two controls are independent (ephemeral port, read-only schema
    // root), so both run in flight together and each test awaits its own.
    unboundControl = startWireWitness(schemaRoot, false);
    registeredControl = startWireWitness(schemaRoot, true);
    validate = await ajv.compileAsync(JSON.parse(readFileSync(path.join(schemaRoot, 'media-buy/decline-proposals-response.json'), 'utf8')));
  }, 60_000);

  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    // The tests await both controls; one still running here belongs to a test
    // that failed early or was filtered out, so stop it instead of waiting.
    for (const child of runningControls) child.kill('SIGKILL');
    await Promise.all([unboundControl, registeredControl]);
    rmSync(schemaRoot, { recursive: true, force: true });
  });

  it('requires the explicit test mode, a root, and its exact candidate identity', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ADCP_STORYBOARD_CANDIDATE_VERSION_MODE', '1');
    expect(() => registerStoryboardCandidateSchemaRoot(CANDIDATE_BUNDLE, schemaRoot)).toThrow('explicit test candidate mode');
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('ADCP_STORYBOARD_CANDIDATE_VERSION_MODE', '0');
    expect(() => registerStoryboardCandidateSchemaRoot(CANDIDATE_BUNDLE, schemaRoot)).toThrow('explicit test candidate mode');
    vi.stubEnv('ADCP_STORYBOARD_CANDIDATE_VERSION_MODE', '1');
    expect(() => registerStoryboardCandidateSchemaRoot(CANDIDATE_BUNDLE, undefined)).toThrow('requires ADCP_SCHEMA_ROOT');
    expect(() => registerStoryboardCandidateSchemaRoot('3.3.0-beta.999998', schemaRoot)).toThrow('must match the package and compliance bundle version');
  });

  it('negative control: an injected CommonJS schema loader without the root is detected while the envelope still conforms', async () => {
    const { candidate, commonjsCandidateSchemaVersion, cjsSdkFiles } = wireWitness(await unboundControl);
    // The SDK-bump detector's require.cache probe sees the injected loader,
    // so a clean registered control is evidence, not a blind spot.
    expect(cjsSdkFiles.filter(file => CJS_SCHEMA_LOADER.test(file)), JSON.stringify(cjsSdkFiles)).toHaveLength(1);
    expect(candidate.httpStatus, JSON.stringify(candidate)).toBe(200);
    expect(candidate.body.adcp_error).toBeUndefined();
    expect(candidate.body.adcp_version).toBe(CANDIDATE_WIRE);
    expect(candidate.body.results).toEqual([expect.objectContaining({ proposal_id: 'proposal-not-visible-to-caller', outcome: 'unable' })]);
    expect(commonjsCandidateSchemaVersion).not.toBe(CANDIDATE_BUNDLE);
    // SDK 17 beta.16 omits the stale completed status even without the future
    // root. That coincidence does not establish the candidate schema binding.
    expect(Object.hasOwn(candidate.body, 'status')).toBe(false);
    expect(validate(candidate.body), JSON.stringify(validate.errors)).toBe(true);
  }, 90_000);

  it('SDK-bump detector: strict raw future-candidate declines come from the ESM schema loader alone, and explicit stable 3.2 is unchanged', async () => {
    const { candidate, stable, esmCandidateSchemaVersion, cjsSdkFiles } = wireWitness(await registeredControl);
    expect(candidate.httpStatus, JSON.stringify(candidate)).toBe(200);
    expect(candidate.body.adcp_error).toBeUndefined();
    expect(candidate.body.adcp_version).toBe(CANDIDATE_WIRE);
    expect(candidate.body.results).toEqual([expect.objectContaining({ proposal_id: 'proposal-not-visible-to-caller', outcome: 'unable' })]);
    expect(Object.hasOwn(candidate.body, 'status'), JSON.stringify(candidate.body)).toBe(false);
    expect(Object.hasOwn(candidate.body, 'task_id')).toBe(false);
    expect(validate(candidate.body), JSON.stringify(validate.errors)).toBe(true);
    expect(stable?.httpStatus).toBe(200);
    expect(stable?.body.adcp_error).toBeUndefined();
    expect(stable?.body.adcp_version).toBe('3.2');
    expect(stable?.schemaVersion).toBe('3.2.8');
    expect(stable?.schemaValid, JSON.stringify(stable?.errors)).toBe(true);
    // One schema authority: the ESM loader serves the candidate, and no
    // CommonJS schema loader or entry point was loaded, even at response time.
    // An SDK that drops bindEnvelopeSchemaLoader falls back to the CommonJS
    // loader while shaping the decline, which this catches.
    expect(esmCandidateSchemaVersion).toBe(CANDIDATE_BUNDLE);
    expect(cjsSdkFiles.filter(file => CJS_SCHEMA_AUTHORITY.test(file))).toEqual([]);
  }, 90_000);

  it('runs both wire-witness control processes in flight together', async () => {
    // The controls are independent (ephemeral port, read-only schema root), so
    // both fresh processes are launched before any test body runs and the
    // second is launched before the first exits. The launch and exit events are
    // already recorded (or the first is still running), so nothing is awaited.
    const launches = childLaunchesSince(0);
    expect(launches, 'both control processes are launched before the tests that read them').toHaveLength(2);
    const [first, second] = launches;
    expect(launchedBeforeExitOf(second!, first!), 'the second control process is launched before the first exits').toBe(true);
  });
});
