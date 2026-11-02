import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

const logs = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }));

vi.mock('../../src/logger.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/logger.js')>()),
  logger: { child: () => logs },
}));

import { closeDatabase, initializeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { ComplianceDatabase } from '../../src/db/compliance-db.js';
import {
  claimHeartbeatAgents,
  createHeartbeatProcessIdentity,
  markHeartbeatSuiteStarted,
  reconcileOrphanedHeartbeatClaims,
  releaseHeartbeatClaim,
  releaseUnstartedHeartbeatClaims,
} from '../../src/addie/jobs/compliance-heartbeat-claims.js';

interface MetadataRow {
  heartbeat_claim_owner: string | null;
  heartbeat_started_at: Date | null;
  heartbeat_orphan_streak: number;
  minutes_until_next_check: number | null;
}

describe.skipIf(!process.env.DATABASE_URL)('compliance heartbeat claim ownership', () => {
  let pool: Pool;
  const db = new ComplianceDatabase();
  const agentUrls: string[] = [];
  const orgIds: string[] = [];

  beforeAll(async () => {
    pool = initializeDatabase({ connectionString: process.env.DATABASE_URL });
    await runMigrations();
  }, 180_000);

  afterAll(async () => {
    if (orgIds.length > 0) {
      await pool.query('DELETE FROM organizations WHERE workos_organization_id = ANY($1::text[])', [orgIds]);
    }
    if (agentUrls.length > 0) {
      await pool.query('DELETE FROM agent_registry_metadata WHERE agent_url = ANY($1::text[])', [agentUrls]);
    }
    await closeDatabase();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const newAgentUrl = () => {
    const url = `https://${randomUUID()}.heartbeat-claims.example/mcp`;
    agentUrls.push(url);
    return url;
  };

  const seedClaim = async (
    agentUrl: string,
    claim: { owner: string | null; started: boolean; nextCheckMinutes: number | null; streak?: number },
  ) => {
    await pool.query(
      `INSERT INTO agent_registry_metadata (
         agent_url, heartbeat_claim_owner, heartbeat_started_at, heartbeat_orphan_streak, next_compliance_check_at
       ) VALUES (
         $1, $2, CASE WHEN $3::boolean THEN NOW() - INTERVAL '1 minute' END, $5,
         CASE WHEN $4::int IS NULL THEN NULL ELSE NOW() + make_interval(mins => $4::int) END
       )`,
      [agentUrl, claim.owner, claim.started, claim.nextCheckMinutes, claim.streak ?? 0],
    );
  };

  const readRow = async (agentUrl: string): Promise<MetadataRow> => (await pool.query<MetadataRow>(
    `SELECT heartbeat_claim_owner, heartbeat_started_at, heartbeat_orphan_streak,
            (EXTRACT(EPOCH FROM next_compliance_check_at - NOW()) / 60)::float8 AS minutes_until_next_check
     FROM agent_registry_metadata WHERE agent_url = $1`,
    [agentUrl],
  )).rows[0];

  const deadProcess = (machineId: string) => `${machineId}:${randomUUID()}`;

  describe('orphan reconciliation', () => {
    it('backs off an agent whose suite was running when its process died and releases the claim', async () => {
      const me = createHeartbeatProcessIdentity(`machine-${randomUUID()}`);
      const agentUrl = newAgentUrl();
      await seedClaim(agentUrl, { owner: deadProcess('other-machine'), started: true, nextCheckMinutes: -1 });

      await reconcileOrphanedHeartbeatClaims(me);

      const row = await readRow(agentUrl);
      expect(row.heartbeat_claim_owner).toBeNull();
      expect(row.heartbeat_started_at).toBeNull();
      expect(row.heartbeat_orphan_streak).toBe(1);
      expect(row.minutes_until_next_check).toBeGreaterThan(29);
      expect(row.minutes_until_next_check).toBeLessThanOrEqual(30);
      expect(logs.warn).toHaveBeenCalledWith(
        expect.objectContaining({ agentUrl, orphanStreak: 1 }),
        expect.any(String),
      );
      expect(logs.error).not.toHaveBeenCalled();
    });

    it.each([
      { priorStreak: 1, minutes: 60 },
      { priorStreak: 2, minutes: 120 },
      { priorStreak: 6, minutes: 32 * 60 },
      { priorStreak: 7, minutes: 48 * 60 },
      { priorStreak: 40, minutes: 48 * 60 },
    ])('doubles the backoff per consecutive orphan up to 48 hours (prior streak $priorStreak)', async ({ priorStreak, minutes }) => {
      const me = createHeartbeatProcessIdentity(`machine-${randomUUID()}`);
      const agentUrl = newAgentUrl();
      await seedClaim(agentUrl, {
        owner: deadProcess('other-machine'), started: true, nextCheckMinutes: -1, streak: priorStreak,
      });

      await reconcileOrphanedHeartbeatClaims(me);

      const row = await readRow(agentUrl);
      expect(row.heartbeat_orphan_streak).toBe(priorStreak + 1);
      expect(row.minutes_until_next_check).toBeGreaterThan(minutes - 1);
      expect(row.minutes_until_next_check).toBeLessThanOrEqual(minutes);
    });

    it('escalates with logger.error once the streak reaches 3', async () => {
      const me = createHeartbeatProcessIdentity(`machine-${randomUUID()}`);
      const agentUrl = newAgentUrl();
      await seedClaim(agentUrl, {
        owner: deadProcess('other-machine'), started: true, nextCheckMinutes: -1, streak: 2,
      });

      await reconcileOrphanedHeartbeatClaims(me);

      expect(logs.error).toHaveBeenCalledWith(
        expect.objectContaining({ agentUrl, orphanStreak: 3 }),
        'Compliance heartbeat agent suite repeatedly ended with the worker process dying',
      );
    });

    it('releases an unstarted orphan immediately without changing its streak', async () => {
      const me = createHeartbeatProcessIdentity(`machine-${randomUUID()}`);
      const agentUrl = newAgentUrl();
      await seedClaim(agentUrl, {
        owner: deadProcess('other-machine'), started: false, nextCheckMinutes: -1, streak: 2,
      });

      await reconcileOrphanedHeartbeatClaims(me);

      const row = await readRow(agentUrl);
      expect(row.heartbeat_claim_owner).toBeNull();
      expect(row.heartbeat_orphan_streak).toBe(2);
      expect(Math.abs(row.minutes_until_next_check ?? 99)).toBeLessThan(1);
      expect(logs.warn).not.toHaveBeenCalled();
      expect(logs.error).not.toHaveBeenCalled();
    });

    it('leaves another live machine\'s unexpired claim untouched', async () => {
      const me = createHeartbeatProcessIdentity(`machine-${randomUUID()}`);
      const agentUrl = newAgentUrl();
      const otherOwner = deadProcess('other-machine');
      await seedClaim(agentUrl, { owner: otherOwner, started: true, nextCheckMinutes: 90, streak: 1 });

      await reconcileOrphanedHeartbeatClaims(me);

      const row = await readRow(agentUrl);
      expect(row.heartbeat_claim_owner).toBe(otherOwner);
      expect(row.heartbeat_started_at).not.toBeNull();
      expect(row.heartbeat_orphan_streak).toBe(1);
      expect(row.minutes_until_next_check).toBeGreaterThan(89);
    });

    it('treats a different process on this machine as dead even when its lock has not expired', async () => {
      const me = createHeartbeatProcessIdentity(`machine-${randomUUID()}`);
      const agentUrl = newAgentUrl();
      await seedClaim(agentUrl, { owner: deadProcess(me.machineId), started: true, nextCheckMinutes: 90 });

      await reconcileOrphanedHeartbeatClaims(me);

      const row = await readRow(agentUrl);
      expect(row.heartbeat_claim_owner).toBeNull();
      expect(row.heartbeat_orphan_streak).toBe(1);
      expect(row.minutes_until_next_check).toBeLessThanOrEqual(30);
    });

    it('does not mistake a machine whose id merely starts with this machine\'s id for the same machine', async () => {
      const me = createHeartbeatProcessIdentity(`machine-${randomUUID()}`);
      const agentUrl = newAgentUrl();
      const neighbour = deadProcess(`${me.machineId}-2`);
      await seedClaim(agentUrl, { owner: neighbour, started: true, nextCheckMinutes: 90 });

      await reconcileOrphanedHeartbeatClaims(me);

      expect((await readRow(agentUrl)).heartbeat_claim_owner).toBe(neighbour);
    });

    it('does not reclaim this process\'s own claims', async () => {
      const me = createHeartbeatProcessIdentity(`machine-${randomUUID()}`);
      const agentUrl = newAgentUrl();
      await seedClaim(agentUrl, { owner: me.owner, started: true, nextCheckMinutes: -1 });

      await reconcileOrphanedHeartbeatClaims(me);

      const row = await readRow(agentUrl);
      expect(row.heartbeat_claim_owner).toBe(me.owner);
      expect(row.heartbeat_orphan_streak).toBe(0);
    });
  });

  describe('claim lifecycle', () => {
    it('records the owner and clears any stale start marker when claiming', async () => {
      const me = createHeartbeatProcessIdentity(`machine-${randomUUID()}`);
      const agentUrl = newAgentUrl();
      await seedClaim(agentUrl, { owner: null, started: true, nextCheckMinutes: -5 });

      const claimed = await claimHeartbeatAgents([agentUrl], new Date(Date.now() + 3_600_000), me.owner);

      expect([...claimed]).toEqual([agentUrl]);
      const row = await readRow(agentUrl);
      expect(row.heartbeat_claim_owner).toBe(me.owner);
      expect(row.heartbeat_started_at).toBeNull();
      expect(row.minutes_until_next_check).toBeGreaterThan(59);
    });

    it('does not claim an agent whose lock is still held', async () => {
      const me = createHeartbeatProcessIdentity(`machine-${randomUUID()}`);
      const agentUrl = newAgentUrl();
      const otherOwner = deadProcess('other-machine');
      await seedClaim(agentUrl, { owner: otherOwner, started: false, nextCheckMinutes: 60 });

      const claimed = await claimHeartbeatAgents([agentUrl], new Date(Date.now() + 3_600_000), me.owner);

      expect(claimed.size).toBe(0);
      expect((await readRow(agentUrl)).heartbeat_claim_owner).toBe(otherOwner);
    });

    it('marks the suite started only for the claim owner', async () => {
      const me = createHeartbeatProcessIdentity(`machine-${randomUUID()}`);
      const other = createHeartbeatProcessIdentity(`machine-${randomUUID()}`);
      const agentUrl = newAgentUrl();
      await claimHeartbeatAgents([agentUrl], new Date(Date.now() + 3_600_000), me.owner);

      await markHeartbeatSuiteStarted(agentUrl, other.owner);
      expect((await readRow(agentUrl)).heartbeat_started_at).toBeNull();

      await markHeartbeatSuiteStarted(agentUrl, me.owner);
      expect((await readRow(agentUrl)).heartbeat_started_at).not.toBeNull();
    });

    it('clears the claim and resets the orphan streak when a started suite finishes, leaving the schedule alone', async () => {
      const me = createHeartbeatProcessIdentity(`machine-${randomUUID()}`);
      const agentUrl = newAgentUrl();
      await seedClaim(agentUrl, { owner: me.owner, started: true, nextCheckMinutes: 720, streak: 2 });

      await releaseHeartbeatClaim(agentUrl, me.owner);

      const row = await readRow(agentUrl);
      expect(row.heartbeat_claim_owner).toBeNull();
      expect(row.heartbeat_started_at).toBeNull();
      expect(row.heartbeat_orphan_streak).toBe(0);
      expect(row.minutes_until_next_check).toBeGreaterThan(719);
    });

    it('keeps the orphan streak when the release comes from a path that never started the suite', async () => {
      const me = createHeartbeatProcessIdentity(`machine-${randomUUID()}`);
      const agentUrl = newAgentUrl();
      await seedClaim(agentUrl, { owner: me.owner, started: false, nextCheckMinutes: 5, streak: 2 });

      await releaseHeartbeatClaim(agentUrl, me.owner);

      const row = await readRow(agentUrl);
      expect(row.heartbeat_claim_owner).toBeNull();
      expect(row.heartbeat_orphan_streak).toBe(2);
    });

    it('does not release a claim held by another process', async () => {
      const me = createHeartbeatProcessIdentity(`machine-${randomUUID()}`);
      const agentUrl = newAgentUrl();
      const otherOwner = deadProcess('other-machine');
      await seedClaim(agentUrl, { owner: otherOwner, started: true, nextCheckMinutes: 60, streak: 1 });

      await releaseHeartbeatClaim(agentUrl, me.owner);

      const row = await readRow(agentUrl);
      expect(row.heartbeat_claim_owner).toBe(otherOwner);
      expect(row.heartbeat_orphan_streak).toBe(1);
    });

    it('makes only this batch\'s unstarted claims due immediately', async () => {
      const me = createHeartbeatProcessIdentity(`machine-${randomUUID()}`);
      const unstarted = newAgentUrl();
      const started = newAgentUrl();
      const otherBatch = newAgentUrl();
      const theirs = newAgentUrl();
      await seedClaim(unstarted, { owner: me.owner, started: false, nextCheckMinutes: 110 });
      await seedClaim(started, { owner: me.owner, started: true, nextCheckMinutes: 110 });
      await seedClaim(otherBatch, { owner: me.owner, started: false, nextCheckMinutes: 110 });
      await seedClaim(theirs, { owner: deadProcess('other-machine'), started: false, nextCheckMinutes: 110 });

      await releaseUnstartedHeartbeatClaims([unstarted, started, theirs], me.owner);

      const released = await readRow(unstarted);
      expect(released.heartbeat_claim_owner).toBeNull();
      expect(released.minutes_until_next_check).toBeLessThanOrEqual(0.1);
      expect((await readRow(started)).heartbeat_claim_owner).toBe(me.owner);
      expect((await readRow(started)).minutes_until_next_check).toBeGreaterThan(100);
      expect((await readRow(otherBatch)).heartbeat_claim_owner).toBe(me.owner);
      expect((await readRow(theirs)).minutes_until_next_check).toBeGreaterThan(100);
    });
  });

  describe('crash attribution', () => {
    const seedKnownAgent = async (agentUrl: string) => {
      const orgId = `org_heartbeat_claims_${randomUUID()}`;
      orgIds.push(orgId);
      await pool.query('INSERT INTO organizations (workos_organization_id, name) VALUES ($1, $2)', [orgId, 'Heartbeat claims test']);
      await pool.query(
        `INSERT INTO member_profiles (workos_organization_id, display_name, slug, agents)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [orgId, 'Heartbeat claims test', `heartbeat-claims-${randomUUID()}`, JSON.stringify([{ url: agentUrl }])],
      );
    };
    const dueUrls = async () => new Set((await db.getAgentsDueForCheck(100_000)).map(agent => agent.agent_url));

    it('frees the agents that were only waiting and backs off the one that was running', async () => {
      const machineId = `machine-${randomUUID()}`;
      const before = createHeartbeatProcessIdentity(machineId);
      const afterRestart = createHeartbeatProcessIdentity(machineId);
      const running = newAgentUrl();
      const waiting = newAgentUrl();
      await seedKnownAgent(running);
      await seedKnownAgent(waiting);

      const claimed = await claimHeartbeatAgents([running, waiting], new Date(Date.now() + 6_780_000), before.owner);
      expect(claimed.size).toBe(2);
      await markHeartbeatSuiteStarted(running, before.owner);
      expect(await dueUrls()).not.toContain(running);
      expect(await dueUrls()).not.toContain(waiting);

      await reconcileOrphanedHeartbeatClaims(afterRestart);

      const due = await dueUrls();
      expect(due).toContain(waiting);
      expect(due).not.toContain(running);
      expect((await readRow(running)).heartbeat_orphan_streak).toBe(1);
      expect((await readRow(waiting)).heartbeat_orphan_streak).toBe(0);
    });

    it('reports the orphan streak of each due agent', async () => {
      const suspect = newAgentUrl();
      const healthy = newAgentUrl();
      await seedKnownAgent(suspect);
      await seedKnownAgent(healthy);
      await seedClaim(suspect, { owner: null, started: false, nextCheckMinutes: -1, streak: 2 });
      await seedClaim(healthy, { owner: null, started: false, nextCheckMinutes: -1 });

      const selected = (await db.getAgentsDueForCheck(100_000))
        .filter(agent => agent.agent_url === suspect || agent.agent_url === healthy);

      expect(Object.fromEntries(selected.map(agent => [agent.agent_url, agent.heartbeat_orphan_streak])))
        .toEqual({ [suspect]: 2, [healthy]: 0 });
    });
  });
});
