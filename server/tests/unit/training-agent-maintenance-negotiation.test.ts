import express from 'express';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import fixtureTestSdk from '@adcp-protocol/fixture-test-sdk/testing';

const token = 'maintenance-negotiation-test-token';
let server: Server;
let url: string;
let cleanup: () => void;
const productRequests: Record<string, unknown>[] = [];

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
    if (request.body?.method === 'tools/call' && request.body.params?.name === 'get_products') {
      productRequests.push(structuredClone(request.body.params.arguments));
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
