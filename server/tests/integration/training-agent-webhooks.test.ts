/**
 * End-to-end webhook emission for the training agent.
 *
 * Spins up an ephemeral HTTP receiver, posts a mutating tool request with
 * `push_notification_config.url` set to the receiver, and asserts the
 * training agent delivers a signed MCP webhook envelope with a stable
 * idempotency_key.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { Response as SupertestResponse } from 'supertest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { verifyWebhookSignature, StaticJwksResolver, InMemoryReplayStore, InMemoryRevocationStore } from '@adcp/sdk/signing';
import type { AdcpJsonWebKey } from '@adcp/sdk/signing';
import { buildCatalog } from '../../src/training-agent/product-factory.js';

vi.hoisted(() => {
  process.env.PUBLIC_TEST_AGENT_TOKEN = 'test-token-webhook';
});

vi.mock('../../src/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
}));

const { createTrainingAgentRouter } = await import('../../src/training-agent/index.js');
const { stopSessionCleanup, clearSessions } = await import('../../src/training-agent/state.js');
const { clearAccountStore } = await import('../../src/training-agent/account-handlers.js');
const { resetWebhookSigning, getPublicJwks } = await import('../../src/training-agent/webhooks.js');

const AUTH = 'Bearer test-token-webhook';
const BILLABLE_AUTH = 'Bearer demo-billing-agent-billable-v1';
const OTHER_BILLABLE_AUTH = 'Bearer demo-billing-agent-billable-v2';

interface CapturedDelivery {
  headers: http.IncomingHttpHeaders;
  body: string;
  url: string;
}

function startReceiver(handle: (delivery: CapturedDelivery, res: http.ServerResponse) => void): Promise<http.Server> {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        const host = req.headers.host ?? '127.0.0.1';
        handle({ headers: req.headers, body, url: `http://${host}${req.url ?? ''}` }, res);
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function structuredToolResult(response: SupertestResponse): Record<string, unknown> {
  const result = response.body?.result as { structuredContent?: unknown; content?: Array<{ text?: string }> } | undefined;
  if (result?.structuredContent && typeof result.structuredContent === 'object') {
    return result.structuredContent as Record<string, unknown>;
  }
  const text = result?.content?.[0]?.text;
  return text ? JSON.parse(text) as Record<string, unknown> : {};
}

describe('Training Agent webhook emission', () => {
  let app: express.Application;

  beforeAll(() => {
    resetWebhookSigning(); // fresh key for this test run
    app = express();
    app.use(express.json());
    app.use('/api/training-agent', createTrainingAgentRouter());
  });

  beforeEach(async () => {
    await clearSessions();
    clearAccountStore();
  });

  afterAll(() => {
    stopSessionCleanup();
    resetWebhookSigning();
  });

  it('delivers a signed completion webhook when push_notification_config.url is set', async () => {
    const deliveries: CapturedDelivery[] = [];
    let srv: http.Server | undefined;
    try {
      const done = new Promise<void>(resolve => {
        startReceiver((d, res) => {
          deliveries.push(d);
          res.writeHead(200); res.end();
          resolve();
        }).then(s => {
          srv = s;
          const addr = s.address() as AddressInfo;
          const webhookUrl = `http://127.0.0.1:${addr.port}/hook/create_media_buy`;
          const catalog = buildCatalog();
          const product = catalog[0].product as { product_id: string; pricing_options: Array<{ pricing_option_id: string }> };
          return request(app)
            .post('/api/training-agent/sales/mcp')
            .set('Authorization', AUTH)
            .set('Content-Type', 'application/json')
            .set('Accept', 'application/json, text/event-stream')
            .send({
              jsonrpc: '2.0',
              id: 1,
              method: 'tools/call',
              params: {
                name: 'create_media_buy',
                arguments: {
                  idempotency_key: randomUUID(),
                  adcp_major_version: 3,
                  account: { brand: { domain: 'webhook-test.example' }, operator: 'webhook-test.example' },
                  brand: { domain: 'webhook-test.example' },
                  start_time: '2027-06-01T00:00:00Z',
                  end_time: '2027-07-01T00:00:00Z',
                  packages: [{
                    product_id: product.product_id,
                    pricing_option_id: product.pricing_options[0].pricing_option_id,
                    budget: 50000,
                    start_time: '2027-06-01T00:00:00Z',
                    end_time: '2027-07-01T00:00:00Z',
                  }],
                  push_notification_config: { url: webhookUrl },
                },
              },
            });
        });
      });

      await Promise.race([
        done,
        new Promise((_, reject) => setTimeout(() => reject(new Error('webhook never arrived')), 5000)),
      ]);

      expect(deliveries.length).toBe(1);
      const delivery = deliveries[0];
      const body = JSON.parse(delivery.body) as Record<string, unknown>;
      expect(body.task_id).toBeDefined();
      expect(body.operation_id).toBeDefined();
      expect(body.task_type).toBe('create_media_buy');
      expect(body.status).toBe('completed');
      expect(body.idempotency_key).toMatch(/^[A-Za-z0-9_.:-]{16,255}$/);
      expect(delivery.headers['signature-input']).toBeDefined();
      expect(delivery.headers['signature']).toBeDefined();
      expect(delivery.headers['content-digest']).toBeDefined();

      const jwks = getPublicJwks();
      const jwksResolver = new StaticJwksResolver(jwks.keys as AdcpJsonWebKey[]);
      await expect(verifyWebhookSignature({
        method: 'POST',
        url: delivery.url,
        headers: delivery.headers as Record<string, string>,
        body: delivery.body,
      }, {
        jwks: jwksResolver,
        replayStore: new InMemoryReplayStore(),
        revocationStore: new InMemoryRevocationStore(),
      })).resolves.toMatchObject({ keyid: expect.any(String) });
    } finally {
      if (srv) {
        srv.closeAllConnections?.();
        await new Promise<void>(r => srv!.close(() => r()));
      }
    }
  }, 15000);

  it('publishes its webhook-signing public key at /.well-known/jwks.json', async () => {
    const response = await request(app).get('/api/training-agent/.well-known/jwks.json');
    expect(response.status).toBe(200);
    const jwks = response.body as { keys: AdcpJsonWebKey[] };
    expect(Array.isArray(jwks.keys)).toBe(true);
    expect(jwks.keys.length).toBeGreaterThan(0);
    const key = jwks.keys[0];
    expect(key.adcp_use).toBe('webhook-signing');
    expect(key.key_ops).toContain('verify');
    expect(key.kid).toBeTruthy();
    expect(key.d).toBeUndefined(); // never publish the private scalar
  });

  it('does not emit when push_notification_config is absent', async () => {
    // Nothing to receive — just verify the MCP call succeeds without webhook plumbing.
    const response = await request(app)
      .post('/api/training-agent/sales/mcp')
      .set('Authorization', AUTH)
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: {
          name: 'create_media_buy',
          arguments: {
            idempotency_key: randomUUID(),
            adcp_major_version: 3,
            account: { account_id: 'acct_no_webhook' },
            buyer_ref: 'test_buyer_002',
            total_budget: { amount: 500, currency: 'USD' },
            start_time: '2026-05-01T00:00:00Z',
            end_time: '2026-05-08T00:00:00Z',
            packages: [],
          },
        },
      });
    expect(response.status).toBe(200);
  });

  it('delivers account-level creative lifecycle webhooks registered through sync_accounts', async () => {
    const deliveries: CapturedDelivery[] = [];
    let srv: http.Server | undefined;
    try {
      let resolveDelivery: (() => void) | undefined;
      const done = new Promise<void>(resolve => {
        resolveDelivery = resolve;
      });
      srv = await startReceiver((d, res) => {
        deliveries.push(d);
        res.writeHead(200); res.end();
        resolveDelivery?.();
      });
      const addr = srv.address() as AddressInfo;
      const webhookUrl = `http://127.0.0.1:${addr.port}/hook/creative-lifecycle`;
      const callTool = async (id: number, name: string, args: Record<string, unknown>) => {
        const response = await request(app)
          .post('/api/training-agent/sales/mcp')
          .set('Authorization', BILLABLE_AUTH)
          .set('Content-Type', 'application/json')
          .set('Accept', 'application/json, text/event-stream')
          .send({
            jsonrpc: '2.0',
            id,
            method: 'tools/call',
            params: { name, arguments: args },
          });
        expect(response.status).toBe(200);
        expect(response.text).not.toContain('"isError":true');
        return response;
      };

      const account = { brand: { domain: 'creative-lifecycle.example' }, operator: 'pinnacle-agency.example' };

      await callTool(10, 'sync_accounts', {
        idempotency_key: randomUUID(),
        accounts: [{
          brand: account.brand,
          operator: account.operator,
          billing: 'operator',
          sandbox: true,
          notification_configs: [{
            subscriber_id: 'buyer-primary',
            url: webhookUrl,
            event_types: ['creative.status_changed', 'creative.purged'],
            active: true,
          }],
        }],
      });

      await callTool(11, 'sync_creatives', {
        idempotency_key: randomUUID(),
        account,
        creatives: [{
          creative_id: 'creative_lifecycle_webhook_test',
          name: 'Creative lifecycle webhook test',
          format_id: { agent_url: 'https://creative.example.com', id: 'display_300x250' },
          assets: {
            image: {
              asset_type: 'image',
              url: 'https://assets.example.com/creative.png',
              width: 300,
              height: 250,
              mime_type: 'image/png',
            },
          },
        }],
      });

      await callTool(12, 'comply_test_controller', {
        account: { sandbox: true },
        brand: account.brand,
        scenario: 'force_creative_status',
        params: {
          creative_id: 'creative_lifecycle_webhook_test',
          status: 'rejected',
          rejection_reason: 'Integration test forced revocation',
        },
      });

      await Promise.race([
        done,
        new Promise((_, reject) => setTimeout(() => reject(new Error('creative lifecycle webhook never arrived')), 5000)),
      ]);

      expect(deliveries.length).toBe(1);
      const body = JSON.parse(deliveries[0].body) as Record<string, unknown>;
      expect(body.notification_type).toBe('creative.status_changed');
      expect(body.creative_id).toBe('creative_lifecycle_webhook_test');
      expect(body.subscriber_id).toBe('buyer-primary');
      expect(body.idempotency_key).toMatch(/^[A-Za-z0-9_.:-]{16,255}$/);
      expect(body.notification_id).toBeTruthy();
      expect(body.transition).toMatchObject({ from: 'approved', to: 'rejected' });

      const beforeResync = structuredToolResult(await callTool(13, 'list_creatives', {
        account,
        creative_ids: ['creative_lifecycle_webhook_test'],
        include_webhook_activity: true,
      }));
      const beforeCreative = (beforeResync.creatives as Array<Record<string, unknown>>)[0];
      expect(beforeCreative.webhook_activity).toHaveLength(1);

      await callTool(14, 'sync_creatives', {
        idempotency_key: randomUUID(),
        account,
        creatives: [{
          creative_id: 'creative_lifecycle_webhook_test',
          name: 'Creative lifecycle webhook test resynced',
          format_id: { agent_url: 'https://creative.example.com', id: 'display_300x250' },
          assets: {
            image: {
              asset_type: 'image',
              url: 'https://assets.example.com/creative-v2.png',
              width: 300,
              height: 250,
              mime_type: 'image/png',
            },
          },
        }],
      });

      const afterResync = structuredToolResult(await callTool(15, 'list_creatives', {
        account,
        creative_ids: ['creative_lifecycle_webhook_test'],
        include_webhook_activity: true,
      }));
      const afterCreative = (afterResync.creatives as Array<Record<string, unknown>>)[0];
      expect(afterCreative.webhook_activity).toHaveLength(1);
    } finally {
      if (srv) {
        srv.closeAllConnections?.();
        await new Promise<void>(r => srv!.close(() => r()));
      }
    }
  }, 15000);

  it('sends account-level creative lifecycle webhooks only to the owning account subscriber', async () => {
    const deliveries: CapturedDelivery[] = [];
    let srv: http.Server | undefined;
    try {
      srv = await startReceiver((d, res) => {
        deliveries.push(d);
        res.writeHead(200); res.end();
      });
      const addr = srv.address() as AddressInfo;
      const baseUrl = `http://127.0.0.1:${addr.port}`;
      const callTool = async (id: number, name: string, args: Record<string, unknown>, auth = BILLABLE_AUTH) => {
        const response = await request(app)
          .post('/api/training-agent/sales/mcp')
          .set('Authorization', auth)
          .set('Content-Type', 'application/json')
          .set('Accept', 'application/json, text/event-stream')
          .send({
            jsonrpc: '2.0',
            id,
            method: 'tools/call',
            params: { name, arguments: args },
          });
        expect(response.status).toBe(200);
        expect(response.text).not.toContain('"isError":true');
        return response;
      };

      const brand = { domain: 'creative-lifecycle-scoped.example' };
      await callTool(20, 'sync_accounts', {
        idempotency_key: randomUUID(),
        accounts: [
          {
            brand,
            operator: 'agency-one.example',
            billing: 'operator',
            sandbox: true,
            notification_configs: [{
              subscriber_id: 'owner',
              url: `${baseUrl}/hook/owner?token=secret`,
              event_types: ['creative.status_changed'],
              active: true,
            }],
          },
          {
            brand,
            operator: 'agency-two.example',
            billing: 'operator',
            sandbox: true,
            notification_configs: [{
              subscriber_id: 'other',
              url: `${baseUrl}/hook/other`,
              event_types: ['creative.status_changed'],
              active: true,
            }],
          },
        ],
      });

      await callTool(21, 'sync_creatives', {
        idempotency_key: randomUUID(),
        account: { brand, operator: 'agency-one.example' },
        creatives: [{
          creative_id: 'creative_lifecycle_scoped_test',
          name: 'Creative lifecycle scoped test',
          format_id: { agent_url: 'https://creative.example.com', id: 'display_300x250' },
          assets: { image: { asset_type: 'image', url: 'https://assets.example.com/creative.png' } },
        }],
      });

      await callTool(22, 'comply_test_controller', {
        account: { sandbox: true },
        brand,
        scenario: 'force_creative_status',
        params: {
          creative_id: 'creative_lifecycle_scoped_test',
          status: 'rejected',
          rejection_reason: 'Integration test forced revocation',
        },
      });

      expect(deliveries.map(d => d.url.replace(baseUrl, ''))).toEqual(['/hook/owner?token=secret']);
      const body = JSON.parse(deliveries[0].body) as Record<string, unknown>;
      expect(body.subscriber_id).toBe('owner');

      const ownerList = structuredToolResult(await callTool(23, 'list_creatives', {
        account: { brand, operator: 'agency-one.example' },
        creative_ids: ['creative_lifecycle_scoped_test'],
        include_webhook_activity: true,
      }));
      const ownerCreative = (ownerList.creatives as Array<Record<string, unknown>>)[0];
      expect(ownerCreative.webhook_activity).toHaveLength(1);

      const otherList = structuredToolResult(await callTool(24, 'list_creatives', {
        account: { brand, operator: 'agency-two.example' },
        creative_ids: ['creative_lifecycle_scoped_test'],
        include_webhook_activity: true,
      }));
      expect(otherList.creatives).toEqual([]);

      const crossPrincipalList = structuredToolResult(await callTool(25, 'list_creatives', {
        account: { brand, operator: 'agency-one.example' },
        creative_ids: ['creative_lifecycle_scoped_test'],
        include_webhook_activity: true,
      }, OTHER_BILLABLE_AUTH));
      expect(crossPrincipalList.creatives).toEqual([]);
    } finally {
      if (srv) {
        srv.closeAllConnections?.();
        await new Promise<void>(r => srv!.close(() => r()));
      }
    }
  }, 15000);
});
