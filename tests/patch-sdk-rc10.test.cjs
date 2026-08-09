const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const PATCHER = path.resolve(__dirname, '..', 'scripts', 'patch-sdk-rc10.mjs');
const RUNTIME_FILES = [
  'node_modules/@adcp/sdk/dist/lib/server/decisioning/runtime/from-platform.js',
  'node_modules/@adcp/sdk/dist/lib/server/decisioning/runtime/from-platform.mjs',
];
const CLIENT_FILES = [
  'node_modules/@adcp/sdk/dist/lib/core/SingleAgentClient.js',
  'node_modules/@adcp/sdk/dist/lib/core/SingleAgentClient.mjs',
];
const STORYBOARD_TASK_MAP_FILES = [
  'node_modules/@adcp/sdk/dist/lib/testing/storyboard/task-map.js',
  'node_modules/@adcp/sdk/dist/lib/testing/storyboard/task-map.mjs',
];

const RUNTIME_SOURCE = `const sales = {};
const handlers = {
    syncCreatives: async (params, ctx) => {
      return [params, ctx];
    },
    ...sales?.getMediaBuyDelivery && {
      getMediaBuyDelivery: async () => null
    }
};
module.exports = handlers;
`;

const CLIENT_SOURCE = `class SingleAgentClient {
  async executeTaskUnprojected(...args) { return args; }
  async syncCreatives(...args) { return args; }
  async syncCreativesLegacy(params, inputHandler, options) {
    return await this.syncCreatives(
      params,
      inputHandler,
      options
    );
  }
}
module.exports = SingleAgentClient;
`;

const STORYBOARD_TASK_MAP_SOURCE = `function withLegacyCreativeWireHint(params) {
  return { ...params, ext: { adcp: { creative_wire: "legacy" } } };
}
async function executeStoryboardTask(client, taskName, params) {
  const legacyMethodName = taskName === "get_products" ? "getProductsLegacy" : "syncCreativesLegacy";
  const callParams = legacyMethodName ? withLegacyCreativeWireHint(params) : params;
  return await client[legacyMethodName](callParams);
}
module.exports = { executeStoryboardTask };
`;

function writeFixture(version = '13.0.0-rc.10') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-rc10-patch-'));
  const sdkRoot = path.join(root, 'node_modules', '@adcp', 'sdk');
  fs.mkdirSync(sdkRoot, { recursive: true });
  fs.writeFileSync(path.join(sdkRoot, 'package.json'), JSON.stringify({ version }));
  for (const relative of RUNTIME_FILES) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, relative.endsWith('.mjs')
      ? RUNTIME_SOURCE.replace('module.exports = handlers;', 'export default handlers;')
      : RUNTIME_SOURCE);
  }
  for (const relative of CLIENT_FILES) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, relative.endsWith('.mjs')
      ? CLIENT_SOURCE.replace('module.exports = SingleAgentClient;', 'export default SingleAgentClient;')
      : CLIENT_SOURCE);
  }
  for (const relative of STORYBOARD_TASK_MAP_FILES) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, relative.endsWith('.mjs')
      ? STORYBOARD_TASK_MAP_SOURCE.replace('module.exports = { executeStoryboardTask };', 'export { executeStoryboardTask };')
      : STORYBOARD_TASK_MAP_SOURCE);
  }
  return root;
}

function runPatcher(root) {
  return spawnSync(process.execPath, [PATCHER], { cwd: root, encoding: 'utf8' });
}

test('rc.10 patch transforms and verifies both CJS and ESM artifacts idempotently', async (t) => {
  const root = writeFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const first = runPatcher(root);
  assert.equal(first.status, 0, first.stderr);
  const files = [...RUNTIME_FILES, ...CLIENT_FILES, ...STORYBOARD_TASK_MAP_FILES].map(relative => path.join(root, relative));
  const once = files.map(file => fs.readFileSync(file, 'utf8'));
  assert.ok(once[0].includes('...sales?.syncCreatives && { syncCreatives: async'));
  assert.ok(once[1].includes('...sales?.syncCreatives && { syncCreatives: async'));
  assert.ok(once[2].includes('executeTaskUnprojected("sync_creatives"'));
  assert.ok(once[3].includes('executeTaskUnprojected("sync_creatives"'));
  assert.ok(once[4].includes('taskName !== "get_products"'));
  assert.ok(once[5].includes('taskName !== "get_products"'));
  for (const file of files) {
    const checked = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(checked.status, 0, checked.stderr);
  }
  assert.equal(typeof require(files[0]), 'object');
  assert.equal(typeof (await import(pathToFileURL(files[1]).href)).default, 'object');
  const CjsClient = require(files[2]);
  const EsmClient = (await import(pathToFileURL(files[3]).href)).default;
  assert.deepEqual(await new CjsClient().syncCreativesLegacy({ creatives: [] }), [
    'sync_creatives', { creatives: [] }, undefined, undefined,
  ]);
  assert.deepEqual(await new EsmClient().syncCreativesLegacy({ creatives: [] }), [
    'sync_creatives', { creatives: [] }, undefined, undefined,
  ]);
  const cjsTaskMap = require(files[4]);
  const esmTaskMap = await import(pathToFileURL(files[5]).href);
  const taskClient = {
    getProductsLegacy: async params => params,
    syncCreativesLegacy: async params => params,
  };
  for (const taskMap of [cjsTaskMap, esmTaskMap]) {
    assert.deepEqual(
      await taskMap.executeStoryboardTask(taskClient, 'get_products', { buying_mode: 'wholesale' }),
      { buying_mode: 'wholesale' },
    );
    assert.deepEqual(
      await taskMap.executeStoryboardTask(taskClient, 'sync_creatives', { creatives: [] }),
      { creatives: [], ext: { adcp: { creative_wire: 'legacy' } } },
    );
  }

  const second = runPatcher(root);
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(files.map(file => fs.readFileSync(file, 'utf8')), once);
});

test('rc.10 patch refuses an unreviewed SDK version before modifying artifacts', (t) => {
  const root = writeFixture('13.0.0-rc.11');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = runPatcher(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refusing to patch @adcp\/sdk 13\.0\.0-rc\.11/);
});
