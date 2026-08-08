import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  checkAndAwardCredentials: vi.fn(),
  hasEffectiveMembershipForUser: vi.fn(),
  ensureCertifierCredential: vi.fn(),
}));

vi.hoisted(() => {
  process.env.WORKOS_API_KEY ??= 'sk_test_mock_key';
  process.env.WORKOS_CLIENT_ID ??= 'client_mock_id';
  process.env.WORKOS_COOKIE_PASSWORD ??= 'test-cookie-password-at-least-32-chars-long';
});

vi.mock('../../src/middleware/auth.js', async (importOriginal) => {
  const passThrough = (_req: any, _res: any, next: any) => next();
  return {
    ...(await importOriginal<typeof import('../../src/middleware/auth.js')>()),
    requireAuth: passThrough,
    requireGlobalAdmin: [passThrough],
    optionalAuth: passThrough,
  };
});

vi.mock('../../src/db/client.js', () => ({
  query: mocks.query,
}));

vi.mock('../../src/db/certification-db.js', () => ({
  checkAndAwardCredentials: mocks.checkAndAwardCredentials,
  hasEffectiveMembershipForUser: mocks.hasEffectiveMembershipForUser,
}));

vi.mock('../../src/services/certifier-client.js', () => ({
  isCertifierConfigured: () => true,
}));

vi.mock('../../src/services/certification-credential-issuance.js', () => ({
  CertifierNotConfiguredError: class extends Error {},
  CredentialNameRequiredError: class extends Error {},
  CredentialNotEarnedError: class extends Error {},
  CredentialRecoveryConflictError: class extends Error {},
  ensureCertifierCredential: mocks.ensureCertifierCredential,
}));

import { createCertificationRouters } from '../../src/routes/certification.js';

function uuid(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

describe('admin certification badge backfill', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const inactive = Array.from({ length: 50 }, (_, index) => ({
      id: uuid(index + 1),
      workos_user_id: `inactive_${index}`,
      credential_id: 'practitioner',
      tier: 2,
      certifier_credential_id: null,
      certifier_public_id: null,
    }));
    const eligible = [{
      id: uuid(51),
      workos_user_id: 'free_learner',
      credential_id: 'basics',
      tier: 1,
      certifier_credential_id: null,
      certifier_public_id: null,
    }];

    mocks.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('SELECT DISTINCT workos_user_id FROM learner_progress')) {
        return { rows: [] };
      }
      if (sql.includes('FROM user_credentials uc')) {
        return { rows: params?.[0] === null ? inactive : eligible };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    mocks.hasEffectiveMembershipForUser.mockResolvedValue(false);
    mocks.ensureCertifierCredential.mockResolvedValue({ badgeUrl: 'https://badge.example.test/basics' });
  });

  it('paginates past inactive paid rows instead of starving eligible badges', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/admin/certification', createCertificationRouters().adminRouter);

    const response = await request(app)
      .post('/api/admin/certification/backfill-badges')
      .send({});

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      total: 51,
      updated: 1,
      skipped_inactive: 50,
    });
    expect(mocks.ensureCertifierCredential).toHaveBeenCalledTimes(1);
    expect(mocks.ensureCertifierCredential).toHaveBeenCalledWith({
      userId: 'free_learner',
      credentialId: 'basics',
    });
  });

  it('counts each failed issuance once when enforcing the 50-item batch cap', async () => {
    const eligible = Array.from({ length: 50 }, (_, index) => ({
      id: uuid(index + 1),
      workos_user_id: `free_${index}`,
      credential_id: 'basics',
      tier: 1,
      certifier_credential_id: null,
      certifier_public_id: null,
    }));
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT DISTINCT workos_user_id FROM learner_progress')) return { rows: [] };
      if (sql.includes('FROM user_credentials uc')) return { rows: eligible };
      throw new Error(`Unexpected query: ${sql}`);
    });
    mocks.ensureCertifierCredential.mockRejectedValue(new Error('provider unavailable'));
    const app = express();
    app.use(express.json());
    app.use('/api/admin/certification', createCertificationRouters().adminRouter);

    const response = await request(app)
      .post('/api/admin/certification/backfill-badges')
      .send({});

    expect(response.status).toBe(200);
    expect(response.body.total).toBe(50);
    expect(response.body.errors).toHaveLength(50);
    expect(mocks.ensureCertifierCredential).toHaveBeenCalledTimes(50);
  });

  it('bounds inactive-row scanning and resumes from the returned cursor', async () => {
    const inactive = Array.from({ length: 500 }, (_, index) => ({
      id: uuid(index + 1),
      workos_user_id: `inactive_${index}`,
      credential_id: 'practitioner',
      tier: 2,
      certifier_credential_id: null,
      certifier_public_id: null,
    }));
    const eligible = {
      id: uuid(501),
      workos_user_id: 'free_after_bound',
      credential_id: 'basics',
      tier: 1,
      certifier_credential_id: null,
      certifier_public_id: null,
    };
    const allRows = [...inactive, eligible];
    mocks.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('SELECT DISTINCT workos_user_id FROM learner_progress')) return { rows: [] };
      if (sql.includes('FROM user_credentials uc')) {
        const cursor = params?.[0];
        const start = cursor == null
          ? 0
          : allRows.findIndex(row => row.id === cursor) + 1;
        return { rows: allRows.slice(start, start + 50) };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    const app = express();
    app.use(express.json());
    app.use('/api/admin/certification', createCertificationRouters().adminRouter);

    const first = await request(app)
      .post('/api/admin/certification/backfill-badges')
      .send({});

    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      total: 500,
      updated: 0,
      skipped_inactive: 500,
      has_more: true,
      next_cursor: uuid(500),
    });
    expect(mocks.ensureCertifierCredential).not.toHaveBeenCalled();

    const second = await request(app)
      .post('/api/admin/certification/backfill-badges')
      .send({ cursor: first.body.next_cursor });

    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({
      total: 1,
      updated: 1,
      has_more: false,
      next_cursor: null,
    });
    expect(mocks.ensureCertifierCredential).toHaveBeenCalledWith({
      userId: 'free_after_bound',
      credentialId: 'basics',
    });
  });
});
