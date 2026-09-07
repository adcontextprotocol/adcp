const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const semver = require('semver');
const test = require('node:test');

const CURRENT_SDK_CHECKPOINT_FILES = [
  'docs/building/by-layer/L4/choose-your-sdk.mdx',
  'docs/learning/supplements/buyer-briefs-and-get-products.mdx',
  'docs/learning/tracks/buyer.mdx',
  'docs/media-buy/product-discovery/proposal-negotiation.mdx',
  'docs/reference/3-2-beta.mdx',
  'docs/reference/migration/3-1-to-3-2.mdx',
  'docs/reference/release-notes.mdx',
  'docs/reference/versions.mdx',
  'docs/reference/whats-new-in-3-2.mdx',
  'server/src/addie/mcp/certification-tools.ts',
];

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

function sdkCheckpointVersions(source, expectedVersion) {
  const exactVersion = semver.parse(expectedVersion);
  assert.equal(exactVersion?.version, expectedVersion, 'current SDK checkpoint must remain an exact package version');
  const versionCore = `${exactVersion.major}.${exactVersion.minor}.${exactVersion.patch}`;
  const escapedVersionCore = versionCore.replaceAll('.', '\\.');
  const prereleaseChannel = exactVersion.prerelease.length > 0
    ? String(exactVersion.prerelease[0])
    : undefined;
  const semverBuild = String.raw`(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?`;
  const tokenStart = String.raw`(?<![0-9A-Za-z.+-])`;
  const tokenEnd = String.raw`(?![0-9A-Za-z.+-])`;
  const currentSdkVersionPattern = prereleaseChannel
    ? new RegExp(`${tokenStart}${escapedVersionCore}-${prereleaseChannel}(?:\\.[0-9A-Za-z-]+)*${semverBuild}${tokenEnd}`, 'g')
    : new RegExp(`${tokenStart}${escapedVersionCore}${semverBuild}${tokenEnd}`, 'g');
  return [...new Set(source.match(currentSdkVersionPattern) ?? [])];
}

test('SDK checkpoint matching compares complete SemVer tokens', () => {
  assert.deepEqual(
    sdkCheckpointVersions('114.0.0-rc.33 14.0.0-rc.33+build.1 14.0.0-rc.33', '14.0.0-rc.33'),
    ['14.0.0-rc.33+build.1', '14.0.0-rc.33'],
  );
  assert.deepEqual(
    sdkCheckpointVersions('114.0.0 14.0.0-rc.33 14.0.0+build.1 14.0.0', '14.0.0'),
    ['14.0.0+build.1', '14.0.0'],
  );
});

test('current exact SDK checkpoint references match package.json', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'));
  const expectedVersion = packageJson.dependencies['@adcp/sdk'];

  for (const relativePath of CURRENT_SDK_CHECKPOINT_FILES) {
    const source = fs.readFileSync(path.resolve(__dirname, '..', relativePath), 'utf8');
    const versions = sdkCheckpointVersions(source, expectedVersion);
    assert.deepEqual(versions, [expectedVersion], `${relativePath} must use the package.json SDK checkpoint`);
  }
});

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

test('installed SDK exposes legacy 3.0 schemas without cache staging', async () => {
  for (const sdk of [require('@adcp/sdk'), await import('@adcp/sdk')]) {
    assert.equal(sdk.resolveAdcpVersion('3.0'), '3.0');
    assert.ok(sdk.listBundledAdcpVersions().includes('3.0'));
  }
});

test('installed SDK accepts protocol macro-bearing URL strings', async () => {
  const macroUrl = 'https://daast.acme.example/tag.xml?cb=${CACHEBUSTER}&gdpr=[GDPR]';
  for (const schemas of [require('@adcp/sdk/schemas'), await import('@adcp/sdk/schemas')]) {
    const macroSchemas = Object.entries(schemas)
      .filter(([name]) => /^MacroBearingURL\d*Schema$/.test(name));
    assert.ok(macroSchemas.length > 0, 'expected public macro-bearing URL schemas');
    for (const [name, schema] of macroSchemas) {
      const parsed = schema.safeParse(macroUrl);
      assert.equal(parsed.success, true, `${name} rejected ${macroUrl}`);
    }
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
    transport: { trustedFetchFn: async () => { throw new Error('unexpected network call'); } },
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
