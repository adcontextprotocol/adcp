import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// Load probe for heavy dependencies that most callers never use. Each probe
// runs in a fresh `node --import tsx/esm` process with a resolve hook that
// records every module URL Node resolves (static imports, import() and
// require() of ESM all pass through it), so the test sees exactly what
// evaluating a module costs, independent of vitest's module cache and of
// other test files.
//
// tsx/esm registers only tsx's ESM loader: TypeScript sources are compiled as
// they are imported, and require() is Node's own, as in production (the
// image runs the compiled server with plain node). The full `tsx` loader also
// installs a CommonJS hook that recompiles every ES module package reached
// through require(esm) with esbuild, which the deferred getters do for
// isomorphic-dompurify and linkedom; that is test-only work.

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const OUTPUT_PREFIX = 'DEFERRED_IMPORT_PROBE ';

/** Packages whose evaluation the probes observe. */
const PACKAGE_MATCHERS: Record<string, RegExp> = {
  'isomorphic-dompurify': /\/node_modules\/isomorphic-dompurify\//,
  jsdom: /\/node_modules\/jsdom\//,
  linkedom: /\/node_modules\/linkedom\//,
  'pdf-parse': /\/node_modules\/pdf-parse\//,
  mammoth: /\/node_modules\/mammoth\//,
  '@google-cloud/kms': /\/node_modules\/@google-cloud\/kms\//,
  '@adcp/sdk barrel': /\/node_modules\/@adcp\/sdk\/dist\/lib\/index\.m?js$/,
  supertest: /\/node_modules\/supertest\//,
  '@google-cloud/storage': /\/node_modules\/@google-cloud\/storage\//,
  '@adcp/reporting-storage': /\/node_modules\/@adcp\/reporting-storage\//,
};
const DURABLE_REPORTING = ['@google-cloud/storage', '@adcp/reporting-storage'];
const DEFERRED_FIVE = ['isomorphic-dompurify', 'linkedom', 'pdf-parse', 'mammoth', '@google-cloud/kms'];

type ProbeResult = {
  importError?: string;
  useError?: string;
  /** Heavy packages resolved while evaluating the module. */
  atImport: string[];
  /** Heavy packages resolved after the `use` step ran. */
  afterUse: string[];
  output?: unknown;
};

/** Probe processes still running; a test that times out leaves its probe here. */
const running = new Set<ChildProcess>();
afterEach(() => {
  for (const child of running) child.kill('SIGKILL');
  running.clear();
});

type ProbeStep = {
  /** Repo-relative module to import. */
  modulePath: string;
  /** Source of an async function `(mod) => output` run after the import snapshot. */
  use?: string;
};

/** The modules each probe process started by this file imported, in order. */
const probeRuns: string[][] = [];

/**
 * Import each step's `modulePath` (repo-relative) in turn in one fresh
 * process, running its `use` after its import snapshot. A step's atImport and
 * afterUse list the heavy packages resolved since that step began. That is
 * exactly what the step's own evaluation loads while no earlier step loaded
 * any of the packages the step's test observes: a module that an earlier step
 * left evaluated would have resolved them then. The tests of the earlier steps
 * assert that, so steps share a process only when every step but the last
 * expects none of the packages a later step observes. The child runs
 * asynchronously, so the test's own timeout bounds it.
 */
async function probeSteps(steps: readonly ProbeStep[], options: { env?: Record<string, string | undefined> } = {}): Promise<ProbeResult[]> {
  const stepSources = steps.map(({ modulePath, use }) => `{ url: ${JSON.stringify(new URL(modulePath, `file://${REPO_ROOT}`).href)}, use: ${use ?? 'null'} }`);
  const script = `
    import { registerHooks } from 'node:module';
    const matchers = ${JSON.stringify(Object.fromEntries(Object.entries(PACKAGE_MATCHERS).map(([k, v]) => [k, v.source])))};
    const seen = [];
    registerHooks({ resolve(specifier, context, next) { const r = next(specifier, context); seen.push(r.url); return r; } });
    const loadedSince = (start) => {
      const urls = seen.slice(start);
      return Object.entries(matchers)
        .filter(([, source]) => urls.some((url) => new RegExp(source).test(url)))
        .map(([name]) => name);
    };
    const steps = [${stepSources.join(',\n')}];
    const results = [];
    for (const step of steps) {
      const start = seen.length;
      const result = { atImport: [], afterUse: [] };
      let mod;
      try {
        mod = await import(step.url);
      } catch (error) {
        result.importError = String(error?.code ?? '') + ' ' + String(error?.message ?? error);
      }
      result.atImport = loadedSince(start);
      if (mod && step.use) {
        try {
          result.output = await step.use(mod);
        } catch (error) {
          result.useError = String(error?.stack ?? error);
        }
      }
      result.afterUse = loadedSince(start);
      results.push(result);
    }
    await new Promise((resolve) => process.stdout.write(${JSON.stringify(OUTPUT_PREFIX)} + JSON.stringify(results) + '\\n', resolve));
    process.exit(0);
  `;
  const env: Record<string, string | undefined> = { ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent', ...options.env };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  probeRuns.push(steps.map((step) => step.modulePath));
  const child = await new Promise<{ error?: Error; status: number | null; stdout: string; stderr: string }>((resolve) => {
    const process_ = spawn(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '--eval', script], {
      cwd: REPO_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    running.add(process_);
    let stdout = '';
    let stderr = '';
    let error: Error | undefined;
    process_.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    process_.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    process_.once('error', (cause) => { error = cause; });
    process_.once('close', (status) => { running.delete(process_); resolve({ error, status, stdout, stderr }); });
  });
  expect(child.error, `${child.stdout}\n${child.stderr}`).toBeUndefined();
  expect(child.status, `${child.stdout}\n${child.stderr}`).toBe(0);
  const line = child.stdout.split('\n').find((l) => l.startsWith(OUTPUT_PREFIX));
  expect(line, `${child.stdout}\n${child.stderr}`).toBeDefined();
  const results = JSON.parse(line!.slice(OUTPUT_PREFIX.length)) as ProbeResult[];
  expect(results).toHaveLength(steps.length);
  return results;
}

/** One step in its own fresh process. */
async function probe(modulePath: string, options: { use?: string; env?: Record<string, string | undefined> } = {}): Promise<ProbeResult> {
  const [result] = await probeSteps([{ modulePath, use: options.use }], { env: options.env });
  return result!;
}

/** A shared probe run, started by the first test that needs it. */
function shared<T>(run: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => (pending ??= run());
}

// Modules whose import evaluates none of the heavy packages. One module per
// test so a regression names the module that reintroduced the eager load. The
// imports share one process (probeSteps): no test expects any of the packages.
const LEAF_MODULES = [
  'server/src/legal-markdown.ts',
  'server/src/services/brand-logo-service.ts',
  'server/src/training-agent/vast-document-validation.ts',
  'server/src/addie/jobs/committee-document-indexer.ts',
  'server/src/security/gcp-kms-signer.ts',
  'server/src/services/supply-path-input.ts',
  'server/src/compliance/run-provenance.ts',
  'server/src/training-agent/plan-hash.ts',
];

const leafProbe = shared(() => probeSteps(LEAF_MODULES.map((modulePath) => ({ modulePath }))));

// The durable reporting probes share one process (probeSteps), in this order:
// every step but the last expects neither package, and the last, the first
// reporting call, is the one that loads them.
const REPORTING_STEPS = {
  routes: { modulePath: 'server/src/training-agent/gcs-reporting-routes.ts' },
  tools: { modulePath: 'server/src/training-agent/gcs-reporting-tools.ts' },
  router: {
    modulePath: 'server/src/training-agent/index.ts',
    use: 'async (mod) => { mod.createTrainingAgentRouter({ disableRateLimit: true }); (await import("./server/src/training-agent/state.ts")).stopSessionCleanup(); return "built"; }',
  },
  runtime: {
    modulePath: 'server/src/training-agent/gcs-reporting-runtime.ts',
    use: 'async (mod) => String(await mod.loadTrainingGcsReporting())',
  },
} satisfies Record<string, ProbeStep>;
const reportingProbe = shared(async () => {
  const results = await probeSteps(Object.values(REPORTING_STEPS), {
    env: { PUBLIC_TEST_AGENT_TOKEN: 'test-token', TRAINING_REPORTING_GCS_ENABLED: undefined },
  });
  return Object.fromEntries(Object.keys(REPORTING_STEPS).map((name, i) => [name, results[i]!])) as Record<keyof typeof REPORTING_STEPS, ProbeResult>;
});

describe('importing a module does not evaluate heavy dependencies it uses only on some paths', () => {
  it.each(LEAF_MODULES)('%s', async (modulePath) => {
    const result = (await leafProbe())[LEAF_MODULES.indexOf(modulePath)]!;
    expect(result.importError).toBeUndefined();
    expect(result.atImport, `heavy packages evaluated by importing ${modulePath}`).toEqual([]);
  });
});

describe('first use loads a deferred dependency and behaves as before', () => {
  it('renderLegalMarkdown loads DOMPurify (and its jsdom window) and sanitizes', async () => {
    const result = await probe('server/src/legal-markdown.ts', {
      use: `async (mod) => mod.renderLegalMarkdown(
        '# Terms\\n\\n[ok](https://example.com) [bad](javascript:alert(1)) <img src=x onerror=alert(1)>'
      )`,
    });
    expect(result.importError).toBeUndefined();
    expect(result.useError).toBeUndefined();
    expect(result.output).toBe('<h1>Terms</h1>\n<p><a href="https://example.com">ok</a> <a>bad</a> </p>\n');
    expect(result.afterUse).toEqual(expect.arrayContaining(['isomorphic-dompurify', 'jsdom']));
    expect(result.atImport, 'loaded before first use').toEqual([]);
  });

  it('validateInlineVastDocument loads linkedom and parses the document', async () => {
    const result = await probe('server/src/training-agent/vast-document-validation.ts', {
      use: `async (mod) => [
        mod.validateInlineVastDocument({
          xml: '<VAST version="3.0"><Ad><InLine><Creatives><Creative><Linear><MediaFiles><MediaFile>https://cdn.example/a.mp4</MediaFile></MediaFiles></Linear></Creative></Creatives></InLine></Ad></VAST>',
          field: 'assets.video',
          sellerVastVersions: mod.TRAINING_SELLER_VAST_VERSIONS,
        }),
        mod.validateInlineVastDocument({
          xml: '<VAST version="3.0"><Ad/></VAST>',
          field: 'assets.video',
          assetVastVersion: '4.2',
          sellerVastVersions: mod.TRAINING_SELLER_VAST_VERSIONS,
        }),
      ]`,
    });
    expect(result.importError).toBeUndefined();
    expect(result.useError).toBeUndefined();
    expect(result.afterUse).toContain('linkedom');
    expect(result.output).toEqual([
      null,
      expect.objectContaining({
        code: 'VAST_VERSION_MISMATCH',
        details: expect.objectContaining({ asset_vast_version: '4.2', observed_document_vast_version: '3.0' }),
      }),
    ]);
    expect(result.atImport, 'loaded before first use').toEqual([]);
  });

  it('preloadDeferredModules() loads all five deferred packages (production boot parity)', async () => {
    const result = await probe('server/src/utils/deferred-modules.ts', {
      use: 'async (mod) => { await mod.preloadDeferredModules(); return "preloaded"; }',
    });
    expect(result.importError, 'server/src/utils/deferred-modules.ts must exist and import cleanly').toBeUndefined();
    expect(result.useError).toBeUndefined();
    expect(result.atImport, 'the helper itself must not load what it defers').toEqual([]);
    expect(result.output).toBe('preloaded');
    expect(result.afterUse).toEqual(expect.arrayContaining(DEFERRED_FIVE));
  });
});

describe('building the training agent does not load the durable reporting stack', () => {
  // gcs-reporting.ts (pg, @google-cloud/storage, @adcp/reporting-storage)
  // serves only the reporting routes and tools; its runtime exists only after
  // server boot initializes it (server/src/http.ts). Building the router, as
  // every training-agent test's setup does, must not evaluate it.

  it('createTrainingAgentRouter() evaluates neither package', async () => {
    const result = (await reportingProbe()).router;
    expect(result.importError).toBeUndefined();
    expect(result.useError).toBeUndefined();
    expect(result.output).toBe('built');
    expect(result.atImport.filter((name) => DURABLE_REPORTING.includes(name)), 'evaluated by importing the training agent').toEqual([]);
    expect(result.afterUse.filter((name) => DURABLE_REPORTING.includes(name)), 'evaluated by building the router').toEqual([]);
  });

  it.each([
    ['server/src/training-agent/gcs-reporting-routes.ts', 'routes'],
    ['server/src/training-agent/gcs-reporting-tools.ts', 'tools'],
  ] as const)('importing %s evaluates neither package', async (_modulePath, step) => {
    const result = (await reportingProbe())[step];
    expect(result.importError).toBeUndefined();
    expect(result.atImport.filter((name) => DURABLE_REPORTING.includes(name))).toEqual([]);
  });

  it('the first reporting call loads the runtime module and, with reporting off, finds no runtime', async () => {
    const result = (await reportingProbe()).runtime;
    expect(result.importError).toBeUndefined();
    expect(result.useError).toBeUndefined();
    expect(result.atImport.filter((name) => DURABLE_REPORTING.includes(name)), 'loaded before first use').toEqual([]);
    expect(result.output).toBe('undefined');
    expect(result.afterUse).toEqual(expect.arrayContaining(DURABLE_REPORTING));
  });
});

describe('building the training agent leaves brand data and product-discovery schemas for first use', () => {
  // brand-handlers.ts reads the SDK's sandbox brands (YAML test kits) and
  // task-handlers.ts bundles seven product-discovery request schemas, both
  // only for tool definitions and brand handlers. The probe records file reads
  // after the router is built: if import or construction had already loaded
  // them, the first full tool list would read nothing (both are cached).
  const PRODUCT_DISCOVERY = [
    'list-products-request', 'request-proposals-request', 'refine-proposals-request', 'decline-proposals-request',
    'buy-products-request', 'accept-proposal-request', 'control-media-buy-request',
  ].map((name) => `media-buy/${name}.json`);

  it('the first full tool list reads them; tool names and a second list do not', async () => {
    const result = await probe('server/src/training-agent/index.ts', {
      use: `async (mod) => {
        mod.createTrainingAgentRouter({ disableRateLimit: true });
        (await import("./server/src/training-agent/state.ts")).stopSessionCleanup();
        const tasks = await import("./server/src/training-agent/task-handlers.ts");
        const fs = (await import("node:fs")).default;
        const { syncBuiltinESMExports } = await import("node:module");
        let reads = [];
        const original = fs.readFileSync;
        fs.readFileSync = function (file, ...rest) { reads.push(String(file)); return original.call(this, file, ...rest); };
        syncBuiltinESMExports();
        const take = () => { const taken = reads; reads = []; return taken; };
        const names = tasks.visibleTrainingToolNamesForContext({});
        const afterNames = take();
        const first = JSON.stringify(tasks.visibleToolsForContext({}));
        const afterFirst = take();
        const second = JSON.stringify(tasks.visibleToolsForContext({}));
        const afterSecond = take();
        return { names: names.length, same: first === second, afterNames, afterFirst, afterSecond };
      }`,
      env: { PUBLIC_TEST_AGENT_TOKEN: 'test-token', TRAINING_REPORTING_GCS_ENABLED: undefined },
    });
    expect(result.importError).toBeUndefined();
    expect(result.useError).toBeUndefined();
    const output = result.output as { names: number; same: boolean; afterNames: string[]; afterFirst: string[]; afterSecond: string[] };
    const testKits = (files: string[]) => files.filter((file) => /\/test-kits\/[^/]+\.ya?ml$/.test(file));
    const discovery = (files: string[]) => PRODUCT_DISCOVERY.filter((name) => files.some((file) => file.endsWith(name)));
    expect(output.names).toBeGreaterThan(0);
    expect(testKits(output.afterNames), 'tool names read the sandbox test kits').toEqual([]);
    expect(discovery(output.afterNames), 'tool names read product-discovery schemas').toEqual([]);
    expect(testKits(output.afterFirst).length, 'the first full list reads the sandbox test kits').toBeGreaterThan(0);
    expect(discovery(output.afterFirst), 'the first full list reads every product-discovery schema').toEqual(PRODUCT_DISCOVERY);
    expect(testKits(output.afterSecond), 'the second list reads the test kits again').toEqual([]);
    expect(discovery(output.afterSecond), 'the second list reads product-discovery schemas again').toEqual([]);
    expect(output.same, 'both lists serialize identically').toBe(true);
  });

  it('building routers starts no tenant-registry init; the boot prewarm starts one per registry', async () => {
    // Every registry init awaits the memoized schema bundle before it logs
    // 'Tenant registry init starting'. Awaiting the same promise afterwards,
    // plus one macrotask, lets any init that construction started log first.
    // The prewarmed router is the positive control; its inits end with the
    // child process.
    const result = await probe('server/src/training-agent/index.ts', {
      use: `async (mod) => {
        let starts = 0;
        (await import("./server/src/logger.ts")).setLogHook((level, message) => {
          if (message === "Tenant registry init starting") starts += 1;
        });
        const { ensureTrainingAgentSchemaBundle } = await import("./server/src/training-agent/schema-compat.ts");
        const settle = async () => { await ensureTrainingAgentSchemaBundle(); await new Promise((resolve) => setImmediate(resolve)); };
        for (const disableRateLimit of [true, true, false]) mod.createTrainingAgentRouter({ disableRateLimit });
        await settle();
        const built = starts;
        starts = 0;
        mod.createTrainingAgentRouter({ disableRateLimit: true, prewarmTenantRegistries: true });
        await settle();
        const prewarmed = starts;
        const tenants = await import("./server/src/training-agent/tenants/router.ts");
        (await import("./server/src/training-agent/state.ts")).stopSessionCleanup();
        return {
          built,
          prewarmed,
          profiles: tenants.PROPOSAL_NEGOTIATION_PROFILE_ROUTES.length,
          profilesEnabled: tenants.proposalNegotiationProfilesEnabled(),
        };
      }`,
      env: { LOG_LEVEL: 'info', PUBLIC_TEST_AGENT_TOKEN: 'test-token', TRAINING_REPORTING_GCS_ENABLED: undefined },
    });
    expect(result.importError).toBeUndefined();
    expect(result.useError).toBeUndefined();
    const output = result.output as { built: number; prewarmed: number; profiles: number; profilesEnabled: boolean };
    expect(output.built, 'tenant-registry inits started by building three routers').toBe(0);
    expect(
      output.prewarmed,
      'tenant-registry inits started by one router built with prewarmTenantRegistries: true (main plus each enabled proposal profile)',
    ).toBe(1 + (output.profilesEnabled ? output.profiles : 0));
  });
});

describe('server unit setup file', () => {
  const SETUP_FILE = 'server/tests/setup/conductor-loopback-setup.ts';
  const readPatchState = `async () => {
    const supertest = (await import('supertest')).default;
    return { patched: supertest.Test.prototype.__adcpConductorLoopbackPatched === true };
  }`;

  it('does not load Supertest outside Conductor', async () => {
    const result = await probe(SETUP_FILE, { env: { CONDUCTOR_IS_LOCAL: undefined }, use: readPatchState });
    expect(result.importError).toBeUndefined();
    expect(result.useError).toBeUndefined();
    expect(result.atImport).not.toContain('supertest');
    expect(result.output).toEqual({ patched: false });
  });

  it('loads Supertest and installs the loopback patch when CONDUCTOR_IS_LOCAL=1', async () => {
    const result = await probe(SETUP_FILE, { env: { CONDUCTOR_IS_LOCAL: '1' }, use: readPatchState });
    expect(result.importError).toBeUndefined();
    expect(result.useError).toBeUndefined();
    expect(result.atImport).toContain('supertest');
    expect(result.output).toEqual({ patched: true });
  });
});

describe('probe processes', () => {
  it('the leaf modules share one probe process, and the durable reporting probes another', async () => {
    await leafProbe();
    await reportingProbe();
    const reporting = Object.values(REPORTING_STEPS).map((step) => step.modulePath);
    // Other tests probe some of these modules again, alone, for first use.
    expect(probeRuns.filter((run) => LEAF_MODULES.some((m) => run.includes(m)) && run.length > 1)).toEqual([LEAF_MODULES]);
    expect(probeRuns.filter((run) => reporting.some((m) => run.includes(m)) && run.length > 1)).toEqual([reporting]);
  });
});
