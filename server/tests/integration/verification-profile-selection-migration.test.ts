import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { closeDatabase, initializeDatabase } from '../../src/db/client.js';
import {
  claimGradingProfileProjectionJobs,
  completeGradingProfileProjectionJob,
  getPublicSelectedGradingStatuses,
  GradingProfileConflictError,
  selectGradingProfile,
} from '../../src/db/verification-profile-db.js';

const TEST_SCHEMA = `verification_profile_selection_${process.pid}`;
const MIGRATION = readFileSync(
  resolve(__dirname, '../../src/db/migrations/598_owner_selectable_grading_profiles.sql'),
  'utf8',
);

describe.skipIf(!process.env.DATABASE_URL)('owner-selectable grading profile migration', () => {
  let pool: Pool;
  let client: PoolClient;
  let runId: string;
  let assessmentId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    client = await pool.connect();
    await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await client.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
    await client.query(`SET search_path TO ${TEST_SCHEMA}, public`);
    await client.query(`
      CREATE TABLE system_settings (
        key VARCHAR(100) PRIMARY KEY, value JSONB NOT NULL, description TEXT
      );
      CREATE TABLE system_settings_audit (
        id BIGSERIAL PRIMARY KEY, key VARCHAR(100) NOT NULL,
        old_value JSONB, new_value JSONB NOT NULL,
        changed_by TEXT, changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE agent_compliance_runs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        agent_url TEXT NOT NULL DEFAULT 'https://seller.example.test/mcp',
        lifecycle_stage TEXT NOT NULL DEFAULT 'production',
        requested_compliance_target TEXT,
        adcp_version TEXT DEFAULT '3.1.4',
        agent_profile_json JSONB NOT NULL DEFAULT '{"adcp_supported_versions":["3.1.4"]}'::jsonb,
        tested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        dry_run BOOLEAN NOT NULL DEFAULT FALSE,
        is_authoritative BOOLEAN NOT NULL DEFAULT TRUE,
        completeness TEXT NOT NULL DEFAULT 'complete'
      );
      CREATE TABLE agent_verification_badges (
        agent_url TEXT NOT NULL, role TEXT NOT NULL, adcp_version TEXT NOT NULL,
        verified_specialisms TEXT[] NOT NULL DEFAULT '{}', verification_modes TEXT[] NOT NULL DEFAULT '{spec}',
        verified_protocol_version TEXT, verification_token TEXT, token_expires_at TIMESTAMPTZ,
        membership_org_id TEXT, status TEXT NOT NULL DEFAULT 'active', verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        revoked_at TIMESTAMPTZ, revocation_reason TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (agent_url, role, adcp_version)
      );
      CREATE TABLE organizations (
        workos_organization_id TEXT PRIMARY KEY,
        membership_tier TEXT,
        subscription_status TEXT,
        subscription_canceled_at TIMESTAMPTZ
      );
      CREATE TABLE member_profiles (
        workos_organization_id TEXT PRIMARY KEY,
        agents JSONB NOT NULL DEFAULT '[]'::jsonb
      );
      CREATE TABLE organization_memberships (
        workos_organization_id TEXT NOT NULL,
        workos_user_id TEXT NOT NULL,
        role TEXT NOT NULL,
        PRIMARY KEY (workos_organization_id, workos_user_id)
      );
      CREATE TABLE agent_registry_metadata (
        agent_url TEXT PRIMARY KEY,
        compliance_opt_out BOOLEAN NOT NULL DEFAULT FALSE,
        badge_requalification_required BOOLEAN NOT NULL DEFAULT FALSE
      );
      INSERT INTO organizations (workos_organization_id, membership_tier, subscription_status)
      VALUES ('org_1', 'company_standard', 'active');
      INSERT INTO member_profiles (workos_organization_id, agents)
      VALUES (
        'org_1',
        '[{"url":"https://seller.example.test/mcp","visibility":"public"}]'::jsonb
      );
      INSERT INTO organization_memberships (workos_organization_id, workos_user_id, role)
      VALUES ('org_1', 'user_1', 'owner');
      INSERT INTO agent_verification_badges (agent_url, role, adcp_version)
      VALUES ('https://seller.example.test/mcp', 'media-buy', '3.1');
    `);
    const run = await client.query<{ id: string }>('INSERT INTO agent_compliance_runs DEFAULT VALUES RETURNING id');
    runId = run.rows[0].id;
    await client.query(MIGRATION);
    const assessment = await client.query<{ id: string }>(
      `INSERT INTO verification_profile_role_assessments (
         source_run_id, agent_url, role, adcp_version, grading_profile, status,
         selectable, policy_version, compliance_bundle_version, lifecycle_stage,
         run_complete, evidence, source_tested_at
       ) VALUES ($1, 'https://seller.example.test/mcp', 'media-buy', '3.1',
         'spec', 'passing', TRUE, 'verification-profiles-role-v1', '3.1.4',
         'production', TRUE, '{}', NOW()) RETURNING id`,
      [runId],
    );
    assessmentId = assessment.rows[0].id;
    const appUrl = new URL(process.env.DATABASE_URL!);
    appUrl.searchParams.set('options', `-csearch_path=${TEST_SCHEMA},public`);
    initializeDatabase({ connectionString: appUrl.toString(), maxPoolSize: 2 });
  });

  afterAll(async () => {
    if (client) {
      await closeDatabase();
      await client.query('RESET search_path');
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      client.release();
    }
    await pool?.end();
  });

  it('preserves existing badges as Legacy without creating selections', async () => {
    const badge = await client.query('SELECT grading_profile, grading_profile_revision FROM agent_verification_badges');
    expect(badge.rows).toEqual([{ grading_profile: 'legacy', grading_profile_revision: '0' }]);
    expect((await client.query('SELECT 1 FROM agent_grading_profiles')).rowCount).toBe(0);
  });

  it('makes Sandbox selection impossible at the database layer', async () => {
    await expect(client.query(
      `INSERT INTO agent_grading_profiles (
         agent_url, role, adcp_version, selected_profile, selected_assessment_id,
         revision, selected_by_user_id, selected_by_org_id
       ) VALUES ('https://seller.example.test/mcp', 'media-buy', '3.1',
         'sandbox', $1, 1, 'user_1', 'org_1')`,
      [assessmentId],
    )).rejects.toThrow();
  });

  it('binds a selection to the assessment exact agent, role, version, and profile', async () => {
    await expect(client.query(
      `INSERT INTO agent_grading_profiles (
         agent_url, role, adcp_version, selected_profile, selected_assessment_id,
         revision, selected_by_user_id, selected_by_org_id
       ) VALUES ('https://seller.example.test/mcp', 'media-buy', '3.1',
         'legacy', $1, 1, 'user_1', 'org_1')`,
      [assessmentId],
    )).rejects.toThrow(/assessment_identity_fk/);

    await expect(client.query(
      `INSERT INTO agent_grading_profiles (
         agent_url, role, adcp_version, selected_profile, selected_assessment_id,
         revision, selected_by_user_id, selected_by_org_id
       ) VALUES ('https://seller.example.test/mcp', 'creative', '3.1',
         'spec', $1, 1, 'user_1', 'org_1')`,
      [assessmentId],
    )).rejects.toThrow(/assessment_identity_fk/);
  });

  it('requires authoritative exact source-run provenance and freezes it after assessment', async () => {
    const dryRun = await client.query<{ id: string }>(
      `INSERT INTO agent_compliance_runs (dry_run) VALUES (TRUE) RETURNING id`,
    );
    await expect(client.query(
      `INSERT INTO verification_profile_role_assessments (
         source_run_id, agent_url, role, adcp_version, grading_profile, status,
         selectable, policy_version, compliance_bundle_version, lifecycle_stage,
         run_complete, evidence, source_tested_at
       ) VALUES ($1, 'https://seller.example.test/mcp', 'creative', '3.1',
         'spec', 'passing', TRUE, 'verification-profiles-role-v1', '3.1.4',
         'production', TRUE, '{}', NOW())`,
      [dryRun.rows[0].id],
    )).rejects.toThrow(/authoritative complete source run/);

    await expect(client.query(
      `INSERT INTO verification_profile_role_assessments (
         source_run_id, agent_url, role, adcp_version, grading_profile, status,
         selectable, policy_version, compliance_bundle_version, lifecycle_stage,
         run_complete, evidence, source_tested_at
       ) VALUES ($1, 'https://different.example.test/mcp', 'creative', '3.1',
         'spec', 'passing', TRUE, 'verification-profiles-role-v1', '3.1.4',
         'production', TRUE, '{}', NOW())`,
      [runId],
    )).rejects.toThrow(/provenance does not match/);

    const timestamps = await client.query(
      `SELECT a.source_tested_at = r.tested_at AS exact
       FROM verification_profile_role_assessments a
       JOIN agent_compliance_runs r ON r.id = a.source_run_id
       WHERE a.id = $1`,
      [assessmentId],
    );
    expect(timestamps.rows[0].exact).toBe(true);

    await expect(client.query(
      `UPDATE agent_compliance_runs SET adcp_version = '3.1.99' WHERE id = $1`,
      [runId],
    )).rejects.toThrow(/provenance is immutable/);
  });

  it('prevents assessment mutation and deletion', async () => {
    await expect(client.query(
      `UPDATE verification_profile_role_assessments SET status = 'failing' WHERE id = $1`,
      [assessmentId],
    )).rejects.toThrow('immutable');
    await expect(client.query(
      'DELETE FROM verification_profile_role_assessments WHERE id = $1',
      [assessmentId],
    )).rejects.toThrow('immutable');
  });

  it('ships selection enabled without a Legacy auto-migration deadline', async () => {
    const setting = await client.query('SELECT value FROM system_settings WHERE key = $1', ['grading_profile_rollout']);
    expect(setting.rows[0].value).toEqual({ selection_enabled: true, legacy_selection_allowed_until: null });
  });

  it('commits selection, badge projection, audit, idempotent replay, and revision CAS together', async () => {
    const first = await selectGradingProfile({
      agentUrl: 'https://seller.example.test/mcp',
      role: 'media-buy',
      adcpVersion: '3.1',
      selectedProfile: 'spec',
      assessmentId,
      expectedRevision: 0,
      acknowledgePublicImpact: false,
      idempotencyKey: '11111111-1111-4111-8111-111111111111',
      requestId: 'request-1',
      actorUserId: 'user_1',
      actorOrgId: 'org_1',
      actorKind: 'organization',
    });
    expect(first).toMatchObject({ selected_profile: 'spec', revision: '1', public_effect: 'regrade', replayed: false });

    const badge = await client.query(
      `SELECT grading_profile, grading_profile_revision, verification_token
       FROM agent_verification_badges`,
    );
    expect(badge.rows).toEqual([{ grading_profile: 'spec', grading_profile_revision: '1', verification_token: null }]);
    expect((await client.query('SELECT 1 FROM agent_grading_profile_audit')).rowCount).toBe(1);
    expect((await client.query(
      `SELECT status, selection_revision::text, source_run_id, assessment_id
       FROM agent_grading_profile_projection_jobs`,
    )).rows).toEqual([{
      status: 'pending',
      selection_revision: '1',
      source_run_id: runId,
      assessment_id: assessmentId,
    }]);

    const replay = await selectGradingProfile({
      agentUrl: 'https://seller.example.test/mcp',
      role: 'media-buy',
      adcpVersion: '3.1',
      selectedProfile: 'spec',
      assessmentId,
      expectedRevision: 0,
      acknowledgePublicImpact: false,
      idempotencyKey: '11111111-1111-4111-8111-111111111111',
      requestId: 'request-retry',
      actorUserId: 'user_1',
      actorOrgId: 'org_1',
      actorKind: 'organization',
    });
    expect(replay.replayed).toBe(true);
    expect((await client.query('SELECT 1 FROM agent_grading_profile_audit')).rowCount).toBe(1);
    expect((await client.query('SELECT 1 FROM agent_grading_profile_projection_jobs')).rowCount).toBe(1);

    await expect(selectGradingProfile({
      agentUrl: 'https://seller.example.test/mcp',
      role: 'media-buy',
      adcpVersion: '3.1',
      selectedProfile: 'legacy',
      assessmentId,
      expectedRevision: 0,
      acknowledgePublicImpact: false,
      idempotencyKey: '11111111-1111-4111-8111-111111111111',
      requestId: 'request-mismatched-retry',
      actorUserId: 'user_1',
      actorOrgId: 'org_1',
      actorKind: 'organization',
    })).rejects.toMatchObject<Partial<GradingProfileConflictError>>({ reason: 'idempotency_mismatch' });

    const fingerprint = await client.query<{
      stored: string;
      same_request: string;
      changed_request: string;
    }>(
      `SELECT request_fingerprint AS stored,
              grading_profile_request_fingerprint(
                actor_user_id, actor_org_id, actor_kind, admin_override_reason,
                agent_url, role, adcp_version, selected_profile, assessment_id,
                previous_revision
              ) AS same_request,
              grading_profile_request_fingerprint(
                actor_user_id, actor_org_id, actor_kind, admin_override_reason,
                agent_url, role, adcp_version, 'legacy', assessment_id,
                previous_revision
              ) AS changed_request
       FROM agent_grading_profile_audit
       WHERE idempotency_key = '11111111-1111-4111-8111-111111111111'`,
    );
    expect(fingerprint.rows[0].stored).toBe(fingerprint.rows[0].same_request);
    expect(fingerprint.rows[0].changed_request).not.toBe(fingerprint.rows[0].stored);

    await expect(selectGradingProfile({
      agentUrl: 'https://seller.example.test/mcp',
      role: 'media-buy',
      adcpVersion: '3.1',
      selectedProfile: 'spec',
      assessmentId,
      expectedRevision: 0,
      acknowledgePublicImpact: false,
      idempotencyKey: '22222222-2222-4222-8222-222222222222',
      requestId: 'request-stale',
      actorUserId: 'user_1',
      actorOrgId: 'org_1',
      actorKind: 'organization',
    })).rejects.toMatchObject<Partial<GradingProfileConflictError>>({ reason: 'stale_revision' });
  });

  it('leases and completes the durable exact projection retry', async () => {
    const claimed = await claimGradingProfileProjectionJobs(1);
    expect(claimed).toEqual([expect.objectContaining({
      agent_url: 'https://seller.example.test/mcp',
      role: 'media-buy',
      adcp_version: '3.1',
      selection_revision: '1',
      source_run_id: runId,
      assessment_id: assessmentId,
      attempts: 1,
    })]);
    await completeGradingProfileProjectionJob({
      agentUrl: claimed[0].agent_url,
      role: claimed[0].role,
      adcpVersion: claimed[0].adcp_version,
      selectionRevision: claimed[0].selection_revision,
    });
    expect((await client.query(
      `SELECT status, lease_expires_at, last_error
       FROM agent_grading_profile_projection_jobs
       WHERE selection_revision = 1`,
    )).rows).toEqual([{ status: 'completed', lease_expires_at: null, last_error: null }]);
  });

  it('requires explicit impact confirmation before degrading a badge', async () => {
    const run = await client.query<{ id: string }>(
      `INSERT INTO agent_compliance_runs (adcp_version, tested_at)
       SELECT '3.1.5', MAX(tested_at) + INTERVAL '1 second' FROM agent_compliance_runs
       RETURNING id`,
    );
    const failing = await client.query<{ id: string }>(
      `INSERT INTO verification_profile_role_assessments (
         source_run_id, agent_url, role, adcp_version, grading_profile, status,
         selectable, policy_version, compliance_bundle_version, lifecycle_stage,
         run_complete, evidence, source_tested_at
       ) VALUES ($1, 'https://seller.example.test/mcp', 'media-buy', '3.1',
         'spec', 'failing', TRUE, 'verification-profiles-role-v1', '3.1.5',
         'production', TRUE, '{"specialisms":["sales-non-guaranteed"]}', NOW() + INTERVAL '1 second')
       RETURNING id`,
      [run.rows[0].id],
    );
    const base = {
      agentUrl: 'https://seller.example.test/mcp',
      role: 'media-buy' as const,
      adcpVersion: '3.1',
      selectedProfile: 'spec' as const,
      assessmentId: failing.rows[0].id,
      expectedRevision: 1,
      requestId: 'request-failing',
      actorUserId: 'user_1',
      actorOrgId: 'org_1',
      actorKind: 'organization' as const,
    };
    await expect(selectGradingProfile({
      ...base,
      acknowledgePublicImpact: false,
      idempotencyKey: '33333333-3333-4333-8333-333333333333',
    })).rejects.toMatchObject<Partial<GradingProfileConflictError>>({ reason: 'impact_confirmation_required' });
    expect((await client.query('SELECT revision FROM agent_grading_profiles')).rows[0].revision).toBe('1');

    const confirmed = await selectGradingProfile({
      ...base,
      acknowledgePublicImpact: true,
      idempotencyKey: '44444444-4444-4444-8444-444444444444',
    });
    expect(confirmed).toMatchObject({ revision: '2', public_effect: 'degrade' });
    const state = await client.query('SELECT status, degraded_at FROM agent_verification_badges');
    expect(state.rows[0].status).toBe('degraded');
    expect(state.rows[0].degraded_at).not.toBeNull();
  });

  it('fails closed for malformed rollout state and transaction-time authorization changes', async () => {
    await client.query(
      `UPDATE system_settings SET value = '{"selection_enabled": true, "legacy_selection_allowed_until": null, "future": true}'
       WHERE key = 'grading_profile_rollout'`,
    );
    const attempt = {
      agentUrl: 'https://seller.example.test/mcp',
      role: 'media-buy' as const,
      adcpVersion: '3.1',
      selectedProfile: 'spec' as const,
      assessmentId: (await client.query<{ id: string }>(
        `SELECT id FROM verification_profile_role_assessments
         WHERE grading_profile = 'spec' ORDER BY source_tested_at DESC LIMIT 1`,
      )).rows[0].id,
      expectedRevision: 2,
      acknowledgePublicImpact: true,
      requestId: 'request-closed-gates',
      actorUserId: 'user_1',
      actorOrgId: 'org_1',
      actorKind: 'organization' as const,
    };
    await expect(selectGradingProfile({
      ...attempt,
      idempotencyKey: '66666666-6666-4666-8666-666666666666',
    })).rejects.toMatchObject<Partial<GradingProfileConflictError>>({ reason: 'selection_disabled' });

    await client.query(
      `UPDATE system_settings SET value = '{"selection_enabled": true, "legacy_selection_allowed_until": null}'
       WHERE key = 'grading_profile_rollout'`,
    );
    await client.query(`DELETE FROM organization_memberships WHERE workos_user_id = 'user_1'`);
    await expect(selectGradingProfile({
      ...attempt,
      idempotencyKey: '77777777-7777-4777-8777-777777777777',
    })).rejects.toMatchObject<Partial<GradingProfileConflictError>>({ reason: 'authorization_changed' });
    await client.query(
      `INSERT INTO organization_memberships (workos_organization_id, workos_user_id, role)
       VALUES ('org_1', 'user_1', 'owner')`,
    );
  });

  it('rejects stale evidence and a superseded run that has no matching assessments', async () => {
    await client.query(
      `UPDATE member_profiles
       SET agents = agents || '[{"url":"https://stale.example.test/mcp","visibility":"public"}]'::jsonb
       WHERE workos_organization_id = 'org_1'`,
    );
    const staleRun = await client.query<{ id: string }>(
      `INSERT INTO agent_compliance_runs (
         agent_url, adcp_version, agent_profile_json, tested_at
       ) VALUES (
         'https://stale.example.test/mcp', '3.1.4',
         '{"adcp_supported_versions":["3.1.4"]}', NOW() - INTERVAL '25 hours'
       ) RETURNING id`,
    );
    const staleAssessment = await client.query<{ id: string }>(
      `INSERT INTO verification_profile_role_assessments (
         source_run_id, agent_url, role, adcp_version, grading_profile, status,
         selectable, policy_version, compliance_bundle_version, lifecycle_stage,
         run_complete, evidence, source_tested_at
       ) VALUES ($1, 'https://stale.example.test/mcp', 'media-buy', '3.1',
         'spec', 'passing', TRUE, 'verification-profiles-role-v1', '3.1.4',
         'production', TRUE, '{"specialisms":["sales-non-guaranteed"]}', NOW()) RETURNING id`,
      [staleRun.rows[0].id],
    );
    await expect(selectGradingProfile({
      agentUrl: 'https://stale.example.test/mcp',
      role: 'media-buy',
      adcpVersion: '3.1',
      selectedProfile: 'spec',
      assessmentId: staleAssessment.rows[0].id,
      expectedRevision: 0,
      acknowledgePublicImpact: false,
      idempotencyKey: '88888888-8888-4888-8888-888888888888',
      requestId: 'request-stale-age',
      actorUserId: 'user_1',
      actorOrgId: 'org_1',
      actorKind: 'organization',
    })).rejects.toMatchObject<Partial<GradingProfileConflictError>>({ reason: 'stale_assessment' });

    await client.query(
      `INSERT INTO agent_compliance_runs (adcp_version, tested_at)
       SELECT '3.1.6', MAX(tested_at) + INTERVAL '1 second' FROM agent_compliance_runs
       WHERE agent_url = 'https://seller.example.test/mcp'`,
    );
    await expect(selectGradingProfile({
      agentUrl: 'https://seller.example.test/mcp',
      role: 'media-buy',
      adcpVersion: '3.1',
      selectedProfile: 'spec',
      assessmentId: assessmentId,
      expectedRevision: 2,
      acknowledgePublicImpact: true,
      idempotencyKey: '99999999-9999-4999-8999-999999999999',
      requestId: 'request-superseded',
      actorUserId: 'user_1',
      actorOrgId: 'org_1',
      actorKind: 'organization',
    })).rejects.toMatchObject<Partial<GradingProfileConflictError>>({ reason: 'stale_assessment' });
    expect(await getPublicSelectedGradingStatuses('https://seller.example.test/mcp')).toEqual([
      expect.objectContaining({
        role: 'media-buy',
        adcp_version: '3.1',
        grading_profile: 'spec',
        grading_status: null,
        availability: 'unavailable',
        revision: '2',
      }),
    ]);
  });

  it('gives Legacy a fresh grace period while retaining the dormant Strict Spec clock', async () => {
    const passingRun = await client.query<{ id: string }>(
      `INSERT INTO agent_compliance_runs (adcp_version, tested_at)
       SELECT '3.1.7', MAX(tested_at) + INTERVAL '1 second' FROM agent_compliance_runs
       WHERE agent_url = 'https://seller.example.test/mcp' RETURNING id`,
    );
    const passingLegacy = await client.query<{ id: string }>(
      `INSERT INTO verification_profile_role_assessments (
         source_run_id, agent_url, role, adcp_version, grading_profile, status,
         selectable, policy_version, compliance_bundle_version, lifecycle_stage,
         run_complete, evidence, source_tested_at
       ) VALUES ($1, 'https://seller.example.test/mcp', 'media-buy', '3.1',
         'legacy', 'passing', TRUE, 'verification-profiles-role-v1', '3.1.7',
         'production', TRUE, '{"specialisms":["sales-non-guaranteed"]}', NOW()) RETURNING id`,
      [passingRun.rows[0].id],
    );
    await client.query(
      `UPDATE agent_grading_profiles SET spec_failure_since = NOW() - INTERVAL '72 hours'`,
    );
    const restored = await selectGradingProfile({
      agentUrl: 'https://seller.example.test/mcp', role: 'media-buy', adcpVersion: '3.1',
      selectedProfile: 'legacy', assessmentId: passingLegacy.rows[0].id, expectedRevision: 2,
      acknowledgePublicImpact: false, idempotencyKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      requestId: 'request-legacy-restore', actorUserId: 'user_1', actorOrgId: 'org_1', actorKind: 'organization',
    });
    expect(restored.public_effect).toBe('restore');

    const failingRun = await client.query<{ id: string }>(
      `INSERT INTO agent_compliance_runs (adcp_version, tested_at)
       SELECT '3.1.8', MAX(tested_at) + INTERVAL '1 second' FROM agent_compliance_runs
       WHERE agent_url = 'https://seller.example.test/mcp' RETURNING id`,
    );
    const failingLegacy = await client.query<{ id: string }>(
      `INSERT INTO verification_profile_role_assessments (
         source_run_id, agent_url, role, adcp_version, grading_profile, status,
         selectable, policy_version, compliance_bundle_version, lifecycle_stage,
         run_complete, evidence, source_tested_at
       ) VALUES ($1, 'https://seller.example.test/mcp', 'media-buy', '3.1',
         'legacy', 'failing', TRUE, 'verification-profiles-role-v1', '3.1.8',
         'production', TRUE, '{"specialisms":["sales-non-guaranteed"]}', NOW()) RETURNING id`,
      [failingRun.rows[0].id],
    );
    const degraded = await selectGradingProfile({
      agentUrl: 'https://seller.example.test/mcp', role: 'media-buy', adcpVersion: '3.1',
      selectedProfile: 'legacy', assessmentId: failingLegacy.rows[0].id, expectedRevision: 3,
      acknowledgePublicImpact: true, idempotencyKey: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      requestId: 'request-legacy-failure', actorUserId: 'user_1', actorOrgId: 'org_1', actorKind: 'organization',
    });
    expect(degraded.public_effect).toBe('degrade');
    const state = await client.query(
      `SELECT b.status, b.degraded_at > NOW() - INTERVAL '1 minute' AS fresh,
              g.spec_failure_since < NOW() - INTERVAL '48 hours' AS spec_clock_retained
       FROM agent_verification_badges b
       JOIN agent_grading_profiles g USING (agent_url, role, adcp_version)`,
    );
    expect(state.rows[0]).toMatchObject({ status: 'degraded', fresh: true, spec_clock_retained: true });
  });

  it('serializes selection behind authoritative publication on the shared agent lock', async () => {
    const latestLegacy = await client.query<{ id: string }>(
      `SELECT id FROM verification_profile_role_assessments
       WHERE agent_url = 'https://seller.example.test/mcp' AND grading_profile = 'legacy'
       ORDER BY source_tested_at DESC LIMIT 1`,
    );
    const publisher = await pool.connect();
    await publisher.query('BEGIN');
    await publisher.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      ['verification-badge:https://seller.example.test/mcp'],
    );
    let settled = false;
    const selection = selectGradingProfile({
      agentUrl: 'https://seller.example.test/mcp', role: 'media-buy', adcpVersion: '3.1',
      selectedProfile: 'legacy', assessmentId: latestLegacy.rows[0].id, expectedRevision: 4,
      acknowledgePublicImpact: true, idempotencyKey: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      requestId: 'request-serialized', actorUserId: 'user_1', actorOrgId: 'org_1', actorKind: 'organization',
    }).finally(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(settled).toBe(false);
    await publisher.query('COMMIT');
    publisher.release();
    await expect(selection).resolves.toMatchObject({ revision: '5' });
  });

  it('resets Legacy grace when rolling a degraded Strict badge back to failing Legacy', async () => {
    const insertAssessment = async (bundle: string, profile: 'legacy' | 'spec', status: 'passing' | 'failing') => {
      const run = await client.query<{ id: string }>(
        `INSERT INTO agent_compliance_runs (adcp_version, tested_at)
         SELECT $1, MAX(tested_at) + INTERVAL '1 second' FROM agent_compliance_runs
         WHERE agent_url = 'https://seller.example.test/mcp' RETURNING id`,
        [bundle],
      );
      return (await client.query<{ id: string }>(
        `INSERT INTO verification_profile_role_assessments (
           source_run_id, agent_url, role, adcp_version, grading_profile, status,
           selectable, policy_version, compliance_bundle_version, lifecycle_stage,
           run_complete, evidence, source_tested_at
         ) VALUES ($1, 'https://seller.example.test/mcp', 'media-buy', '3.1',
           $2, $3, TRUE, 'verification-profiles-role-v1', $4,
           'production', TRUE, '{"specialisms":["sales-non-guaranteed"]}', NOW()) RETURNING id`,
        [run.rows[0].id, profile, status, bundle],
      )).rows[0].id;
    };
    const passingSpec = await insertAssessment('3.1.9', 'spec', 'passing');
    await selectGradingProfile({
      agentUrl: 'https://seller.example.test/mcp', role: 'media-buy', adcpVersion: '3.1',
      selectedProfile: 'spec', assessmentId: passingSpec, expectedRevision: 5,
      acknowledgePublicImpact: false, idempotencyKey: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      requestId: 'request-spec-restore', actorUserId: 'user_1', actorOrgId: 'org_1', actorKind: 'organization',
    });
    const failingSpec = await insertAssessment('3.1.10', 'spec', 'failing');
    await selectGradingProfile({
      agentUrl: 'https://seller.example.test/mcp', role: 'media-buy', adcpVersion: '3.1',
      selectedProfile: 'spec', assessmentId: failingSpec, expectedRevision: 6,
      acknowledgePublicImpact: true, idempotencyKey: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      requestId: 'request-spec-degrade', actorUserId: 'user_1', actorOrgId: 'org_1', actorKind: 'organization',
    });
    await client.query(
      `UPDATE agent_verification_badges SET degraded_at = NOW() - INTERVAL '72 hours';
       UPDATE agent_grading_profiles SET spec_failure_since = NOW() - INTERVAL '72 hours'`,
    );
    const failingLegacy = await insertAssessment('3.1.11', 'legacy', 'failing');
    const rollback = await selectGradingProfile({
      agentUrl: 'https://seller.example.test/mcp', role: 'media-buy', adcpVersion: '3.1',
      selectedProfile: 'legacy', assessmentId: failingLegacy, expectedRevision: 7,
      acknowledgePublicImpact: false, idempotencyKey: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      requestId: 'request-failing-rollback', actorUserId: 'user_1', actorOrgId: 'org_1', actorKind: 'organization',
    });
    expect(rollback.public_effect).toBe('regrade');
    const state = await client.query(
      `SELECT b.status, b.degraded_at > NOW() - INTERVAL '1 minute' AS legacy_clock_fresh,
              g.spec_failure_since < NOW() - INTERVAL '48 hours' AS spec_clock_retained
       FROM agent_verification_badges b
       JOIN agent_grading_profiles g USING (agent_url, role, adcp_version)`,
    );
    expect(state.rows[0]).toMatchObject({
      status: 'degraded', legacy_clock_fresh: true, spec_clock_retained: true,
    });
  });

  it('revokes immediately when reselecting Strict with an expired retained clock', async () => {
    await client.query(`UPDATE agent_verification_badges SET status = 'active', degraded_at = NULL`);
    const run = await client.query<{ id: string }>(
      `INSERT INTO agent_compliance_runs (adcp_version, tested_at)
       SELECT '3.1.12', MAX(tested_at) + INTERVAL '1 second' FROM agent_compliance_runs
       WHERE agent_url = 'https://seller.example.test/mcp' RETURNING id`,
    );
    const failingSpec = await client.query<{ id: string }>(
      `INSERT INTO verification_profile_role_assessments (
         source_run_id, agent_url, role, adcp_version, grading_profile, status,
         selectable, policy_version, compliance_bundle_version, lifecycle_stage,
         run_complete, evidence, source_tested_at
       ) VALUES ($1, 'https://seller.example.test/mcp', 'media-buy', '3.1',
         'spec', 'failing', TRUE, 'verification-profiles-role-v1', '3.1.12',
         'production', TRUE, '{"specialisms":["sales-non-guaranteed"]}', NOW()) RETURNING id`,
      [run.rows[0].id],
    );
    const selection = await selectGradingProfile({
      agentUrl: 'https://seller.example.test/mcp', role: 'media-buy', adcpVersion: '3.1',
      selectedProfile: 'spec', assessmentId: failingSpec.rows[0].id, expectedRevision: 8,
      acknowledgePublicImpact: true, idempotencyKey: '12121212-1212-4121-8121-121212121212',
      requestId: 'request-expired-spec-reselection', actorUserId: 'user_1', actorOrgId: 'org_1', actorKind: 'organization',
    });
    expect(selection.public_effect).toBe('revoke');
    const revoked = await client.query(
      `SELECT status, revoked_at > NOW() - INTERVAL '1 minute' AS revoked_now,
              revocation_reason
       FROM agent_verification_badges`,
    );
    expect(revoked.rows[0]).toEqual({
      status: 'revoked',
      revoked_now: true,
      revocation_reason: 'Selected grading profile remained non-passing beyond the 48-hour grace period',
    });
  });

  it('preserves original revocation facts when a revoked badge selects another failing profile', async () => {
    const before = (await client.query(
      `SELECT revoked_at, revocation_reason FROM agent_verification_badges`,
    )).rows[0];
    const run = await client.query<{ id: string }>(
      `INSERT INTO agent_compliance_runs (adcp_version, tested_at)
       SELECT '3.1.13', MAX(tested_at) + INTERVAL '1 second' FROM agent_compliance_runs
       WHERE agent_url = 'https://seller.example.test/mcp' RETURNING id`,
    );
    const failingLegacy = await client.query<{ id: string }>(
      `INSERT INTO verification_profile_role_assessments (
         source_run_id, agent_url, role, adcp_version, grading_profile, status,
         selectable, policy_version, compliance_bundle_version, lifecycle_stage,
         run_complete, evidence, source_tested_at
       ) VALUES ($1, 'https://seller.example.test/mcp', 'media-buy', '3.1',
         'legacy', 'failing', TRUE, 'verification-profiles-role-v1', '3.1.13',
         'production', TRUE, '{"specialisms":["sales-non-guaranteed"]}', NOW()) RETURNING id`,
      [run.rows[0].id],
    );
    const selection = await selectGradingProfile({
      agentUrl: 'https://seller.example.test/mcp', role: 'media-buy', adcpVersion: '3.1',
      selectedProfile: 'legacy', assessmentId: failingLegacy.rows[0].id, expectedRevision: 9,
      acknowledgePublicImpact: false, idempotencyKey: '13131313-1313-4131-8131-131313131313',
      requestId: 'request-revoked-legacy-selection', actorUserId: 'user_1', actorOrgId: 'org_1', actorKind: 'organization',
    });
    expect(selection.public_effect).toBe('unchanged');
    const after = (await client.query(
      `SELECT revoked_at, revocation_reason FROM agent_verification_badges`,
    )).rows[0];
    expect(after).toEqual(before);
  });

  it('allows the bounded regrade effect and rejects unknown public effects', async () => {
    const source = await client.query<{
      source_run_id: string;
      policy_version: string;
      compliance_bundle_version: string;
    }>(
      `SELECT source_run_id, policy_version, compliance_bundle_version
       FROM verification_profile_role_assessments WHERE id = $1`,
      [assessmentId],
    );
    await client.query(
      `INSERT INTO agent_grading_profile_audit (
         idempotency_key, request_id, actor_user_id, actor_org_id, actor_kind,
         agent_url, role, adcp_version, previous_profile, selected_profile,
         previous_revision, selected_revision, assessment_id, source_run_id,
         policy_version, compliance_bundle_version,
         predicted_public_effect, actual_public_effect
       ) VALUES (
         '55555555-5555-4555-8555-555555555555', 'request-regrade',
         'user_1', 'org_1', 'organization',
         'https://seller.example.test/mcp', 'media-buy', '3.1', 'spec', 'spec',
         2, 3, $1, $2, $3, $4, 'regrade', 'regrade'
       )`,
      [
        assessmentId,
        source.rows[0].source_run_id,
        source.rows[0].policy_version,
        source.rows[0].compliance_bundle_version,
      ],
    );

    await expect(client.query(
      `INSERT INTO agent_grading_profile_audit (
         idempotency_key, request_id, actor_user_id, actor_org_id, actor_kind,
         agent_url, role, adcp_version, previous_profile, selected_profile,
         previous_revision, selected_revision, assessment_id, source_run_id,
         policy_version, compliance_bundle_version,
         predicted_public_effect, actual_public_effect
       ) VALUES (
         '66666666-6666-4666-8666-666666666666', 'request-invalid-effect',
         'user_1', 'org_1', 'organization',
         'https://seller.example.test/mcp', 'media-buy', '3.1', 'spec', 'spec',
         3, 4, $1, $2, $3, $4, 'elevate', 'elevate'
       )`,
      [
        assessmentId,
        source.rows[0].source_run_id,
        source.rows[0].policy_version,
        source.rows[0].compliance_bundle_version,
      ],
    )).rejects.toThrow();
  });
});
