import express from 'express';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import fixtureTestSdk from '@adcp-protocol/fixture-test-sdk/testing';
import { runStoryboard as runLegacyStoryboard } from '@adcp/sdk/testing';

const token = 'maintenance-negotiation-test-token';
let server: Server;
let url: string;
let cleanup: () => void;
const productRequests: Record<string, unknown>[] = [];
const wireRequests: Array<{ name: string; arguments: Record<string, unknown> }> = [];

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.PUBLIC_TEST_AGENT_TOKEN = token;
  const { createTrainingAgentRouter } = await import('../../src/training-agent/index.js');
  const { stopSessionCleanup, clearSessions } = await import('../../src/training-agent/state.js');
  const { clearAccountStore } = await import('../../src/training-agent/account-handlers.js');
  cleanup = () => { stopSessionCleanup(); clearSessions(); clearAccountStore(); };
  const app = express();
  app.use(express.json({ verify: (request, _response, bytes) => {
    (request as typeof request & { rawBody?: string }).rawBody = bytes.toString('utf8');
  } }));
  app.use((request, _response, next) => {
    if (request.body?.method === 'tools/call') {
      wireRequests.push(structuredClone(request.body.params));
    }
    if (request.body?.method === 'tools/call' && request.body.params?.name === 'get_products') {
      productRequests.push(structuredClone(request.body.params.arguments));
    }
    next();
  });
  app.use((request, response, next) => {
    const { name, arguments: args } = request.body?.params ?? {};
    if (name === 'get_products' && args?.buying_mode === 'wholesale' && args.brief !== undefined) {
      // Exercise a strict seller's normative 3.1 mode boundary. The schema's
      // description forbids brief on wholesale reads even on older bundles
      // whose structural validator alone does not enforce that condition.
      response.json({ jsonrpc: '2.0', id: request.body.id, result: {
        isError: true, content: [{ type: 'text', text: JSON.stringify({ adcp_error: {
          code: 'INVALID_REQUEST', field: 'brief', message: 'brief is forbidden for wholesale discovery',
        } }) }],
      } });
      return;
    }
    next();
  });
  app.use('/api/training-agent', createTrainingAgentRouter());
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Local test server has no TCP address');
  url = `http://127.0.0.1:${address.port}/api/training-agent/sales/mcp`;
});

afterAll(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  cleanup?.();
});

it('a published modern SDK keeps a 3.1.30 seller request on stable 3.1 and validates its inline cards', async () => {
  const account = { brand: { domain: 'acmeoutdoor.example' }, operator: 'pinnacle-agency.example', sandbox: true };
  const storyboard = {
    id: 'maintenance/stable_seller_negotiation', title: 'Stable seller negotiation',
    version: '1.0.0', category: 'media_buy_seller', track: 'products',
    phases: [{ id: 'read', title: 'Read the current seller contract', steps: [
      { id: 'account', title: 'Establish the sandbox account', task: 'sync_accounts', stateful: true,
        sample_request: { accounts: [{ ...account, billing: 'operator' }] },
        validations: [{ check: 'response_schema' }, { check: 'field_present', path: 'accounts[0].account_id' }] },
      { id: 'products', title: 'Read stable product cards', task: 'get_products', stateful: true,
        sample_request: { buying_mode: 'wholesale', account },
        validations: [{ check: 'response_schema' }, { check: 'field_present', path: 'products[0].product_card.title' }] },
    ] }],
  };
  const result = await fixtureTestSdk.runStoryboard(url, storyboard, {
    protocol: 'mcp', allow_http: true, auth: { type: 'bearer', token },
    adcpVersion: '3.1.30', schemaRoot: fileURLToPath(new URL('../../../dist/schemas/3.1.30', import.meta.url)),
  });
  expect(result.overall_passed, JSON.stringify(result)).toBe(true);
  expect(productRequests.length).toBeGreaterThan(0);
  expect(productRequests.every(request => request.adcp_version === '3.1')).toBe(true);
  const products = result.phases.flatMap((phase: { steps: Array<{ step_id: string; response?: unknown }> }) => phase.steps)
    .find((step: { step_id: string }) => step.step_id === 'products');
  expect(products?.response).toMatchObject({ adcp_version: '3.1' });
  const response = products?.response as { products: Array<{ product_card: { title: string } }> };
  expect(response.products[0].product_card.title).toEqual(expect.any(String));
});

it('discovers seeded auctions and preserves accepted bids through a budget-only update over MCP', async () => {
  const storyboard = fixtureTestSdk.parseStoryboard(readFileSync(fileURLToPath(new URL(
    '../../../static/compliance/source/specialisms/sales-non-guaranteed/index.yaml', import.meta.url,
  )), 'utf8'));
  const start = wireRequests.length;
  const result = await fixtureTestSdk.runStoryboard(url, storyboard, {
    protocol: 'mcp', allow_http: true, auth: { type: 'bearer', token },
    adcpVersion: '3.1.31', schemaRoot: fileURLToPath(new URL('../../../dist/schemas/3.1.31', import.meta.url)),
  });
  const failures = result.phases.flatMap(phase => phase.steps)
    .filter(step => !step.passed || step.skipped)
    .map(step => ({ id: step.step_id, error: step.error,
      validations: step.validations?.filter(validation => !validation.passed)
        .map(validation => ({ check: validation.check, path: validation.path, description: validation.description })) }));
  expect(result.overall_passed, JSON.stringify(failures)).toBe(true);
  expect(result.failed_count).toBe(0);
  expect(result.skipped_count).toBe(0);

  const calls = wireRequests.slice(start);
  const account = storyboard.context.account;
  const seeds = calls.filter(call => call.name === 'comply_test_controller'
    && ['seed_product', 'seed_pricing_option'].includes(String(call.arguments.scenario)));
  expect(seeds).toHaveLength(4);
  for (const call of seeds) expect(call.arguments.account).toEqual(account);
  const discovery = calls.find(call => call.name === 'get_products');
  const create = calls.find(call => call.name === 'create_media_buy');
  const update = calls.find(call => call.name === 'update_media_buy');
  expect(discovery?.arguments.buying_mode).toBe('wholesale');
  expect(discovery?.arguments).not.toHaveProperty('brief');
  for (const call of [discovery, create, update]) {
    expect(call?.arguments.account).toEqual(account);
    expect(call?.arguments.adcp_version).toBe('3.1');
  }
  expect(create?.arguments.packages).toEqual([
    expect.objectContaining({ product_id: 'sports_display_auction', bid_price: 6, budget: 10000 }),
    expect.objectContaining({ product_id: 'outdoor_video_auction', bid_price: 16, budget: 15000 }),
  ]);
  expect(update?.arguments.packages).toEqual([
    expect.objectContaining({ budget: 12000 }), expect.objectContaining({ budget: 13000 }),
  ]);
  for (const pkg of update?.arguments.packages as Record<string, unknown>[]) {
    expect(pkg).not.toHaveProperty('bid_price');
  }
  const updated = result.phases.flatMap(phase => phase.steps).find(step => step.step_id === 'update_media_buy');
  expect(updated?.response).toMatchObject({ affected_packages: [
    { product_id: 'sports_display_auction', bid_price: 6, budget: 12000 },
    { product_id: 'outdoor_video_auction', bid_price: 16, budget: 13000 },
  ] });
});

it('the legacy SDK sends a forbidden wholesale brief over MCP and stops later auction mutations on refusal', async () => {
  const storyboard = fixtureTestSdk.parseStoryboard(readFileSync(fileURLToPath(new URL(
    '../../../static/compliance/source/specialisms/sales-non-guaranteed/index.yaml', import.meta.url,
  )), 'utf8'));
  // Isolate the actual client request from controller preflight, which is
  // independently covered by the complete modern-runner lifecycle above.
  delete storyboard.prerequisites;
  delete storyboard.fixtures;
  delete storyboard.invariants;
  const ids = ['get_products_brief', 'create_media_buy', 'update_media_buy'];
  storyboard.phases = storyboard.phases.map(phase => ({
    ...phase, steps: phase.steps.filter(step => ids.includes(step.id)),
  })).filter(phase => phase.steps.length > 0);
  const start = wireRequests.length;
  const result = await runLegacyStoryboard(url, storyboard, {
    protocol: 'mcp', allow_http: true, auth: { type: 'bearer', token },
    brand: { domain: 'acmeoutdoor.example' }, adcpVersion: '3.1.31',
    schemaRoot: fileURLToPath(new URL('../../../dist/schemas/3.1.31', import.meta.url)),
  });
  const calls = wireRequests.slice(start);
  const discovery = calls.find(call => call.name === 'get_products');
  expect(discovery?.arguments).toMatchObject({ buying_mode: 'wholesale', brief: expect.any(String) });
  expect(result.overall_passed).toBe(false);
  expect(result.failed_count).toBe(1);
  expect(result.skipped_count).toBe(2);
  expect(calls.some(call => ['create_media_buy', 'update_media_buy'].includes(call.name))).toBe(false);
});
