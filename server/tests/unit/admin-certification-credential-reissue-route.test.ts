import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockCertDb = vi.hoisted(() => ({
  getCredential: vi.fn(),
  awardCredential: vi.fn(),
}));
const mockQuery = vi.hoisted(() => vi.fn());
const mockCertifier = vi.hoisted(() => ({
  issueCredential: vi.fn(),
  isCertifierConfigured: vi.fn(),
  getCredentialBadgeUrl: vi.fn(),
  buildRecipientName: vi.fn((user: { first_name: string | null; last_name: string | null; email: string }) =>
    `${user.first_name ?? ''} ${user.last_name ?? ''}`.trim() || user.email),
}));

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
  const passThrough = (_req: any, _res: any, next: any) => next();
  return {
    ...(await importOriginal<typeof import('../../src/middleware/auth.js')>()),
    requireAuth: mockedRequireAuth,
    requireAdmin: passThrough,
    optionalAuth: passThrough,
  };
});

vi.mock('../../src/db/certification-db.js', () => mockCertDb);
vi.mock('../../src/db/client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/db/client.js')>()),
  query: mockQuery,
}));
vi.mock('../../src/services/certifier-client.js', () => mockCertifier);

import { createCertificationRouters } from '../../src/routes/certification.js';

const USER_ID = 'user_learner';
const CREDENTIAL_ID = 'specialist_signals';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/certification', createCertificationRouters().adminRouter);
  return app;
}

describe('admin credential reissue route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCertDb.getCredential.mockResolvedValue({
      id: CREDENTIAL_ID,
      name: 'AdCP Specialist — Signals',
      certifier_group_id: 'group_signals',
    });
    mockCertifier.isCertifierConfigured.mockReturnValue(true);
    mockCertifier.issueCredential.mockResolvedValue({ id: 'cert_new', publicId: 'public_new' });
    mockCertifier.getCredentialBadgeUrl.mockResolvedValue('https://cdn.test/badge.png');
    mockCertDb.awardCredential.mockResolvedValue({
      credential_id: CREDENTIAL_ID,
      certifier_credential_id: 'cert_new',
      certifier_public_id: 'public_new',
      certifier_badge_url: 'https://cdn.test/badge.png',
    });
  });

  it('issues and stores a missing external credential for an earned credential', async () => {
    mockQuery.mockResolvedValue({ rows: [{
      first_name: 'Test',
      last_name: 'Learner',
      email: 'learner@test.example',
      certifier_credential_id: null,
      certifier_public_id: null,
      certifier_badge_url: null,
    }] });

    const response = await request(buildApp())
      .post(`/api/admin/certification/learners/${USER_ID}/credentials/${CREDENTIAL_ID}/reissue`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ issued: true, badge_available: true });
    expect(mockCertifier.issueCredential).toHaveBeenCalledWith({
      groupId: 'group_signals',
      recipient: { name: 'Test Learner', email: 'learner@test.example' },
    });
    expect(mockCertDb.awardCredential).toHaveBeenCalledWith(
      USER_ID,
      CREDENTIAL_ID,
      'cert_new',
      'public_new',
      'https://cdn.test/badge.png',
    );
  });

  it('only retries badge lookup when the external credential already exists', async () => {
    mockQuery.mockResolvedValue({ rows: [{
      first_name: 'Test',
      last_name: 'Learner',
      email: 'learner@test.example',
      certifier_credential_id: 'cert_existing',
      certifier_public_id: 'public_existing',
      certifier_badge_url: null,
    }] });
    mockCertDb.awardCredential.mockResolvedValue({
      credential_id: CREDENTIAL_ID,
      certifier_credential_id: 'cert_existing',
      certifier_public_id: 'public_existing',
      certifier_badge_url: 'https://cdn.test/badge.png',
    });

    const response = await request(buildApp())
      .post(`/api/admin/certification/learners/${USER_ID}/credentials/${CREDENTIAL_ID}/reissue`);

    expect(response.status).toBe(200);
    expect(response.body.issued).toBe(false);
    expect(mockCertifier.issueCredential).not.toHaveBeenCalled();
    expect(mockCertifier.getCredentialBadgeUrl).toHaveBeenCalledWith('cert_existing');
  });

  it('does not issue a credential the learner has not earned', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const response = await request(buildApp())
      .post(`/api/admin/certification/learners/${USER_ID}/credentials/${CREDENTIAL_ID}/reissue`);

    expect(response.status).toBe(404);
    expect(response.body.error).toContain('has not earned');
    expect(mockCertifier.issueCredential).not.toHaveBeenCalled();
    expect(mockCertDb.awardCredential).not.toHaveBeenCalled();
  });
});
