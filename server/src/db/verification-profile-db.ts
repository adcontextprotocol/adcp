import { getClient, query } from './client.js';
import type { BadgeRole } from './compliance-db.js';
import {
  API_ACCESS_TIERS,
  ACTIVE_SUBSCRIPTION_STATUSES,
} from '../services/membership-tiers.js';
import {
  VERIFICATION_PROFILE_ROLE_POLICY_VERSION,
  type GradingProfile,
  type GradingStatus,
} from '../services/verification-profile-assessment.js';
import { advertisesStableBadgeLine } from '../services/adcp-taxonomy.js';

export type SelectableGradingProfile = Exclude<GradingProfile, 'sandbox'>;
export type PublicProfileEffect = 'unchanged' | 'issue' | 'restore' | 'regrade' | 'degrade' | 'revoke';

export function planGradingProfilePublicEffect(input: {
  selectedProfile: SelectableGradingProfile;
  currentProfile: SelectableGradingProfile;
  assessmentStatus: GradingStatus;
  badgeStatus: 'active' | 'degraded' | 'revoked' | null;
  badgeDegradedAt?: Date | null;
  specFailureSince?: Date | null;
  now?: Date;
}): {
  publicEffect: PublicProfileEffect;
  failureSince: Date | null;
  graceDeadline: Date | null;
} {
  const now = input.now ?? new Date();
  if (input.assessmentStatus === 'passing') {
    const publicEffect = !input.badgeStatus || input.badgeStatus === 'revoked'
      ? 'issue'
      : input.badgeStatus === 'degraded'
        ? 'restore'
        : input.currentProfile !== input.selectedProfile
          ? 'regrade'
          : 'unchanged';
    return { publicEffect, failureSince: null, graceDeadline: null };
  }

  const failureSince = input.selectedProfile === 'spec'
    ? input.specFailureSince ?? now
    : input.currentProfile === 'legacy'
      ? input.badgeDegradedAt ?? now
      : now;
  if (!input.badgeStatus || input.badgeStatus === 'revoked') {
    return { publicEffect: 'unchanged', failureSince, graceDeadline: null };
  }
  const graceDeadline = new Date(failureSince.getTime() + 48 * 60 * 60 * 1000);
  const graceExpired = graceDeadline.getTime() <= now.getTime();
  const publicEffect = graceExpired
    ? 'revoke'
    : input.badgeStatus === 'active'
      ? 'degrade'
      : input.currentProfile !== input.selectedProfile
        ? 'regrade'
        : 'unchanged';
  return { publicEffect, failureSince, graceDeadline };
}

const CURRENT_ASSESSMENT_MAX_AGE_HOURS = 24;
const SUPPORTED_SELECTABLE_BADGE_VERSIONS = new Set(['3.0', '3.1']);

export interface GradingProfileRolloutSetting {
  selection_enabled: boolean;
  legacy_selection_allowed_until: string | null;
}

function parseGradingProfileRollout(value: unknown): GradingProfileRolloutSetting | null {
  const keys = value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value as Record<string, unknown>).sort()
    : [];
  if (
    keys.length !== 2
    || keys[0] !== 'legacy_selection_allowed_until'
    || keys[1] !== 'selection_enabled'
    || typeof (value as { selection_enabled?: unknown } | null)?.selection_enabled !== 'boolean'
    || (
      (value as { legacy_selection_allowed_until?: unknown } | null)?.legacy_selection_allowed_until !== null
      && typeof (value as { legacy_selection_allowed_until?: unknown } | null)?.legacy_selection_allowed_until !== 'string'
    )
  ) return null;
  const parsed = value as GradingProfileRolloutSetting;
  if (
    parsed.legacy_selection_allowed_until !== null
    && Number.isNaN(new Date(parsed.legacy_selection_allowed_until).getTime())
  ) return null;
  return parsed;
}

export async function getGradingProfileRollout(): Promise<GradingProfileRolloutSetting> {
  const result = await query(
    `SELECT value FROM system_settings WHERE key = 'grading_profile_rollout'`,
  );
  return parseGradingProfileRollout(result.rows[0]?.value) ?? {
    selection_enabled: false,
    legacy_selection_allowed_until: null,
  };
}

export interface StoredRoleAssessment {
  id: string;
  source_run_id: string;
  agent_url: string;
  role: BadgeRole;
  adcp_version: string;
  grading_profile: GradingProfile;
  status: GradingStatus | null;
  selectable: boolean;
  policy_version: string;
  compliance_bundle_version: string;
  requested_compliance_target: string | null;
  lifecycle_stage: string;
  run_complete: boolean;
  evidence: Record<string, unknown>;
  source_tested_at: Date;
  assessed_at: Date;
  source_is_latest?: boolean;
  source_is_fresh?: boolean;
}

export interface EffectiveGradingDecision {
  profile: SelectableGradingProfile;
  revision: string;
  assessment: StoredRoleAssessment | null;
  spec_failure_since: Date | null;
}

export class GradingProfileConflictError extends Error {
  constructor(
    message: string,
    public readonly reason:
      | 'stale_revision'
      | 'stale_assessment'
      | 'selection_disabled'
      | 'legacy_selection_expired'
      | 'impact_confirmation_required'
      | 'authorization_changed'
      | 'idempotency_mismatch'
      | 'unsupported_version',
  ) {
    super(message);
    this.name = 'GradingProfileConflictError';
  }
}

export async function getEffectiveGradingDecision(input: {
  agentUrl: string;
  role: BadgeRole;
  adcpVersion: string;
  sourceRunId?: string | null;
}): Promise<EffectiveGradingDecision> {
  const result = await query(
    `SELECT COALESCE(g.selected_profile, 'legacy') AS profile,
            COALESCE(g.revision, 0)::text AS revision, g.spec_failure_since,
            a.*
     FROM (SELECT 1) seed
     LEFT JOIN agent_grading_profiles g
       ON g.agent_url = $1 AND g.role = $2 AND g.adcp_version = $3
     LEFT JOIN verification_profile_role_assessments a
       ON a.agent_url = $1 AND a.role = $2 AND a.adcp_version = $3
      AND a.grading_profile = COALESCE(g.selected_profile, 'legacy')
      AND a.policy_version = $4
      AND ($5::uuid IS NULL OR a.source_run_id = $5)
     ORDER BY a.source_tested_at DESC NULLS LAST
     LIMIT 1`,
    [
      input.agentUrl,
      input.role,
      input.adcpVersion,
      VERIFICATION_PROFILE_ROLE_POLICY_VERSION,
      input.sourceRunId ?? null,
    ],
  );
  const row = result?.rows?.[0];
  const assessment = row?.id ? row as StoredRoleAssessment : null;
  return {
    profile: row?.profile === 'spec' ? 'spec' : 'legacy',
    revision: row?.revision ?? '0',
    assessment,
    spec_failure_since: row?.spec_failure_since ?? null,
  };
}

export async function getRoleProfileComparisons(agentUrl: string): Promise<Array<{
  role: BadgeRole;
  adcp_version: string;
  selected_profile: SelectableGradingProfile;
  revision: string;
  spec_failure_since: Date | null;
  assessments: StoredRoleAssessment[];
}>> {
  const rows = await query(
    `WITH latest AS (
       SELECT DISTINCT ON (agent_url, role, adcp_version, grading_profile)
              a.*
       FROM verification_profile_role_assessments a
       WHERE a.agent_url = $1 AND a.policy_version = $2
       ORDER BY agent_url, role, adcp_version, grading_profile, source_tested_at DESC
     )
     SELECT l.*, COALESCE(g.selected_profile, 'legacy') AS selected_profile,
            COALESCE(g.revision, 0)::text AS revision, g.spec_failure_since,
            l.source_tested_at >= NOW() - ($3::text || ' hours')::interval AS source_is_fresh,
            l.source_run_id = (
              SELECT r.id
              FROM agent_compliance_runs r
              WHERE r.agent_url = l.agent_url
                AND r.dry_run = FALSE
                AND r.is_authoritative = TRUE
                AND r.completeness = 'complete'
                AND r.adcp_version ~ '^[1-9][0-9]*\.[0-9]+(\.[0-9]+)?$'
                AND split_part(r.adcp_version, '.', 1) || '.' || split_part(r.adcp_version, '.', 2) = l.adcp_version
              ORDER BY r.tested_at DESC, r.id DESC
              LIMIT 1
            ) AS source_is_latest
     FROM latest l
     LEFT JOIN agent_grading_profiles g
       ON g.agent_url = l.agent_url AND g.role = l.role AND g.adcp_version = l.adcp_version
     ORDER BY l.role, split_part(l.adcp_version, '.', 1)::int DESC,
              split_part(l.adcp_version, '.', 2)::int DESC, l.grading_profile`,
    [agentUrl, VERIFICATION_PROFILE_ROLE_POLICY_VERSION, String(CURRENT_ASSESSMENT_MAX_AGE_HOURS)],
  );
  const grouped = new Map<string, {
    role: BadgeRole;
    adcp_version: string;
    selected_profile: SelectableGradingProfile;
    revision: string;
    spec_failure_since: Date | null;
    assessments: StoredRoleAssessment[];
  }>();
  for (const row of rows.rows) {
    const key = `${row.role}\u0000${row.adcp_version}`;
    let entry = grouped.get(key);
    if (!entry) {
      entry = {
        role: row.role,
        adcp_version: row.adcp_version,
        selected_profile: row.selected_profile === 'spec' ? 'spec' : 'legacy',
        revision: row.revision,
        spec_failure_since: row.spec_failure_since,
        assessments: [],
      };
      grouped.set(key, entry);
    }
    entry.assessments.push(row as StoredRoleAssessment);
  }
  return [...grouped.values()];
}

export async function getPublicSelectedGradingStatuses(agentUrl: string): Promise<Array<{
  role: BadgeRole;
  adcp_version: string;
  grading_profile: SelectableGradingProfile;
  grading_status: GradingStatus | null;
  availability: 'current' | 'unavailable';
  badge_status: 'active' | 'degraded' | 'revoked' | null;
  revision: string;
}>> {
  const result = await query(
    `SELECT g.role, g.adcp_version, g.selected_profile AS grading_profile,
            a.status AS grading_status,
            CASE WHEN a.id IS NULL THEN 'unavailable' ELSE 'current' END AS availability,
            b.status AS badge_status,
            g.revision::text AS revision
     FROM agent_grading_profiles g
     LEFT JOIN LATERAL (
       SELECT r.id
       FROM agent_compliance_runs r
       WHERE r.agent_url = g.agent_url
         AND r.dry_run = FALSE AND r.is_authoritative = TRUE
         AND r.completeness = 'complete'
         AND r.adcp_version ~ '^[1-9][0-9]*\.[0-9]+(\.[0-9]+)?$'
         AND split_part(r.adcp_version, '.', 1) || '.' || split_part(r.adcp_version, '.', 2) = g.adcp_version
       ORDER BY r.tested_at DESC, r.id DESC
       LIMIT 1
     ) latest_run ON TRUE
     LEFT JOIN verification_profile_role_assessments a
       ON a.source_run_id = latest_run.id
      AND a.agent_url = g.agent_url AND a.role = g.role
      AND a.adcp_version = g.adcp_version
      AND a.grading_profile = g.selected_profile
      AND a.policy_version = $2
     LEFT JOIN agent_verification_badges b
       ON b.agent_url = g.agent_url AND b.role = g.role AND b.adcp_version = g.adcp_version
     WHERE g.agent_url = $1
     ORDER BY split_part(g.adcp_version, '.', 1)::int DESC,
              split_part(g.adcp_version, '.', 2)::int DESC, g.role`,
    [agentUrl, VERIFICATION_PROFILE_ROLE_POLICY_VERSION],
  );
  return result.rows;
}

export async function selectGradingProfile(input: {
  agentUrl: string;
  role: BadgeRole;
  adcpVersion: string;
  selectedProfile: SelectableGradingProfile;
  assessmentId: string;
  expectedRevision: number;
  acknowledgePublicImpact: boolean;
  idempotencyKey: string;
  requestId: string;
  actorUserId: string;
  actorOrgId: string;
  actorKind: 'organization' | 'registry_admin';
  adminOverrideReason?: string | null;
}): Promise<{
  selected_profile: SelectableGradingProfile;
  revision: string;
  public_effect: PublicProfileEffect;
  replayed: boolean;
  source_run_id: string;
}> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`verification-badge:${input.agentUrl}`],
    );

    if (!SUPPORTED_SELECTABLE_BADGE_VERSIONS.has(input.adcpVersion)) {
      throw new GradingProfileConflictError(
        'This AdCP version is not enabled for public badge grading',
        'unsupported_version',
      );
    }

    // Lock and validate the runtime gate. The exact shape is deliberate:
    // malformed or future settings fail closed instead of being interpreted
    // as enabled by PostgreSQL text coercion.
    const rolloutResult = await client.query(
      `SELECT value FROM system_settings
       WHERE key = 'grading_profile_rollout'
       FOR SHARE`,
    );
    const rollout = parseGradingProfileRollout(rolloutResult.rows[0]?.value);
    if (!rollout) {
      throw new GradingProfileConflictError('Grading profile selection is disabled', 'selection_disabled');
    }
    if (!rollout.selection_enabled) {
      throw new GradingProfileConflictError('Grading profile selection is disabled', 'selection_disabled');
    }
    if (input.selectedProfile === 'legacy' && rollout.legacy_selection_allowed_until !== null) {
      const legacyDeadline = new Date(rollout.legacy_selection_allowed_until);
      if (Number.isNaN(legacyDeadline.getTime()) || legacyDeadline.getTime() <= Date.now()) {
        throw new GradingProfileConflictError(
          'New Legacy selections are no longer available',
          'legacy_selection_expired',
        );
      }
    }

    const replay = await client.query(
      `SELECT selected_profile, selected_revision::text AS revision, actual_public_effect, source_run_id,
              agent_url, role, adcp_version, assessment_id, actor_org_id
              , actor_kind, admin_override_reason, previous_revision
       FROM agent_grading_profile_audit
       WHERE idempotency_key = $1 AND actor_user_id = $2`,
      [input.idempotencyKey, input.actorUserId],
    );
    if (replay.rows[0]) {
      const row = replay.rows[0];
      if (
        row.agent_url !== input.agentUrl
        || row.role !== input.role
        || row.adcp_version !== input.adcpVersion
        || row.selected_profile !== input.selectedProfile
        || row.assessment_id !== input.assessmentId
        || row.actor_org_id !== input.actorOrgId
        || row.actor_kind !== input.actorKind
        || (row.admin_override_reason ?? null) !== (input.adminOverrideReason ?? null)
        || Number(row.previous_revision) !== input.expectedRevision
      ) {
        throw new GradingProfileConflictError(
          'The idempotency key was already used for a different selection',
          'idempotency_mismatch',
        );
      }
      await client.query('COMMIT');
      return {
        selected_profile: row.selected_profile,
        revision: row.revision,
        public_effect: row.actual_public_effect,
        replayed: true,
        source_run_id: row.source_run_id,
      };
    }

    // Repeat the ownership and role check under row locks. Route-level checks
    // provide a fast denial, while these locks make membership deletion, role
    // downgrade, and agent removal serialize with the mutation itself.
    const authorization = input.actorKind === 'organization'
      ? await client.query(
          `SELECT 1 FROM member_profiles mp
           JOIN organization_memberships om
             ON om.workos_organization_id = mp.workos_organization_id
           WHERE mp.workos_organization_id = $1
             AND mp.agents @> $2::jsonb
             AND om.workos_user_id = $3
             AND om.role IN ('owner', 'admin')
           LIMIT 1
           FOR SHARE OF mp, om`,
          [input.actorOrgId, JSON.stringify([{ url: input.agentUrl }]), input.actorUserId],
        )
      : await client.query(
          `SELECT 1 FROM member_profiles mp
           WHERE mp.workos_organization_id = $1
             AND mp.agents @> $2::jsonb
           LIMIT 1
           FOR SHARE OF mp`,
          [input.actorOrgId, JSON.stringify([{ url: input.agentUrl }])],
        );
    if (authorization.rowCount !== 1) {
      throw new GradingProfileConflictError(
        'Authorization or agent ownership changed; refresh before retrying',
        'authorization_changed',
      );
    }

    const assessmentResult = await client.query<StoredRoleAssessment>(
      `SELECT a.*, r.agent_profile_json AS source_agent_profile_json
       FROM verification_profile_role_assessments a
       JOIN agent_compliance_runs r ON r.id = a.source_run_id
       WHERE a.id = $1 AND a.agent_url = $2 AND a.role = $3
         AND a.adcp_version = $4 AND a.grading_profile = $5
         AND a.policy_version = $6 AND a.selectable = TRUE
         AND a.run_complete = TRUE
         AND a.source_tested_at >= NOW() - ($7::text || ' hours')::interval
         AND r.agent_url = a.agent_url
         AND r.dry_run = FALSE
         AND r.is_authoritative = TRUE
         AND r.completeness = 'complete'
         AND r.adcp_version ~ '^[1-9][0-9]*\.[0-9]+(\.[0-9]+)?$'
         AND split_part(r.adcp_version, '.', 1) || '.' || split_part(r.adcp_version, '.', 2) = a.adcp_version
         AND a.source_run_id = (
           SELECT latest.id FROM agent_compliance_runs latest
           WHERE latest.agent_url = a.agent_url
             AND latest.dry_run = FALSE
             AND latest.is_authoritative = TRUE
             AND latest.completeness = 'complete'
             AND latest.adcp_version ~ '^[1-9][0-9]*\.[0-9]+(\.[0-9]+)?$'
             AND split_part(latest.adcp_version, '.', 1) || '.' || split_part(latest.adcp_version, '.', 2) = a.adcp_version
           ORDER BY latest.tested_at DESC, latest.id DESC
           LIMIT 1
         )
       FOR SHARE OF a, r`,
      [
        input.assessmentId,
        input.agentUrl,
        input.role,
        input.adcpVersion,
        input.selectedProfile,
        VERIFICATION_PROFILE_ROLE_POLICY_VERSION,
        String(CURRENT_ASSESSMENT_MAX_AGE_HOURS),
      ],
    );
    const assessment = assessmentResult.rows[0];
    if (!assessment || !assessment.status) {
      throw new GradingProfileConflictError('The selected assessment is stale or unavailable', 'stale_assessment');
    }
    const advertisedVersions = (assessment as StoredRoleAssessment & {
      source_agent_profile_json?: { adcp_supported_versions?: unknown };
    }).source_agent_profile_json?.adcp_supported_versions;
    const advertisesStableLine = Array.isArray(advertisedVersions)
      && advertisedVersions.some(value => advertisesStableBadgeLine(value, input.adcpVersion));
    if (!advertisesStableLine) {
      throw new GradingProfileConflictError(
        'The latest agent profile does not advertise this stable AdCP badge version',
        'unsupported_version',
      );
    }

    const currentResult = await client.query(
      `SELECT * FROM agent_grading_profiles
       WHERE agent_url = $1 AND role = $2 AND adcp_version = $3
       FOR UPDATE`,
      [input.agentUrl, input.role, input.adcpVersion],
    );
    const current = currentResult.rows[0];
    const currentRevision = Number(current?.revision ?? 0);
    const currentProfile: SelectableGradingProfile = current?.selected_profile === 'spec' ? 'spec' : 'legacy';
    if (currentRevision !== input.expectedRevision) {
      throw new GradingProfileConflictError('The grading selection changed; refresh before retrying', 'stale_revision');
    }

    const badgeResult = await client.query(
      `SELECT * FROM agent_verification_badges
       WHERE agent_url = $1 AND role = $2 AND adcp_version = $3
       FOR UPDATE`,
      [input.agentUrl, input.role, input.adcpVersion],
    );
    const badge = badgeResult.rows[0];
    const now = new Date();
    const priorFailureSince = current?.spec_failure_since
      ? new Date(current.spec_failure_since)
      : null;
    const plan = planGradingProfilePublicEffect({
      selectedProfile: input.selectedProfile,
      currentProfile,
      assessmentStatus: assessment.status!,
      badgeStatus: badge?.status ?? null,
      badgeDegradedAt: badge?.degraded_at ? new Date(badge.degraded_at) : null,
      specFailureSince: priorFailureSince,
      now,
    });
    const specFailureSince = input.selectedProfile === 'spec' && assessment.status !== 'passing'
      ? plan.failureSince
      : input.selectedProfile === 'spec' && assessment.status === 'passing'
        ? null
        : priorFailureSince;
    const publicFailureSince = plan.failureSince;
    const predictedEffect = plan.publicEffect;
    if ((predictedEffect === 'degrade' || predictedEffect === 'revoke') && !input.acknowledgePublicImpact) {
      throw new GradingProfileConflictError(
        `Selecting ${input.selectedProfile} would ${predictedEffect} the public badge`,
        'impact_confirmation_required',
      );
    }

    const nextRevision = currentRevision + 1;
    await client.query(
      `INSERT INTO agent_grading_profiles (
         agent_url, role, adcp_version, selected_profile, selected_assessment_id,
         revision, spec_failure_since, selected_by_user_id, selected_by_org_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (agent_url, role, adcp_version) DO UPDATE SET
         selected_profile = EXCLUDED.selected_profile,
         selected_assessment_id = EXCLUDED.selected_assessment_id,
         revision = EXCLUDED.revision,
         spec_failure_since = EXCLUDED.spec_failure_since,
         selected_by_user_id = EXCLUDED.selected_by_user_id,
         selected_by_org_id = EXCLUDED.selected_by_org_id,
         selected_at = NOW(), updated_at = NOW()`,
      [
        input.agentUrl,
        input.role,
        input.adcpVersion,
        input.selectedProfile,
        assessment.id,
        nextRevision,
        specFailureSince,
        input.actorUserId,
        input.actorOrgId,
      ],
    );
    const eligibleOrg = await client.query(
      `SELECT 1 FROM organizations o
       WHERE o.workos_organization_id = $1
         AND o.membership_tier = ANY($2::text[])
         AND o.subscription_status = ANY($3::text[])
         AND o.subscription_canceled_at IS NULL`,
      [input.actorOrgId, [...API_ACCESS_TIERS], [...ACTIVE_SUBSCRIPTION_STATUSES]],
    );
    const metadata = await client.query(
      `SELECT compliance_opt_out, badge_requalification_required
       FROM agent_registry_metadata WHERE agent_url = $1`,
      [input.agentUrl],
    );
    const badgeWritesAllowed = eligibleOrg.rowCount === 1
      && metadata.rows[0]?.compliance_opt_out !== true
      && metadata.rows[0]?.badge_requalification_required !== true;
    const specialisms = Array.isArray(assessment.evidence?.specialisms)
      ? assessment.evidence.specialisms.filter((value): value is string => typeof value === 'string')
      : [];

    let actualEffect: PublicProfileEffect = 'unchanged';
    if (assessment.status === 'passing' && badgeWritesAllowed && specialisms.length > 0) {
      const projection = await client.query(
        `INSERT INTO agent_verification_badges (
           agent_url, role, adcp_version, verified_specialisms,
           verification_modes, membership_org_id, status, verified_at,
           grading_profile, grading_policy_version, grading_source_run_id,
           grading_assessment_id, grading_profile_revision, degraded_at,
           verification_token, token_expires_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, ARRAY['spec']::text[], $5, 'active', NOW(),
           $6, $7, $8, $9, $10, NULL, NULL, NULL, NOW()
         )
         ON CONFLICT (agent_url, role, adcp_version) DO UPDATE SET
           verified_specialisms = EXCLUDED.verified_specialisms,
           verification_modes = ARRAY(SELECT DISTINCT unnest(
             ARRAY['spec']::text[] || agent_verification_badges.verification_modes
           )),
           membership_org_id = EXCLUDED.membership_org_id,
           status = 'active', revoked_at = NULL, revocation_reason = NULL,
           verified_at = CASE WHEN agent_verification_badges.status = 'active'
             THEN agent_verification_badges.verified_at ELSE NOW() END,
           grading_profile = EXCLUDED.grading_profile,
           grading_policy_version = EXCLUDED.grading_policy_version,
           grading_source_run_id = EXCLUDED.grading_source_run_id,
           grading_assessment_id = EXCLUDED.grading_assessment_id,
           grading_profile_revision = EXCLUDED.grading_profile_revision,
           degraded_at = NULL, verification_token = NULL, token_expires_at = NULL,
           updated_at = NOW()
         RETURNING status`,
        [
          input.agentUrl,
          input.role,
          input.adcpVersion,
          specialisms,
          input.actorOrgId,
          input.selectedProfile,
          assessment.policy_version,
          assessment.source_run_id,
          assessment.id,
          nextRevision,
        ],
      );
      if (projection.rowCount === 1) actualEffect = predictedEffect;
    } else if (
      assessment.status === 'passing'
      && badge?.status === 'active'
      && predictedEffect === 'regrade'
    ) {
      const projection = await client.query(
        `UPDATE agent_verification_badges SET
           grading_profile = $4, grading_policy_version = $5,
           grading_source_run_id = $6, grading_assessment_id = $7,
           grading_profile_revision = $8,
           verification_token = NULL, token_expires_at = NULL, updated_at = NOW()
         WHERE agent_url = $1 AND role = $2 AND adcp_version = $3
           AND status = 'active'
         RETURNING status`,
        [
          input.agentUrl,
          input.role,
          input.adcpVersion,
          input.selectedProfile,
          assessment.policy_version,
          assessment.source_run_id,
          assessment.id,
          nextRevision,
        ],
      );
      if (projection.rowCount === 1) actualEffect = 'regrade';
    } else if (assessment.status !== 'passing' && badge) {
      const nextStatus = predictedEffect === 'revoke' ? 'revoked'
        : predictedEffect === 'degrade' ? 'degraded'
          : badge.status;
      const projection = await client.query(
        `UPDATE agent_verification_badges SET
           status = $4,
           degraded_at = CASE
             WHEN $4 = 'degraded' AND $11::boolean THEN $5
             WHEN $4 = 'degraded' THEN COALESCE(degraded_at, $5)
             WHEN $4 = 'active' THEN NULL
             ELSE degraded_at
           END,
           revoked_at = CASE WHEN $12::boolean THEN NOW() ELSE revoked_at END,
           revocation_reason = CASE WHEN $12::boolean
             THEN 'Selected grading profile remained non-passing beyond the 48-hour grace period'
             ELSE revocation_reason END,
           grading_profile = $6, grading_policy_version = $7,
           grading_source_run_id = $8, grading_assessment_id = $9,
           grading_profile_revision = $10,
           verification_token = NULL, token_expires_at = NULL, updated_at = NOW()
         WHERE agent_url = $1 AND role = $2 AND adcp_version = $3
         RETURNING status`,
        [
          input.agentUrl,
          input.role,
          input.adcpVersion,
          nextStatus,
          publicFailureSince ?? now,
          input.selectedProfile,
          assessment.policy_version,
          assessment.source_run_id,
          assessment.id,
          nextRevision,
          currentProfile !== input.selectedProfile,
          predictedEffect === 'revoke',
        ],
      );
      if (projection.rowCount === 1) actualEffect = predictedEffect;
    }

    await client.query(
      `INSERT INTO agent_grading_profile_audit (
         idempotency_key, request_id, actor_user_id, actor_org_id, actor_kind,
         admin_override_reason, agent_url, role, adcp_version,
         previous_profile, selected_profile, previous_revision, selected_revision,
         assessment_id, source_run_id, policy_version, compliance_bundle_version,
         predicted_public_effect, actual_public_effect
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9,
         $10, $11, $12, $13, $14, $15, $16, $17, $18, $19
       )`,
      [
        input.idempotencyKey,
        input.requestId,
        input.actorUserId,
        input.actorOrgId,
        input.actorKind,
        input.adminOverrideReason ?? null,
        input.agentUrl,
        input.role,
        input.adcpVersion,
        currentProfile,
        input.selectedProfile,
        currentRevision,
        nextRevision,
        assessment.id,
        assessment.source_run_id,
        assessment.policy_version,
        assessment.compliance_bundle_version,
        predictedEffect,
        actualEffect,
      ],
    );
    await client.query(
      `INSERT INTO agent_grading_profile_projection_jobs (
         agent_url, role, adcp_version, selection_revision, source_run_id, assessment_id
       ) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (agent_url, role, adcp_version, selection_revision) DO NOTHING`,
      [input.agentUrl, input.role, input.adcpVersion, nextRevision, assessment.source_run_id, assessment.id],
    );
    await client.query('COMMIT');
    return {
      selected_profile: input.selectedProfile,
      revision: String(nextRevision),
      public_effect: actualEffect,
      replayed: false,
      source_run_id: assessment.source_run_id,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export interface GradingProfileProjectionJob {
  agent_url: string;
  role: BadgeRole;
  adcp_version: string;
  selection_revision: string;
  source_run_id: string;
  assessment_id: string;
  attempts: number;
}

export async function claimGradingProfileProjectionJobs(limit = 20): Promise<GradingProfileProjectionJob[]> {
  const safeLimit = Math.min(Math.max(1, limit), 100);
  const result = await query(
    `WITH due AS (
       SELECT agent_url, role, adcp_version, selection_revision
       FROM agent_grading_profile_projection_jobs
       WHERE (status = 'pending' OR (status = 'running' AND lease_expires_at <= NOW()))
         AND next_attempt_at <= NOW()
       ORDER BY next_attempt_at, created_at
       FOR UPDATE SKIP LOCKED
       LIMIT $1
     )
     UPDATE agent_grading_profile_projection_jobs j
     SET status = 'running', attempts = attempts + 1,
         lease_expires_at = NOW() + INTERVAL '5 minutes', updated_at = NOW()
     FROM due
     WHERE j.agent_url = due.agent_url AND j.role = due.role
       AND j.adcp_version = due.adcp_version
       AND j.selection_revision = due.selection_revision
     RETURNING j.agent_url, j.role, j.adcp_version, j.selection_revision::text,
               j.source_run_id, j.assessment_id, j.attempts`,
    [safeLimit],
  );
  return result.rows;
}

export async function completeGradingProfileProjectionJob(input: {
  agentUrl: string;
  role: BadgeRole;
  adcpVersion: string;
  selectionRevision: string;
}): Promise<void> {
  await query(
    `UPDATE agent_grading_profile_projection_jobs
     SET status = 'completed', lease_expires_at = NULL, last_error = NULL, updated_at = NOW()
     WHERE agent_url = $1 AND role = $2 AND adcp_version = $3
       AND selection_revision = $4`,
    [input.agentUrl, input.role, input.adcpVersion, input.selectionRevision],
  );
}

export async function retryGradingProfileProjectionJob(
  job: GradingProfileProjectionJob,
  error: unknown,
): Promise<void> {
  const delaySeconds = Math.min(3600, 30 * (2 ** Math.min(job.attempts, 7)));
  await query(
    `UPDATE agent_grading_profile_projection_jobs
     SET status = 'pending', lease_expires_at = NULL,
         next_attempt_at = NOW() + ($5::text || ' seconds')::interval,
         last_error = left($6, 2000), updated_at = NOW()
     WHERE agent_url = $1 AND role = $2 AND adcp_version = $3
       AND selection_revision = $4`,
    [
      job.agent_url,
      job.role,
      job.adcp_version,
      job.selection_revision,
      String(delaySeconds),
      error instanceof Error ? error.message : String(error),
    ],
  );
}
