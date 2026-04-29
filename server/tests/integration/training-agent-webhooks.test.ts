/**
 * End-to-end webhook emission for the training agent.
 *
 * Spins up an ephemeral HTTP receiver, posts a mutating tool request with
 * `push_notification_config.url` set to the receiver, and asserts the
 * training agent delivers a signed MCP webhook envelope with a stable
 * idempotency_key.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { verifyWebhookSignature, StaticJwksResolver, InMemoryReplayStore, InMemoryRevocationStore } from '@adcp/client/signing';
import type { AdcpJsonWebKey } from '@adcp/client/signing';
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
const { stopSessionCleanup } = await import('../../src/training-agent/state.js');
const { resetWebhookSigning, getPublicJwks } = await import('../../src/training-agent/webhooks.js');

const AUTH = 'Bearer test-token-webhook';

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

describe('Training Agent webhook emission', () => {
  let app: express.Application;

  beforeAll(() => {
    resetWebhookSigning(); // fresh key for this test run
    app = express();
    app.use(express.json());
    app.use('/api/training-agent', createTrainingAgentRouter());
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
            .post('/api/training-agent/mcp')
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
      .post('/api/training-agent/mcp')
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
});
