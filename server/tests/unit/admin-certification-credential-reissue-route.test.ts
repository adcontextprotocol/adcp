import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockCertDb = vi.hoisted(() => ({
  getCredential: vi.fn(),
  recordAdminCredentialReissueEvent: vi.fn(),
}));
const mockQuery = vi.hoisted(() => vi.fn());
const mockEnsureCredential = vi.hoisted(() => vi.fn());
const authState = vi.hoisted(() => ({ allowGlobalAdmin: true }));

vi.hoisted(() => {
  process.env.WORKOS_API_KEY ??= 'sk_test_mock_key';
  process.env.WORKOS_CLIENT_ID ??= 'client_mock_id';
  process.env.WORKOS_COOKIE_PASSWORD ??= 'test-cookie-password-at-least-32-chars-long';
});

vi.mock('../../src/middleware/auth.js', async (importOriginal) => {
  const mockedRequireAuth = (req: any, _res: any, next: any) => {
    req.user = { id: 'user_test_admin', email: 'admin@test.local' };
    next();
  };
  const globalGate = (_req: any, res: any, next: any) => {
    if (!authState.allowGlobalAdmin) {
      return res.status(403).json({ error: 'global_admin_required' });
    }
    next();
  };
  const passThrough = (_req: any, _res: any, next: any) => next();
  return {
    ...(await importOriginal<typeof import('../../src/middleware/auth.js')>()),
    requireAuth: mockedRequireAuth,
    requireAdmin: passThrough,
    requireGlobalAdmin: [mockedRequireAuth, globalGate, passThrough],
    optionalAuth: passThrough,
  };
});

vi.mock('../../src/db/certification-db.js', () => mockCertDb);
vi.mock('../../src/db/client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/db/client.js')>()),
  query: mockQuery,
}));
vi.mock('../../src/services/certification-credential-issuance.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/certification-credential-issuance.js')>()),
  ensureCertifierCredential: mockEnsureCredential,
}));

import { createCertificationRouters } from '../../src/routes/certification.js';

const USER_ID = 'user_learner';
const CREDENTIAL_ID = 'specialist_signals';
const REASON = 'Escalation #6032 credential recovery';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/certification', createCertificationRouters().adminRouter);
  return app;
}

describe('admin credential reissue route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.allowGlobalAdmin = true;
    mockCertDb.getCredential.mockResolvedValue({
      id: CREDENTIAL_ID,
      name: 'AdCP Specialist — Signals',
      certifier_group_id: 'group_signals',
    });
    mockCertDb.recordAdminCredentialReissueEvent.mockResolvedValue(undefined);
    mockQuery.mockResolvedValue({ rows: [{
      certifier_credential_id: null,
      certifier_public_id: null,
      certifier_badge_url: null,
    }] });
    mockEnsureCredential.mockResolvedValue({
      outcome: 'issued',
      credentialId: 'cert_new',
      publicId: 'public_new',
      badgeUrl: 'https://cdn.test/badge.png',
      emailDelivery: 'sent',
    });
  });

  it('recovers an earned credential and appends actor-attributed audit events', async () => {
    const response = await request(buildApp())
      .post(`/api/admin/certification/learners/${USER_ID}/credentials/${CREDENTIAL_ID}/reissue`)
      .send({ reason: REASON });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      outcome: 'issued',
      issued: true,
      badge_available: true,
      email_delivery: 'sent',
    });
    expect(response.body.operation_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(mockEnsureCredential).toHaveBeenCalledWith({ userId: USER_ID, credentialId: CREDENTIAL_ID });
    expect(mockCertDb.recordAdminCredentialReissueEvent).toHaveBeenCalledTimes(2);
    expect(mockCertDb.recordAdminCredentialReissueEvent).toHaveBeenNthCalledWith(1, expect.objectContaining({
      userId: USER_ID,
      credentialId: CREDENTIAL_ID,
      adminUserId: 'user_test_admin',
      reason: REASON,
      eventType: 'started',
    }));
    expect(mockCertDb.recordAdminCredentialReissueEvent).toHaveBeenNthCalledWith(2, expect.objectContaining({
      eventType: 'succeeded',
    }));
  });

  it('returns partial-success semantics when the success audit append fails', async () => {
    mockCertDb.recordAdminCredentialReissueEvent
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('audit unavailable'));

    const response = await request(buildApp())
      .post(`/api/admin/certification/learners/${USER_ID}/credentials/${CREDENTIAL_ID}/reissue`)
      .send({ reason: REASON });

    expect(response.status).toBe(200);
    expect(response.body.credential.certifier_credential_id).toBe('cert_new');
    expect(response.body.warnings[0]).toContain('audit event');
    expect(mockCertDb.recordAdminCredentialReissueEvent).toHaveBeenCalledTimes(2);
  });

  it('requires a bounded incident reason before performing an external action', async () => {
    const response = await request(buildApp())
      .post(`/api/admin/certification/learners/${USER_ID}/credentials/${CREDENTIAL_ID}/reissue`)
      .send({ reason: 'short' });

    expect(response.status).toBe(400);
    expect(mockEnsureCredential).not.toHaveBeenCalled();
    expect(mockCertDb.recordAdminCredentialReissueEvent).not.toHaveBeenCalled();
  });

  it('does not recover a credential the learner has not earned', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const response = await request(buildApp())
      .post(`/api/admin/certification/learners/${USER_ID}/credentials/${CREDENTIAL_ID}/reissue`)
      .send({ reason: REASON });

    expect(response.status).toBe(404);
    expect(response.body.error).toContain('has not earned');
    expect(mockEnsureCredential).not.toHaveBeenCalled();
    expect(mockCertDb.recordAdminCredentialReissueEvent).not.toHaveBeenCalled();
  });

  it('refuses tenant-scoped admin API keys through the global-admin gate', async () => {
    authState.allowGlobalAdmin = false;

    const response = await request(buildApp())
      .post(`/api/admin/certification/learners/${USER_ID}/credentials/${CREDENTIAL_ID}/reissue`)
      .send({ reason: REASON });

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('global_admin_required');
    expect(mockEnsureCredential).not.toHaveBeenCalled();
  });
});
