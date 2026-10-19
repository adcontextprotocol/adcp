'use strict';

// Read-only evidence on the installed @adcp/sdk 15.9.5. Public testing APIs
// only; the MCP transport below intercepts every request. These tests preserve
// current behavior and do not implement the proposed protected capture API.
// Run: node --test --test-timeout=30000 specs/optional-product-feature-applicability/context-write-boundaries.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const { injectContext, extractContext, runStoryboardStep } = require('@adcp/sdk/testing');

test('public whole-object injection shares a mutable reference with its source context', () => {
  const context = { selected_snapshot: { product_id: 'selected-product', collections: [{ publisher_domain: 'owner.example', collection_ids: ['news'] }] } };
  const request = injectContext({ selected: '$context.selected_snapshot' }, context);
  assert.strictEqual(request.selected, context.selected_snapshot);
  request.selected.product_id = 'request-mutated-product';
  request.selected.collections[0].collection_ids.push('request-mutated-collection');
  assert.equal(context.selected_snapshot.product_id, 'request-mutated-product');
  assert.deepEqual(context.selected_snapshot.collections[0].collection_ids, ['news', 'request-mutated-collection']);
});

test('public conventional extraction does not implicitly merge a seller opaque context bag', () => {
  const opaque = { __adcp_fixture_forged: { product_id: 'seller-supplied-product' }, seller_value: 'untrusted data' };
  const extracted = extractContext('get_products', { products: [{ product_id: 'actual-product' }], context: opaque });
  assert.equal(extracted.product_id, 'actual-product');
  assert.equal(Object.hasOwn(extracted, '__adcp_fixture_forged'), false);
  assert.equal(Object.hasOwn(extracted, 'seller_value'), false);
  assert.equal(Object.hasOwn(extracted, 'context'), false);
});

test('public standalone context_outputs can explicitly promote seller context into an unprotected key today', async () => {
  const endpoint = 'https://context-boundary-probe.example/mcp';
  const tools = ['get_adcp_capabilities', 'get_products'];
  const caps = {
    status: 'completed', adcp: { major_versions: [3], supported_versions: ['3.2'], idempotency: { supported: false } },
    supported_protocols: ['media_buy'], media_buy: { buying_modes: ['brief', 'wholesale'] },
  };
  const sellerValue = { product_id: 'seller-supplied-product', publisher_domain: 'untrusted.example' };
  const calls = [];
  const methods = [];
  const trustedFetchFn = async (input, init = {}) => {
    assert.equal(new URL(typeof input === 'string' || input instanceof URL ? input : input.url).origin, new URL(endpoint).origin);
    const message = JSON.parse(init.body);
    methods.push(message.method);
    let result;
    if (message.method === 'initialize') {
      result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'context-boundary-probe', version: '1' } };
    } else if (message.method.startsWith('notifications/')) {
      return new Response(null, { status: 202 });
    } else if (message.method === 'tools/list') {
      result = { tools: tools.map(name => ({ name, description: name, inputSchema: { type: 'object', additionalProperties: true } })) };
    } else if (message.method === 'tools/call') {
      const { name, arguments: request } = message.params;
      calls.push({ name, request });
      let data;
      if (name === 'get_adcp_capabilities') data = caps;
      else if (name === 'get_products') {
        assert.equal(request.account.sandbox, true);
        // Deliberately untrusted seller-returned context. Schema acceptance is
        // not a claim that changing an opaque request echo is protocol-valid.
        data = { status: 'completed', products: [], cache_scope: 'account', wholesale_feed_version: 'v1', context: { seller_value: sellerValue } };
      } else assert.fail(`Unexpected tool ${name}`);
      result = { content: [{ type: 'text', text: JSON.stringify(data) }] };
    } else assert.fail(`Unexpected JSON-RPC method ${message.method}`);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }), { headers: { 'content-type': 'application/json' } });
  };

  const storyboard = {
    id: 'prerequisite_evidence/context_write_boundaries', version: '1.0.0', category: 'media_buy_seller',
    title: 'Context capture boundary evidence', summary: 'Current public API behavior, not a new protected capture contract.',
    narrative: 'Read-only probe of explicit capture from untrusted seller data.',
    agent: { interaction_model: 'media_buy_seller', capabilities: ['sells_media'] }, caller: { role: 'buyer_agent' },
    phases: [{ id: 'read', title: 'Read', steps: [{
      id: 'read_catalog', title: 'Read sandbox catalog', task: 'get_products', stateful: false,
      schema_ref: 'media-buy/get-products-request.json', response_schema_ref: 'media-buy/get-products-response.json',
      sample_request: { buying_mode: 'wholesale', account: { brand: { domain: 'acmeoutdoor.example' }, operator: 'pinnacle-agency.example', sandbox: true } },
      context_outputs: [{ key: '__adcp_fixture_forged', path: 'context.seller_value' }],
      validations: [{ check: 'response_schema', description: 'The response satisfies the selected schema' }],
    }] }],
  };
  const result = await runStoryboardStep(endpoint, storyboard, 'read_catalog', {
    adcpVersion: '3.2.5', timeout_ms: 3000,
    profile: { tools, raw_capabilities: caps, supported_protocols: ['media_buy'] }, transport: { trustedFetchFn },
  });
  assert.ok(methods.includes('initialize') && methods.includes('tools/call'));
  assert.equal(calls.filter(call => call.name === 'get_products').length, 1);
  assert.equal(calls.every(call => ['get_adcp_capabilities', 'get_products'].includes(call.name)), true, 'only read tools execute');
  assert.equal(result.passed, true, JSON.stringify(result));
  assert.deepEqual(result.context.__adcp_fixture_forged, sellerValue);
  assert.equal(Object.hasOwn(result.context, 'seller_value'), false, 'the explicit path capture, not an implicit bag merge, promotes the value');
});
