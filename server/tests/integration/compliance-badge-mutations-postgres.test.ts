import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ pool: undefined as Pool | undefined }));
vi.mock('../../src/db/client.js', () => ({
  query: (sql: string, params?: unknown[]) => state.pool!.query(sql, params),
  getClient: () => state.pool!.connect(),
}));
import { ComplianceDatabase } from '../../src/db/compliance-db.js';

const testUrl = process.env.COMPLIANCE_BADGE_TEST_DATABASE_URL;
const schema = `badge_mutations_${randomUUID().replaceAll('-', '')}`;
const agentUrl = 'https://badge-agent.example/mcp';
const sourceRunId = '00000000-0000-4000-8000-000000000001';
const guard: NonNullable<Parameters<ComplianceDatabase['degradeBadge']>[4]> = {
  profile: 'spec', revision: '7', sourceRunId,
};

describe.skipIf(!testUrl)('badge mutations against disposable PostgreSQL', () => {
  const db = new ComplianceDatabase();
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/compliance_badge_tests') {
      throw new Error('Tests require the dedicated local compliance_badge_tests database.');
    }
    state.pool = new Pool({ connectionString: testUrl, options: `-c search_path=${schema},pg_catalog` });
    await state.pool.query(`CREATE SCHEMA ${schema}`);
    await state.pool.query(`
      CREATE TABLE agent_verification_badges (
        agent_url text, role text, adcp_version text, status text,
        revoked_at timestamptz, revocation_reason text, degraded_at timestamptz,
        grading_profile text, grading_profile_revision bigint,
        grading_source_run_id uuid, grading_assessment_id uuid, grading_policy_version text,
        verification_token text, token_expires_at timestamptz, updated_at timestamptz
      );
      CREATE TABLE agent_registry_metadata (agent_url text, badge_requalification_generation bigint);
      CREATE TABLE agent_grading_profiles (agent_url text, role text, adcp_version text, revision bigint, selected_profile text);
      CREATE TABLE agent_compliance_runs (
        id uuid, agent_url text, dry_run boolean, is_authoritative boolean,
        completeness text, adcp_version text, tested_at timestamptz
      );
    `);
  });
  afterAll(async () => {
    if (!state.pool) return;
    try { await state.pool.query(`DROP SCHEMA ${schema} CASCADE`); }
    finally { await state.pool.end(); state.pool = undefined; }
  });
  beforeEach(async () => {
    await state.pool!.query('TRUNCATE agent_verification_badges, agent_registry_metadata, agent_grading_profiles, agent_compliance_runs');
    await state.pool!.query(`INSERT INTO agent_verification_badges
      (agent_url, role, adcp_version, status, verification_token, token_expires_at)
      VALUES ($1, 'media-buy', '3.2', 'active', 'previous-token', NOW() + INTERVAL '1 day')`, [agentUrl]);
    await state.pool!.query('INSERT INTO agent_registry_metadata VALUES ($1, 5)', [agentUrl]);
    await state.pool!.query("INSERT INTO agent_grading_profiles VALUES ($1, 'media-buy', '3.2', 7, 'spec')", [agentUrl]);
    await state.pool!.query("INSERT INTO agent_compliance_runs VALUES ($1, $2, FALSE, TRUE, 'complete', '3.2.6', NOW())", [sourceRunId, agentUrl]);
  });

  const mutate = (action: 'revoke' | 'degrade', generation: string | undefined, gradingGuard = guard, target = db) => action === 'revoke'
    ? target.revokeBadge(agentUrl, 'media-buy', '3.2', 'Failed compliance', generation, gradingGuard)
    : target.degradeBadge(agentUrl, 'media-buy', '3.2', generation, gradingGuard);

  it.each(['revoke', 'degrade'] as const)('%s executes with current guards and clears the verification token', async action => {
    expect(await mutate(action, '5')).toBe(true);
    const { rows: [badge] } = await state.pool!.query('SELECT * FROM agent_verification_badges');
    expect(badge).toMatchObject({
      status: action === 'revoke' ? 'revoked' : 'degraded',
      verification_token: null, token_expires_at: null,
      grading_profile: 'spec', grading_profile_revision: '7', grading_source_run_id: sourceRunId,
    });
  });

  it.each(['revoke', 'degrade'] as const)('%s refuses stale generation, revision, profile and source-run guards', async action => {
    expect(await mutate(action, '4')).toBe(false);
    expect(await mutate(action, '5', { ...guard, revision: '6' })).toBe(false);
    expect(await mutate(action, '5', { ...guard, profile: 'legacy' })).toBe(false);
    expect(await mutate(action, '5', { ...guard, sourceRunId: randomUUID() })).toBe(false);
    expect((await state.pool!.query('SELECT status, verification_token FROM agent_verification_badges')).rows)
      .toEqual([{ status: 'active', verification_token: 'previous-token' }]);
  });

  it.each(['revoke', 'degrade'] as const)('%s enforces grading guards when only the canonical write fence is present', async action => {
    const fenced = new ComplianceDatabase(async () => {});
    expect(await mutate(action, undefined, { ...guard, revision: '6' }, fenced)).toBe(false);
    expect(await mutate(action, undefined, guard, fenced)).toBe(true);
  });
});
