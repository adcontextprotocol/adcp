import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { closeDatabase, initializeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  ComplianceRefreshInProgressError,
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
    if (ids.length === 0) return;
    await pool.query('DELETE FROM agent_compliance_refresh_requests WHERE id = ANY($1::uuid[])', [[...ids]]);
    ids.length = 0;
  });

  afterAll(async () => {
    if (ids.length > 0) {
      await pool.query('DELETE FROM agent_compliance_refresh_requests WHERE id = ANY($1::uuid[])', [[...ids]]);
    }
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
      triggeredBy: 'owner_test',
      ...overrides,
    });
  }

  it('persists a stable test-session identity without credential material', async () => {
    const created = await enqueue();
    const stored = await db.getById(created.request.id);

    expect(stored).toMatchObject({
      status: 'queued',
      owner_org_id: 'org-refresh-test',
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
      requestedByUserId: 'another-user-in-org',
      triggeredBy: 'owner_test',
    });

    expect(duplicate.coalesced).toBe(true);
    expect(duplicate.request.id).toBe(first.request.id);
  });

  it('rejects coalescing across owner-organization or admin credential contexts', async () => {
    const agentUrl = `https://${randomUUID()}.example.test/mcp`;
    await enqueue({ agentUrl });

    for (const context of [
      { ownerOrgId: 'org-other', requesterType: 'user' as const, requestedByUserId: 'user-other', triggeredBy: 'owner_test' as const },
      { ownerOrgId: null, requesterType: 'static_admin' as const, requestedByUserId: null, triggeredBy: 'manual' as const },
    ]) {
      const id = randomUUID();
      ids.push(id);
      await expect(db.createOrGetActive({ id, agentUrl, ...context }))
        .rejects.toBeInstanceOf(ComplianceRefreshInProgressError);
    }
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
    await expect(db.markSucceeded(created.request.id, firstClaim.lease_token, { online: true }))
      .resolves.toBe(false);
    await expect(db.markSucceeded(created.request.id, reclaimed.lease_token, { online: true }))
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
});
