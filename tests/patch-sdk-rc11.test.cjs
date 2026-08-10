const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const PATCHER = path.resolve(__dirname, '..', 'scripts', 'patch-sdk-rc11.mjs');
const TASK_MAP_FILES = [
  'node_modules/@adcp/sdk/dist/lib/testing/storyboard/task-map.js',
  'node_modules/@adcp/sdk/dist/lib/testing/storyboard/task-map.mjs',
];

const TASK_MAP_SOURCE = `function withLegacyCreativeWireHint(params) {
  return { ...params, ext: { adcp: { creative_wire: "legacy" } } };
}
async function executeStoryboardTask(client, taskName, params) {
  const legacyMethodName = taskName === "get_products" ? "getProductsLegacy" : "syncCreativesLegacy";
  const callParams = legacyMethodName ? withLegacyCreativeWireHint(params) : params;
  return await client[legacyMethodName](callParams);
}
module.exports = { executeStoryboardTask };
`;

function writeFixture(version = '13.0.0-rc.13') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-rc11-patch-'));
  const sdkRoot = path.join(root, 'node_modules', '@adcp', 'sdk');
  fs.mkdirSync(sdkRoot, { recursive: true });
  fs.writeFileSync(path.join(sdkRoot, 'package.json'), JSON.stringify({ version }));
  for (const relative of TASK_MAP_FILES) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, relative.endsWith('.mjs')
      ? TASK_MAP_SOURCE.replace('module.exports = { executeStoryboardTask };', 'export { executeStoryboardTask };')
      : TASK_MAP_SOURCE);
  }
  return root;
}

function runPatcher(root) {
  return spawnSync(process.execPath, [PATCHER], { cwd: root, encoding: 'utf8' });
}

test('rc.13 patch fixes get_products routing in CJS and ESM idempotently', async (t) => {
  const root = writeFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const first = runPatcher(root);
  assert.equal(first.status, 0, first.stderr);
  const files = TASK_MAP_FILES.map(relative => path.join(root, relative));
  const once = files.map(file => fs.readFileSync(file, 'utf8'));
  for (const source of once) assert.ok(source.includes('taskName !== "get_products"'));
  for (const file of files) {
    const checked = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(checked.status, 0, checked.stderr);
  }

  const cjsTaskMap = require(files[0]);
  const esmTaskMap = await import(pathToFileURL(files[1]).href);
  const client = {
    getProductsLegacy: async params => params,
    syncCreativesLegacy: async params => params,
  };
  for (const taskMap of [cjsTaskMap, esmTaskMap]) {
    assert.deepEqual(
      await taskMap.executeStoryboardTask(client, 'get_products', { buying_mode: 'wholesale' }),
      { buying_mode: 'wholesale' },
    );
    assert.deepEqual(
      await taskMap.executeStoryboardTask(client, 'sync_creatives', { creatives: [] }),
      { creatives: [], ext: { adcp: { creative_wire: 'legacy' } } },
    );
  }

  const second = runPatcher(root);
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(files.map(file => fs.readFileSync(file, 'utf8')), once);
});

test('rc.13 patch refuses an unreviewed SDK version before modifying artifacts', (t) => {
  const root = writeFixture('13.0.0-rc.14');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = runPatcher(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refusing to patch @adcp\/sdk 13\.0\.0-rc\.14/);
});

test('rc.13 patch rejects an unexpected task-map source shape', (t) => {
  const root = writeFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const relative of TASK_MAP_FILES) {
    const file = path.join(root, relative);
    const source = fs.readFileSync(file, 'utf8').replace(
      '  const callParams = legacyMethodName ? withLegacyCreativeWireHint(params) : params;',
      '  const callParams = params;',
    );
    fs.writeFileSync(file, source);
  }

  const result = runPatcher(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unexpected 13\.0\.0-rc\.13 storyboard task-map shape/);
});

test('rc.13 patch preflights both module formats before writing either one', (t) => {
  const root = writeFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cjsFile = path.join(root, TASK_MAP_FILES[0]);
  const esmFile = path.join(root, TASK_MAP_FILES[1]);
  const cjsBefore = fs.readFileSync(cjsFile, 'utf8');
  fs.writeFileSync(
    esmFile,
    fs.readFileSync(esmFile, 'utf8').replace(
      '  const callParams = legacyMethodName ? withLegacyCreativeWireHint(params) : params;',
      '  const callParams = params;',
    ),
  );

  const result = runPatcher(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unexpected 13\.0\.0-rc\.13 storyboard task-map shape/);
  assert.equal(fs.readFileSync(cjsFile, 'utf8'), cjsBefore);
});
