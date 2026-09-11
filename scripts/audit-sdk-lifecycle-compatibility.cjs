#!/usr/bin/env node

// Read-only boundary probes for the installed TypeScript SDK. Agent methods are
// replaced with local fixtures; no network request or real purchase is made.
// Run: node scripts/audit-sdk-lifecycle-compatibility.cjs [installed-sdk-directory]
// This reports observed behavior, including current limitations. It is not a
// conformance test or an assertion that those limitations should be permanent.

process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const sdkRoot = process.argv[2] && path.resolve(process.argv[2]);
const sdkRequire = sdkRoot ? createRequire(path.join(sdkRoot, 'package.json')) : require;
const { AgentClient } = sdkRequire('@adcp/sdk');
const packagePath = sdkRoot
  ? path.join(sdkRoot, 'package.json')
  : require.resolve('@adcp/sdk/package.json');
const packageVersion = JSON.parse(fs.readFileSync(packagePath, 'utf8')).version;

const ACCOUNT = { account_id: 'audit-account' };
const BRAND = { domain: 'acmeoutdoor.example' };
const observations = [];

async function routingMatrix() {
  // The low-level server entry is useful for wire fixtures. New seller
  // applications use createAdcpServerFromPlatform from @adcp/sdk/server.
  const { createAdcpServer } = sdkRequire('@adcp/sdk/server/legacy/v5');
  const { createIdempotencyStore, memoryBackend } = sdkRequire('@adcp/sdk/server');
  const { Client } = sdkRequire('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = sdkRequire('@modelcontextprotocol/sdk/inMemory.js');
  const latestSchemas = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'dist', 'schemas', 'latest.json'), 'utf8'));
  const versions = ['3.0.25', latestSchemas.latest_stable, '3.2.0-rc.1'];
  const rows = [];
  for (const buyerVersion of versions) {
    for (const [index, sellerVersion] of versions.entries()) {
      const calls = [];
      const server = createAdcpServer({
        name: 'audit-seller', version: '1.0.0', adcpVersion: sellerVersion,
        capabilities: { supported_versions: versions.slice(0, index + 1) },
        idempotency: createIdempotencyStore({ backend: memoryBackend({ sweepIntervalMs: 0 }) }),
        resolveSessionKey: () => 'audit-session',
        validation: { requests: 'strict', responses: 'off' },
        mediaBuy: {
          getProducts: async (params, ctx) => {
            calls.push({ tool: 'get_products', requestedVersion: params.adcp_version ?? null,
              servedVersion: ctx.servedAdcpVersion });
            return { products: [], cache_scope: 'public' };
          },
          ...(index === 2 && { listProducts: async (params, ctx) => {
            calls.push({ tool: 'list_products', requestedVersion: params.adcp_version ?? null,
              servedVersion: ctx.servedAdcpVersion });
            return { outcome: 'listed', products: [], feed_version: 'seller-feed-1', cache_scope: 'public' };
          } }),
        },
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const mcpClient = new Client({ name: 'audit-buyer', version: '1.0.0' });
      let coordinator;
      let phase = 'connect';
      try {
        await Promise.all([mcpClient.connect(clientTransport), server.connect(serverTransport)]);
        const buyer = AgentClient.fromMCPClient(mcpClient, {
          adcpVersion: buyerVersion, validation: { requests: 'strict', responses: 'off' },
        });
        phase = 'negotiate';
        let result;
        if (buyerVersion.startsWith('3.2')) {
          coordinator = await buyer.negotiateMediaBuyLifecycle();
          phase = 'list';
          result = await coordinator.listProducts({ max_results: 1 });
        } else {
          phase = 'get_products';
          result = await buyer.getProducts({ buying_mode: 'wholesale' });
        }
        rows.push({ buyerVersion, sellerVersion, status: result.status,
          negotiatedVersion: coordinator?.negotiated_version,
          ...(result.error && { error: result.error }), calls });
      } catch (error) {
        rows.push({ buyerVersion, sellerVersion, status: 'error', phase,
          code: error.code, message: error.message, calls });
      } finally {
        coordinator?.dispose();
        await Promise.allSettled([mcpClient.close(), server.close()]);
      }
    }
  }
  return rows;
}

function completed(tool, data) {
  return {
    success: true,
    status: 'completed',
    data,
    metadata: {
      taskId: `audit-${tool}`,
      taskName: tool,
      agent: { id: 'audit-seller', name: 'Audit seller', protocol: 'mcp' },
      responseTimeMs: 0,
      timestamp: new Date().toISOString(),
      clarificationRounds: 0,
      status: 'completed',
    },
  };
}

function makeAgent(version, { feed = false, versionMetadata = true } = {}) {
  const calls = [];
  const agent = new AgentClient(
    { id: 'audit-seller', name: 'Audit seller', agent_uri: 'https://seller.example/mcp', protocol: 'mcp' },
    { adcpVersion: '3.2.0-rc.1', validateFeatures: false }
  );
  agent.getCapabilities = async () => ({
    version: 'v3',
    majorVersions: [3],
    ...(versionMetadata && { supportedVersions: [version] }),
    protocols: ['media_buy'],
    features: {},
    extensions: [],
    idempotency: { replayTtlSeconds: 3600 },
    _synthetic: false,
  });
  agent.getProducts = async params => {
    calls.push({ tool: 'get_products', params: structuredClone(params) });
    return completed('get_products', {
      products: [{ product_id: 'display-1', name: 'Display inventory' }],
      cache_scope: 'account',
      ...(feed && { wholesale_feed_version: 'seller-feed-1', pricing_version: 'seller-price-1' }),
    });
  };
  agent.createMediaBuy = async params => {
    calls.push({ tool: 'create_media_buy', params: structuredClone(params) });
    return completed('create_media_buy', {
      media_buy_id: 'audit-buy', confirmed_at: '2098-12-31T12:00:00Z', revision: 1,
      packages: [{ package_id: 'audit-package' }],
    });
  };
  return { agent, calls };
}

async function observe(name, fixture, run, options = {}) {
  const coordinator = await fixture.agent.negotiateMediaBuyLifecycle({
    legacyPurchaseSellerSessionScope: 'audit-session',
    ...options,
  });
  const initialCalls = fixture.calls.length;
  try {
    const result = await run(coordinator);
    observations.push({
      name, negotiatedVersion: coordinator.negotiated_version, status: result.status,
      tools: fixture.calls.slice(initialCalls).map(call => call.tool),
      feedVersionPresent: Object.hasOwn(result.data ?? {}, 'feed_version'),
      losses: result.compatibility?.losses ?? [],
    });
  } catch (error) {
    // Unexpected harness/runtime failures must fail the script, not masquerade
    // as an intentional preflight rejection in the audit report.
    if (error.code !== 'UNSUPPORTED_FEATURE') throw error;
    observations.push({
      name, negotiatedVersion: coordinator.negotiated_version, status: 'unsupported',
      feature: error.feature, losses: error.losses ?? [],
      tools: fixture.calls.slice(initialCalls).map(call => call.tool),
    });
  } finally {
    coordinator.dispose();
  }
}

async function main() {
  for (const version of ['3.0', '3.1']) {
    await observe(`${version}: ordinary listing without feed metadata`, makeAgent(version),
      coordinator => coordinator.listProducts({ account: ACCOUNT, max_results: 1 }));
    await observe(`${version}: listing with country coverage`, makeAgent(version),
      coordinator => coordinator.listProducts({
        account: ACCOUNT, criteria: { offer_filters: { countries: ['US'] } }, max_results: 1,
      }));
    await observe(`${version}: brief with the same country coverage`, makeAgent(version),
      coordinator => coordinator.requestProposals({
        account: ACCOUNT, brand: BRAND, brief: 'Display campaign',
        criteria: { offer_filters: { countries: ['US'] } },
      }));

    const purchase = {
      idempotency_key: `audit-purchase-${version}-0001`, account: ACCOUNT, brand: BRAND,
      purchases: [{ product_id: 'display-1', pricing_option_id: 'fixed-cpm', budget: 1000 }],
      start_time: '2099-01-01T00:00:00Z', end_time: '2099-02-01T00:00:00Z',
    };
    const policy = { allowedLosses: ['feed_version_not_atomic', 'pricing_version_not_atomic'] };
    await observe(`${version}: purchase without feed token, losses accepted`, makeAgent(version),
      coordinator => coordinator.buyProducts(purchase), policy);

    if (version === '3.1') {
      const fixture = makeAgent(version, { feed: true });
      // Source tokens from the fixture's actual listing, rather than inventing
      // a token merely to get the purchase adapter past preflight.
      const listed = await fixture.agent.getProducts({ buying_mode: 'wholesale', account: ACCOUNT });
      const fenced = { ...purchase, feed_version: listed.data.wholesale_feed_version,
        pricing_version: listed.data.pricing_version };
      await observe('3.1: observed feed, default loss policy', fixture,
        coordinator => coordinator.buyProducts(fenced));
      await observe('3.1: observed feed, losses accepted', fixture,
        coordinator => coordinator.buyProducts(fenced), policy);
      const dispatched = fixture.calls.find(call => call.tool === 'create_media_buy');
      assert.ok(dispatched, 'create_media_buy was not dispatched — regression in legacy purchase path');
      assert.equal(dispatched.params.idempotency_key, purchase.idempotency_key);
      assert.equal(dispatched.params.feed_version, undefined);
      assert.equal(dispatched.params.packages[0].budget, 1000);
    }
  }
  await observe('v3 capabilities without release metadata', makeAgent('3.0', { versionMetadata: false }),
    coordinator => coordinator.listProducts({ account: ACCOUNT, max_results: 1 }));
  const routing = await routingMatrix();
  console.log(JSON.stringify({ sdk: `@adcp/sdk@${packageVersion}`,
    scope: 'Boundary fixtures plus in-memory MCP discovery routing. All peers use the audited SDK with different wire pins; these are not archived buyer implementations or production sellers.',
    observations, routing }, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
