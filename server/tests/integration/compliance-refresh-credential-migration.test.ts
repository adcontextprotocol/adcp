import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool, type PoolClient } from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, initializeDatabase } from '../../src/db/client.js';
import {
  ComplianceRefreshRequestsDatabase,
  type ClaimedComplianceRefreshRequest,
} from '../../src/db/compliance-refresh-requests-db.js';
import { ComplianceRefreshQueue } from '../../src/services/compliance-refresh-queue.js';

const workos = vi.hoisted(() => {
  const getUser = vi.fn();
  return { getUser, getClient: vi.fn(() => ({ userManagement: { getUser } })) };
});
vi.mock('../../src/auth/workos-client.js', () => ({ getAuthorizationEnforcementWorkos: workos.getClient }));

import { authorizeComplianceRefresh } from '../../src/services/compliance-refresh-authorization.js';

const original = readFileSync(new URL('../../src/db/migrations/571_agent_compliance_refresh_requests.sql', import.meta.url), 'utf8');
const correction = readFileSync(new URL('../../src/db/migrations/591_compliance_refresh_authenticated_credential.sql', import.meta.url), 'utf8');
const connectionString = process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test';
const admin = new Pool({ connectionString });
const contract = "SELECT set_config('adcp.compliance_refresh_writer_contract', 'authenticated-credential-v1', true)";

// This is the pre-591 claim shape: it deliberately knows nothing about the new
// authenticated provenance fields or the worker-contract setting.
const oldClaim = `UPDATE agent_compliance_refresh_requests
  SET status = 'running', attempts = attempts + 1, lease_owner = 'old-worker',
      lease_token = gen_random_uuid(), lease_expires_at = NOW() + INTERVAL '1 minute'
  WHERE id = $1 RETURNING *`;

describe('compliance refresh authenticated credential migration', () => {
  let schema: string;
  let pool: Pool;
  let db: ComplianceRefreshRequestsDatabase;

  beforeEach(async () => {
    vi.clearAllMocks();
    schema = `refresh_credential_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(connectionString);
    scoped.searchParams.set('options', `-c search_path=${schema}`);
    pool = initializeDatabase({ connectionString: scoped.toString() });
    await pool.query('CREATE TABLE agent_compliance_runs (id UUID PRIMARY KEY)');
    await pool.query('CREATE TABLE users (workos_user_id TEXT PRIMARY KEY, email TEXT NOT NULL)');
    await pool.query(`CREATE TABLE authorization_epochs (
      workos_user_id TEXT PRIMARY KEY REFERENCES users(workos_user_id) ON DELETE CASCADE,
      epoch BIGINT NOT NULL DEFAULT 1
    )`);
    await pool.query("INSERT INTO users VALUES ('user-exact', 'exact@example.test')");
    await pool.query(original);
    db = new ComplianceRefreshRequestsDatabase();
  });

  afterEach(async () => {
    await closeDatabase();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  });

  afterAll(async () => { await admin.end(); });

  async function legacy(status: 'queued' | 'running' | 'succeeded' | 'failed', requesterType = 'user') {
    const id = randomUUID();
    const agentUrl = `https://${id}.example.test/mcp`;
    await pool.query(`INSERT INTO agent_compliance_refresh_requests
      (id, agent_url, owner_org_id, requester_type, requested_by_user_id, triggered_by, test_session_id,
       status, lease_owner, lease_token, lease_expires_at, result_json, completed_at)
      VALUES ($1, $2, NULL, $3, $4, 'manual', $5, $6,
        CASE WHEN $6 = 'running' THEN 'old-worker' END,
        CASE WHEN $6 = 'running' THEN gen_random_uuid() END,
        CASE WHEN $6 = 'running' THEN NOW() + INTERVAL '1 minute' END,
        CASE WHEN $6 = 'succeeded' THEN '{"online":true}'::jsonb END,
        CASE WHEN $6 IN ('succeeded', 'failed') THEN NOW() END)`,
    [id, agentUrl, requesterType, requesterType === 'user' ? 'user-canonical-linked' : null, `legacy-${id}`, status]);
    return { id, agentUrl };
  }

  async function migrate(client?: PoolClient): Promise<void> {
    const own = client ?? await pool.connect();
    try {
      await own.query('BEGIN');
      await own.query(correction);
      await own.query('COMMIT');
    } catch (error) {
      await own.query('ROLLBACK');
      throw error;
    } finally {
      if (!client) own.release();
    }
  }

  async function enqueue(agentUrl = `https://${randomUUID()}.example.test/mcp`) {
    return db.createOrGetActive({ id: randomUUID(), agentUrl, ownerOrgId: null, requesterType: 'user',
      requestedByUserId: 'user-exact', requestedByAuthWorkosUserId: 'user-exact',
      authorizationFingerprint: '', triggeredBy: 'manual', requesterLimit: 1 });
  }

  it('marks real legacy histories unproven, rejects pending jobs, and allows fresh resubmission', async () => {
    const queued = await legacy('queued');
    const staticQueued = await legacy('queued', 'static_admin');
    const succeeded = await legacy('succeeded');
    const failed = await legacy('failed');
    const historical = (await pool.query('SELECT * FROM agent_compliance_refresh_requests WHERE id = $1', [succeeded.id])).rows[0];
    await migrate();

    const rows = (await pool.query('SELECT * FROM agent_compliance_refresh_requests')).rows;
    for (const row of rows) {
      expect(row.requested_by_auth_workos_user_id).toBe('__unproven__');
      expect(row.authorization_fingerprint).toBe('__unproven__');
      expect(row.requested_by_user_id).toBe(row.requester_type === 'user' ? 'user-canonical-linked' : null);
    }
    for (const pending of [queued, staticQueued]) {
      expect(rows.find(row => row.id === pending.id)).toMatchObject({ status: 'failed',
        last_error_code: 'authorization_provenance_missing', lease_token: null, result_json: null });
    }
    expect(rows.find(row => row.id === succeeded.id)).toMatchObject({ status: 'succeeded',
      result_json: historical.result_json, completed_at: historical.completed_at });
    expect(rows.find(row => row.id === failed.id)?.status).toBe('failed');
    const fresh = await enqueue(queued.agentUrl);
    expect(fresh.coalesced).toBe(false);
    expect(fresh.request.id).not.toBe(queued.id);
    expect(fresh.request.authorization_fingerprint).toBe('');
    const shape = await pool.query(`SELECT column_name, is_nullable, column_default
      FROM information_schema.columns WHERE table_schema = $1
      AND table_name = 'agent_compliance_refresh_requests'
      AND column_name IN ('requested_by_auth_workos_user_id', 'authorization_fingerprint')`, [schema]);
    expect(shape.rows).toHaveLength(2);
    for (const column of shape.rows) expect(column).toMatchObject({ is_nullable: 'NO', column_default: null });
  });

  it('blocks actual workers and authorization for migrated queued user and static-admin jobs', async () => {
    const pending = [await legacy('queued'), await legacy('queued', 'static_admin')];
    await migrate();
    expect(await db.claimDue('new-worker', 2, 60_000)).toEqual({ requests: [], terminalizedExpired: 0 });

    const resolveSecrets = vi.fn();
    const executor = vi.fn(async (request: ClaimedComplianceRefreshRequest) => {
      await authorizeComplianceRefresh(request);
      await resolveSecrets();
      return { online: true };
    });
    const queue = new ComplianceRefreshQueue(executor, db, 'migration-proof-worker');
    expect(await queue.processQueue()).toEqual({ claimed: 0, succeeded: 0, failed: 0, lostLease: 0 });
    expect(executor).not.toHaveBeenCalled();
    expect(resolveSecrets).not.toHaveBeenCalled();

    for (const old of pending) {
      const migrated = (await db.getById(old.id))!;
      await expect(authorizeComplianceRefresh(migrated)).rejects.toMatchObject({
        code: 'authorization_provenance_missing',
        message: 'Authenticated credential provenance is missing; submit a new refresh',
      });
      expect(migrated).toMatchObject({ status: 'failed', requested_by_auth_workos_user_id: '__unproven__',
        authorization_fingerprint: '__unproven__', last_error_code: 'authorization_provenance_missing' });
    }
    expect(workos.getClient).not.toHaveBeenCalled();
    expect(workos.getUser).not.toHaveBeenCalled();

    const fresh = await enqueue(pending[0].agentUrl);
    expect(fresh.coalesced).toBe(false);
    expect(pending.map(old => old.id)).not.toContain(fresh.request.id);
    const claims = await db.claimDue('new-worker', 2, 60_000);
    expect(claims.requests.map(request => request.id)).toEqual([fresh.request.id]);
  });

  it('rejects resurrecting either sentinel job even with the valid new-worker contract', async () => {
    const pending = [await legacy('queued'), await legacy('queued', 'static_admin')];
    await migrate();
    const client = await pool.connect();
    try {
      for (const old of pending) {
        for (const status of ['queued', 'running']) {
          await client.query('BEGIN');
          await client.query(contract);
          // Satisfy every original 571 lease/result/completion shape. The
          // rejection must come from the new provenance CHECK itself.
          await expect(client.query(`UPDATE agent_compliance_refresh_requests
            SET status = $2, completed_at = NULL, result_json = NULL,
                lease_owner = CASE WHEN $2 = 'running' THEN 'new-worker' END,
                lease_token = CASE WHEN $2 = 'running' THEN gen_random_uuid() END,
                lease_expires_at = CASE WHEN $2 = 'running' THEN NOW() + INTERVAL '1 minute' END
            WHERE id = $1`, [old.id, status])).rejects.toMatchObject({
            code: '23514', constraint: 'agent_compliance_refresh_authenticated_credential',
          });
          await client.query('ROLLBACK');
          expect((await db.getById(old.id))?.status).toBe('failed');
        }
      }
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    expect((await db.claimDue('new-worker', 2, 60_000)).requests).toEqual([]);
  });

  it.each([false, true])('rejects every running legacy row (expired: %s) without partial schema or history edits', async expired => {
    const queued = await legacy('queued');
    const running = await legacy('running');
    if (expired) await pool.query("UPDATE agent_compliance_refresh_requests SET lease_expires_at = NOW() - INTERVAL '1 hour', attempts = max_attempts WHERE id = $1", [running.id]);
    await expect(migrate()).rejects.toThrow('Drain all running');
    expect((await pool.query('SELECT status FROM agent_compliance_refresh_requests WHERE id = $1', [queued.id])).rows[0].status)
      .toBe('queued');
    const columns = await pool.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'agent_compliance_refresh_requests'
      AND column_name = 'requested_by_auth_workos_user_id'`, [schema]);
    expect(columns.rows).toHaveLength(0);
  });

  it('checks running claims only after waiting for a concurrent old claim transaction', async () => {
    const pending = await legacy('queued');
    const oldWorker = await pool.connect();
    const migrator = await pool.connect();
    const migratorPid = (await migrator.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await oldWorker.query('BEGIN');
    await oldWorker.query(oldClaim, [pending.id]);
    const migration = migrate(migrator).then(() => ({ passed: true }), error => ({ error }));
    try {
      await vi.waitFor(async () => {
        const waiting = await admin.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1", [migratorPid]);
        expect(waiting.rows[0].wait_event_type).toBe('Lock');
      });
      await oldWorker.query('COMMIT');
      expect(await migration).toMatchObject({ error: { message: expect.stringContaining('Drain all running') } });
    } finally {
      await oldWorker.query('ROLLBACK');
      await migration;
      oldWorker.release();
      migrator.release();
    }
  });

  it('rejects old inserts, malformed fingerprints, static admissions, and direct running inserts', async () => {
    await migrate();
    await expect(legacy('queued')).rejects.toMatchObject({ code: '23502' });
    await expect(legacy('queued', 'static_admin')).rejects.toThrow('authenticated user provenance');
    const insert = (credential: string | null, fingerprint: string | null, requesterType = 'user', status = 'queued') => {
      const id = randomUUID();
      return pool.query(`INSERT INTO agent_compliance_refresh_requests
        (id, agent_url, owner_org_id, requester_type, requested_by_user_id, triggered_by, test_session_id,
         requested_by_auth_workos_user_id, authorization_fingerprint, status)
        VALUES ($1, $2, NULL, $3, $4, 'manual', $5, $6, $7, $8)`,
      [id, `https://${id}.example.test/mcp`, requesterType, requesterType === 'user' ? 'user-exact' : null,
        `new-${id}`, credential, fingerprint, status]);
    };
    for (const [credential, fingerprint] of [[null, null], [null, ''], ['user-exact', null]]) {
      await expect(insert(credential, fingerprint)).rejects.toMatchObject({ code: '23502' });
    }
    expect((await pool.query('SELECT COUNT(*)::integer AS count FROM agent_compliance_refresh_requests')).rows[0].count).toBe(0);
    expect((await db.claimDue('new-worker', 2, 60_000)).requests).toEqual([]);
    for (const [credential, fingerprint] of [
      ['', ''], [' user-exact ', ''], ['user-linked', ''],
      ['__unproven__', '__unproven__'], ['user-exact', '__unproven__'], ['user-exact', 'user-linked:1'],
      ['user-exact', 'user-exact:0'], ['user-exact', 'user-exact:01'], ['user-exact', 'user-exact:9223372036854775808'],
    ]) await expect(insert(credential, fingerprint)).rejects.toBeDefined();
    await expect(insert('user-exact', '', 'static_admin')).rejects.toThrow('authenticated user provenance');
    await expect(insert('user-exact', '', 'user', 'running')).rejects.toThrow('authenticated user provenance');
    await insert('user-exact', 'user-exact:9223372036854775807');
  });

  it('blocks old claims and reclaims while preserving new lease lifecycle writes', async () => {
    await migrate();
    const created = await enqueue();
    await expect(pool.query(oldClaim, [created.request.id])).rejects.toThrow('worker contract');
    expect((await db.getById(created.request.id))?.status).toBe('queued');
    const [claim] = (await db.claimDue('new-worker', 1, 60_000)).requests;
    await expect(pool.query(oldClaim, [claim.id])).rejects.toThrow('worker contract');
    expect((await db.getById(claim.id))?.lease_token).toBe(claim.lease_token);
    expect(await db.heartbeat(claim.id, claim.lease_token, 60_000)).toBe(true);
    expect(await db.recordProbeResult(claim.id, claim.lease_token, { online: true }, false)).toBe(true);
    expect(await db.deferClaim(claim.id, claim.lease_token, 0)).toBe(true);
    const [reclaimed] = (await db.claimDue('new-worker-2', 1, 60_000)).requests;
    expect(await db.markFailed(reclaimed.id, reclaimed.lease_token, 'authorization_revoked', 'Revoked')).toBe(true);
  });

  it.each(['COMMIT', 'ROLLBACK'])('does not leak its claim protocol setting after %s', async end => {
    await migrate();
    const created = await enqueue();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(contract);
      await client.query(oldClaim, [created.request.id]);
      await client.query(end);
      await expect(client.query(oldClaim, [created.request.id])).rejects.toThrow('worker contract');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('keeps credential, fingerprint, and context immutable, including unproven history', async () => {
    const old = await legacy('succeeded');
    await migrate();
    const created = await enqueue();
    for (const assignment of ["requested_by_auth_workos_user_id = 'user-linked'", "authorization_fingerprint = 'user-exact:1'",
      "requested_by_user_id = 'user-linked'", "agent_url = 'https://changed.example.test/mcp'", "owner_org_id = 'org-other'"]) {
      await expect(pool.query(`UPDATE agent_compliance_refresh_requests SET ${assignment} WHERE id = $1`, [created.request.id]))
        .rejects.toThrow('immutable');
    }
    await expect(pool.query(`UPDATE agent_compliance_refresh_requests
      SET requested_by_auth_workos_user_id = 'user-canonical-linked', authorization_fingerprint = '' WHERE id = $1`, [old.id]))
      .rejects.toThrow('immutable');
    await expect(pool.query(oldClaim, [old.id])).rejects.toThrow('worker contract');
    expect((await db.getById(old.id))?.status).toBe('succeeded');
  });
});
