import { beforeEach, describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { isEmailUnavailable } from '../../src/routes/account-linking-errors.js';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  status: vi.fn(),
  mutate: vi.fn(),
  clientQuery: vi.fn(),
  release: vi.fn(),
}));
const client = { query: mocks.clientQuery, release: mocks.release };
vi.mock('../../src/db/client.js', () => ({ query: mocks.query, getPool: () => ({ connect: async () => client }) }));
vi.mock('../../src/middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: 'user_canonical', authWorkosUserId: 'user_credential', email: 'canonical@example.test' };
    next();
  },
}));
vi.mock('express-rate-limit', () => ({ default: () => (_req: any, _res: any, next: any) => next() }));
vi.mock('../../src/middleware/pg-rate-limit-store.js', () => ({ CachedPostgresStore: class {} }));
vi.mock('../../src/notifications/email.js', () => ({ sendEmailLinkVerification: vi.fn() }));
vi.mock('../../src/services/email-mutation.js', () => ({
  getEmailMutationStatus: mocks.status,
  setPrimaryEmail: mocks.mutate,
  EmailMutationError: class extends Error {
    constructor(public status: number, public body: Record<string, unknown>) { super('Email mutation failed'); }
  },
}));
import { createAccountLinkingRouter, handleEmailLinkVerification } from '../../src/routes/account-linking.js';
import { EmailMutationError } from '../../src/services/email-mutation.js';

const app = express();
app.use(express.json());
app.use('/api/me/linked-emails', createAccountLinkingRouter());
handleEmailLinkVerification(app);
const operationId = '7bc02bce-fb04-47ac-8104-c3bb4b93a1e7';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.status.mockResolvedValue({ reconciliation_required: false });
  mocks.query.mockResolvedValue({ rows: [] });
  mocks.clientQuery.mockResolvedValue({ rows: [] });
});

describe('Primary email credential boundary', () => {
  it('mutates the credential that authenticated, regardless of canonical identity direction', async () => {
    mocks.mutate.mockResolvedValue({ status: 'primary_updated', primary_email: 'new@example.test', operation_id: operationId });
    const response = await request(app).put('/api/me/linked-emails/primary').send({ email: 'new@example.test', operation_id: operationId });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'primary_updated', primary_email: 'new@example.test', operation_id: operationId });
    expect(mocks.mutate).toHaveBeenCalledWith({ userId: 'user_credential', actorUserId: 'user_credential', email: 'new@example.test', operationId });
  });

  it('passes through the safe reconciliation response without claiming success', async () => {
    const body = { reconciliation_required: true, operation_id: 'operation-1', message: 'Contact support to reconcile this change.' };
    mocks.mutate.mockRejectedValue(new EmailMutationError(503, body));
    const response = await request(app).put('/api/me/linked-emails/primary').send({ email: 'new@example.test' });
    expect(response.status).toBe(503);
    expect(response.body).toEqual(body);
    expect(response.body.status).not.toBe('primary_updated');
  });

  it('fails closed without exposing unexpected provider exceptions', async () => {
    mocks.mutate.mockRejectedValue(new Error('Authorization: Bearer secret-token'));
    const response = await request(app).put('/api/me/linked-emails/primary').send({ email: 'new@example.test' });
    expect(response.status).toBe(503);
    expect(response.body.reconciliation_required).toBeUndefined();
    expect(response.body.status_unknown).toBe(true);
    expect(response.body.message).toMatch(/contact support/i);
    expect(JSON.stringify(response.body)).not.toContain('secret-token');
  });

  it('lists only the authenticated credential emails and durable reconciliation status', async () => {
    mocks.status.mockResolvedValue({ reconciliation_required: true, operation_id: 'operation-1', message: 'Contact support.' });
    mocks.query.mockImplementation(async (sql: string, params: unknown[]) => {
      expect(params).toEqual(['user_credential']);
      return { rows: sql.includes('SELECT email FROM users') ? [{ email: 'credential@example.test' }] : [] };
    });
    const response = await request(app).get('/api/me/linked-emails');
    expect(response.status).toBe(200);
    expect(mocks.status).toHaveBeenCalledWith('user_credential');
    expect(response.body).toEqual({
      credential_id: 'user_credential',
      primary_email: 'credential@example.test', aliases: [], pending: [],
      reconciliation_required: true, operation_id: 'operation-1', message: 'Contact support.',
    });
  });

  it('returns credential contention as retryable without inventing a reconciliation operation', async () => {
    const body = { error: 'credential_busy', message: 'Please retry.', retryable: true };
    mocks.mutate.mockRejectedValue(new EmailMutationError(409, body));
    const response = await request(app).put('/api/me/linked-emails/primary').send({ email: 'new@example.test', operation_id: operationId });
    expect(response.status).toBe(409);
    expect(response.body).toEqual(body);
    expect(response.body.reconciliation_required).toBeUndefined();
    expect(response.body.operation_id).toBeUndefined();
  });

  it('recovers a durable operation status after an unexpected failure without exposing diagnostics', async () => {
    mocks.mutate.mockRejectedValue(new Error('provider-secret'));
    const status = { reconciliation_required: true, operation_id: operationId, message: 'Contact support.' };
    mocks.status.mockResolvedValue(status);
    const response = await request(app).put('/api/me/linked-emails/primary').send({ email: 'new@example.test', operation_id: operationId });
    expect(response.status).toBe(503);
    expect(response.body).toEqual(status);
    expect(mocks.status).toHaveBeenCalledWith('user_credential');
  });

  it('checks verification reconciliation with the already-held transaction client', async () => {
    mocks.clientQuery.mockImplementation(async (sql: string) => ({
      rows: sql.includes('FROM email_link_tokens') ? [{
        id: 'token-id', primary_workos_user_id: 'user_credential', target_email: 'alias@example.test',
        status: 'pending', expires_at: new Date(Date.now() + 60_000),
      }] : [],
    }));
    mocks.status.mockResolvedValue({ reconciliation_required: true, message: 'Contact support.' });
    const response = await request(app).post('/verify-email-link').send({ token: 'verification-token' });
    expect(response.status).toBe(200);
    expect(mocks.status).toHaveBeenCalledExactlyOnceWith('user_credential', client);
    expect(mocks.clientQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledOnce();
    expect(response.text).toContain('Contact support.');
  });

  it('blocks new email verification while reconciliation is outstanding', async () => {
    mocks.status.mockResolvedValue({ reconciliation_required: true, message: 'Contact support.' });
    const response = await request(app).post('/api/me/linked-emails').send({ email: 'new@example.test' });
    expect(response.status).toBe(409);
    expect(response.body.reconciliation_required).toBe(true);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it.each(['reconciliation', 'busy', 'unknown'] as const)('surfaces a concurrent token writer failure as %s instead of an unclassified error', async (kind) => {
    mocks.status.mockResolvedValueOnce({ reconciliation_required: false });
    if (kind === 'reconciliation') {
      mocks.status.mockResolvedValueOnce({ reconciliation_required: true, operation_id: operationId, message: 'Contact support to reconcile.' });
    } else if (kind === 'unknown') {
      mocks.status.mockRejectedValueOnce(new Error('database diagnostic'));
    } else mocks.status.mockResolvedValueOnce({ reconciliation_required: false });
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO email_link_tokens')) throw Object.assign(new Error('database diagnostic'), { code: kind === 'busy' ? '55P03' : '23514' });
      if (sql.includes('COUNT(*)')) return { rows: [{ count: '0' }] };
      if (sql.includes('SELECT email FROM users')) return { rows: [{ email: 'credential@example.test' }] };
      return { rows: [] };
    });
    const response = await request(app).post('/api/me/linked-emails').send({ email: 'new@example.test' });
    expect(response.status).toBe(kind === 'busy' ? 409 : 503);
    expect(mocks.status).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(response.body)).not.toContain('diagnostic');
    if (kind === 'reconciliation') expect(response.body).toEqual({ reconciliation_required: true, operation_id: operationId, message: 'Contact support to reconcile.' });
    else {
      expect(response.body.reconciliation_required).toBeUndefined();
      expect(response.body.operation_id).toBeUndefined();
      if (kind === 'busy') expect(response.body).toMatchObject({ error: 'credential_busy', retryable: true });
      else expect(response.body.status_unknown).toBe(true);
    }
  });
});

describe('isEmailUnavailable', () => {
  it('matches WorkOS GenericServerException with "This email is not available" message', () => {
    expect(isEmailUnavailable({
      name: 'GenericServerException',
      status: 422,
      message: 'This email is not available.',
    })).toBe(true);
  });

  it('matches by code regardless of status', () => {
    expect(isEmailUnavailable({ code: 'email_already_exists' })).toBe(true);
    expect(isEmailUnavailable({ code: 'email_not_available' })).toBe(true);
  });

  it('matches a 409 conflict response', () => {
    expect(isEmailUnavailable({ status: 409, message: 'Conflict' })).toBe(true);
  });

  it('does NOT match a bare 422 with an unrelated validation message', () => {
    expect(isEmailUnavailable({
      status: 422,
      message: 'Password does not meet complexity requirements.',
    })).toBe(false);
  });

  it('does NOT match a generic server error', () => {
    expect(isEmailUnavailable({ status: 500, message: 'Internal server error' })).toBe(false);
  });

  it('does NOT match a vague "email already verified" message', () => {
    expect(isEmailUnavailable({ status: 422, message: 'Email already verified' })).toBe(false);
  });

  it('returns false for null/undefined', () => {
    expect(isEmailUnavailable(null)).toBe(false);
    expect(isEmailUnavailable(undefined)).toBe(false);
  });
});
