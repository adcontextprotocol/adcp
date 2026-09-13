import { beforeEach, describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { isEmailUnavailable } from '../../src/routes/account-linking-errors.js';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  status: vi.fn(),
  mutate: vi.fn(),
}));
vi.mock('../../src/db/client.js', () => ({ query: mocks.query, getPool: vi.fn() }));
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
import { createAccountLinkingRouter } from '../../src/routes/account-linking.js';
import { EmailMutationError } from '../../src/services/email-mutation.js';

const app = express();
app.use(express.json());
app.use('/api/me/linked-emails', createAccountLinkingRouter());

beforeEach(() => {
  vi.clearAllMocks();
  mocks.status.mockResolvedValue({ reconciliation_required: false });
  mocks.query.mockResolvedValue({ rows: [] });
});

describe('Primary email credential boundary', () => {
  it('mutates the credential that authenticated, regardless of canonical identity direction', async () => {
    mocks.mutate.mockResolvedValue({ primary_email: 'new@example.test' });
    const response = await request(app).put('/api/me/linked-emails/primary').send({ email: 'new@example.test' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'primary_updated', primary_email: 'new@example.test' });
    expect(mocks.mutate).toHaveBeenCalledWith({ userId: 'user_credential', actorUserId: 'user_credential', email: 'new@example.test' });
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
    expect(response.body.reconciliation_required).toBe(true);
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
      primary_email: 'credential@example.test', aliases: [], pending: [],
      reconciliation_required: true, operation_id: 'operation-1', message: 'Contact support.',
    });
  });

  it('blocks new email verification while reconciliation is outstanding', async () => {
    mocks.status.mockResolvedValue({ reconciliation_required: true, message: 'Contact support.' });
    const response = await request(app).post('/api/me/linked-emails').send({ email: 'new@example.test' });
    expect(response.status).toBe(409);
    expect(response.body.reconciliation_required).toBe(true);
    expect(mocks.query).not.toHaveBeenCalled();
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
