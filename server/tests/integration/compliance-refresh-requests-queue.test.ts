import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { closeDatabase, initializeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  assertComplianceRefreshAuthorizationFingerprint,
  ComplianceRefreshInProgressError,
  ComplianceRefreshProvenanceError,
  ComplianceRefreshRateLimitError,
  ComplianceRefreshRequestsDatabase,
} from '../../src/db/compliance-refresh-requests-db.js';

describe('durable compliance refresh request queue', () => {
  let pool: Pool;
  let db: ComplianceRefreshRequestsDatabase;
  const ids: string[] = [];

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
    db = new ComplianceRefreshRequestsDatabase();
  });

  beforeEach(async () => {
    await pool.query(
      `INSERT INTO users (workos_user_id, email) VALUES ('user-refresh-test', 'refresh@example.test'), ('user-other', 'other@example.test')
       ON CONFLICT (workos_user_id) DO NOTHING`,
    );
    await pool.query("DELETE FROM authorization_epochs WHERE workos_user_id IN ('user-refresh-test', 'user-other')");
    await pool.query('DELETE FROM agent_compliance_refresh_requests WHERE id = ANY($1::uuid[])', [[...ids]]);
    ids.length = 0;
  });

  afterAll(async () => {
    if (ids.length > 0) {
      await pool.query('DELETE FROM agent_compliance_refresh_requests WHERE id = ANY($1::uuid[])', [[...ids]]);
    }
    await pool.query("DELETE FROM users WHERE workos_user_id IN ('user-refresh-test', 'user-other')");
    await closeDatabase();
  });

  async function enqueue(overrides: Partial<Parameters<ComplianceRefreshRequestsDatabase['createOrGetActive']>[0]> = {}) {
    const id = overrides.id ?? randomUUID();
    ids.push(id);
    return db.createOrGetActive({
      id,
      agentUrl: `https://${randomUUID()}.example.test/mcp`,
      ownerOrgId: 'org-refresh-test',
      requesterType: 'user',
      requestedByUserId: 'user-refresh-test',
      requestedByAuthWorkosUserId: 'user-refresh-test',
      authorizationFingerprint: '',
      triggeredBy: 'owner_test',
      ...overrides,
    });
  }

  async function complete(id: string, leaseToken: string, result: Record<string, unknown>) {
    const request = (await db.getById(id))!;
    return db.markSucceeded(id, leaseToken, result, client => assertComplianceRefreshAuthorizationFingerprint(
      client, request.requested_by_auth_workos_user_id, request.authorization_fingerprint,
    ));
  }

  it('persists a stable test-session identity without credential material', async () => {
    const created = await enqueue();
    const stored = await db.getById(created.request.id);

    expect(stored).toMatchObject({
      status: 'queued',
      owner_org_id: 'org-refresh-test',
      requested_by_auth_workos_user_id: 'user-refresh-test',
      authorization_fingerprint: '',
      test_session_id: `owner-refresh-${created.request.id}`,
      result_json: null,
    });
    expect(Object.keys(stored ?? {})).not.toEqual(expect.arrayContaining([
      'auth',
      'token',
      'client_secret',
    ]));
  });

  it('coalesces the same credential context across database instances', async () => {
    const agentUrl = `https://${randomUUID()}.example.test/mcp`;
    const first = await enqueue({ agentUrl });
    const duplicateId = randomUUID();
    ids.push(duplicateId);
    const secondDb = new ComplianceRefreshRequestsDatabase();
    const duplicate = await secondDb.createOrGetActive({
      id: duplicateId,
      agentUrl,
      ownerOrgId: 'org-refresh-test',
      requesterType: 'user',
      requestedByUserId: 'user-refresh-test',
      requestedByAuthWorkosUserId: 'user-refresh-test',
      authorizationFingerprint: '',
      triggeredBy: 'owner_test',
    });

    expect(duplicate.coalesced).toBe(true);
    expect(duplicate.request.id).toBe(first.request.id);
  });

  it('rejects coalescing across owner-organization or admin credential contexts', async () => {
    const agentUrl = `https://${randomUUID()}.example.test/mcp`;
    await enqueue({ agentUrl });

    for (const context of [
      { ownerOrgId: 'org-other', requesterType: 'user' as const, requestedByUserId: 'user-other', requestedByAuthWorkosUserId: 'user-other', triggeredBy: 'owner_test' as const },
      { ownerOrgId: 'org-refresh-test', requesterType: 'user' as const, requestedByUserId: 'user-other', requestedByAuthWorkosUserId: 'user-other', triggeredBy: 'owner_test' as const },
    ]) {
      const id = randomUUID();
      ids.push(id);
      await expect(db.createOrGetActive({ id, agentUrl, authorizationFingerprint: '', ...context }))
        .rejects.toBeInstanceOf(ComplianceRefreshInProgressError);
    }
  });

  it.each(['queued', 'succeeded'] as const)('rejects malformed caller provenance before coalescing a %s operation', async (status) => {
    const first = await enqueue();
    if (status === 'succeeded') {
      const [claimed] = (await db.claimDue('worker-test', 1, 60_000)).requests;
      await complete(claimed.id, claimed.lease_token, { online: true });
    }
    for (const credential of [undefined, null, '', '   ', ' user-refresh-test ', 'user-linked']) {
      await expect(enqueue({
        agentUrl: first.request.agent_url,
        requestedByAuthWorkosUserId: credential,
      })).rejects.toBeInstanceOf(ComplianceRefreshProvenanceError);
    }
    const duplicate = await enqueue({ agentUrl: first.request.agent_url });
    expect(duplicate.coalesced).toBe(true);
    expect(duplicate.request.id).toBe(first.request.id);
  });

  it('does not coalesce a recent terminal operation from another authenticated credential', async () => {
    const first = await enqueue();
    const [claimed] = (await db.claimDue('worker-test', 1, 60_000)).requests;
    await complete(claimed.id, claimed.lease_token, { online: true });
    await expect(enqueue({
      agentUrl: first.request.agent_url,
      requestedByUserId: 'user-other',
      requestedByAuthWorkosUserId: 'user-other',
    })).rejects.toBeInstanceOf(ComplianceRefreshRateLimitError);
  });

  it('claims once across workers and preserves session identity on lease recovery', async () => {
    const created = await enqueue();
    const [workerA, workerB] = await Promise.all([
      db.claimDue('worker-a', 1, 60_000),
      new ComplianceRefreshRequestsDatabase().claimDue('worker-b', 1, 60_000),
    ]);
    expect(workerA.requests.length + workerB.requests.length).toBe(1);
    const firstClaim = [...workerA.requests, ...workerB.requests][0];
    expect(firstClaim.test_session_id).toBe(`owner-refresh-${created.request.id}`);

    await pool.query(
      `UPDATE agent_compliance_refresh_requests
          SET lease_expires_at = NOW() - INTERVAL '1 second'
        WHERE id = $1`,
      [created.request.id],
    );
    const [reclaimed] = (await db.claimDue('worker-c', 1, 60_000)).requests;
    expect(reclaimed.was_reclaimed).toBe(true);
    expect(reclaimed.test_session_id).toBe(firstClaim.test_session_id);
    await expect(complete(created.request.id, firstClaim.lease_token, { online: true }))
      .resolves.toBe(false);
    await expect(complete(created.request.id, reclaimed.lease_token, { online: true }))
      .resolves.toBe(true);
  });

  it('does not reclaim an expired lease while its execution fence is held', async () => {
    const created = await enqueue();
    const [claimed] = (await db.claimDue('worker-a', 1, 60_000)).requests;
    const fence = await db.acquireExecutionFence(created.request.id, created.request.agent_url);
    expect(fence).not.toBeNull();

    await pool.query(
      `UPDATE agent_compliance_refresh_requests
          SET lease_expires_at = NOW() - INTERVAL '1 second'
        WHERE id = $1`,
      [created.request.id],
    );
    expect((await db.claimDue('worker-b', 1, 60_000)).requests).toHaveLength(0);

    await fence?.release();
    const [reclaimed] = (await db.claimDue('worker-b', 1, 60_000)).requests;
    expect(reclaimed.was_reclaimed).toBe(true);
    expect(reclaimed.test_session_id).toBe(claimed.test_session_id);
  });

  it('defers without consuming an attempt while a heartbeat owns the agent fence', async () => {
    const created = await enqueue();
    const heartbeatFence = await db.acquireAgentExecutionFence(created.request.agent_url);
    expect(heartbeatFence).not.toBeNull();
    const [claimed] = (await db.claimDue('worker-a', 1, 60_000)).requests;

    expect(await db.acquireExecutionFence(claimed.id, claimed.agent_url)).toBeNull();
    expect(await db.deferClaim(claimed.id, claimed.lease_token, 0)).toBe(true);
    expect(await db.getById(claimed.id)).toMatchObject({ status: 'queued', attempts: 0 });

    await heartbeatFence?.release();
    const [reclaimed] = (await db.claimDue('worker-b', 1, 60_000)).requests;
    expect(reclaimed).toMatchObject({ status: 'running', attempts: 1 });
  });

  it('caps each requester active queue footprint', async () => {
    await enqueue();
    await enqueue();
    await enqueue();

    await expect(enqueue()).rejects.toMatchObject<Partial<ComplianceRefreshRateLimitError>>({
      name: 'ComplianceRefreshRateLimitError',
      scope: 'requester',
    });
  });

  it.each(['queued', 'succeeded'] as const)('rejects absent or malformed fingerprints before %s coalescing', async status => {
    const first = await enqueue();
    if (status === 'succeeded') {
      const [claim] = (await db.claimDue('worker', 1, 60_000)).requests;
      await complete(claim.id, claim.lease_token, { online: true });
    }
    for (const fingerprint of [undefined, null, '__unproven__', 'user-other:1', 'user-refresh-test:0',
      'user-refresh-test:01', 'user-refresh-test:9223372036854775808', 'user-refresh-test:1,user-other:2']) {
      await expect(enqueue({ agentUrl: first.request.agent_url, authorizationFingerprint: fingerprint as string }))
        .rejects.toBeInstanceOf(ComplianceRefreshProvenanceError);
    }
    await expect(enqueue({ agentUrl: first.request.agent_url, requesterType: 'static_admin',
      requestedByUserId: null, requestedByAuthWorkosUserId: null }))
      .rejects.toBeInstanceOf(ComplianceRefreshProvenanceError);
  });

  it('rejects missing local credential authority as unavailable', async () => {
    await pool.query("DELETE FROM users WHERE workos_user_id = 'user-refresh-test'");
    await expect(enqueue()).rejects.toMatchObject({ code: 'authorization_unavailable' });
  });

  it.each(['queued', 'running', 'succeeded', 'failed'] as const)('rejects stale epoch admission and replaces a revoked %s context', async status => {
    const first = await enqueue();
    if (status !== 'queued') {
      const [claim] = (await db.claimDue('worker', 1, 60_000)).requests;
      if (status === 'succeeded') await complete(claim.id, claim.lease_token, { online: true });
      if (status === 'failed') await db.markFailed(claim.id, claim.lease_token, 'authorization_revoked', 'Revoked');
    }
    await pool.query("INSERT INTO authorization_epochs (workos_user_id, epoch) VALUES ('user-refresh-test', 1)");
    await expect(enqueue({ agentUrl: first.request.agent_url })).rejects.toMatchObject({ code: 'authorization_revoked' });
    const fresh = await enqueue({ agentUrl: first.request.agent_url, authorizationFingerprint: 'user-refresh-test:1', requesterLimit: 1 });
    expect(fresh.coalesced).toBe(false);
    expect(fresh.request.id).not.toBe(first.request.id);
    expect(fresh.request.authorization_fingerprint).toBe('user-refresh-test:1');
    if (status === 'queued' || status === 'running') {
      expect(await db.getById(first.request.id)).toMatchObject({ status: 'failed', last_error_code: 'authorization_revoked' });
    }
  });

  it('retains a revoked active request until its execution fence is released', async () => {
    const first = await enqueue();
    const fence = await db.acquireExecutionFence(first.request.id, first.request.agent_url);
    await pool.query("INSERT INTO authorization_epochs (workos_user_id, epoch) VALUES ('user-refresh-test', 1)");
    const replacement = { agentUrl: first.request.agent_url, authorizationFingerprint: 'user-refresh-test:1' };
    try {
      await expect(enqueue(replacement)).rejects.toBeInstanceOf(ComplianceRefreshInProgressError);
      expect((await db.getById(first.request.id))?.status).toBe('queued');
    } finally {
      await fence?.release();
    }
    expect((await enqueue(replacement)).coalesced).toBe(false);
  });

  it('reads an epoch committed while admission waited for its exact user lock', async () => {
    const blocker = await pool.connect();
    await blocker.query('BEGIN');
    await blocker.query("SELECT workos_user_id FROM users WHERE workos_user_id = 'user-refresh-test' FOR UPDATE");
    await blocker.query("INSERT INTO authorization_epochs (workos_user_id, epoch) VALUES ('user-refresh-test', 1)");
    const admission = enqueue().then(value => ({ value }), error => ({ error }));
    try {
      await vi.waitFor(async () => {
        const waiting = await pool.query(`SELECT COUNT(*)::integer AS count FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND query LIKE 'SELECT workos_user_id FROM users WHERE workos_user_id = $1 FOR UPDATE%'`);
        expect(waiting.rows[0].count).toBeGreaterThan(0);
      });
      await blocker.query('COMMIT');
      expect(await admission).toMatchObject({ error: { code: 'authorization_revoked' } });
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      await admission;
    }
  });

  it.each([false, true])('holds the %s existing-epoch fence against a concurrent mutation', async existing => {
    if (existing) await pool.query("INSERT INTO authorization_epochs (workos_user_id, epoch) VALUES ('user-refresh-test', 1)");
    const locked = await pool.connect();
    const writer = await pool.connect();
    try {
      await locked.query('BEGIN');
      await assertComplianceRefreshAuthorizationFingerprint(locked, 'user-refresh-test', existing ? 'user-refresh-test:1' : '');
      await writer.query('BEGIN');
      await writer.query("SET LOCAL lock_timeout = '50ms'");
      const mutation = existing
        ? "UPDATE authorization_epochs SET epoch = 2 WHERE workos_user_id = 'user-refresh-test'"
        : "INSERT INTO authorization_epochs (workos_user_id, epoch) VALUES ('user-refresh-test', 1)";
      await expect(writer.query(mutation)).rejects.toMatchObject({ code: '55P03' });
      await writer.query('ROLLBACK');
      await locked.query('COMMIT');
      await writer.query(mutation);
    } finally {
      await locked.query('ROLLBACK');
      await writer.query('ROLLBACK');
      locked.release();
      writer.release();
    }
  });

  it('rolls back completion writes when the same-transaction authorization callback rejects', async () => {
    const first = await enqueue();
    const [claim] = (await db.claimDue('worker', 1, 60_000)).requests;
    await expect(db.markSucceeded(first.request.id, claim.lease_token, { online: true }, async client => {
      await client.query("UPDATE users SET email = 'must-rollback@example.test' WHERE workos_user_id = 'user-refresh-test'");
      throw Object.assign(new Error('Revoked'), { code: 'authorization_revoked' });
    })).rejects.toMatchObject({ code: 'authorization_revoked' });
    expect((await pool.query("SELECT email FROM users WHERE workos_user_id = 'user-refresh-test'")).rows[0].email)
      .toBe('refresh@example.test');
    expect(await db.getById(first.request.id)).toMatchObject({ status: 'running', result_json: null });
    await expect(db.markSucceeded(first.request.id, claim.lease_token, {}, undefined as never))
      .rejects.toMatchObject({ code: 'authorization_unavailable' });
  });

  it('refuses completion when its captured authorization epoch has changed', async () => {
    const first = await enqueue();
    const [claim] = (await db.claimDue('worker', 1, 60_000)).requests;
    await pool.query("INSERT INTO authorization_epochs (workos_user_id, epoch) VALUES ('user-refresh-test', 1)");
    await expect(complete(first.request.id, claim.lease_token, { online: true }))
      .rejects.toMatchObject({ code: 'authorization_revoked' });
    expect(await db.getById(first.request.id)).toMatchObject({ status: 'running', result_json: null });
  });

});
