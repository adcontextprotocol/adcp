import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client, Pool } from 'pg';

const mocks = vi.hoisted(() => ({
  comply: vi.fn(), notifyComplianceChange: vi.fn(), notifyVerificationChange: vi.fn(),
  runBadgeFanOut: vi.fn(), revokeUnsupportedPublicBadges: vi.fn(),
}));
vi.mock('../../src/addie/services/compliance-testing.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/addie/services/compliance-testing.js')>(),
  comply: mocks.comply,
  selectComplianceTargetForAgentSelection: async () => ({
    target: { requested: '3.1', version: '3.1.20' }, confirmed: true, source: 'live', supportedVersions: ['3.1'],
  }),
}));
vi.mock('../../src/notifications/compliance.js', () => ({
  notifyComplianceChange: mocks.notifyComplianceChange, notifyVerificationChange: mocks.notifyVerificationChange,
}));
vi.mock('../../src/services/badge-issuance.js', () => ({
  runBadgeFanOut: mocks.runBadgeFanOut, revokeUnsupportedPublicBadges: mocks.revokeUnsupportedPublicBadges,
}));
vi.mock('../../src/db/outbound-log-db.js', () => ({ logOutboundRequest: vi.fn() }));
vi.mock('../../src/addie/error-notifier.js', () => ({ notifySystemError: vi.fn() }));
vi.mock('../../src/db/verification-profile-shadow-db.js', () => ({
  pruneVerificationProfileShadowAssessments: async () => 0, recordVerificationProfileShadowAssessment: vi.fn(),
}));
vi.mock('../../src/db/system-settings-db.js', () => ({ getVerificationProfileShadowRollout: async () => ({ enabled: false }) }));

import { runComplianceHeartbeatJob } from '../../src/addie/jobs/compliance-heartbeat.js';
import { complianceResultToDbInput, type ComplianceResult } from '../../src/addie/services/compliance-testing.js';
import { complianceRunProvenance } from '../../src/compliance/run-provenance.js';
import { closeDatabase, initializeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { ComplianceDatabase, type RecordComplianceRunInput } from '../../src/db/compliance-db.js';
import { ComplianceRefreshRequestsDatabase } from '../../src/db/compliance-refresh-requests-db.js';

// #7404 acceptance: exercise the real heartbeat -> adapter -> PostgreSQL publication
// and public-read paths; only outbound SDK/notification/badge calls are substituted.
describe.skipIf(!process.env.DATABASE_URL)('#7404 Bug 3 heartbeat publication', () => {
  let pool: Pool;
  let agentUrl: string;
  const agents: string[] = [];
  const operations: string[] = [];
  const db = new ComplianceDatabase();

  beforeAll(async () => {
    pool = initializeDatabase({ connectionString: process.env.DATABASE_URL });
    await runMigrations();
  }, 180_000);
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    agentUrl = `https://${randomUUID()}.example.test/mcp`;
    agents.push(agentUrl);
    vi.spyOn(ComplianceDatabase.prototype, 'getAgentsDueForCheck').mockImplementation(async () => [
      { agent_url: agentUrl, lifecycle_stage: 'production', last_checked_at: null },
    ]);
    vi.spyOn(ComplianceDatabase.prototype, 'resolveOwnerAuth').mockResolvedValue(undefined);
    mocks.runBadgeFanOut.mockResolvedValue({ issued: [{ role: 'signals', adcp_version: '3.1' }], revoked: [] });
    mocks.revokeUnsupportedPublicBadges.mockResolvedValue({ issued: [], revoked: [] });
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    for (const table of ['agent_compliance_step_diagnostics', 'agent_storyboard_status', 'agent_verification_badges',
      'agent_compliance_status', 'agent_compliance_runs', 'agent_registry_metadata']) {
      await pool.query(`DELETE FROM ${table} WHERE agent_url = ANY($1::text[])`, [agents]);
    }
    await pool.query('DELETE FROM agent_compliance_refresh_requests WHERE id = ANY($1::uuid[])', [operations]);
    await closeDatabase();
  });

  function previous(): RecordComplianceRunInput {
    return {
      agent_url: agentUrl, triggered_by: 'owner_test', dry_run: false, completeness: 'complete', is_authoritative: true,
      lifecycle_stage: 'production', requested_compliance_target: '3.1', adcp_version: '3.1.20',
      overall_status: 'passing', headline: 'Last complete grade',
      tracks_json: [{ track: 'core', status: 'pass', scenario_count: 193, passed_count: 159, duration_ms: 220_000 }],
      tracks_passed: 1, tracks_failed: 0, tracks_skipped: 0, tracks_partial: 0,
      replace_storyboard_statuses: true,
      storyboard_statuses: Array.from({ length: 35 }, (_, i) => ({
        storyboard_id: `previous_${i}`, status: 'passing', steps_passed: 1, steps_total: 1,
      })),
      agent_profile_json: { tools: [], adcp_supported_versions: ['3.1'], specialisms: ['signals-audience-activation'] },
      observations_json: [{ message: 'Previous complete observation' }],
      notices_json: [{ code: 'previous_notice', severity: 'info', message: 'Previous complete notice' }],
    };
  }
  async function seed() {
    const { run } = await db.recordComplianceRun(previous());
    await db.upsertBadge({ agent_url: agentUrl, role: 'signals', adcp_version: '3.1', verified_specialisms: ['signals-audience-activation'] });
    return run;
  }
  function sdkResult(completeness: unknown, executed = 48, passing = true): ComplianceResult {
    return {
      agent_url: agentUrl, completeness, adcp_version: '3.1.20', requested_compliance_target: '3.1',
      agent_profile: { tools: [], adcp_supported_versions: ['3.1'], specialisms: ['signals-audience-activation'] },
      overall_status: passing ? 'passing' : 'failing', total_duration_ms: executed === 48 ? 702418 : 638171,
      summary: { headline: 'New assessment', tracks_passed: passing ? 1 : 0, tracks_failed: passing ? 0 : 1, tracks_partial: 0, tracks_skipped: 0 },
      tracks: [{ track: 'core', status: passing ? 'pass' : 'fail', duration_ms: 1,
        scenarios: Array.from({ length: executed }, (_, i) => ({
          scenario: `selected_${i}/check`, overall_passed: passing,
          steps: [{ step_id: 'read', step: 'Read products', task: 'get_products', passed: passing, error: passing ? undefined : 'Expected products' }],
        })),
      }],
      bundle_results: [{ kind: 'universal', id: 'core', status: 'passing',
        storyboard_ids: Array.from({ length: 75 }, (_, i) => `selected_${i}`) }],
      observations: [{ message: `Compliance timeout budget of 600000ms was reached. Stopped starting new storyboards after ${executed}/75 selected storyboard(s).` }],
    } as unknown as ComplianceResult;
  }
  function respond(completeness: unknown, executed = 48, passing = true) {
    mocks.comply.mockImplementation(async (_url, options) => {
      const result = sdkResult(completeness, executed, passing);
      return { ...result, hosted_provenance: complianceRunProvenance(result, options) };
    });
  }
  async function snapshot() {
    const raw = [];
    for (const table of ['agent_compliance_status', 'agent_storyboard_status', 'agent_verification_badges']) {
      raw.push((await pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE agent_url = $1 ORDER BY to_jsonb(t)::text`, [agentUrl])).rows);
    }
    return JSON.stringify({ raw, status: await db.getComplianceStatusWithStoryboardCounts(agentUrl),
      bulk: [...await db.bulkGetComplianceStatus([agentUrl])], storyboards: await db.getStoryboardStatuses(agentUrl, { requireRowsForLatestRun: true }),
      bulkStoryboards: [...await db.bulkGetStoryboardStatuses([agentUrl])], history: await db.getComplianceHistory(agentUrl),
      observations: await db.getLatestObservations(agentUrl), specialisms: await db.getLatestDeclaredSpecialisms(agentUrl),
    });
  }
  function noSideEffects() {
    for (const fn of [mocks.notifyComplianceChange, mocks.notifyVerificationChange, mocks.runBadgeFanOut, mocks.revokeUnsupportedPublicBadges]) {
      expect(fn).not.toHaveBeenCalled();
    }
  }

  it.each([48, 50])('preserves the complete 35-row card after %i/75 timed-out storyboards with either verdict', async executed => {
    const complete = await seed();
    const before = await snapshot();
    for (const passing of [true, false]) {
      respond('timed_out', executed, passing);
      expect(await runComplianceHeartbeatJob()).toEqual({ checked: 0, passed: 0, failed: 0, skipped: 1 });
      expect(await snapshot()).toBe(before);
      const audit = await db.getComplianceRun(agentUrl);
      expect(audit).toMatchObject({ completeness: 'timed_out', is_authoritative: false, dry_run: false,
        provenance_json: { reported_completeness: 'timed_out', timeout_ms: 600000, storyboard_start_offset: passing ? 1 : 2 } });
      expect(audit?.storyboard_statuses_json).toHaveLength(75);
      expect(audit?.id).not.toBe(complete.id);
      if (!passing) expect(await db.getStepDiagnostics(agentUrl, { runId: audit!.id })).toHaveLength(executed);
      noSideEffects();
    }
  });

  it.each([undefined, null, 'budget_exhausted', 'partial', 'not_completed', 'future_value', '', true, 42, {}, ['complete']])(
    'rejects completeness %j regardless of passing/failing tracks and retains evidence', async completeness => {
      await seed();
      const before = await snapshot();
      for (const passing of [true, false]) {
        respond(completeness, 48, passing);
        expect(await runComplianceHeartbeatJob()).toMatchObject({ checked: 0, skipped: 1 });
        expect(await snapshot()).toBe(before);
        expect(await db.getComplianceRun(agentUrl)).toMatchObject({ completeness: 'not_completed', is_authoritative: false, dry_run: false,
          provenance_json: { reported_completeness: completeness ?? null } });
        noSideEffects();
      }
    },
  );

  it.each([true, false])('leaves a first-ever incomplete agent ungraded (passing=%s) and rotates durably before a complete replacement', async passing => {
    respond('timed_out', 48, passing);
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await runComplianceHeartbeatJob()).toMatchObject({ checked: 0, skipped: 1 });
      expect(await new ComplianceDatabase().countComplianceRuns(agentUrl)).toBe(attempt + 1);
      expect(mocks.comply.mock.calls[attempt][1].storyboard_start_offset).toBe(attempt);
      expect(await db.getComplianceStatus(agentUrl)).toBeNull();
      expect(await db.getComplianceStatusWithStoryboardCounts(agentUrl)).toBeNull();
      expect(await db.getStoryboardStatuses(agentUrl)).toEqual([]);
      expect(await db.getComplianceHistory(agentUrl)).toEqual([]);
      expect(await db.getBadgesForAgent(agentUrl)).toEqual([]);
      noSideEffects();
    }
    respond('complete', 75);
    expect(await runComplianceHeartbeatJob()).toEqual({ checked: 1, passed: 1, failed: 0, skipped: 0 });
    expect(mocks.comply.mock.calls[2][1].storyboard_start_offset).toBe(2);
    expect(await db.getComplianceHistory(agentUrl)).toHaveLength(1);
    expect((await db.getComplianceStatusWithStoryboardCounts(agentUrl))?.storyboardCounts).toEqual({ passing: 75, total: 75 });
    expect(mocks.runBadgeFanOut).toHaveBeenCalledOnce();
    expect(mocks.notifyVerificationChange).toHaveBeenCalledOnce();
  });

  it('publishes an explicit complete failing replacement atomically and notifies as before', async () => {
    await seed();
    respond('complete', 75, false);
    expect(await runComplianceHeartbeatJob()).toEqual({ checked: 1, passed: 0, failed: 1, skipped: 0 });
    expect((await db.getComplianceStatusWithStoryboardCounts(agentUrl))?.storyboardCounts).toEqual({ passing: 0, total: 75 });
    expect((await db.getComplianceStatus(agentUrl))?.status).toBe('failing');
    expect(mocks.notifyComplianceChange).toHaveBeenCalledOnce();
    expect(mocks.runBadgeFanOut).toHaveBeenCalledOnce();
    expect(mocks.notifyVerificationChange).toHaveBeenCalledOnce();
  });

  it('does not duplicate committed incomplete evidence when scheduling fails', async () => {
    await seed();
    const before = await snapshot();
    respond('timed_out');
    vi.spyOn(ComplianceDatabase.prototype, 'deferComplianceCheckAfterInconclusiveTarget')
      .mockRejectedValueOnce(new Error('Scheduling unavailable'));
    expect(await runComplianceHeartbeatJob()).toMatchObject({ checked: 0, skipped: 1 });
    expect(await db.countComplianceRuns(agentUrl)).toBe(2);
    expect(await snapshot()).toBe(before);
    expect(await db.getComplianceRun(agentUrl)).toMatchObject({ completeness: 'timed_out', is_authoritative: false,
      provenance_json: { reported_completeness: 'timed_out', storyboard_start_offset: 1 } });
    noSideEffects();
  });

  it('enforces explicit heartbeat completeness at the DB boundary without relying on the adapter', async () => {
    await seed();
    const before = await snapshot();
    for (const completeness of [undefined, null, 'partial', 'future_value', {}, ['complete']]) {
      const recorded = await db.recordComplianceRun({
        ...previous(), triggered_by: 'heartbeat', completeness, is_authoritative: true,
        overall_status: 'failing', storyboard_statuses: [],
      } as unknown as RecordComplianceRunInput);
      expect(recorded.run).toMatchObject({ completeness: 'not_completed', is_authoritative: false, dry_run: false });
      expect(await snapshot()).toBe(before);
    }
  });

  it.each(['complete', 'timed_out'])('rejects a %s result whose observed target supersedes the selected target', async completeness => {
    await seed();
    const before = await snapshot();
    const result = sdkResult(completeness);
    result.agent_profile.adcp_supported_versions = ['3.0'];
    mocks.comply.mockResolvedValue(result);
    expect(await runComplianceHeartbeatJob()).toMatchObject({ checked: 0, skipped: 1 });
    expect(await snapshot()).toBe(before);
    expect(await db.countComplianceRuns(agentUrl)).toBe(1);
    noSideEffects();
  });

  // Pause real SQL on the heartbeat's dedicated session at an exact boundary.
  // The other writer/terminator always uses a separate PostgreSQL connection.
  function barrier(match: string) {
    const entered = Promise.withResolvers<Client>();
    const resume = Promise.withResolvers<void>();
    const acquire = ComplianceRefreshRequestsDatabase.prototype.acquireAgentExecutionFence;
    vi.spyOn(ComplianceRefreshRequestsDatabase.prototype, 'acquireAgentExecutionFence').mockImplementation(async function (url) {
      const fence = await acquire.call(this, url);
      if (fence) await fence.withClient(async client => {
        const query = client.query.bind(client);
        let intercepted = false;
        vi.spyOn(client, 'query').mockImplementation((async (sql: string, ...args: unknown[]) => {
          if (!intercepted && sql.includes(match)) {
            intercepted = true;
            entered.resolve(client);
            await resume.promise;
          }
          return (query as (...args: unknown[]) => unknown)(sql, ...args);
        }) as Client['query']);
      });
      return fence;
    });
    return { entered: entered.promise, resume: () => resume.resolve() };
  }

  it('a delayed incomplete transaction cannot replace a concurrent owner complete refresh', async () => {
    await seed();
    respond('timed_out');
    const pause = barrier('COMMIT');
    const heartbeat = runComplianceHeartbeatJob();
    await pause.entered;
    try {
      const owner = await pool.connect();
      try {
        await new ComplianceDatabase().recordComplianceRun({ ...previous(), headline: 'New owner grade' }, owner);
      } finally { owner.release(); }
      const newer = await snapshot();
      pause.resume();
      expect(await heartbeat).toMatchObject({ checked: 0, skipped: 1 });
      expect(await snapshot()).toBe(newer);
      noSideEffects();
    } finally { pause.resume(); await heartbeat; }
  });

  it.each(['timed_out', 'complete'])('fence loss at the %s commit boundary rolls back before a newer owner can publish', async completeness => {
    await seed();
    respond(completeness, 75, false);
    const before = await snapshot();
    const pause = barrier('COMMIT');
    const heartbeat = runComplianceHeartbeatJob();
    const client = await pause.entered;
    try {
      const pid = await client.query('SELECT pg_backend_pid() AS pid');
      await pool.query('SELECT pg_terminate_backend($1)', [pid.rows[0].pid]);
      // Acquiring the real owner fence proves the old session released its lock.
      const ownerFence = await new ComplianceRefreshRequestsDatabase().acquireExecutionFence(randomUUID(), agentUrl);
      expect(ownerFence).not.toBeNull();
      try {
        expect(await snapshot()).toBe(before);
        await ownerFence!.withClient(owner => db.recordComplianceRun({ ...previous(), headline: 'Newer owner evidence' }, owner));
        const newer = await snapshot();
        pause.resume();
        await heartbeat;
        expect(await snapshot()).toBe(newer);
        expect(await db.countComplianceRuns(agentUrl)).toBe(2);
        noSideEffects();
      } finally { await ownerFence?.release(); }
    } finally { pause.resume(); await heartbeat; }
  });

  it.each([
    { completeness: 'timed_out', boundary: 'INSERT INTO agent_compliance_runs' },
    { completeness: 'complete', boundary: 'INSERT INTO agent_compliance_runs' },
    { completeness: 'complete', boundary: 'INSERT INTO agent_compliance_status' },
    { completeness: 'complete', boundary: 'INSERT INTO agent_storyboard_status' },
  ])('rolls back $completeness without any public mutation when $boundary fails', async ({ completeness, boundary }) => {
      await seed();
      respond(completeness, 75, false);
      const before = await snapshot();
      const pause = barrier(boundary);
      const heartbeat = runComplianceHeartbeatJob();
      const client = await pause.entered;
      try {
        // Real PostgreSQL transaction failure after BEGIN; fallback audit evidence is allowed.
        await expect(client.query('SELECT 1 / 0')).rejects.toThrow();
        pause.resume();
        expect(await heartbeat).toMatchObject({ checked: 0, skipped: 1 });
        expect(await snapshot()).toBe(before);
        const evidence = await db.getComplianceRun(agentUrl);
        expect(evidence).toMatchObject({ completeness, is_authoritative: false, dry_run: false,
          headline: 'New assessment', overall_status: 'failing', provenance_json: { reported_completeness: completeness } });
        expect(evidence?.storyboard_statuses_json).toHaveLength(75);
        expect(evidence?.tracks_json[0].scenario_count).toBe(75);
        expect(evidence?.observations_json).toEqual(sdkResult(completeness, 75, false).observations);
        noSideEffects();
      } finally { pause.resume(); await heartbeat; }
    },
  );

  it('does not promote or duplicate a replayed audit run through an authoritative retry', async () => {
    const old = await seed();
    const operationId = randomUUID();
    const lease = randomUUID();
    operations.push(operationId);
    await pool.query(`INSERT INTO agent_compliance_refresh_requests
      (id, agent_url, requester_type, triggered_by, test_session_id, status, lease_owner, lease_token, lease_expires_at)
      VALUES ($1::uuid, $2, 'static_admin', 'manual', $1::text, 'running', 'test-worker', $3, NOW() + INTERVAL '1 hour')`, [operationId, agentUrl, lease]);
    const input = { ...complianceResultToDbInput(sdkResult('timed_out'), agentUrl, 'production', 'heartbeat'),
      dry_run: false, refresh_operation_id: operationId, refresh_operation_lease_token: lease };
    const audit = await db.recordComplianceRun(input);
    const replay = await db.recordComplianceRun({ ...input, completeness: 'complete', is_authoritative: true });
    expect(replay).toMatchObject({ replayedExisting: true, statusTransition: null,
      run: { id: audit.run.id, is_authoritative: false, completeness: 'timed_out' } });
    expect((await db.getComplianceStatus(agentUrl))?.last_run_id).toBe(old.id);
    expect(await db.countComplianceRuns(agentUrl)).toBe(2);
    await new ComplianceRefreshRequestsDatabase().markSucceeded(operationId, lease, {});
    const completeOperation = randomUUID();
    operations.push(completeOperation);
    await pool.query(`INSERT INTO agent_compliance_refresh_requests
      (id, agent_url, requester_type, triggered_by, test_session_id, status, lease_owner, lease_token, lease_expires_at)
      VALUES ($1::uuid, $2, 'static_admin', 'manual', $1::text, 'running', 'test-worker', $3, NOW() + INTERVAL '1 hour')`, [completeOperation, agentUrl, lease]);
    const completeInput = { ...complianceResultToDbInput(sdkResult('complete', 75), agentUrl, 'production', 'heartbeat'),
      dry_run: false, refresh_operation_id: completeOperation, refresh_operation_lease_token: lease };
    const complete = await db.recordComplianceRun(completeInput);
    const beforeReplay = await snapshot();
    expect((await db.recordComplianceRun(completeInput)).replayedExisting).toBe(true);
    expect(await snapshot()).toBe(beforeReplay);
    expect((await db.getComplianceStatus(agentUrl))?.last_run_id).toBe(complete.run.id);
    expect(await db.countComplianceRuns(agentUrl)).toBe(3);
    await expect(db.recordComplianceRun({ ...completeInput, refresh_operation_lease_token: randomUUID() }))
      .rejects.toMatchObject({ code: 'lease_lost' });
    expect(await snapshot()).toBe(beforeReplay);
  });
});
