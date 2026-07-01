import { describe, it, expect, afterAll, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { randomUUID } from 'node:crypto';

vi.hoisted(() => {
  delete process.env.PUBLIC_TEST_AGENT_TOKEN;
  delete process.env.TRAINING_AGENT_TOKEN;
});

const { createTrainingAgentRouter } = await import('../../src/training-agent/index.js');
const { stopSessionCleanup } = await import('../../src/training-agent/state.js');

const DOCUMENTED_PUBLIC_TEST_AGENT_TOKEN = '1v8tAhASaUYYp4odoQ1PnMpdqNaMiTrCRqYo9OJp6IQ';

function createApp(): express.Application {
  const app = express();
  app.use(express.json({
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody?: string }).rawBody = buf.toString('utf8');
    },
  }));
  app.use('/api/training-agent', createTrainingAgentRouter());
  return app;
}

describe('Training Agent documented public token', () => {
  afterAll(() => {
    vi.unstubAllEnvs();
    stopSessionCleanup();
  });

  it('allows documented no-signup sandbox sync_accounts flows', async () => {
    const app = createApp();

    const res = await request(app)
      .post('/api/training-agent/sales/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json')
      .set('Authorization', `Bearer ${DOCUMENTED_PUBLIC_TEST_AGENT_TOKEN}`)
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'sync_accounts',
          arguments: {
            idempotency_key: `public-token-sync-${randomUUID()}`,
            accounts: [{
              brand: { domain: 'public-token.example' },
              operator: 'public-token.example',
              billing: 'operator',
              sandbox: true,
            }],
          },
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.result?.structuredContent?.accounts?.[0]).toMatchObject({
      action: 'created',
      status: 'active',
      billing: 'operator',
      sandbox: true,
    });
  });

  it('does not require public-JWKS request signing on the public sandbox route', async () => {
    const app = createApp();

    const res = await request(app)
      .post('/api/training-agent/sales/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json')
      .set('Authorization', `Bearer ${DOCUMENTED_PUBLIC_TEST_AGENT_TOKEN}`)
      // Malformed on purpose: the public sandbox should ignore request-signing
      // headers and authenticate via bearer so localhost SDK smoke tests can
      // exercise protocol flows without publishing a fetchable JWKS.
      .set('Signature-Input', 'sig1=("@method");created=1;keyid="localhost-dev"')
      .set('Signature', 'sig1=:not-valid-base64:')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'get_adcp_capabilities',
          arguments: {},
        },
      });

    expect(res.status).toBe(200);
    const requestSigning = res.body.result?.structuredContent?.request_signing;
    if (requestSigning != null) {
      expect(requestSigning).toMatchObject({
        supported: false,
        required_for: [],
        supported_for: [],
      });
    }
  });

  it('rejects bearer fallback on strict required AdCP operations', async () => {
    const app = createApp();

    const res = await request(app)
      .post('/api/training-agent/sales/mcp-strict')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json')
      .set('Authorization', `Bearer ${DOCUMENTED_PUBLIC_TEST_AGENT_TOKEN}`)
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'create_media_buy',
          arguments: {
            idempotency_key: `strict-create-${randomUUID()}`,
            brand: { domain: 'strict-create.example' },
            packages: [{ product_id: 'pkg_streamhaus_ctv_prime', budget: { amount: 1000, currency: 'USD' } }],
            start_time: 'asap',
            end_time: '2099-06-30T00:00:00Z',
          },
        },
      });

    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toContain('Signature');
    expect(res.headers['www-authenticate']).toContain('request_signature_required');
  });

  it.each([
    '/api/training-agent/sales/mcp-strict-required',
    '/api/training-agent/sales/mcp-strict-forbidden',
  ])('rejects unsigned required protocol methods on %s', async (path) => {
    const app = createApp();

    const res = await request(app)
      .post(path)
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'tasks/cancel',
        params: { id: 'task_123' },
      });

    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toContain('Signature');
    expect(res.headers['www-authenticate']).toContain('request_signature_required');
  });
});
