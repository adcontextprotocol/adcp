import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { registerStoryboardCandidateSchemaRoot } from '../manual/storyboard-candidate-schema-root.js';

const CANDIDATE_BUNDLE = '3.3.0-beta.999999';
const CANDIDATE_WIRE = '3.3-beta.999999';
const OUTPUT_PREFIX = 'CANDIDATE_SCHEMA_WITNESS ';

type DeclineResponse = {
  results?: Array<{ proposal_id: string; outcome: string; reason?: string }>;
  status?: string;
  task_id?: string;
  adcp_version?: string;
  adcp_error?: unknown;
};
type Witness = {
  candidate: { httpStatus: number; body: DeclineResponse };
  stable?: { httpStatus: number; body: DeclineResponse; schemaVersion: string; schemaValid: boolean; errors: unknown };
};

function runWireWitness(schemaRoot: string, register: boolean): Witness {
  // A fresh process for each control is essential: the SDK's envelope policy
  // is cached by tool and release before response validation takes place.
  const helper = pathToFileURL(path.resolve('server/tests/manual/storyboard-candidate-schema-root.ts')).href;
  const script = `
    import express from 'express';
    import http from 'node:http';
    import { randomUUID } from 'node:crypto';
    import { getCanonicalToolValidator, getToolResponseSchema } from '@adcp/sdk/schemas';
    const { registerStoryboardCandidateSchemaRoot } = await import(${JSON.stringify(helper)});
    if (${register}) {
      registerStoryboardCandidateSchemaRoot(${JSON.stringify(CANDIDATE_BUNDLE)}, ${JSON.stringify(schemaRoot)});
    } else {
      // Give the application/validator its future schema metadata, while
      // leaving the CommonJS server envelope resolver unaware of the release.
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
    const result = { candidate: await call('decline_proposals', {
      adcp_version: ${JSON.stringify(CANDIDATE_WIRE)}, idempotency_key: randomUUID(),
      declines: [{ proposal_id: 'proposal-not-visible-to-caller', reason: 'inventory_fit' }],
    }) };
    if (${register}) {
      const stable = await call('get_adcp_capabilities', { adcp_version: '3.2' });
      const validate = getCanonicalToolValidator('get_adcp_capabilities', 'sync', { adcpVersion: '3.2.7' });
      const schemaVersion = getToolResponseSchema('get_adcp_capabilities', { adcpVersion: '3.2.7' })?.resolvedVersion;
      result.stable = { ...stable, schemaVersion, schemaValid: typeof validate === 'function' && validate(stable.body), errors: validate?.errors };
    }
    stopSessionCleanup();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => process.stdout.write(${JSON.stringify(OUTPUT_PREFIX)} + JSON.stringify(result) + '\\n', resolve));
    process.exit(0);
  `;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      PUBLIC_TEST_AGENT_TOKEN: 'future-candidate-schema-token',
      ADCP_STORYBOARD_CANDIDATE_VERSION_MODE: '1',
      ADCP_TRAINING_CANDIDATE_VERSION: CANDIDATE_WIRE,
    },
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  expect(result.error, `${result.stdout}\n${result.stderr}`).toBeUndefined();
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  const line = result.stdout.split('\n').find(line => line.startsWith(OUTPUT_PREFIX));
  expect(line, `${result.stdout}\n${result.stderr}`).toBeDefined();
  return JSON.parse(line!.slice(OUTPUT_PREFIX.length)) as Witness;
}

describe('candidate server schema registration', () => {
  let schemaRoot: string;
  let validate: ValidateFunction;

  beforeAll(async () => {
    schemaRoot = mkdtempSync(path.join(tmpdir(), 'adcp-future-candidate-schema-'));
    cpSync(path.resolve('static/schemas/source'), schemaRoot, { recursive: true });
    for (const file of readdirSync(schemaRoot, { recursive: true }) as string[]) {
      if (!file.endsWith('.json')) continue;
      const filename = path.join(schemaRoot, file);
      writeFileSync(filename, readFileSync(filename, 'utf8').replaceAll('"/schemas/', '"/schemas/latest/'));
    }
    const indexPath = path.join(schemaRoot, 'index.json');
    const index = JSON.parse(readFileSync(indexPath, 'utf8'));
    writeFileSync(indexPath, JSON.stringify({ ...index, adcp_version: CANDIDATE_BUNDLE }));
    const ajv = new Ajv({ allErrors: true, strict: false, loadSchema: async uri => {
      const relative = new URL(uri, 'https://adcontextprotocol.org').pathname.replace(/^\/schemas\/(?:latest\/)?/, '');
      return JSON.parse(readFileSync(path.join(schemaRoot, relative), 'utf8'));
    } });
    addFormats(ajv);
    validate = await ajv.compileAsync(JSON.parse(readFileSync(path.join(schemaRoot, 'media-buy/decline-proposals-response.json'), 'utf8')));
  }, 60_000);

  afterEach(() => vi.unstubAllEnvs());
  afterAll(() => rmSync(schemaRoot, { recursive: true, force: true }));

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

  it('reproduces the invalid raw envelope when the CommonJS server schema root is unbound', () => {
    const { candidate } = runWireWitness(schemaRoot, false);
    expect(candidate.httpStatus, JSON.stringify(candidate)).toBe(200);
    expect(candidate.body.adcp_error).toBeUndefined();
    expect(candidate.body.adcp_version).toBe(CANDIDATE_WIRE);
    expect(candidate.body.results).toEqual([expect.objectContaining({ proposal_id: 'proposal-not-visible-to-caller', outcome: 'unable' })]);
    expect(candidate.body).toHaveProperty('status', 'completed');
    expect(validate(candidate.body)).toBe(false);
  }, 90_000);

  it('serves strict raw future-candidate declines without changing explicit stable 3.2', () => {
    const { candidate, stable } = runWireWitness(schemaRoot, true);
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
    expect(stable?.schemaVersion).toBe('3.2.7');
    expect(stable?.schemaValid, JSON.stringify(stable?.errors)).toBe(true);
  }, 90_000);
});
