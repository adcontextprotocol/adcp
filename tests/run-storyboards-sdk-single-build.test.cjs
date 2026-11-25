#!/usr/bin/env node
/**
 * Runtime guard: a storyboard child loads one @adcp/sdk build.
 *
 * adcp reaches the SDK only through its ESM entry points (static import,
 * import(), import.meta.resolve). A createRequire(...)('@adcp/sdk...') or a
 * deep dist/lib/*.js path loads the CommonJS build as well, so the process
 * holds two schema loaders, two sets of external schema roots and two sets of
 * validator caches, and the CJS copy repeats the schema-root work.
 *
 * The guard spawns the real storyboard discovery child (the same invocation
 * scripts/run-storyboards-isolated.mjs uses, candidate mode and the shared
 * validator cache as the pre-push hook runs it) under
 * tests/helpers/sdk-build-trace.mjs and asserts:
 *   - ESM edges into the SDK are recorded (the hook works);
 *   - no edge from outside node_modules/@adcp/sdk/ resolves to the CJS build;
 *   - no edge at all resolves to the CJS schema loader
 *     (dist/lib/validation/schema-loader.js) or a CJS index.js entry point.
 *
 * Discovery (--list-applicable-json) loads the same import graph as a full
 * child: the runner top level, the candidate schema-root helper, the training
 * agent router and the tenant registry (ensureTrainingAgentSchemaBundle). It
 * does not serve responses, so it cannot see the SDK's response-time CJS
 * fallback; server/tests/unit/storyboard-candidate-schema-root.test.ts covers
 * that.
 *
 * Discovery never builds the creative33 sandbox or registers the hosted
 * preview, so a second child mounts the training-agent router on HTTP and
 * sends one creative33 request and one preview-pinned request (see the
 * comment above that test).
 *
 * Not asserted: CJS leaves the SDK's own ESM build loads through its
 * createRequire of relative siblings (validation/compact-schema.js,
 * validation/schema-diagnostic-origins.js, types/schemas.generated.js). Those
 * belong to the SDK build, not to adcp; once the SDK imports its siblings as
 * .mjs this guard can tighten to "zero CJS SDK files".
 */

'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { fileURLToPath, pathToFileURL } = require('node:url');
const { ensureBuiltCompliance, ensureBuiltSchemas } = require('../scripts/built-schemas.cjs');
const { runChild } = require('./fixtures/storyboard-process-reaper.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const TRACE_HELPER = pathToFileURL(path.join(__dirname, 'helpers', 'sdk-build-trace.mjs')).href;
const COMPLIANCE_DIR = path.join(REPO_ROOT, 'dist', 'compliance', 'latest');
const SCHEMA_ROOT = path.join(REPO_ROOT, 'dist', 'schemas', 'latest');
// scripts/run-storyboards-matrix.sh's default ADCP_VALIDATOR_CACHE_DIR, and
// .husky/pre-push's default NODE_COMPILE_CACHE: the caches every pre-push
// storyboard child and every server-suite worker gets.
const VALIDATOR_CACHE_DIR = path.join(REPO_ROOT, 'node_modules', '.cache', 'adcp-sdk-validators');
const COMPILE_CACHE_DIR = path.join(REPO_ROOT, 'node_modules', '.cache', 'node-compile-cache');
const SDK_PACKAGE = '/node_modules/@adcp/sdk/';
const CJS_SCHEMA_LOADER = /\/node_modules\/@adcp\/sdk\/dist\/lib\/validation\/schema-loader\.js$/;
const CJS_INDEX_ENTRY = /\/node_modules\/@adcp\/sdk\/dist\/lib\/(?:.+\/)?index\.js$/;

// ---------------------------------------------------------------------------
// Trace reading
// ---------------------------------------------------------------------------

function shortName(url) {
  if (!url) return '<none>';
  const file = url.startsWith('file:') ? fileURLToPath(url) : url;
  const nm = file.lastIndexOf('/node_modules/');
  if (nm !== -1) return file.slice(nm + 1);
  return path.relative(REPO_ROOT, file) || file;
}

function readTrace(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function unique(lines) {
  return [...new Set(lines)].sort();
}

function describeEdge(edge) {
  const specifier = /^(?:\/|file:)/.test(edge.specifier) ? shortName(edge.specifier) : edge.specifier;
  return `${shortName(edge.parentURL)}: ${JSON.stringify(specifier)} -> ${shortName(edge.url)}`;
}

function outsideSdk(edge) {
  return !(edge.parentURL ?? '').includes(SDK_PACKAGE);
}

/** ESM edges from outside the SDK into it: proof the hook saw the graph. */
function esmEdgesFromOutsideSdk(edges) {
  return unique(edges.filter((e) => e.build === 'esm' && outsideSdk(e)).map(describeEdge));
}

/** CJS edges whose parent is not the SDK itself: adcp-side offenders. */
function cjsEdgesFromOutsideSdk(edges) {
  return unique(edges.filter((e) => e.build === 'cjs' && outsideSdk(e)).map(describeEdge));
}

/** Any edge, from any parent, into the CJS schema loader or a CJS entry point. */
function forbiddenCjsTargets(edges) {
  return unique(edges
    .filter((e) => e.build === 'cjs' && (CJS_SCHEMA_LOADER.test(e.url) || CJS_INDEX_ENTRY.test(e.url)))
    .map(describeEdge));
}

// ---------------------------------------------------------------------------
// Traced child processes
// ---------------------------------------------------------------------------

function traceFile(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-sdk-build-trace-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'edges.jsonl');
}

// Asynchronous, so the runner's --test-timeout bounds the child.
async function runTraced(t, nodeArgs, env) {
  const file = traceFile(t);
  const result = await runChild(t, process.execPath, ['--import', TRACE_HELPER, ...nodeArgs], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env, ADCP_SDK_BUILD_TRACE_FILE: file },
  });
  return { result, edges: readTrace(file) };
}

function evalModule(source) {
  return ['--input-type=module', '--eval', source];
}

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

test('a candidate-mode storyboard discovery child loads only the ESM @adcp/sdk build', async (t) => {
  // The pre-push matrix ensures both builds before any child starts; so does
  // the test:run-storyboards-schema-root script, so these are cache hits there.
  ensureBuiltSchemas();
  ensureBuiltCompliance();
  // As scripts/run-storyboards-isolated.mjs launches children, with the
  // environment the pre-push matrix gives the sales tenant in candidate mode.
  const { result, edges } = await runTraced(t, [
    '--import', 'tsx',
    'server/tests/manual/run-storyboards.ts',
    '--list-applicable-json',
  ], {
    TENANT_PATH: 'sales',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    PUBLIC_TEST_AGENT_TOKEN: 'storyboard-local-token',
    ADCP_STORYBOARD_CANDIDATE_VERSION_MODE: '1',
    ADCP_COMPLIANCE_DIR: COMPLIANCE_DIR,
    ADCP_SCHEMA_ROOT: SCHEMA_ROOT,
    ADCP_VALIDATOR_CACHE_DIR: VALIDATOR_CACHE_DIR,
    NODE_COMPILE_CACHE: COMPILE_CACHE_DIR,
  });

  const output = `${result.stdout.slice(-4000)}\n${result.stderr.slice(-4000)}`;
  assert.equal(result.status, 0, output);
  assert.match(result.stdout, /^ADCP_STORYBOARD_LIST \{/m, output);

  assert.ok(esmEdgesFromOutsideSdk(edges).length > 0,
    `the trace hook recorded no ESM edge into @adcp/sdk (${edges.length} SDK edges in total)`);
  const offenders = cjsEdgesFromOutsideSdk(edges);
  assert.deepEqual(offenders, [],
    `adcp modules reach the CommonJS @adcp/sdk build (${offenders.length}); import the ESM entry point instead:\n${offenders.join('\n')}`);
  const forbidden = forbiddenCjsTargets(edges);
  assert.deepEqual(forbidden, [],
    `the CommonJS schema loader or a CommonJS SDK entry point is loaded (${forbidden.length}):\n${forbidden.join('\n')}`);
});

/**
 * The training agent's server-side schema-root registrations, driven the way
 * production reaches them: through HTTP on a mounted router.
 *
 *   - router construction (createTrainingAgentRouter) and the retained
 *     bundles (ensureTrainingAgentSchemaBundle);
 *   - the first creative33 MCP request on /beta/3.3/creative/mcp, which
 *     builds the sandbox lazily (createCreative33Sandbox ->
 *     ensureCreative33SchemaBundle) and validates its response;
 *   - the first preview-pinned request on the v5 /mcp route, which registers
 *     the hosted preview's bundle (ensurePreviewSchemaBundle).
 *
 * Candidate mode and the hosted preview exclude each other per process, so
 * this child runs with candidate mode off and the preview on; the candidate
 * branch of ensureTrainingAgentSchemaBundle is covered by the discovery child
 * above. A fresh tsx child (not a vitest worker) gives each edge its parent
 * module; vitest-specific resolution (server.deps.inline, resolve.conditions)
 * is not covered here.
 */
const ROUTE_CHILD_PREFIX = 'TRAINING_AGENT_ROUTE_CHILD ';
const ROUTE_CHILD_TOKEN = 'test-token';
const CREATIVE33_SCHEMA_MODULE = 'server/src/training-agent/creative33/schema.ts';
const SCHEMA_COMPAT_MODULE = 'server/src/training-agent/schema-compat.ts';

function trainingAgentRouteChild() {
  return evalModule(`
    import express from 'express';
    import http from 'node:http';
    const { createTrainingAgentRouter } = await import('./server/src/training-agent/index.ts');
    const { stopSessionCleanup } = await import('./server/src/training-agent/state.ts');
    const { isCreative33McpPath } = await import('./server/src/training-agent/lab-route-paths.ts');
    const { TRAINING_AGENT_PREVIEW_ADCP_VERSION } = await import('./server/src/training-agent/candidate-version.ts');
    const { PREVIEW_SCHEMA_BUNDLE } = await import('./server/src/training-agent/schema-compat.ts');
    const { CREATIVE33_WIRE_VERSION } = await import('./server/src/training-agent/creative33/catalog.ts');
    const app = express();
    // As server/src/http.ts parses training-agent bodies: rawBody for the
    // v5 routes, the exact bytes for the creative33 revision checks.
    app.use(express.json({ limit: '1mb', verify: (req, _res, body) => {
      req.rawBody = body.toString('utf8');
      if (isCreative33McpPath(req.url)) req.creative33RawBody = Buffer.from(body);
    } }));
    app.use('/api/training-agent', createTrainingAgentRouter({ disableRateLimit: true }));
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port + '/api/training-agent';
    async function call(route, name, args) {
      const response = await fetch(base + route, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer ${ROUTE_CHILD_TOKEN}' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      });
      const text = await response.text();
      let envelope = null;
      try { envelope = JSON.parse(text); } catch {}
      const content = envelope?.result?.content?.find(item => item.type === 'text')?.text;
      const payload = envelope?.result?.structuredContent ?? (content ? JSON.parse(content) : null);
      return {
        httpStatus: response.status,
        isError: envelope?.result?.isError ?? null,
        rpcError: envelope?.error ?? null,
        adcpVersion: payload?.adcp_version ?? null,
        adcpError: payload?.adcp_error ?? null,
        body: envelope ? undefined : text.slice(0, 2000),
      };
    }
    const result = {
      previewVersion: TRAINING_AGENT_PREVIEW_ADCP_VERSION ?? null,
      previewBundle: PREVIEW_SCHEMA_BUNDLE ?? null,
      creative33WireVersion: CREATIVE33_WIRE_VERSION,
    };
    result.creative33 = await call('/beta/3.3/creative/mcp', 'get_adcp_capabilities', { adcp_version: CREATIVE33_WIRE_VERSION });
    result.preview = await call('/mcp', 'get_adcp_capabilities', { adcp_version: TRAINING_AGENT_PREVIEW_ADCP_VERSION });
    stopSessionCleanup();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => process.stdout.write(${JSON.stringify(ROUTE_CHILD_PREFIX)} + JSON.stringify(result) + '\\n', resolve));
    process.exit(0);
  `);
}

function esmEdgesFrom(edges, moduleName) {
  return esmEdgesFromOutsideSdk(edges).filter((line) => line.startsWith(`${moduleName}: `));
}

test('a training-agent process serving a creative33 request and a preview-pinned request loads only the ESM @adcp/sdk build', async (t) => {
  ensureBuiltSchemas();
  const { result, edges } = await runTraced(t, ['--import', 'tsx', ...trainingAgentRouteChild()], {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    PUBLIC_TEST_AGENT_TOKEN: ROUTE_CHILD_TOKEN,
    // The caches a server-suite worker gets (vitest.config.ts files): the
    // schema-root checks read the SDK's entries instead of every document.
    ADCP_VALIDATOR_CACHE_DIR: VALIDATOR_CACHE_DIR,
    NODE_COMPILE_CACHE: COMPILE_CACHE_DIR,
    // Candidate mode off, preview on, creative33 on (NODE_ENV=test enables
    // it): an inherited value must not turn a registration path into a no-op.
    ADCP_STORYBOARD_CANDIDATE_VERSION_MODE: undefined,
    ADCP_TRAINING_CANDIDATE_VERSION: undefined,
    TRAINING_AGENT_DISABLE_ADCP_PREVIEW: undefined,
    ENABLE_ADCP_3_3_CREATIVE_ROUTE: undefined,
  });

  const output = `${result.stdout.slice(-4000)}\n${result.stderr.slice(-4000)}`;
  assert.equal(result.status, 0, output);
  const line = result.stdout.split('\n').find((entry) => entry.startsWith(ROUTE_CHILD_PREFIX));
  assert.ok(line, output);
  const child = JSON.parse(line.slice(ROUTE_CHILD_PREFIX.length));

  // Each registration path ran: the preview is served by this process and
  // both requests were answered by the route that owns them.
  assert.ok(child.previewVersion, `the hosted preview is off in the child: ${line}`);
  assert.ok(child.previewBundle, `PREVIEW_SCHEMA_BUNDLE is unset in the child: ${line}`);
  assert.equal(child.creative33.httpStatus, 200, line);
  assert.equal(child.creative33.rpcError, null, line);
  assert.equal(child.creative33.adcpError, null, line);
  assert.equal(child.creative33.adcpVersion, child.creative33WireVersion, line);
  assert.equal(child.preview.httpStatus, 200, line);
  assert.equal(child.preview.rpcError, null, line);
  assert.equal(child.preview.adcpError, null, line);
  assert.equal(child.preview.adcpVersion, child.previewVersion, line);

  assert.ok(esmEdgesFrom(edges, CREATIVE33_SCHEMA_MODULE).length > 0,
    `no ESM edge into @adcp/sdk from ${CREATIVE33_SCHEMA_MODULE}:\n${esmEdgesFromOutsideSdk(edges).join('\n')}`);
  assert.ok(esmEdgesFrom(edges, SCHEMA_COMPAT_MODULE).length > 0,
    `no ESM edge into @adcp/sdk from ${SCHEMA_COMPAT_MODULE}:\n${esmEdgesFromOutsideSdk(edges).join('\n')}`);
  const offenders = cjsEdgesFromOutsideSdk(edges);
  assert.deepEqual(offenders, [],
    `adcp modules reach the CommonJS @adcp/sdk build (${offenders.length}); import the ESM entry point instead:\n${offenders.join('\n')}`);
  const forbidden = forbiddenCjsTargets(edges);
  assert.deepEqual(forbidden, [],
    `the CommonJS schema loader or a CommonJS SDK entry point is loaded (${forbidden.length}):\n${forbidden.join('\n')}`);
});

// ---------------------------------------------------------------------------
// Meta-tests: the trace helper and the edge classification
// ---------------------------------------------------------------------------

test('trace meta-test: a createRequire of @adcp/sdk/testing is reported as a CommonJS edge', async (t) => {
  const { result, edges } = await runTraced(t, evalModule([
    "import { createRequire } from 'node:module';",
    "createRequire(import.meta.url)('@adcp/sdk/testing');",
  ].join('\n')), {});

  assert.equal(result.status, 0, result.stderr);
  const offenders = cjsEdgesFromOutsideSdk(edges);
  assert.ok(offenders.some((line) => /"@adcp\/sdk\/testing" -> node_modules\/@adcp\/sdk\/dist\/lib\/testing\/index\.js$/.test(line)),
    `expected the createRequire edge to be reported:\n${offenders.join('\n')}`);
  const forbidden = forbiddenCjsTargets(edges);
  assert.ok(forbidden.some((line) => /testing\/index\.js$/.test(line)), forbidden.join('\n'));
  assert.ok(forbidden.some((line) => /validation\/schema-loader\.js$/.test(line)),
    `the CJS testing entry loads the CJS schema loader, which must be reported:\n${forbidden.join('\n')}`);
});

test('trace meta-test: an ESM import of @adcp/sdk/testing is reported as ESM only', async (t) => {
  const { result, edges } = await runTraced(t, evalModule("await import('@adcp/sdk/testing');"), {});

  assert.equal(result.status, 0, result.stderr);
  assert.ok(esmEdgesFromOutsideSdk(edges).some((line) => /testing\/index\.mjs$/.test(line)),
    esmEdgesFromOutsideSdk(edges).join('\n'));
  assert.deepEqual(cjsEdgesFromOutsideSdk(edges), []);
  assert.deepEqual(forbiddenCjsTargets(edges), []);
});

test('trace meta-test: the helper refuses to run without a trace file', () => {
  const { ADCP_SDK_BUILD_TRACE_FILE: _unused, ...env } = process.env;
  const result = spawnSync(process.execPath, ['--import', TRACE_HELPER, ...evalModule('')], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /needs ADCP_SDK_BUILD_TRACE_FILE/);
});
