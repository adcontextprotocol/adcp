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
import { generateKeyPairSync, randomUUID } from 'node:crypto';
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
const { stopSessionCleanup, clearSessions, getSession, runWithSessionContext, sessionKeyFromArgs } = await import('../../src/training-agent/state.js');
const { clearAccountStore } = await import('../../src/training-agent/account-handlers.js');
const {
  resetWebhookSigning,
  getPublicJwks,
  emitFrameworkTaskWebhook,
  maybeEmitCompletionWebhook,
} = await import('../../src/training-agent/webhooks.js');
const { handleCreatePropertyList, handleUpdatePropertyList } = await import('../../src/training-agent/property-handlers.js');

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

function webhookRequest(delivery: CapturedDelivery, body = delivery.body) {
  return {
    method: 'POST',
    url: delivery.url,
    headers: delivery.headers as Record<string, string>,
    body,
  };
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
                  push_notification_config: { url: webhookUrl, operation_id: 'op_completion_webhook' },
                },
              },
            });
        });
      });

      await Promise.race([
        done,
        new Promise((_, reject) => setTimeout(() => reject(new Error('webhook never arrived')), 10_000)),
      ]);

      expect(deliveries.length).toBe(1);
      const delivery = deliveries[0];
      const body = JSON.parse(delivery.body) as Record<string, unknown>;
      expect(body.task_id).toBeDefined();
      expect(body.operation_id).toBe('op_completion_webhook');
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
  }, 20000);

  it('emits token-correlated callbacks across the split proposal lifecycle', async () => {
    const deliveries: CapturedDelivery[] = [];
    let srv: http.Server | undefined;
    try {
      let resolveDeliveries: (() => void) | undefined;
      const delivered = new Promise<void>(resolve => { resolveDeliveries = resolve; });
      srv = await startReceiver((delivery, res) => {
        deliveries.push(delivery);
        res.writeHead(200);
        res.end();
        if (deliveries.length === 2) resolveDeliveries?.();
      });
      const addr = srv.address() as AddressInfo;
      const webhookUrl = `http://127.0.0.1:${addr.port}/hook/split-proposals`;
      const call = (name: string, args: Record<string, unknown>) => request(app)
        .post('/api/training-agent/sales/mcp')
        .set('Authorization', AUTH)
        .set('Content-Type', 'application/json')
        .set('Accept', 'application/json, text/event-stream')
        .send({
          jsonrpc: '2.0',
          id: randomUUID(),
          method: 'tools/call',
          params: { name, arguments: args },
        });

      const callback = (operationId: string) => ({
        url: webhookUrl,
        operation_id: operationId,
        token: 'split-callback-token-1234',
      });
      const requestedResponse = await call('request_proposals', {
        idempotency_key: `split-request-${randomUUID()}`,
        brand: { domain: 'split-webhook.example' },
        brief: 'Reach sports fans with social display',
        push_notification_config: callback('op_request_proposals'),
      });
      const requested = structuredToolResult(requestedResponse);
      expect(requested).not.toHaveProperty('adcp_error');
      expect(requested.outcome).toBe('proposed');
      const source = (requested.proposals as Array<Record<string, unknown>>)[0];

      const refinedResponse = await call('refine_proposals', {
        idempotency_key: `split-refine-${randomUUID()}`,
        refinements: [{
          proposal_id: source.proposal_id,
          action: 'revise',
          instructions: 'Prefer social inventory while preserving the total budget.',
        }],
        push_notification_config: callback('op_refine_proposals'),
      });
      const refined = structuredToolResult(refinedResponse);
      expect(refined).not.toHaveProperty('adcp_error');
      await Promise.race([
        delivered,
        new Promise((_, reject) => setTimeout(() => reject(new Error('split lifecycle webhooks never arrived')), 10_000)),
      ]);

      expect(deliveries).toHaveLength(2);
      const bodies = deliveries.map(delivery => JSON.parse(delivery.body) as Record<string, unknown>);
      expect(bodies.map(body => body.task_type)).toEqual([
        'request_proposals',
        'refine_proposals',
      ]);
      expect(bodies.map(body => body.operation_id)).toEqual([
        'op_request_proposals',
        'op_refine_proposals',
      ]);
      expect(bodies.every(body => body.token === 'split-callback-token-1234')).toBe(true);
      const results = bodies.map(body => body.result as Record<string, unknown>);
      expect(results[0]).toMatchObject({ proposals: expect.any(Array), products: expect.any(Array) });
      expect(results[0]).not.toHaveProperty('refinement_applied');
      expect(results[1]).toMatchObject({ results: expect.any(Array), products: expect.any(Array) });
      expect(results[1]).not.toHaveProperty('proposals');
      expect(results[1]).not.toHaveProperty('refinement_applied');
    } finally {
      if (srv) {
        srv.closeAllConnections?.();
        await new Promise<void>(resolve => srv!.close(() => resolve()));
      }
    }
  }, 20000);

  it('honors legacy callback authentication when emitting split-tool webhooks', async () => {
    const deliveries: CapturedDelivery[] = [];
    let srv: http.Server | undefined;
    try {
      let resolveDeliveries: (() => void) | undefined;
      const delivered = new Promise<void>(resolve => { resolveDeliveries = resolve; });
      srv = await startReceiver((delivery, res) => {
        deliveries.push(delivery);
        res.writeHead(200);
        res.end();
        if (deliveries.length === 2) resolveDeliveries?.();
      });
      const addr = srv.address() as AddressInfo;
      maybeEmitCompletionWebhook({
        toolName: 'request_proposals',
        args: {
          push_notification_config: {
            url: `http://127.0.0.1:${addr.port}/hook/bearer`,
            operation_id: 'op_split_bearer',
            authentication: {
              schemes: ['Bearer'],
              credentials: 'legacy-bearer-credential-1234567890',
            },
          },
        },
        response: { proposals: [], products: [] },
        principal: 'webhook-test-principal',
      });
      maybeEmitCompletionWebhook({
        toolName: 'refine_proposals',
        args: {
          push_notification_config: {
            url: `http://127.0.0.1:${addr.port}/hook/hmac`,
            operation_id: 'op_split_hmac',
            authentication: {
              schemes: ['HMAC-SHA256'],
              credentials: 'legacy-hmac-credential-123456789012',
            },
          },
        },
        response: { results: [], products: [] },
        principal: 'webhook-test-principal',
      });
      await Promise.race([
        delivered,
        new Promise((_, reject) => setTimeout(() => reject(new Error('authenticated webhook never arrived')), 10_000)),
      ]);

      expect(deliveries).toHaveLength(2);
      const bearer = deliveries.find(delivery => delivery.url.endsWith('/hook/bearer'))!;
      const hmac = deliveries.find(delivery => delivery.url.endsWith('/hook/hmac'))!;
      expect(bearer.headers.authorization).toBe('Bearer legacy-bearer-credential-1234567890');
      expect(bearer.headers['signature-input']).toBeUndefined();
      expect(hmac.headers['x-adcp-timestamp']).toMatch(/^\d+$/);
      expect(hmac.headers['x-adcp-signature']).toMatch(/^sha256=[a-f0-9]{64}$/);
      expect(hmac.headers['signature-input']).toBeUndefined();
    } finally {
      if (srv) {
        srv.closeAllConnections?.();
        await new Promise<void>(resolve => srv!.close(() => resolve()));
      }
    }
  }, 20000);

  it('falls back to task_id when the buyer omits webhook operation_id', async () => {
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
          const webhookUrl = `http://127.0.0.1:${addr.port}/hook/create_media_buy/no-operation-id`;
          const catalog = buildCatalog();
          const product = catalog[0].product as { product_id: string; pricing_options: Array<{ pricing_option_id: string }> };
          return request(app)
            .post('/api/training-agent/sales/mcp')
            .set('Authorization', BILLABLE_AUTH)
            .set('Content-Type', 'application/json')
            .set('Accept', 'application/json, text/event-stream')
            .send({
              jsonrpc: '2.0',
              id: 2,
              method: 'tools/call',
              params: {
                name: 'create_media_buy',
                arguments: {
                  idempotency_key: randomUUID(),
                  adcp_major_version: 3,
                  account: { brand: { domain: 'webhook-task-id-fallback.example' }, operator: 'webhook-task-id-fallback.example' },
                  brand: { domain: 'webhook-task-id-fallback.example' },
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
      const body = JSON.parse(deliveries[0].body) as Record<string, unknown>;
      expect(body.task_id).toEqual(expect.any(String));
      expect(body.operation_id).toEqual(expect.any(String));
      expect(body.operation_id).toContain(body.task_id as string);
      expect(body.operation_id).not.toContain('demo-billing-agent-billable-v1');
      expect(body.operation_id).not.toContain('static:demo:');
    } finally {
      if (srv) {
        srv.closeAllConnections?.();
        await new Promise<void>(r => srv!.close(() => r()));
      }
    }
  }, 15000);

  it('does not copy the framework idempotency scope into webhook operation_id', async () => {
    const deliveries: CapturedDelivery[] = [];
    let srv: http.Server | undefined;
    try {
      srv = await startReceiver((d, res) => {
        deliveries.push(d);
        res.writeHead(200); res.end();
      });
      const addr = srv.address() as AddressInfo;
      const unsafeScope = 'static:demo:demo-billing-agent-billable-v1|create_media_buy.mb_secret';

      await emitFrameworkTaskWebhook({
        url: `http://127.0.0.1:${addr.port}/hook/framework-fallback`,
        operation_id: unsafeScope,
        payload: {
          task_id: 'tsk_framework_fallback',
          task_type: 'create_media_buy',
          status: 'completed',
        },
      });

      expect(deliveries.length).toBe(1);
      const body = JSON.parse(deliveries[0].body) as Record<string, unknown>;
      expect(body.operation_id).toBe('tsk_framework_fallback');
      expect(body.operation_id).not.toBe(unsafeScope);
      expect(body.operation_id).not.toContain('demo-billing-agent-billable-v1');
      expect(body.operation_id).not.toContain('static:demo:');
    } finally {
      if (srv) {
        srv.closeAllConnections?.();
        await new Promise<void>(r => srv!.close(() => r()));
      }
    }
  }, 15000);

  it('publishes newly generated webhook keys under the canonical request-signing purpose', async () => {
    const response = await request(app).get('/api/training-agent/.well-known/jwks.json');
    expect(response.status).toBe(200);
    const jwks = response.body as { keys: AdcpJsonWebKey[] };
    expect(Array.isArray(jwks.keys)).toBe(true);
    expect(jwks.keys.length).toBeGreaterThan(0);
    const key = jwks.keys[0];
    expect(key.adcp_use).toBe('request-signing');
    expect(key.key_ops).toContain('verify');
    expect(key.kid).toBeTruthy();
    expect(key.d).toBeUndefined(); // never publish the private scalar
  });

  it('preserves the purpose of an existing configured webhook kid', () => {
    const original = process.env.WEBHOOK_SIGNING_KEY_JWK;
    const { privateKey } = generateKeyPairSync('ed25519');
    const configured = privateKey.export({ format: 'jwk' }) as Record<string, unknown>;
    process.env.WEBHOOK_SIGNING_KEY_JWK = JSON.stringify({
      ...configured,
      kid: 'existing-webhook-kid',
      adcp_use: 'webhook-signing',
    });
    resetWebhookSigning();

    try {
      expect(getPublicJwks().keys[0]).toMatchObject({
        kid: 'existing-webhook-kid',
        adcp_use: 'webhook-signing',
      });
    } finally {
      if (original === undefined) delete process.env.WEBHOOK_SIGNING_KEY_JWK;
      else process.env.WEBHOOK_SIGNING_KEY_JWK = original;
      resetWebhookSigning();
    }
  });

  it('emits and verifies an RFC 9421-only property-list change webhook', async () => {
    const deliveries: CapturedDelivery[] = [];
    let resolveDelivery: (() => void) | undefined;
    const delivered = new Promise<void>(resolve => { resolveDelivery = resolve; });
    let srv: http.Server | undefined;

    try {
      srv = await startReceiver((delivery, res) => {
        deliveries.push(delivery);
        res.writeHead(200); res.end();
        resolveDelivery?.();
      });
      const addr = srv.address() as AddressInfo;
      const webhookUrl = `http://127.0.0.1:${addr.port}/hook/property-list`;
      const account = {
        brand: { domain: 'property-webhook.example' },
        operator: 'pinnacle-agency.example',
      };
      const createArgs = {
        name: 'Property webhook list',
        base_properties: [{
          selection_type: 'identifiers',
          identifiers: [{ type: 'domain', value: 'first.example' }],
        }],
        account,
        idempotency_key: randomUUID(),
      };
      const ctx = { mode: 'open' as const };
      let listId = '';
      await runWithSessionContext(async () => {
        const created = await handleCreatePropertyList(createArgs, ctx);
        listId = (created.list as { list_id: string }).list_id;

        // Storage-time SSRF tests deliberately reject loopback. Seed the
        // already-validated target directly so this integration test can probe
        // the delivery/signature boundary against an ephemeral local receiver.
        const session = await getSession(sessionKeyFromArgs(createArgs, ctx.mode));
        session.propertyLists.get(listId)!.webhookUrl = webhookUrl;

        await handleUpdatePropertyList({
          list_id: listId,
          account,
          idempotency_key: randomUUID(),
          base_properties: [{
            selection_type: 'identifiers',
            identifiers: [
              { type: 'domain', value: 'first.example' },
              { type: 'domain', value: 'second.example' },
            ],
          }],
        }, ctx);
      });

      await Promise.race([
        delivered,
        new Promise((_, reject) => setTimeout(() => reject(new Error('property-list webhook never arrived')), 5000)),
      ]);

      expect(deliveries).toHaveLength(1);
      const delivery = deliveries[0];
      const body = JSON.parse(delivery.body) as Record<string, unknown>;
      expect(body).toMatchObject({
        event: 'property_list_changed',
        list_id: listId,
        change_summary: { properties_added: 1, properties_removed: 0, total_properties: 2 },
        signature: 'rfc9421',
      });
      expect(body.idempotency_key).toMatch(/^[A-Za-z0-9_.:-]{16,255}$/);
      expect(delivery.headers['signature-input']).toBeDefined();
      expect(delivery.headers.signature).toBeDefined();
      expect(delivery.headers['content-digest']).toBeDefined();
      expect(delivery.headers['x-adcp-signature']).toBeUndefined();

      const jwks = new StaticJwksResolver(getPublicJwks().keys as AdcpJsonWebKey[]);
      const verificationOptions = () => ({
        jwks,
        replayStore: new InMemoryReplayStore(),
        revocationStore: new InMemoryRevocationStore(),
      });
      await expect(verifyWebhookSignature(
        webhookRequest(delivery),
        verificationOptions(),
      )).resolves.toMatchObject({ status: 'verified' });

      const tamperedBody = JSON.stringify({ ...body, signature: 'attacker-controlled-body-value' });
      await expect(verifyWebhookSignature(
        webhookRequest(delivery, tamperedBody),
        verificationOptions(),
      )).rejects.toMatchObject({ code: 'webhook_signature_digest_mismatch' });

      const bodyOnlyHeaders = { ...delivery.headers };
      delete bodyOnlyHeaders.signature;
      delete bodyOnlyHeaders['signature-input'];
      await expect(verifyWebhookSignature({
        ...webhookRequest(delivery),
        headers: bodyOnlyHeaders as Record<string, string>,
      }, verificationOptions())).rejects.toMatchObject({ code: 'webhook_signature_header_malformed' });

      await expect(verifyWebhookSignature(
        webhookRequest(delivery),
        { ...verificationOptions(), now: () => Math.floor(Date.now() / 1000) + 1_000 },
      )).rejects.toMatchObject({ code: 'webhook_signature_window_invalid' });
    } finally {
      if (srv) {
        srv.closeAllConnections?.();
        await new Promise<void>(resolve => srv!.close(() => resolve()));
      }
    }
  }, 15000);

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
            start_time: 'asap',
            end_time: '2099-05-08T00:00:00Z',
            packages: [],
          },
        },
      });
    expect(response.status).toBe(200);
  });

  it('activates an existing inactive subscriber and re-challenges after URL or credential changes', async () => {
    const challenges: Array<Record<string, unknown>> = [];
    const challengeUrls: string[] = [];
    let srv: http.Server | undefined;
    try {
      srv = await startReceiver((delivery, res) => {
        const body = JSON.parse(delivery.body) as Record<string, unknown>;
        challenges.push(body);
        challengeUrls.push(delivery.url);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ challenge: body.challenge }));
      });
      const addr = srv.address() as AddressInfo;
      const baseUrl = `http://127.0.0.1:${addr.port}`;
      const callSyncAccounts = async (id: number, accounts: Array<Record<string, unknown>>) => {
        const response = await request(app)
          .post('/api/training-agent/sales/mcp')
          .set('Authorization', BILLABLE_AUTH)
          .set('Content-Type', 'application/json')
          .set('Accept', 'application/json, text/event-stream')
          .send({
            jsonrpc: '2.0',
            id,
            method: 'tools/call',
            params: {
              name: 'sync_accounts',
              arguments: { idempotency_key: randomUUID(), accounts },
            },
          });
        expect(response.status).toBe(200);
        expect(response.text).not.toContain('"isError":true');
        return structuredToolResult(response);
      };

      const initial = await callSyncAccounts(30, [{
        brand: { domain: 'activation-proof.example' },
        operator: 'pinnacle-agency.example',
        billing: 'operator',
        sandbox: true,
        notification_configs: [{
          subscriber_id: 'buyer-primary',
          url: `${baseUrl}/hook/a`,
          event_types: ['creative.status_changed'],
          active: false,
        }],
      }]);
      const accountId = (initial.accounts as Array<Record<string, unknown>>)[0].account_id as string;
      expect(challenges).toHaveLength(0);

      const config = {
        subscriber_id: 'buyer-primary',
        url: `${baseUrl}/hook/a`,
        event_types: ['creative.status_changed'],
        active: true,
      };
      await callSyncAccounts(31, [{ account: { account_id: accountId }, notification_configs: [config] }]);
      expect(challenges).toHaveLength(1);

      // The unchanged active tuple retains its existing proof.
      await callSyncAccounts(32, [{ account: { account_id: accountId }, notification_configs: [config] }]);
      expect(challenges).toHaveLength(1);

      await callSyncAccounts(33, [{
        account: { account_id: accountId },
        notification_configs: [{ ...config, url: `${baseUrl}/hook/b` }],
      }]);
      expect(challenges).toHaveLength(2);

      await callSyncAccounts(34, [{
        account: { account_id: accountId },
        notification_configs: [{
          ...config,
          url: `${baseUrl}/hook/b`,
          authentication: {
            schemes: ['HMAC-SHA256'],
            credentials: 'new-shared-secret-0000000000000001',
          },
        }],
      }]);
      expect(challenges).toHaveLength(3);
      expect(challengeUrls).toEqual([
        `${baseUrl}/hook/a`,
        `${baseUrl}/hook/b`,
        `${baseUrl}/hook/b`,
      ]);
      expect(challenges[2].delivery_auth).toMatchObject({
        mode: 'HMAC-SHA256',
        credential_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      });

      const previousFingerprint = (challenges[2].delivery_auth as Record<string, unknown>)
        .credential_fingerprint;
      await callSyncAccounts(35, [{
        account: { account_id: accountId },
        notification_configs: [{
          ...config,
          url: `${baseUrl}/hook/b`,
          authentication: {
            schemes: ['HMAC-SHA256'],
            credentials: 'rotated-shared-secret-00000000000001',
          },
        }],
      }]);
      expect(challenges).toHaveLength(4);
      const rotatedFingerprint = (challenges[3].delivery_auth as Record<string, unknown>)
        .credential_fingerprint;
      expect(rotatedFingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(rotatedFingerprint).not.toBe(previousFingerprint);
    } finally {
      if (srv) {
        srv.closeAllConnections?.();
        await new Promise<void>(resolve => srv!.close(() => resolve()));
      }
    }
  }, 15000);

  it('delivers account-level creative lifecycle webhooks registered through sync_accounts', async () => {
    const deliveries: CapturedDelivery[] = [];
    let srv: http.Server | undefined;
    try {
      let resolveDelivery: (() => void) | undefined;
      const done = new Promise<void>(resolve => {
        resolveDelivery = resolve;
      });
      srv = await startReceiver((d, res) => {
        const body = JSON.parse(d.body) as Record<string, unknown>;
        if (body.type === 'webhook.challenge') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ challenge: body.challenge }));
          return;
        }
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

      const account = {
        brand: { domain: 'creative-lifecycle.example' },
        operator: 'pinnacle-agency.example',
        sandbox: true,
      };

      await callTool(10, 'sync_accounts', {
        idempotency_key: randomUUID(),
        accounts: [{
          brand: account.brand,
          operator: account.operator,
          billing: 'operator',
          sandbox: account.sandbox,
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
        account,
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
        const body = JSON.parse(d.body) as Record<string, unknown>;
        if (body.type === 'webhook.challenge') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ challenge: body.challenge }));
          return;
        }
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
      const ownerAccount = { brand, operator: 'agency-one.example', sandbox: true };
      const otherAccount = { brand, operator: 'agency-two.example', sandbox: true };
      await callTool(20, 'sync_accounts', {
        idempotency_key: randomUUID(),
        accounts: [
          {
            brand,
            operator: ownerAccount.operator,
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
            operator: otherAccount.operator,
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
        account: ownerAccount,
        creatives: [{
          creative_id: 'creative_lifecycle_scoped_test',
          name: 'Creative lifecycle scoped test',
          format_id: { agent_url: 'https://creative.example.com', id: 'display_300x250' },
          assets: { image: { asset_type: 'image', url: 'https://assets.example.com/creative.png' } },
        }],
      });

      await callTool(22, 'comply_test_controller', {
        account: ownerAccount,
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
        account: ownerAccount,
        creative_ids: ['creative_lifecycle_scoped_test'],
        include_webhook_activity: true,
      }));
      const ownerCreative = (ownerList.creatives as Array<Record<string, unknown>>)[0];
      expect(ownerCreative.webhook_activity).toHaveLength(1);

      const otherList = structuredToolResult(await callTool(24, 'list_creatives', {
        account: otherAccount,
        creative_ids: ['creative_lifecycle_scoped_test'],
        include_webhook_activity: true,
      }));
      expect(otherList.creatives).toEqual([]);

      const crossPrincipalList = structuredToolResult(await callTool(25, 'list_creatives', {
        account: ownerAccount,
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
