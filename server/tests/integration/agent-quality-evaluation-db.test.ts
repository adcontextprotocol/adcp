import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, getClient, initializeDatabase, query } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  AgentQualityEvaluationDatabase,
  AgentQualityEvaluationLeaseLostError,
  agentQualityEvaluationRequestKey,
} from '../../src/db/agent-quality-evaluation-db.js';
import { ComplianceDatabase } from '../../src/db/compliance-db.js';

describe('durable Addie agent-quality evaluation claims', () => {
  beforeAll(async () => {
    initializeDatabase({ connectionString: process.env.DATABASE_URL });
    await runMigrations();
  }, 60_000);

  beforeEach(async () => {
    await query(`DELETE FROM agent_compliance_runs
      WHERE agent_url LIKE 'https://evaluation-lease-test.example/%'`);
    await query(`DELETE FROM addie_agent_quality_evaluations
      WHERE agent_url LIKE 'https://evaluation-lease-test.example/%'`);
  });

  afterAll(async () => {
    await query(`DELETE FROM agent_compliance_runs
      WHERE agent_url LIKE 'https://evaluation-lease-test.example/%'`);
    await query(`DELETE FROM addie_agent_quality_evaluations
      WHERE agent_url LIKE 'https://evaluation-lease-test.example/%'`);
    await closeDatabase();
  });

  it('grants one execution across independent database clients and coalesces the other claim', async () => {
    const replicaA = new AgentQualityEvaluationDatabase();
    const replicaB = new AgentQualityEvaluationDatabase();
    const identity = {
      agentUrl: 'https://evaluation-lease-test.example/concurrent',
      complianceTarget: '3.1->3.1.0-rc.4',
      tracks: ['media_buy', 'core'],
      authScope: 'saved:organization:org_test',
      leaseMs: 60_000,
    } as const;

    const claims = await Promise.all([
      replicaA.claimOrObserve({ ...identity, ownerId: 'replica-a' }),
      replicaB.claimOrObserve({ ...identity, tracks: ['core', 'media_buy'], ownerId: 'replica-b' }),
    ]);

    expect(claims.filter(claim => claim.owned)).toHaveLength(1);
    expect(claims.filter(claim => !claim.owned)).toHaveLength(1);
    expect(claims[0].evaluation.id).toBe(claims[1].evaluation.id);
    const owner = claims.find(claim => claim.owned)!;
    await expect(replicaA.markCompleted(
      owner.evaluation.id,
      owner.evaluation.lease_token!,
      { completeness: 'complete', authoritative: true },
    )).resolves.toBe(true);
  });

  it('separates every input that materially changes the evaluation', () => {
    const base = {
      agentUrl: 'https://evaluation-lease-test.example/identity',
      complianceTarget: '3.0->3.0.14',
      tracks: ['core'],
      authScope: 'saved:organization:org_test:credential:aaa',
    } as const;
    const key = agentQualityEvaluationRequestKey(base).requestKey;

    expect(agentQualityEvaluationRequestKey({ ...base, agentUrl: `${base.agentUrl}/other` }).requestKey)
      .not.toBe(key);
    expect(agentQualityEvaluationRequestKey({ ...base, complianceTarget: '3.1->3.1.0' }).requestKey)
      .not.toBe(key);
    expect(agentQualityEvaluationRequestKey({ ...base, tracks: ['media_buy'] }).requestKey)
      .not.toBe(key);
    expect(agentQualityEvaluationRequestKey({ ...base, authScope: 'saved:organization:org_test:credential:bbb' }).requestKey)
      .not.toBe(key);
  });

  it('recovers only after expiry and fences the stale owner from heartbeat or completion', async () => {
    const replicaA = new AgentQualityEvaluationDatabase();
    const replicaB = new AgentQualityEvaluationDatabase();
    const identity = {
      agentUrl: 'https://evaluation-lease-test.example/recovery',
      complianceTarget: '3.0->3.0.14',
      tracks: [] as string[],
      authScope: 'anonymous',
      leaseMs: 60_000,
    };
    const first = await replicaA.claimOrObserve({ ...identity, ownerId: 'replica-a' });
    expect(first.owned).toBe(true);

    const liveObserver = await replicaB.claimOrObserve({ ...identity, ownerId: 'replica-b' });
    expect(liveObserver.owned).toBe(false);
    expect(liveObserver.evaluation.id).toBe(first.evaluation.id);

    const { requestKey } = agentQualityEvaluationRequestKey(identity);
    await query(
      `UPDATE addie_agent_quality_evaluations
          SET lease_expires_at = NOW() - INTERVAL '1 second'
        WHERE request_key = $1 AND status = 'running'`,
      [requestKey],
    );

    const recovered = await replicaB.claimOrObserve({ ...identity, ownerId: 'replica-b' });
    expect(recovered.owned).toBe(true);
    if (!recovered.owned || !first.owned) throw new Error('Expected owned claims');
    expect(recovered.recoveredExpiredLease).toBe(true);
    expect(recovered.evaluation.id).not.toBe(first.evaluation.id);
    await expect(replicaA.heartbeat(first.evaluation.id, first.evaluation.lease_token, 60_000))
      .resolves.toBeNull();
    await expect(replicaA.markCompleted(
      first.evaluation.id,
      first.evaluation.lease_token,
      { completeness: 'complete', authoritative: true },
    )).resolves.toBe(false);

    const statuses = await query<{ status: string; count: string }>(
      `SELECT status, COUNT(*)::text AS count
         FROM addie_agent_quality_evaluations
        WHERE request_key = $1
        GROUP BY status`,
      [requestKey],
    );
    expect(Object.fromEntries(statuses.rows.map(row => [row.status, Number(row.count)])))
      .toEqual({ expired: 1, running: 1 });
  });

  it('fences compliance publication and replays one exact mutation receipt', async () => {
    const leaseDb = new AgentQualityEvaluationDatabase();
    const complianceDb = new ComplianceDatabase();
    const identity = {
      agentUrl: 'https://evaluation-lease-test.example/publication',
      complianceTarget: '3.0->3.0.14',
      tracks: [] as string[],
      authScope: 'saved:organization:org_test',
      leaseMs: 60_000,
    };
    const claim = await leaseDb.claimOrObserve({ ...identity, ownerId: 'replica-a' });
    if (!claim.owned) throw new Error('Expected publication lease ownership');
    const input = {
      agent_url: identity.agentUrl,
      requested_compliance_target: '3.0',
      adcp_version: '3.0.14',
      lifecycle_stage: 'production' as const,
      overall_status: 'partial' as const,
      headline: 'Partial evidence retained',
      tracks_json: [],
      tracks_passed: 0,
      tracks_failed: 0,
      tracks_skipped: 0,
      tracks_partial: 0,
      triggered_by: 'manual' as const,
      dry_run: true,
      completeness: 'timed_out' as const,
      is_authoritative: false,
      agent_quality_evaluation_id: claim.evaluation.id,
      agent_quality_evaluation_lease_token: claim.evaluation.lease_token,
    };

    const first = await complianceDb.recordComplianceRun(input);
    const replay = await complianceDb.recordComplianceRun(input);
    expect(first.replayedExisting).toBe(false);
    expect(replay.replayedExisting).toBe(true);
    expect(replay.run.id).toBe(first.run.id);
    const count = await query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM agent_compliance_runs WHERE agent_quality_evaluation_id = $1',
      [claim.evaluation.id],
    );
    expect(Number(count.rows[0].count)).toBe(1);

    await query(
      `UPDATE addie_agent_quality_evaluations
          SET lease_expires_at = NOW() - INTERVAL '1 second'
        WHERE id = $1`,
      [claim.evaluation.id],
    );
    await expect(complianceDb.recordComplianceRun(input))
      .rejects.toBeInstanceOf(AgentQualityEvaluationLeaseLostError);
  });

  it.each(['before lease fence', 'after lease fence'] as const)(
    'rejects publication when a SQL lock wait expires ownership %s',
    async (lockPhase) => {
      const agentUrl = `https://evaluation-lease-test.example/blocked-${lockPhase.replaceAll(' ', '-')}`;
      const blocker = await getClient();
      let publication: Promise<unknown> | undefined;
      try {
        await blocker.query('BEGIN');
        const blockerPid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        if (lockPhase === 'before lease fence') {
          await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`verification-badge:${agentUrl}`]);
        } else {
          // This lock permits reads but makes INSERT wait after FOR UPDATE
          // has already fenced and locked the evaluation row.
          await blocker.query('LOCK TABLE agent_compliance_runs IN SHARE MODE');
        }
        const claim = await new AgentQualityEvaluationDatabase().claimOrObserve({
          agentUrl,
          complianceTarget: '3.0->3.0.14',
          tracks: [],
          authScope: 'anonymous',
          ownerId: 'blocked-publisher',
          leaseMs: 600,
        });
        if (!claim.owned) throw new Error('Expected owned claim');
        publication = new ComplianceDatabase().recordComplianceRun({
          agent_url: agentUrl,
          adcp_version: '3.0.14',
          lifecycle_stage: 'production',
          overall_status: 'passing',
          tracks_json: [],
          tracks_passed: 0,
          tracks_failed: 0,
          tracks_skipped: 0,
          tracks_partial: 0,
          completeness: 'complete',
          is_authoritative: lockPhase === 'before lease fence',
          agent_quality_evaluation_id: claim.evaluation.id,
          agent_quality_evaluation_lease_token: claim.evaluation.lease_token,
        });
        const rejection = expect(publication).rejects.toBeInstanceOf(AgentQualityEvaluationLeaseLostError);
        let waiting = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          const result = await query<{ waiting: boolean }>(
            'SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::integer = ANY(pg_blocking_pids(pid))) AS waiting',
            [blockerPid],
          );
          if (result.rows[0].waiting) {
            waiting = true;
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        expect(waiting).toBe(true);
        await query('SELECT pg_sleep(0.7)');
        await blocker.query('COMMIT');
        await rejection;
        const runs = await query('SELECT id FROM agent_compliance_runs WHERE agent_url = $1', [agentUrl]);
        expect(runs.rowCount).toBe(0);
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
        await publication?.catch(() => undefined);
      }
    },
  );
});
