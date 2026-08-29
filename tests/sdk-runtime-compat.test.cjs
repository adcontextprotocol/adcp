const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

async function loadInstalledSingleAgentClients() {
  return [
    require('@adcp/sdk').SingleAgentClient,
    (await import('@adcp/sdk')).SingleAgentClient,
  ];
}

function trainingAgentAdcpVersion(constantName) {
  const source = fs.readFileSync(path.resolve(
    __dirname,
    '..',
    'server/src/training-agent/types.ts',
  ), 'utf8');
  const match = source.match(new RegExp(`${constantName}\\s*=\\s*'([^']+)'`));
  assert.ok(match, `${constantName} must remain an explicit release pin`);
  return match[1];
}

function installedSdkAdcpVersion() {
  return require('@adcp/sdk').ADCP_VERSION;
}

function canonicalAdcpVersion(version) {
  const match = version.match(/^(\d+)\.(\d+)(?:\.(\d+))?((?:-(?:beta|rc)\.\d+)?)$/);
  assert.ok(match, `invalid AdCP release version: ${version}`);
  return `${match[1]}.${match[2]}.${match[3] ?? '0'}${match[4]}`;
}

test('training-agent current AdCP version exactly matches the installed SDK schema release', async () => {
  const currentVersion = trainingAgentAdcpVersion('TRAINING_AGENT_CURRENT_ADCP_VERSION');
  const sdkVersion = installedSdkAdcpVersion();
  for (const sdk of [require('@adcp/sdk'), await import('@adcp/sdk')]) {
    const resolvedVersion = sdk.resolveAdcpVersion(currentVersion);
    assert.equal(
      canonicalAdcpVersion(resolvedVersion),
      canonicalAdcpVersion(sdkVersion),
      `training-agent current ${currentVersion} must track the installed SDK schema ${sdkVersion}`,
    );
    assert.ok(
      sdk.listBundledAdcpVersions().includes(resolvedVersion),
      `${currentVersion} must resolve to an installed SDK schema bundle`,
    );
  }
});

test('training agent registers its retained beta.6 release bundle', async () => {
  const retainedVersion = trainingAgentAdcpVersion('SELLER_GOVERNANCE_DISCOVERY_ADCP_VERSION');
  const schemaRoot = path.resolve(__dirname, '..', 'dist/schemas/3.2.0-beta.6');
  const cjsTesting = require('@adcp/sdk/testing');
  const esmTesting = await import('@adcp/sdk/testing');
  cjsTesting.registerExternalSchemaRoot(retainedVersion, schemaRoot);
  esmTesting.registerExternalSchemaRoot(retainedVersion, schemaRoot);

  assert.doesNotThrow(() => require('@adcp/sdk').resolveAdcpVersion(retainedVersion));
  const esmSdk = await import('@adcp/sdk');
  assert.doesNotThrow(() => esmSdk.resolveAdcpVersion(retainedVersion));
});

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
  const { SyncAccountsResponseSchema } = await import('@adcp/sdk/schemas');
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
