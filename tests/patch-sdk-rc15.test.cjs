const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const PATCHER = path.resolve(__dirname, '..', 'scripts', 'patch-sdk-rc15.mjs');
const TASK_MAP_FILES = [
  'node_modules/@adcp/sdk/dist/lib/testing/storyboard/task-map.js',
  'node_modules/@adcp/sdk/dist/lib/testing/storyboard/task-map.mjs',
];
const SINGLE_AGENT_CLIENT_FILES = [
  'node_modules/@adcp/sdk/dist/lib/core/SingleAgentClient.js',
  'node_modules/@adcp/sdk/dist/lib/core/SingleAgentClient.mjs',
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

const SINGLE_AGENT_CLIENT_SOURCE = `const CAPABILITY_DISCOVERY_CONTEXT = Symbol("capabilityDiscoveryContext");
function resolveAdapterKey() {}
const import_version2 = { resolveAdapterKey };
class SingleAgentClient {
  executeCanonical(capabilityDiscoveryContext) {
    return this.adaptRequest("get_products", {}, "v3", [], capabilityDiscoveryContext.toolSchemas
    );
  }
  executeUnprojected(capabilityDiscoveryContext) {
    return this.adaptRequest("get_products", {}, "v3", [], capabilityDiscoveryContext.toolSchemas
    );
  }
  adaptRequest(taskType, params, serverVersion, debugLogs, perCallToolSchemas) {
    const adapterKey = resolveAdapterKey(this.resolvedAdcpVersion, this.cachedCapabilities);
    return adapterKey;
  }
  async getCapabilities() { return { version: "v3" }; }
  async detectServerVersion(options) {
    const capabilities = await this.getCapabilities(options);
    return capabilities.version;
  }
}
module.exports = { SingleAgentClient };
`;

function writeFixture(version = '13.0.0-rc.20') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-rc15-patch-'));
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
  for (const relative of SINGLE_AGENT_CLIENT_FILES) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const source = relative.endsWith('.mjs')
      ? SINGLE_AGENT_CLIENT_SOURCE.replace('module.exports = { SingleAgentClient };', 'export { SingleAgentClient };')
      : SINGLE_AGENT_CLIENT_SOURCE.replace(
        '    const adapterKey = resolveAdapterKey(this.resolvedAdcpVersion, this.cachedCapabilities);',
        '    const adapterKey = (0, import_version2.resolveAdapterKey)(this.resolvedAdcpVersion, this.cachedCapabilities);',
      );
    fs.writeFileSync(file, source);
  }
  return root;
}

function runPatcher(root) {
  return spawnSync(process.execPath, [PATCHER], { cwd: root, encoding: 'utf8' });
}

test('hosted SDK patch fixes get_products routing in CJS and ESM idempotently', async (t) => {
  const root = writeFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const first = runPatcher(root);
  assert.equal(first.status, 0, first.stderr);
  const files = TASK_MAP_FILES.map(relative => path.join(root, relative));
  const clientFiles = SINGLE_AGENT_CLIENT_FILES.map(relative => path.join(root, relative));
  const once = files.map(file => fs.readFileSync(file, 'utf8'));
  const clientsOnce = clientFiles.map(file => fs.readFileSync(file, 'utf8'));
  for (const source of once) assert.ok(source.includes('taskName !== "get_products"'));
  for (const source of clientsOnce) {
    assert.ok(source.includes('perCallCapabilities ?? this.cachedCapabilities'));
    assert.equal((source.match(/capabilityDiscoveryContext\.capabilities/g) ?? []).length, 2);
    assert.ok(source.includes('discoveryContext.capabilities = capabilities'));
  }
  for (const file of [...files, ...clientFiles]) {
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
    const request = {
      buying_mode: 'wholesale',
      filters: { pricing_currencies: ['USD'] },
      fields: ['product_id', 'pricing_options'],
      account: { account_id: 'account-1' },
      context: { correlation_id: 'pricing-filter-test' },
    };
    assert.deepEqual(
      await taskMap.executeStoryboardTask(client, 'get_products', request),
      request,
    );
    assert.deepEqual(
      await taskMap.executeStoryboardTask(client, 'sync_creatives', { creatives: [] }),
      { creatives: [], ext: { adcp: { creative_wire: 'legacy' } } },
    );
  }

  const second = runPatcher(root);
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(files.map(file => fs.readFileSync(file, 'utf8')), once);
  assert.deepEqual(clientFiles.map(file => fs.readFileSync(file, 'utf8')), clientsOnce);
});

test('hosted SDK patch refuses an unreviewed SDK version before modifying artifacts', (t) => {
  const root = writeFixture('13.0.0-rc.19');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = runPatcher(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refusing to patch @adcp\/sdk 13\.0\.0-rc\.19/);
});

test('hosted SDK patch rejects an unexpected task-map source shape', (t) => {
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
  assert.match(result.stderr, /Unexpected 13\.0\.0-rc\.20 SDK shape/);
});

test('hosted SDK patch rejects mixed original and patched call sites before writing either format', (t) => {
  const root = writeFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cjsFile = path.join(root, TASK_MAP_FILES[0]);
  const esmFile = path.join(root, TASK_MAP_FILES[1]);
  const cjsBefore = fs.readFileSync(cjsFile, 'utf8');
  const original = '  const callParams = legacyMethodName ? withLegacyCreativeWireHint(params) : params;';
  const patched = '  const callParams = legacyMethodName && taskName !== "get_products" ? withLegacyCreativeWireHint(params) : params;';
  fs.writeFileSync(esmFile, fs.readFileSync(esmFile, 'utf8').replace(original, `${original}\n${patched}`));

  const result = runPatcher(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unexpected 13\.0\.0-rc\.20 SDK shape/);
  assert.equal(fs.readFileSync(cjsFile, 'utf8'), cjsBefore);
});

test('hosted SDK patch rejects duplicate original call sites before writing either format', (t) => {
  const root = writeFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cjsFile = path.join(root, TASK_MAP_FILES[0]);
  const esmFile = path.join(root, TASK_MAP_FILES[1]);
  const cjsBefore = fs.readFileSync(cjsFile, 'utf8');
  const original = '  const callParams = legacyMethodName ? withLegacyCreativeWireHint(params) : params;';
  fs.writeFileSync(esmFile, fs.readFileSync(esmFile, 'utf8').replace(original, `${original}\n${original}`));

  const result = runPatcher(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unexpected 13\.0\.0-rc\.20 SDK shape/);
  assert.equal(fs.readFileSync(cjsFile, 'utf8'), cjsBefore);
});

test('hosted SDK patch preflights both module formats before writing either one', (t) => {
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
  assert.match(result.stderr, /Unexpected 13\.0\.0-rc\.20 SDK shape/);
  assert.equal(fs.readFileSync(cjsFile, 'utf8'), cjsBefore);
});

test('hosted SDK patch preflights core clients before writing any artifact', (t) => {
  const root = writeFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const taskMapFile = path.join(root, TASK_MAP_FILES[0]);
  const clientFile = path.join(root, SINGLE_AGENT_CLIENT_FILES[1]);
  const taskMapBefore = fs.readFileSync(taskMapFile, 'utf8');
  fs.writeFileSync(
    clientFile,
    fs.readFileSync(clientFile, 'utf8').replace(
      '  adaptRequest(taskType, params, serverVersion, debugLogs, perCallToolSchemas) {',
      '  adaptRequest(taskType, params, serverVersion, debugLogs) {',
    ),
  );

  const result = runPatcher(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unexpected 13\.0\.0-rc\.20 SDK shape/);
  assert.equal(fs.readFileSync(taskMapFile, 'utf8'), taskMapBefore);
});

async function loadInstalledSingleAgentClients() {
  const cjsPath = path.resolve(__dirname, '..', SINGLE_AGENT_CLIENT_FILES[0]);
  const esmPath = path.resolve(__dirname, '..', SINGLE_AGENT_CLIENT_FILES[1]);
  return [
    require(cjsPath).SingleAgentClient,
    (await import(pathToFileURL(esmPath).href)).SingleAgentClient,
  ];
}

async function runScopedCapabilityCase(SingleAgentClient, supportedVersion, methodName) {
  const client = new SingleAgentClient({
    id: `scoped-${supportedVersion}`,
    name: `Scoped ${supportedVersion}`,
    agent_uri: 'https://agent.example/mcp',
    protocol: 'mcp',
  }, {
    transport: { fetchFn: async () => { throw new Error('unexpected network call'); } },
    validation: { requests: 'off', responses: 'off' },
    validateFeatures: false,
  });
  client.ensureEndpointDiscovered = async () => client.normalizedAgent;
  client.getAgentInfo = async () => ({
    tools: [
      { name: 'get_adcp_capabilities', inputSchema: { type: 'object', properties: {} } },
      {
        name: 'get_products',
        inputSchema: {
          type: 'object',
          properties: { buying_mode: { type: 'string' }, filters: { type: 'object' } },
        },
      },
    ],
  });
  let outbound;
  client.executor.executeTask = async (_agent, taskName, params) => {
    if (taskName === 'get_adcp_capabilities') {
      return {
        success: true,
        status: 'completed',
        data: {
          adcp: {
            major_versions: [3],
            supported_versions: [supportedVersion],
            build_version: supportedVersion === '3.1' ? '3.1.13' : '3.0.14',
          },
          supported_protocols: ['media_buy'],
        },
        metadata: { status: 'completed', taskName },
        debug_logs: [],
      };
    }
    outbound = params;
    return {
      success: true,
      status: 'completed',
      data: { products: [] },
      metadata: { status: 'completed', taskName },
      debug_logs: [],
    };
  };
  const result = await client[methodName]({
    buying_mode: 'wholesale',
    filters: { pricing_currencies: ['USD'] },
  });
  return { client, outbound, result };
}

test('installed SDK uses request-local scoped capabilities for get_products adaptation', async () => {
  for (const SingleAgentClient of await loadInstalledSingleAgentClients()) {
    for (const methodName of ['getProducts', 'getProductsLegacy']) {
      const v31 = await runScopedCapabilityCase(SingleAgentClient, '3.1', methodName);
      assert.deepEqual(v31.outbound.filters, { pricing_currencies: ['USD'] });
      assert.equal(
        v31.result.debug_logs?.some(log => log.type === 'pre31_pricing_currencies_stripped'),
        false,
      );
      assert.equal(v31.client.cachedCapabilities, undefined, 'scoped capabilities must remain request-local');
      assert.equal(v31.client.cachedToolSchemas, undefined, 'scoped tool schemas must remain request-local');

      const v30 = await runScopedCapabilityCase(SingleAgentClient, '3.0', methodName);
      assert.deepEqual(v30.outbound.filters, {});
      assert.equal(
        v30.result.debug_logs?.some(log => log.type === 'pre31_pricing_currencies_stripped'),
        true,
      );
      assert.equal(v30.client.cachedCapabilities, undefined, 'scoped capabilities must remain request-local');
      assert.equal(v30.client.cachedToolSchemas, undefined, 'scoped tool schemas must remain request-local');
    }
  }
});

test('installed 3.1 SDK accepts the additive flat advertiser natural-key response', async () => {
  const schemasPath = path.resolve(
    __dirname,
    '..',
    'node_modules/@adcp/sdk/dist/lib/types/schemas.generated.js',
  );
  const { SyncAccountsResponseSchema } = await import(pathToFileURL(schemasPath).href);
  const parsed = SyncAccountsResponseSchema.safeParse({
    status: 'completed',
    accounts: [{
      account_id: 'acc_nova_nl',
      brand: { domain: 'nova-athletics.example', countries: ['NL'] },
      operator: 'pinnacle-agency.example',
      operator_unit: { id: '234284238', name: 'EMEA' },
      currency: 'EUR',
      sandbox: true,
      action: 'created',
      status: 'active',
      billing: 'operator',
    }],
  });

  assert.equal(parsed.success, true, parsed.success ? undefined : parsed.error.toString());
});
