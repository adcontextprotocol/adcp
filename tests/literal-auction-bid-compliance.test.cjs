'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { z } = require('zod');
const { AgentClient } = require('@adcp/sdk');
const { loadStoryboardFile, runStoryboard } = require('@adcp/sdk/testing');

const sourceRoot = process.env.ADCP_COMPLIANCE_TEST_ROOT
  || path.join(__dirname, '..', 'static', 'compliance', 'source');
const files = [
  'protocols/media-buy/index.yaml',
  'protocols/media-buy/scenarios/audience_buy_flow.yaml',
  'protocols/media-buy/scenarios/completed_views_buy_flow.yaml',
  'protocols/media-buy/scenarios/reach_buy_flow.yaml',
  'protocols/media-buy/scenarios/dependency_impairment_audience.yaml',
];

test('literal auction buys reach pricing admission over official MCP without discovery context', async t => {
  const server = new McpServer({ name: 'auction-bid-admission', version: '1' });
  const receipts = [];
  let prices = [];
  server.registerTool('get_adcp_capabilities', { inputSchema: z.object({}).passthrough() }, async () => {
    const data = { status: 'completed', adcp: { major_versions: [3], supported_versions: ['3.3-beta.1'] }, supported_protocols: ['media_buy'] };
    return { structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] };
  });
  server.registerTool('create_media_buy', { inputSchema: z.object({}).passthrough() }, async request => {
    // This endpoint isolates auction pricing admission. The source's audience
    // and optimization-goal assertions have their own end-to-end scenarios.
    const admitted = request.packages.every(pkg => {
      const price = prices.find(price => price.product_id === pkg.product_id
        && price.pricing_option_id === pkg.pricing_option_id);
      return price && Number.isFinite(pkg.bid_price) && pkg.bid_price >= price.floor_price;
    });
    receipts.push({ request: structuredClone(request), admitted });
    const data = admitted
      ? { media_buy_id: 'auction-admitted', context: request.context }
      : { adcp_error: { code: 'INVALID_REQUEST', message: 'Auction bid is missing or below its floor.', recovery: 'correctable', field: 'packages.bid_price' } };
    return { structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] };
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const mcp = new Client({ name: 'storyboard-bid-buyer', version: '1' });
  await mcp.connect(clientTransport);
  t.after(async () => { await mcp.close(); await server.close(); });
  const buyer = AgentClient.fromMCPClient(mcp, {
    validateFeatures: false,
    validation: { requests: 'off', responses: 'off' },
  });
  let exercised = 0;
  for (const relative of files) {
    const source = loadStoryboardFile(path.join(sourceRoot, relative));
    prices = source.fixtures.pricing_options;
    const steps = source.phases.flatMap(phase => phase.steps).filter(step => step.task === 'create_media_buy'
      && step.sample_request?.packages?.every(pkg => prices.some(price => price.product_id === pkg.product_id
        && price.pricing_option_id === pkg.pricing_option_id && price.floor_price !== undefined)));
    assert.ok(steps.length > 0, `${source.id} supplies literal auction buys`);
    for (const authored of steps) {
      const storyboard = {
        id: source.id, version: source.version, title: source.title,
        phases: [{ id: 'wire_pricing', title: 'Wire pricing', steps: [{
          // The pricing-only endpoint succeeds after bid admission; keep a
          // negative case's audience/goal payload while isolating that prerequisite.
          ...authored, context_outputs: undefined, expect_error: undefined,
          validations: [{ check: 'field_present', path: 'media_buy_id', description: 'The request passed auction pricing admission' }],
        }] }],
      };
      const receiptCount = receipts.length;
      const result = await runStoryboard('https://auction-seller.example/mcp', storyboard, {
        context: { account_timezone: 'America/New_York' },
        agentTools: ['create_media_buy'], _profile: { tools: ['create_media_buy'] },
        _client: {
          resetContext: () => buyer.resetContext(),
          createMediaBuy: (...args) => buyer.createMediaBuy(...args),
          executeTask: (...args) => buyer.executeTask(...args),
        },
      });
      assert.equal(receipts.length, receiptCount + 1, JSON.stringify(result));
      const receipt = receipts.at(-1);
      assert.ok(receipt?.admitted, `${source.id}/${authored.id} must carry a valid bid on the actual MCP request: ${JSON.stringify(result)}`);
      assert.equal(result.overall_passed, true, JSON.stringify(result));
      assert.deepEqual(receipt.request.packages, authored.sample_request.packages,
        'pricing admission preserves the positive or deliberately invalid audience/goal payload');
      exercised++;
    }
  }
  assert.equal(exercised, 13, 'all positive and negative literal creates remain covered');
});
