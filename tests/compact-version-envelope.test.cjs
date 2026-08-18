'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const { ProtocolClient } = require('@adcp/sdk');

const SOURCE_DIR = path.resolve(__dirname, '..', 'static', 'schemas', 'source');
const ADCP_VERSION = '3.2.0-beta.0';
const EXPECTED_ENVELOPE = {
  adcp_major_version: 3,
  adcp_version: '3.2-beta.0',
};

function readSchema(uri) {
  if (!uri.startsWith('/schemas/')) {
    throw new Error(`Cannot load external schema: ${uri}`);
  }
  return JSON.parse(fs.readFileSync(path.join(SOURCE_DIR, uri.slice('/schemas/'.length)), 'utf8'));
}

async function compileRequestSchema(tool) {
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    discriminator: true,
    loadSchema: async (uri) => readSchema(uri),
  });
  addFormats(ajv);
  return ajv.compileAsync(readSchema(`/schemas/media-buy/${tool.replaceAll('_', '-')}-request.json`));
}

const compactRequests = {
  list_products: {},
  request_proposals: {
    idempotency_key: 'request-proposals-envelope-0001',
    brand: { domain: 'nova-brands.example' },
    brief: 'Reach streaming audio listeners in Rome',
  },
  refine_proposals: {
    idempotency_key: 'refine-proposals-envelope-0001',
    refinements: [{ proposal_id: 'proposal-1', action: 'finalize' }],
  },
  decline_proposals: {
    idempotency_key: 'decline-proposals-envelope-0001',
    declines: [{ proposal_id: 'proposal-1', reason: 'inventory_fit' }],
  },
  buy_products: {
    idempotency_key: 'buy-products-envelope-0001',
    account: { account_id: 'account-1' },
    brand: { domain: 'nova-brands.example' },
    feed_version: 'feed-version-1',
    purchases: [{
      product_id: 'streaming-audio',
      pricing_option_id: 'fixed-cpm',
      budget: 50000,
    }],
    start_time: 'asap',
    end_time: '2027-07-01T00:00:00Z',
  },
  accept_proposal: {
    idempotency_key: 'accept-proposal-envelope-0001',
    account: { account_id: 'account-1' },
    proposal_id: 'proposal-1',
    proposal_terms_digest: `sha256:${'A'.repeat(43)}`,
  },
  control_media_buy: {
    idempotency_key: 'control-media-buy-envelope-0001',
    account: { account_id: 'account-1' },
    media_buy_id: 'media-buy-1',
    revision: 1,
    paused: true,
  },
};

test('SDK auto version envelope passes every strict compact lifecycle request schema', async () => {
  const validators = new Map(await Promise.all(
    Object.keys(compactRequests).map(async (tool) => [tool, await compileRequestSchema(tool)]),
  ));
  const outbound = new Map();
  const strictServer = {
    transport: {},
    getServerCapabilities: () => ({}),
    callTool: async ({ name, arguments: args }) => {
      const validate = validators.get(name);
      assert.ok(validate, `unexpected compact tool ${name}`);
      assert.equal(
        validate(args),
        true,
        `${name} rejected the SDK auto envelope: ${JSON.stringify(validate.errors)}`,
      );
      outbound.set(name, args);
      return { structuredContent: { status: 'completed' } };
    },
  };
  const agent = {
    id: 'strict-compact-server',
    name: 'Strict compact server',
    agent_uri: 'adcp-in-process://strict-compact-server',
    protocol: 'mcp',
    _inProcessMcpClient: strictServer,
  };

  for (const [tool, request] of Object.entries(compactRequests)) {
    await ProtocolClient.callTool(agent, tool, request, { adcpVersion: ADCP_VERSION });
    assert.deepEqual(
      {
        adcp_major_version: outbound.get(tool).adcp_major_version,
        adcp_version: outbound.get(tool).adcp_version,
      },
      EXPECTED_ENVELOPE,
      `${tool} did not receive the SDK's default auto envelope`,
    );
  }
});
