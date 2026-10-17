'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { install } = require('../scripts/install-sdk-creative-build-probe.cjs');

const patchRoot = path.resolve(__dirname, '../patches/sdk-creative-build-probe');
const manifest = JSON.parse(fs.readFileSync(path.join(patchRoot, 'manifest.json'), 'utf8'));
const sdkRoot = path.resolve(require.resolve('@adcp/sdk/testing'), '../../../..');

function originalPackage() {
  // Stay inside this repository so public SDK entry points can resolve their
  // ordinary dependencies from the parent node_modules.
  const dir = fs.mkdtempSync(path.resolve(__dirname, '../.context/sdk-probe-test-'));
  const root = path.join(dir, 'node_modules/@adcp/sdk');
  fs.cpSync(sdkRoot, root, { recursive: true });
  // A normal postinstall may already have patched the source package. Restore
  // exact stock bytes for the compatibility and ignore-scripts install tests.
  for (const entry of manifest.files) {
    const file = path.join(root, entry.path);
    if (entry.before === null) { fs.rmSync(file, { force: true }); continue; }
    let contents = fs.readFileSync(file, 'utf8');
    for (const edit of [...entry.replacements].reverse()) contents = contents.replace(edit.to, () => edit.from);
    fs.writeFileSync(file, contents);
  }
  return { dir, root };
}

const probe = String.raw`
const api = MODE === 'esm' ? await import('@adcp/sdk/testing') : require('@adcp/sdk/testing');
if (api.resolveCreativeBuildProbe && typeof api.validateCreativeBuildProbeSpec !== 'function') throw Error('missing public resolver API');
const sb = api.parseStoryboard(
  'id: build_probe_bridge\nversion: "1.0.0"\ntitle: Probe\ncategory: creative\nsummary: Bridge verification\n' +
  'creative_build_probe:\n  context_prefix: build\n  message: Build one sandbox creative\n' +
  'phases:\n  - id: boundary\n    title: Boundary\n    steps:\n      - id: reject\n        title: Reject\n        task: build_creative\n        requires_contract: creative_build_probe_runner\n        expect_error: true\n        stateful: true\n' +
  '        sample_request:\n          target_capability_id: "$context.build_capability_id"\n          message: "$context.build_message"\n' +
  '        context_inputs:\n          - key: build_creative_manifest\n            inject_at: creative_manifest\n' +
  '        validations:\n          - check: error_code\n            value: EVALUATOR_AGENT_NOT_ACCEPTED\n');
let calls = 0;
const tools = ['get_adcp_capabilities', 'build_creative'];
const creative = { supports_generation: true, supported_formats: [
  { capability_id: 'validate', operations: ['validate'], format: { format_kind: 'image', params: {} } },
  { capability_id: 'build', operations: ['build'], format: { format_kind: 'image', params: {}, technical_requirements_complete: true } }
] };
const options = { _profile: { tools, raw_capabilities: { creative } }, agentTools: tools,
  _client: { resetContext() {}, async executeTask(task, input) {
    calls++;
    if (input.target_capability_id !== 'build' || input.creative_manifest?.format_kind !== 'image') throw Error('invalid binding');
    return { success: false, data: { errors: [{ code: 'INVALID_REQUEST', message: 'Wrong rejection' }] } };
  } } };
const full = await api.runStoryboard('https://agent.example/mcp', sb, options);
const single = await api.runStoryboardStep('https://agent.example/mcp', sb, 'reject', options);
creative.supported_formats[1].format.technical_requirements_complete = false;
const unavailable = await api.runStoryboard('https://agent.example/mcp', sb, options);
const unavailableStep = await api.runStoryboardStep('https://agent.example/mcp', sb, 'reject', options);
const unopted = { ...sb }; delete unopted.creative_build_probe;
const unchanged = await api.runStoryboard('https://agent.example/mcp', unopted, options);
console.log(JSON.stringify({ full, single, unavailable, unavailableStep, unchanged, calls }));
`;

function run(dir, mode) {
  const script = `const MODE = ${JSON.stringify(mode)}; (async () => { ${probe} })().catch(e => { console.error(e); process.exit(1); });`;
  return JSON.parse(execFileSync(process.execPath, ['-e', script], { cwd: dir, encoding: 'utf8' }));
}

test('stock SDK gives no security credit; explicit trusted install supports public CJS and ESM full and standalone runs', () => {
  const { dir, root } = originalPackage();
  try {
    for (const mode of ['cjs', 'esm']) {
      const stock = run(dir, mode);
      assert.equal(stock.calls, 0);
      assert.equal(stock.full.passed_count, 0);
      assert.equal(stock.single.skipped, true);
    }
    install(root); // npm ci --ignore-scripts + explicit trusted invocation
    install(root); // normal install / repeated postinstall is idempotent
    const ts = require('typescript');
    for (const entry of manifest.files.filter(item => item.path.endsWith('.d.mts'))) {
      const file = path.join(root, entry.path);
      const declarations = fs.readFileSync(file, 'utf8');
      const refs = [...declarations.matchAll(/(?:from\s+|import\()(['"])([^'"]*creative-build-probe[^'"]*)\1/g)].map(match => match[2]);
      for (const ref of refs) {
        assert.ok(ref.endsWith('.mjs'), `ESM declaration needs explicit extension: ${ref}`);
        const resolved = ts.resolveModuleName(ref, file, {
          module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
        }, ts.sys, undefined, undefined, ts.ModuleKind.ESNext).resolvedModule;
        assert.ok(resolved?.resolvedFileName.endsWith('.d.mts'), `NodeNext could not resolve ${ref}`);
      }
    }

    for (const mode of ['cjs', 'esm']) {
      const result = run(dir, mode);
      assert.equal(result.calls, 2, mode);
      assert.equal(result.full.overall_passed, false);
      assert.equal(result.full.failed_count, 1);
      assert.equal(result.single.passed, false);
      assert.equal(result.unavailable.passed_count, 0);
      assert.equal(result.unavailable.failed_count, 0);
      assert.equal(result.unavailable.coverage_gaps[0].reason, 'fixture_unsatisfied');
      assert.equal(result.unavailableStep.skip_reason, 'fixture_unsatisfied');
      assert.equal(result.unchanged.passed_count, 0);
      assert.equal(result.unchanged.fixture_resolutions, undefined, 'unopted runner output remains unchanged');
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('bridge rejects version drift, late-file drift and mixed states before writing any target', () => {
  const { dir, root } = originalPackage();
  try {
    const first = path.join(root, manifest.files[0].path);
    const original = fs.readFileSync(first, 'utf8');
    const last = path.join(root, manifest.files.at(-1).path);
    fs.appendFileSync(last, '\n// drift\n');
    assert.throws(() => install(root), /content drift/);
    assert.equal(fs.readFileSync(first, 'utf8'), original);
    fs.writeFileSync(last, fs.readFileSync(last, 'utf8').replace('\n// drift\n', ''));
    const firstEntry = manifest.files[0];
    let patched = original;
    for (const edit of firstEntry.replacements) patched = patched.replace(edit.from, () => edit.to);
    fs.writeFileSync(first, patched);
    assert.throws(() => install(root), /mixed original\/patched/);
    fs.writeFileSync(first, original);
    const pkgFile = path.join(root, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
    for (const version of ['15.9.2', '99.0.0']) {
      pkg.version = version; fs.writeFileSync(pkgFile, JSON.stringify(pkg));
      assert.throws(() => install(root), /requires.*15\.9\.5/);
      assert.equal(fs.readFileSync(first, 'utf8'), original);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});


test('bridge rejects a payload traversal before writing any package target', () => {
  const { dir, root } = originalPackage();
  try {
    const first = path.join(root, manifest.files[0].path);
    const original = fs.readFileSync(first, 'utf8');
    const harness = path.join(dir, 'owned-bridge');
    const harnessPatches = path.join(harness, 'patches/sdk-creative-build-probe');
    fs.mkdirSync(path.join(harness, 'scripts'), { recursive: true });
    fs.cpSync(patchRoot, harnessPatches, { recursive: true });
    const installerFile = path.join(harness, 'scripts/install-sdk-creative-build-probe.cjs');
    fs.copyFileSync(path.resolve(__dirname, '../scripts/install-sdk-creative-build-probe.cjs'), installerFile);
    const altered = structuredClone(manifest);
    const entry = altered.files.find(item => item.contents_file === 'creative-build-probe.js');
    // An outside payload with the correct bytes would satisfy output hashes.
    // The installer must reject its path before reading or writing any target.
    fs.copyFileSync(path.join(patchRoot, entry.contents_file), path.join(harness, 'patches/outside.js'));
    entry.contents_file = '../outside.js';
    fs.writeFileSync(path.join(harnessPatches, 'manifest.json'), JSON.stringify(altered));
    assert.throws(() => require(installerFile).install(root), /Invalid SDK bridge contents_file/);
    assert.equal(fs.readFileSync(first, 'utf8'), original);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
