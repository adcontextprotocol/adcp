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

describe('Training Agent documented public token', () => {
  afterAll(() => {
    vi.unstubAllEnvs();
    stopSessionCleanup();
  });

  it('allows documented no-signup sandbox sync_accounts flows', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/training-agent', createTrainingAgentRouter());

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
});
