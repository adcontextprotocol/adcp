/** Switching orgs rebinds the WorkOS session; request fields never grant authority. */
import { createHash } from 'node:crypto';
import express from 'express';
import supertest from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadSealedSession: vi.fn(), refresh: vi.fn(),
  getRefreshedSession: vi.fn(), storeRefreshedSession: vi.fn(),
}));
vi.hoisted(() => {
  process.env.DEV_USER_EMAIL = '';
  process.env.DEV_USER_ID = '';
  process.env.WORKOS_API_KEY ??= 'sk_test';
  process.env.WORKOS_CLIENT_ID ??= 'client_test';
  process.env.WORKOS_COOKIE_PASSWORD ??= 'placeholder-cookie-password-32-bytes-min';
});
vi.mock('@workos-inc/node', () => ({
  WorkOS: vi.fn(function WorkOS() {
    return {
      userManagement: { loadSealedSession: mocks.loadSealedSession },
      apiKeys: { createValidation: vi.fn() },
    };
  }),
}));
vi.mock('../../src/db/session-refresh-db.js', () => ({
  getRefreshedSession: mocks.getRefreshedSession,
  storeRefreshedSession: mocks.storeRefreshedSession,
  cleanExpiredRefreshes: vi.fn().mockResolvedValue(0),
}));
import { stopAuthTimers, switchSessionOrganization } from '../../src/middleware/auth.js';

const COOKIE = 'sealed-session-bound-to-org-pinnacle';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function app(headers: Record<string, string> = {}, cookie: string | null = COOKIE) {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    req.cookies = cookie === null ? {} : { 'wos-session': cookie };
    Object.assign(req.headers, headers);
    next();
  });
  server.post('/auth/switch-organization', switchSessionOrganization);
  return supertest(server);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadSealedSession.mockReturnValue({ refresh: mocks.refresh });
  mocks.getRefreshedSession.mockResolvedValue(undefined);
  mocks.storeRefreshedSession.mockResolvedValue(undefined);
  mocks.refresh.mockResolvedValue({ authenticated: true, sealedSession: 'sealed-session-bound-to-org-other' });
});
afterAll(() => stopAuthTimers());

describe('switchSessionOrganization', () => {
  it('asks WorkOS to rebind the session and replaces the cookie', async () => {
    const response = await app().post('/auth/switch-organization').send({ target_organization_id: ' org_other ' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ organization_id: 'org_other' });
    expect(mocks.loadSealedSession).toHaveBeenCalledWith(expect.objectContaining({ sessionData: COOKIE }));
    expect(mocks.refresh).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org_other' }));
    expect(response.headers['set-cookie']?.[0]).toMatch(/^wos-session=sealed-session-bound-to-org-other;.*HttpOnly/);
    expect(mocks.storeRefreshedSession).toHaveBeenCalledWith(hash(COOKIE), 'sealed-session-bound-to-org-other');
  });

  it('refreshes from a session another instance already rotated', async () => {
    mocks.getRefreshedSession.mockResolvedValue('rotated-sealed-session');
    await app().post('/auth/switch-organization').send({ target_organization_id: 'org_other' });
    expect(mocks.loadSealedSession).toHaveBeenCalledWith(expect.objectContaining({ sessionData: 'rotated-sealed-session' }));
  });

  it.each([{}, { target_organization_id: '' }, { target_organization_id: '  ' }, { target_organization_id: ['org_other'] }])(
    'rejects a missing or unusable target %j', async (body) => {
      const response = await app().post('/auth/switch-organization').send(body);
      expect(response.status).toBe(400);
      expect(mocks.refresh).not.toHaveBeenCalled();
    },
  );

  it('does not rebind bearer-authenticated callers', async () => {
    const response = await app({ authorization: 'Bearer sk_org_key' })
      .post('/auth/switch-organization').send({ target_organization_id: 'org_other' });
    expect(response.status).toBe(400);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it('requires a browser session cookie', async () => {
    const response = await app({}, null).post('/auth/switch-organization').send({ target_organization_id: 'org_other' });
    expect(response.status).toBe(400);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it('keeps the current session when WorkOS rejects the organization', async () => {
    mocks.refresh.mockResolvedValue({ authenticated: false, reason: 'invalid_grant' });
    const response = await app().post('/auth/switch-organization').send({ target_organization_id: 'org_not_mine' });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'Unable to switch to that organization' });
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(mocks.storeRefreshedSession).not.toHaveBeenCalled();
  });

  it('reports a retryable WorkOS failure as unavailable', async () => {
    mocks.refresh.mockResolvedValue({ authenticated: false, reason: 'network', retryable: true });
    const response = await app().post('/auth/switch-organization').send({ target_organization_id: 'org_other' });
    expect(response.status).toBe(503);
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('does not leak provider errors', async () => {
    mocks.refresh.mockRejectedValue(new Error('WorkOS said: membership om_123 missing'));
    const response = await app().post('/auth/switch-organization').send({ target_organization_id: 'org_other' });
    expect(response.status).toBe(403);
    expect(JSON.stringify(response.body)).not.toContain('om_123');
  });
});
