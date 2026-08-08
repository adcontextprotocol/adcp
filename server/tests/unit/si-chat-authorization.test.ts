import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getSessionMessages: vi.fn(),
  getUser: vi.fn(),
  sendMessage: vi.fn(),
  sendMessageStream: vi.fn(),
  terminateSession: vi.fn(),
}));

vi.mock('../../src/middleware/auth.js', () => ({
  optionalAuth: (req: any, _res: any, next: any) => {
    const id = req.get('x-test-user-id');
    const email = req.get('x-test-user-email');
    if (id || email) req.user = { id, email };
    next();
  },
}));

vi.mock('../../src/db/si-db.js', () => ({
  siDb: {
    getSession: mocks.getSession,
    getSessionMessages: mocks.getSessionMessages,
    getSessionsByUser: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../../src/db/users-db.js', () => ({
  UsersDatabase: class {
    getUser = mocks.getUser;
  },
}));

vi.mock('../../src/addie/services/si-agent-service.js', () => ({
  siAgentService: {
    sendMessage: mocks.sendMessage,
    sendMessageStream: mocks.sendMessageStream,
    terminateSession: mocks.terminateSession,
  },
}));

vi.mock('../../src/db/client.js', () => ({ query: vi.fn() }));

vi.mock('../../src/middleware/pg-rate-limit-store.js', () => ({
  PostgresStore: class {
    private hits = new Map<string, number>();
    init() {}
    async increment(key: string) {
      const totalHits = (this.hits.get(key) ?? 0) + 1;
      this.hits.set(key, totalHits);
      return { totalHits, resetTime: new Date(Date.now() + 60_000) };
    }
    async decrement(key: string) {
      this.hits.set(key, Math.max((this.hits.get(key) ?? 1) - 1, 0));
    }
    async resetKey(key: string) { this.hits.delete(key); }
  },
}));

import {
  createSiChatRoutes,
  parseSiHistoryPagination,
  validateSiMessageInput,
  verifySessionAccess,
} from '../../src/routes/si-chat.js';
import { issueAnonymousSessionCapability } from '../../src/routes/helpers/anonymous-session-capability.js';

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: 'row-1',
    session_id: 'si_11111111-1111-4111-8111-111111111111',
    host_type: 'addy',
    host_identifier: 'thread-1',
    member_profile_id: null,
    brand_name: 'Acme',
    user_slack_id: null,
    user_email: null,
    user_name: null,
    user_anonymous_id: null,
    identity_consent_granted: false,
    status: 'active',
    termination_reason: null,
    initial_context: null,
    campaign_id: null,
    offer_id: null,
    handoff_data: null,
    message_count: 0,
    created_at: new Date(),
    last_activity_at: new Date(),
    terminated_at: null,
    ...overrides,
  } as any;
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/si', createSiChatRoutes().apiRouter);
  return app;
}

describe('SI session ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionMessages.mockResolvedValue([]);
    mocks.sendMessage.mockResolvedValue({ message: 'ok', session_status: 'active' });
    mocks.terminateSession.mockResolvedValue({ terminated: true });
  });

  it('matches email sessions case-insensitively and rejects other users', () => {
    const owned = session({ user_email: 'Owner@Example.com' });
    expect(verifySessionAccess(owned, { userEmail: 'owner@example.com' })).toBe(true);
    expect(verifySessionAccess(owned, { userEmail: 'other@example.com' })).toBe(false);
    expect(verifySessionAccess(owned, {})).toBe(false);
  });

  it('requires the linked Slack identity for Slack sessions', () => {
    const owned = session({ user_slack_id: 'U_OWNER' });
    expect(verifySessionAccess(owned, { linkedSlackId: 'U_OWNER' })).toBe(true);
    expect(verifySessionAccess(owned, { linkedSlackId: 'U_OTHER' })).toBe(false);
    expect(verifySessionAccess(owned, {})).toBe(false);
  });

  it('accepts either matching identity when a session records both email and Slack', () => {
    const owned = session({ user_email: 'owner@example.com', user_slack_id: 'U_OWNER' });
    expect(verifySessionAccess(owned, {
      userEmail: 'other@example.com',
      linkedSlackId: 'U_OWNER',
    })).toBe(true);
    expect(verifySessionAccess(owned, {
      userEmail: 'owner@example.com',
      linkedSlackId: 'U_OTHER',
    })).toBe(true);
    expect(verifySessionAccess(owned, {
      userEmail: 'other@example.com',
      linkedSlackId: 'U_OTHER',
    })).toBe(false);
  });

  it('requires a signed session-bound capability for anonymous sessions', () => {
    const owned = session({ user_anonymous_id: 'anon-1' });
    const token = issueAnonymousSessionCapability('si-session-owner', owned.session_id);
    const otherToken = issueAnonymousSessionCapability('si-session-owner', 'si_other');

    expect(verifySessionAccess(owned, { anonymousCapability: token })).toBe(true);
    expect(verifySessionAccess(owned, { anonymousCapability: otherToken })).toBe(false);
    expect(verifySessionAccess(owned, {})).toBe(false);
  });

  it('fails closed when a session has no owner identity', () => {
    expect(verifySessionAccess(session(), {})).toBe(false);
  });

  it('enforces message and action-response runtime bounds', () => {
    expect(validateSiMessageInput({ message: 42 })).toMatchObject({ ok: false, status: 400 });
    expect(validateSiMessageInput({ message: 'x'.repeat(4_001) })).toMatchObject({ ok: false, status: 413 });
    expect(validateSiMessageInput({
      action_response: { action: 'test', payload: { value: 'x'.repeat(17 * 1024) } },
    })).toMatchObject({ ok: false, status: 413 });
    expect(validateSiMessageInput({
      action_response: { action: 'test', payload: { a: { b: { c: { d: { e: { f: {} } } } } } } },
    })).toMatchObject({ ok: false, status: 400 });
    expect(validateSiMessageInput({ message: ' hello ' })).toEqual({ ok: true, message: 'hello' });
  });

  it('defaults and clamps history pagination', () => {
    expect(parseSiHistoryPagination({})).toEqual({ limit: 50, offset: 0 });
    expect(parseSiHistoryPagination({ limit: '500', offset: '-3' })).toEqual({ limit: 100, offset: 0 });
    expect(parseSiHistoryPagination({ limit: '25', offset: '75' })).toEqual({ limit: 25, offset: 75 });
    expect(parseSiHistoryPagination({ limit: '10junk', offset: '999999999999999999999' }))
      .toEqual({ limit: 50, offset: 0 });
    expect(parseSiHistoryPagination({ offset: '10001' })).toEqual({ limit: 50, offset: 10_000 });
  });

  it.each([
    ['get session', 'get', '/api/si/sessions/si_test', undefined],
    ['get messages', 'get', '/api/si/sessions/si_test/messages', undefined],
    ['post message', 'post', '/api/si/sessions/si_test/messages', { message: 'hello' }],
    ['stream message', 'post', '/api/si/sessions/si_test/messages/stream', { message: 'hello' }],
    ['delete session', 'delete', '/api/si/sessions/si_test', undefined],
  ])('returns the same 404 for an inaccessible %s route', async (_label, method, path, body) => {
    mocks.getSession.mockResolvedValue(session({ user_email: 'owner@example.com' }));
    const app = buildApp();
    let call = (request(app) as any)[method](path).set('x-test-user-email', 'attacker@example.com');
    if (body) call = call.send(body);
    const response = await call.expect(404);
    expect(response.body).toEqual({ error: 'Session not found' });
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(mocks.terminateSession).not.toHaveBeenCalled();
  });

  it('allows an anonymous caller with the correct capability', async () => {
    const owned = session({ user_anonymous_id: 'anon-1' });
    mocks.getSession.mockResolvedValue(owned);
    const capability = issueAnonymousSessionCapability('si-session-owner', owned.session_id);

    const response = await request(buildApp())
      .get(`/api/si/sessions/${owned.session_id}/messages`)
      .set('X-SI-Session-Capability', capability)
      .expect(200);

    expect(response.body).toEqual({
      session_id: owned.session_id,
      messages: [],
      pagination: { limit: 50, offset: 0, returned: 0 },
    });
  });

  it('rejects an unbounded or unknown termination reason before loading a session', async () => {
    const response = await request(buildApp())
      .delete('/api/si/sessions/si_test')
      .send({ reason: 'x'.repeat(10_000) })
      .expect(400);
    expect(response.body.error).toBe('Invalid termination reason');
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.terminateSession).not.toHaveBeenCalled();
  });

  it('passes bounded pagination to the database query', async () => {
    const owned = session({ user_email: 'owner@example.com' });
    mocks.getSession.mockResolvedValue(owned);

    const response = await request(buildApp())
      .get(`/api/si/sessions/${owned.session_id}/messages?limit=500&offset=25`)
      .set('x-test-user-email', 'owner@example.com')
      .expect(200);

    expect(mocks.getSessionMessages).toHaveBeenCalledWith(owned.session_id, 100, 25);
    expect(response.body.pagination).toEqual({ limit: 100, offset: 25, returned: 0 });
  });

  it('rejects oversized whitespace-heavy messages before invoking the model', async () => {
    const response = await request(buildApp())
      .post('/api/si/sessions/si_test/messages')
      .set('x-test-user-id', 'whitespace-user')
      .send({ message: `${' '.repeat(4_000)}x` })
      .expect(413);
    expect(response.body.error).toContain('4000');
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    '/api/si/sessions/si_test/messages',
    '/api/si/sessions/si_test/messages/stream',
  ])('rejects oversized model inputs before invoking %s', async (path) => {
    const response = await request(buildApp())
      .post(path)
      .set('x-test-user-id', `oversize-user-${path.endsWith('/stream') ? 'stream' : 'post'}`)
      .send({ message: 'x'.repeat(4_001) })
      .expect(413);

    expect(response.body.error).toContain('4000');
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(mocks.sendMessageStream).not.toHaveBeenCalled();
  });

  it('rate limits model calls per authenticated identity', async () => {
    mocks.getSession.mockResolvedValue(session({ user_email: 'rate@example.com' }));
    const app = buildApp();

    for (let index = 0; index < 20; index += 1) {
      await request(app)
        .post('/api/si/sessions/si_rate/messages')
        .set('x-test-user-id', 'rate-user')
        .set('x-test-user-email', 'rate@example.com')
        .send({ message: `message ${index}` })
        .expect(200);
    }

    const response = await request(app)
      .post('/api/si/sessions/si_rate/messages')
      .set('x-test-user-id', 'rate-user')
      .set('x-test-user-email', 'rate@example.com')
      .send({ message: 'one too many' })
      .expect(429);
    expect(response.body.error).toBe('Too many requests');
  });

  it('resolves a WorkOS user linked to the owning Slack identity', async () => {
    const owned = session({ user_slack_id: 'U_OWNER' });
    mocks.getSession.mockResolvedValue(owned);
    mocks.getUser.mockResolvedValue({ primary_slack_user_id: 'U_OWNER' });

    await request(buildApp())
      .get(`/api/si/sessions/${owned.session_id}/messages`)
      .set('x-test-user-id', 'user_owner')
      .expect(200);

    expect(mocks.getUser).toHaveBeenCalledWith('user_owner');
  });
});
