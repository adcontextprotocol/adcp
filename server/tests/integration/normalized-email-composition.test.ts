// Run in a disposable checkout of published #7463 with exact 8847fc route and
// migration 595 overlaid. See specs/normalized-email-invariant.md. These source
// hashes prevent a simplified verifier from masquerading as composition proof.
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import { Client, type Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';

const { provider } = vi.hoisted(() => ({ provider: { getUser: vi.fn(), updateUser: vi.fn(), createUser: vi.fn(), deleteUser: vi.fn() } }));
vi.mock('../../src/auth/workos-client.js', () => ({ getWorkos: () => ({ userManagement: provider }), getEmailMutationWorkos: () => ({ userManagement: provider }) }));
vi.mock('../../src/notifications/email.js', () => ({ sendEmailLinkVerification: vi.fn() }));
vi.mock('../../src/db/user-merge-db.js', () => ({ mergeUsers: vi.fn() }));
vi.mock('../../src/middleware/auth.js', () => ({ requireAuth: (req: { user?: unknown }, _res: unknown, next: () => void) => {
  req.user = { id: 'user_normalized_comp_a', authWorkosUserId: 'user_normalized_comp_a',
    authorizationSnapshot: { authenticatedUserId: 'user_normalized_comp_a' } };
  next();
}, invalidateSessionsForUsers: vi.fn() }));
vi.mock('express-rate-limit', () => ({ default: () => (_req: unknown, _res: unknown, next: () => void) => next() }));
import { createAccountLinkingRouter, handleEmailLinkVerification } from '../../src/routes/account-linking.js';

const A = 'user_normalized_comp_a', B = 'user_normalized_comp_b', token = 'normalized-comp-token';
const email = 'normalized-comp-target@test.example';
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function blob(source: Buffer) { return createHash('sha1').update(`blob ${source.length}\0`).update(source).digest('hex'); }

describe.runIf(process.env.ADCP_EMAIL_COMPOSITION === 'true')('exact 592 + 8847fc + 595 composition', () => {
  let pool: Pool;
  const app = express();
  app.use(express.json());
  app.use('/linked-emails', createAccountLinkingRouter());
  handleEmailLinkVerification(app);
  const submit = () => request(app).post('/verify-email-link').type('form').send({ token });
  beforeAll(async () => {
    expect(blob(await fs.readFile(new URL('../../src/routes/account-linking.ts', import.meta.url)))).toBe('ab283d29b754dd083d31c645a49ef56fbb94e2da');
    expect(blob(await fs.readFile(new URL('../../src/db/migrations/592_email_mutations.sql', import.meta.url)))).toBe('e726bbaaa214105df6a922773f7c208bb4919966');
    expect(blob(await fs.readFile(new URL('./alias-verification-atomicity.test.ts', import.meta.url)))).toBe('0cef113161f9bed39a9c52e1f67d0f555771098b');
    const url = new URL(process.env.DATABASE_URL!);
    if (url.hostname !== '127.0.0.1' || !url.pathname.includes('test')) throw new Error('Use a disposable local test database');
    pool = initializeDatabase({ connectionString: url.toString() });
    await runMigrations();
  }, 60000);
  beforeEach(async () => {
    vi.restoreAllMocks(); vi.clearAllMocks();
    for (const mock of Object.values(provider)) mock.mockReset();
    await pool.query('DELETE FROM email_mutations WHERE workos_user_id=ANY($1)', [[A, B]]);
    await pool.query('DELETE FROM users WHERE workos_user_id=ANY($1)', [[A, B]]);
    await pool.query('INSERT INTO users(workos_user_id,email) VALUES($1,$2),($3,$4)', [A, 'normalized-comp-a@test.example', B, 'normalized-comp-b@test.example']);
    await pool.query("INSERT INTO email_link_tokens(token,primary_workos_user_id,target_email,expires_at) VALUES($1,$2,$3,NOW()+INTERVAL '1 day')", [token, A, email]);
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    if (pool) {
      await pool.query('DELETE FROM email_mutations WHERE workos_user_id=ANY($1)', [[A, B]]);
      await pool.query('DELETE FROM users WHERE workos_user_id=ANY($1)', [[A, B]]);
    }
    await closeDatabase();
  });
  async function check(failed: boolean) {
    expect((await pool.query('SELECT status FROM email_link_tokens WHERE token=$1', [token])).rows[0].status).toBe(failed ? 'pending' : 'verified');
    await pool.query('SELECT public.check_normalized_email_invariant()');
    for (const mock of Object.values(provider)) expect(mock).not.toHaveBeenCalled();
  }
  it.each(['INSERT', 'UPDATE'])('rejects verification when a competing users %s commits after its users predicate', async action => {
    if (action === 'INSERT') await pool.query('DELETE FROM users WHERE workos_user_id=$1', [B]);
    const checked = barrier(), release = barrier();
    const query = Client.prototype.query;
    vi.spyOn(Client.prototype, 'query').mockImplementation(function (this: Client, ...args: any[]): any {
      const result = (query as any).apply(this, args);
      if (typeof args[0] === 'string' && args[0].includes('SELECT workos_user_id FROM users WHERE LOWER(email)')) {
        return result.then(async (value: unknown) => { checked.resolve(); await release.promise; return value; });
      }
      return result;
    });
    const verifying = submit().then(result => result);
    try {
      await checked.promise;
      const written = action === 'INSERT'
        ? await pool.query('INSERT INTO users(workos_user_id,email) VALUES($1,$2)', [B, email])
        : await pool.query('UPDATE users SET email=$2 WHERE workos_user_id=$1', [B, email]);
      expect(written.rowCount).toBe(1);
    } finally { release.resolve(); }
    expect((await verifying).text).toContain('Verification Failed');
    await check(true);
  });
  it('allows verified success only when the competing credential writer fails', async () => {
    const checked = barrier(), release = barrier();
    const query = Client.prototype.query;
    vi.spyOn(Client.prototype, 'query').mockImplementation(function (this: Client, ...args: any[]): any {
      const result = (query as any).apply(this, args);
      if (typeof args[0] === 'string' && args[0].includes('INSERT INTO user_email_aliases')) {
        return result.then(async (value: unknown) => { checked.resolve(); await release.promise; return value; });
      }
      return result;
    });
    const verifying = submit().then(result => result);
    try {
      await checked.promise;
      await expect(pool.query('UPDATE users SET email=$2 WHERE workos_user_id=$1', [B, email])).rejects.toMatchObject({ code: '55P03' });
    } finally { release.resolve(); }
    expect((await verifying).text).toContain('Email Linked');
    await expect(pool.query('UPDATE users SET email=$2 WHERE workos_user_id=$1', [B, email])).rejects.toMatchObject({ code: '23505' });
    await check(false);
  });
  it('makes no provider call after mounted primary-email local preflight denial', async () => {
    await request(app).put('/linked-emails/primary').send({ email, operation_id: randomUUID() }).expect(404);
    for (const mock of Object.values(provider)) expect(mock).not.toHaveBeenCalled();
    expect((await pool.query('SELECT 1 FROM email_mutations WHERE workos_user_id=$1', [A])).rowCount).toBe(0);
  });
  it('retains durable reconciliation when the common lock denies local apply and compensation', async () => {
    await pool.query('INSERT INTO user_email_aliases(workos_user_id,email) VALUES($1,$2)', [A, email]);
    const original = { id: A, email: 'normalized-comp-a@test.example', emailVerified: false };
    provider.getUser.mockResolvedValue(original);
    provider.updateUser.mockImplementation(async ({ email: next, emailVerified }) => ({ id: A, email: next, emailVerified }));
    const blocker = await pool.connect();
    const operationId = randomUUID();
    try {
      await blocker.query('BEGIN');
      await blocker.query('INSERT INTO user_email_aliases(workos_user_id,email) VALUES($1,$2)', [B, 'normalized-comp-lock@test.example']);
      const response = await request(app).put('/linked-emails/primary').send({ email, operation_id: operationId }).expect(409);
      expect(response.body).toMatchObject({ reconciliation_required: true, operation_id: operationId });
      expect((await pool.query('SELECT state FROM email_mutations WHERE id=$1', [operationId])).rows[0].state).toBe('reconciliation_required');
      expect((await pool.query('SELECT email FROM users WHERE workos_user_id=$1', [A])).rows[0].email).toBe(original.email);
      expect(provider.updateUser).toHaveBeenCalledTimes(2);
      expect(provider.updateUser).toHaveBeenLastCalledWith({ userId: A, email: original.email, emailVerified: false });
    } finally { await blocker.query('ROLLBACK'); blocker.release(); }
    vi.clearAllMocks();
    await request(app).put('/linked-emails/primary').send({ email, operation_id: operationId }).expect(409);
    for (const mock of Object.values(provider)) expect(mock).not.toHaveBeenCalled();
    await pool.query('SELECT public.check_normalized_email_invariant()');
  });
});
