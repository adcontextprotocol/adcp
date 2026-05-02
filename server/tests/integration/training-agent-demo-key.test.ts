/**
 * Integration test for issue #2841 — security_baseline authentication surface.
 *
 * Asserts the two behaviors the storyboard asserts against:
 *   1. The training agent accepts any Bearer matching the documented
 *      `demo-<kit>-v<n>` conformance handle (the handle every test-kit
 *      advertises in its `auth.api_key` header comment).
 *   2. 401 responses to protected tools include `WWW-Authenticate: Bearer`
 *      per RFC 6750 §3, and unrelated bearers that don't match the demo
 *      pattern still fail.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.hoisted(() => {
  process.env.PUBLIC_TEST_AGENT_TOKEN = 'test-token-for-demo-key';
});

vi.mock('../../src/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const { createTrainingAgentRouter } = await import('../../src/training-agent/index.js');
const { stopSessionCleanup } = await import('../../src/training-agent/state.js');

function postList(app: express.Application, authHeader: string | undefined) {
  const req = request(app)
    .post('/api/training-agent/sales/mcp')
    .set('Content-Type', 'application/json')
    .set('Accept', 'application/json, text/event-stream');
  if (authHeader) req.set('Authorization', authHeader);
  return req.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'list_creatives', arguments: {} },
  });
}

describe('Training Agent conformance-handle bearer auth (issue #2841)', () => {
  let app: express.Application;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api/training-agent', createTrainingAgentRouter());
  });

  afterAll(() => {
    stopSessionCleanup();
  });

  it('accepts a test-kit `demo-<kit>-v<n>` bearer without needing env-configured tokens', async () => {
    const res = await postList(app, 'Bearer demo-acme-outdoor-v1');
    expect(res.status).toBe(200);
  });

  it('accepts the multi-segment handle documented across test-kits', async () => {
    const res = await postList(app, 'Bearer demo-osei-natural-v1');
    expect(res.status).toBe(200);
  });

  it('rejects an unauthenticated request with 401 + WWW-Authenticate per RFC 6750', async () => {
    const res = await postList(app, undefined);
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/^Bearer /);
  });

  it('rejects a bearer that does not match the conformance handle', async () => {
    // Obviously wrong shape — must not be accepted by the demo-key verifier.
    const res = await postList(app, 'Bearer not-a-demo-key');
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/^Bearer /);
  });

  it('rejects an almost-matching bearer missing the version suffix', async () => {
    // The pattern requires `-v<digits>` at the end.
    const res = await postList(app, 'Bearer demo-acme-outdoor');
    expect(res.status).toBe(401);
  });

  it('rejects `demo--v1` (empty kit segment)', async () => {
    const res = await postList(app, 'Bearer demo--v1');
    expect(res.status).toBe(401);
  });
});
