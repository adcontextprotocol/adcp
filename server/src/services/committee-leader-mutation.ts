import { isDeepStrictEqual } from 'node:util';
import type { PoolClient } from 'pg';
import type { WorkOS } from '@workos-inc/node';
import { getAuthorizationEnforcementWorkos } from '../auth/workos-client.js';
import { getPool } from '../db/client.js';
import {
  loadAuthorizationSnapshot,
  sameAuthorizationIdentity,
  sameAuthorizationSnapshot,
  type AuthorizationSnapshot,
} from '../db/user-authorization-snapshot-db.js';
import { CommunityDatabase } from '../db/community-db.js';
import { computeJourneyStage } from '../addie/services/journey-computation.js';
import { createLogger } from '../logger.js';

const logger = createLogger('committee-leader-mutation');

type WorkOSAuthorizationClient = Pick<WorkOS, 'userManagement'>;

export type CommitteeLeaderMutationDenialReason =
  | 'principal_missing'
  | 'organization_required'
  | 'organization_mismatch'
  | 'credential_revoked'
  | 'authorization_changed'
  | 'organization_forbidden'
  | 'committee_not_found'
  | 'committee_forbidden'
  | 'not_committee_leader'
  | 'target_invalid'
  | 'self_removal_forbidden';

export type CommitteeLeaderMutationResult =
  | {
      status: 'mutated';
      action: 'added' | 'removed';
      committeeId: string;
      committeeName: string;
      committeeType: string;
      slackChannelId: string | null;
      targetWorkosUserId: string;
    }
  | {
      status: 'unchanged';
      reason: 'already_leader' | 'not_leader';
      committeeId: string;
      committeeName: string;
      committeeType: string;
      slackChannelId: string | null;
      targetWorkosUserId: string;
    }
  | { status: 'forbidden'; reason: CommitteeLeaderMutationDenialReason }
  | { status: 'unavailable'; source: 'database' | 'workos' };

export type CommitteeLeaderPrincipalResolution =
  | { status: 'resolved'; snapshot: AuthorizationSnapshot }
  | { status: 'forbidden'; reason: 'principal_missing' | 'credential_revoked' }
  | { status: 'unavailable'; source: 'database' };

export interface CommitteeLeaderMutationInput {
  action: 'add' | 'remove';
  principal: AuthorizationSnapshot;
  selectedOrganizationId: string;
  committeeSlug: string;
  targetUserId: string;
  targetEmail?: string;
  surface: 'web' | 'slack';
  slackActorUserId?: string;
}

interface CommitteeLeaderMutationDependencies {
  getWorkos?: () => WorkOSAuthorizationClient;
  /** Integration-test barrier. Production callers never supply hooks. */
  afterProviderAuthorization?: () => Promise<void>;
  /** Integration seam for post-commit business side effects. */
  afterCommit?: (event: CommitteeLeaderMutationCommittedEvent) => void;
}

interface CommitteeLeaderMutationCommittedEvent {
  action: 'added' | 'removed';
  committeeId: string;
  organizationId: string;
  targetWorkosUserId: string;
}

interface LockedActorRow {
  authenticated_user_id: string;
  canonical_user_id: string;
  identity_id: string;
  authorization_epoch: string;
}

interface LockedCommitteeRow {
  id: string;
  name: string;
  committee_type: string;
  slack_channel_id: string | null;
  slug: string;
}

interface LockedGrantRow {
  id: string;
  organization_id: string;
  role: 'owner' | 'admin' | 'member';
  effective_from: string;
  effective_until: string | null;
}

interface LockedLeadershipRow {
  user_id: string;
}

interface LockedSlackMappingRow {
  slack_user_id: string;
  workos_user_id: string | null;
  mapping_status: string;
  slack_is_deleted: boolean | null;
  slack_is_bot: boolean | null;
}

interface LockedLeadershipState {
  leaderUserIds: string[];
  slackMappings: Map<string, LockedSlackMappingRow>;
}

interface ResolvedTargetCredential {
  kind: 'workos' | 'slack';
  workosUserId: string;
  slackUserId: string | null;
}

interface InsertedAuditRow {
  id: string;
  workos_organization_id: string;
  workos_user_id: string;
  action: string;
  resource_type: string;
  resource_id: string;
  details: Record<string, unknown>;
}

function normalizedRequiredId(value: string): string | null {
  const normalized = value.trim();
  return normalized.length > 0 && normalized === value ? normalized : null;
}

/** Resolve a fresh immutable principal without accepting canonical MemberContext identity. */
export async function resolveCommitteeLeaderPrincipal(
  authenticatedWorkosUserId: string | null | undefined,
): Promise<CommitteeLeaderPrincipalResolution> {
  if (!authenticatedWorkosUserId?.trim()) {
    return { status: 'forbidden', reason: 'principal_missing' };
  }
  try {
    const snapshot = await loadAuthorizationSnapshot(authenticatedWorkosUserId.trim(), null);
    return snapshot
      ? { status: 'resolved', snapshot }
      : { status: 'forbidden', reason: 'credential_revoked' };
  } catch (error) {
    logger.warn({ err: error }, 'Committee leader principal snapshot unavailable');
    return { status: 'unavailable', source: 'database' };
  }
}

async function lockActorState(
  client: PoolClient,
  authenticatedWorkosUserId: string,
): Promise<LockedActorRow | null> {
  const result = await client.query<LockedActorRow>(
    `SELECT credential.workos_user_id AS authenticated_user_id,
            primary_binding.workos_user_id AS canonical_user_id,
            binding.identity_id,
            COALESCE(epoch.epoch, 0)::text AS authorization_epoch
       FROM users credential
       JOIN identity_workos_users binding
         ON binding.workos_user_id = credential.workos_user_id
       JOIN identity_workos_users primary_binding
         ON primary_binding.identity_id = binding.identity_id
        AND primary_binding.is_primary
      LEFT JOIN authorization_epochs epoch
         ON epoch.workos_user_id = credential.workos_user_id
      WHERE credential.workos_user_id = $1
      FOR KEY SHARE OF credential
      FOR SHARE OF binding, primary_binding`,
    [authenticatedWorkosUserId],
  );
  return result.rows[0] ?? null;
}

async function lockAuthorizationEpoch(
  client: PoolClient,
  authenticatedWorkosUserId: string,
): Promise<void> {
  await client.query(
    `SELECT epoch
       FROM authorization_epochs
      WHERE workos_user_id = $1
      FOR UPDATE`,
    [authenticatedWorkosUserId],
  );
}

function actorMatchesSnapshot(row: LockedActorRow, snapshot: AuthorizationSnapshot): boolean {
  return row.authenticated_user_id === snapshot.authenticatedUserId
    && row.canonical_user_id === snapshot.canonicalUserId
    && row.identity_id === snapshot.identityId
    && row.authorization_epoch === snapshot.authorizationEpoch;
}

function liveMappedWorkosUserId(mapping: LockedSlackMappingRow | undefined): string | null {
  return mapping?.mapping_status === 'mapped'
      && mapping.slack_is_deleted === false
      && mapping.slack_is_bot === false
      && typeof mapping.workos_user_id === 'string'
      && mapping.workos_user_id.length > 0
    ? mapping.workos_user_id
    : null;
}

async function getActiveCredentialGrant(
  client: PoolClient,
  authenticatedWorkosUserId: string,
  selectedOrganizationId: string,
): Promise<LockedGrantRow | null> {
  const result = await client.query<LockedGrantRow>(
    `SELECT id, workos_organization_id AS organization_id, role,
            to_char(effective_from AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS effective_from,
            to_char(effective_until AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS effective_until
       FROM organization_credential_grants
      WHERE workos_user_id = $1
        AND workos_organization_id = $2
        AND revoked_at IS NULL
        AND effective_from <= clock_timestamp()
        AND (effective_until IS NULL OR effective_until > clock_timestamp())
      FOR UPDATE`,
    [authenticatedWorkosUserId, selectedOrganizationId],
  );
  return result.rows[0] ?? null;
}

function grantMatchesSnapshot(
  grant: LockedGrantRow | null,
  snapshot: AuthorizationSnapshot,
): boolean {
  const expected = snapshot.credentialGrant;
  if (!grant || !expected) return grant === null && expected === null;
  return grant.id === expected.id
    && grant.organization_id === expected.organizationId
    && grant.role === expected.role
    && grant.effective_from === expected.effectiveFrom
    && grant.effective_until === expected.effectiveUntil;
}

async function lockCommitteeLeadershipState(
  client: PoolClient,
  committeeId: string,
  extraSlackUserIds: string[],
): Promise<LockedLeadershipState> {
  const leaders = await client.query<LockedLeadershipRow>(
    `SELECT user_id
       FROM working_group_leaders
      WHERE working_group_id = $1
      ORDER BY user_id
      FOR UPDATE`,
    [committeeId],
  );
  const leaderUserIds = leaders.rows.map((row) => row.user_id);
  const aliases = [...new Set([...leaderUserIds, ...extraSlackUserIds].filter(Boolean))].sort();
  if (aliases.length === 0) {
    return { leaderUserIds, slackMappings: new Map() };
  }
  const mappings = await client.query<LockedSlackMappingRow>(
    `SELECT slack_user_id, workos_user_id, mapping_status,
            slack_is_deleted, slack_is_bot
       FROM slack_user_mappings
      WHERE slack_user_id = ANY($1)
      ORDER BY slack_user_id
      FOR SHARE`,
    [aliases],
  );
  return {
    leaderUserIds,
    slackMappings: new Map(mappings.rows.map((row) => [row.slack_user_id, row])),
  };
}

function hasExactCommitteeLeadership(
  state: LockedLeadershipState,
  authenticatedWorkosUserId: string,
): boolean {
  return state.leaderUserIds.some((leaderUserId) =>
    leaderUserId === authenticatedWorkosUserId
    || liveMappedWorkosUserId(state.slackMappings.get(leaderUserId))
      === authenticatedWorkosUserId
  );
}

async function resolveTargetCredential(
  client: PoolClient,
  targetUserId: string,
): Promise<ResolvedTargetCredential | null> {
  const result = await client.query<{
    kind: 'workos' | 'slack';
    workos_user_id: string;
    slack_user_id: string | null;
  }>(
    `SELECT candidate.kind, candidate.workos_user_id, candidate.slack_user_id
       FROM (
         SELECT 'workos'::text AS kind, credential.workos_user_id,
                NULL::text AS slack_user_id, 0 AS priority
           FROM users credential
           JOIN identity_workos_users binding
             ON binding.workos_user_id = credential.workos_user_id
          WHERE credential.workos_user_id = $1
         UNION ALL
         SELECT 'slack'::text AS kind, credential.workos_user_id,
                mapping.slack_user_id, 1 AS priority
           FROM slack_user_mappings mapping
           JOIN users credential
             ON credential.workos_user_id = mapping.workos_user_id
           JOIN identity_workos_users binding
             ON binding.workos_user_id = credential.workos_user_id
          WHERE mapping.slack_user_id = $1
            AND mapping.mapping_status = 'mapped'
            AND mapping.slack_is_deleted = FALSE
            AND mapping.slack_is_bot = FALSE
       ) candidate
      ORDER BY candidate.priority
      LIMIT 1`,
    [targetUserId],
  );
  const row = result.rows[0];
  return row
    ? { kind: row.kind, workosUserId: row.workos_user_id, slackUserId: row.slack_user_id }
    : null;
}

async function lockExactTargetCredential(
  client: PoolClient,
  workosUserId: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1
       FROM users credential
       JOIN identity_workos_users binding
         ON binding.workos_user_id = credential.workos_user_id
      WHERE credential.workos_user_id = $1
      FOR KEY SHARE OF credential
      FOR SHARE OF binding`,
    [workosUserId],
  );
  return result.rowCount === 1;
}

async function bumpTargetAuthorizationEpochExactlyOnce(
  client: PoolClient,
  workosUserId: string,
): Promise<string> {
  const result = await client.query<{ epoch: string }>(
    `INSERT INTO authorization_epochs (workos_user_id, epoch)
     SELECT workos_user_id, 1
       FROM users
      WHERE workos_user_id = $1
     ON CONFLICT (workos_user_id) DO UPDATE
       SET epoch = authorization_epochs.epoch + 1, updated_at = NOW()
     RETURNING epoch::text`,
    [workosUserId],
  );
  if (result.rowCount !== 1 || !result.rows[0]?.epoch) {
    throw new Error('Target credential epoch bump did not affect exactly one live credential');
  }
  return result.rows[0].epoch;
}

async function targetBelongsToActorIdentity(
  client: PoolClient,
  targetWorkosUserId: string,
  actorIdentityId: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1
       FROM identity_workos_users
      WHERE workos_user_id = $1
        AND identity_id = $2
      FOR SHARE`,
    [targetWorkosUserId, actorIdentityId],
  );
  return result.rowCount === 1;
}

async function hasActiveWorkOSMembership(
  workos: WorkOSAuthorizationClient,
  authenticatedWorkosUserId: string,
  selectedOrganizationId: string,
): Promise<boolean> {
  const memberships = await workos.userManagement.listOrganizationMemberships({
    userId: authenticatedWorkosUserId,
    organizationId: selectedOrganizationId,
  });
  return memberships.data.some((membership) =>
    membership.userId === authenticatedWorkosUserId
    && membership.organizationId === selectedOrganizationId
    && membership.status === 'active'
  );
}

function scheduleLeadershipSideEffects(event: CommitteeLeaderMutationCommittedEvent): void {
  computeJourneyStage(
    event.organizationId,
    'leadership_change',
    `working_group:${event.committeeId}`,
  ).catch((error) => {
    logger.error({ err: error, workingGroupId: event.committeeId }, 'Journey stage computation failed');
  });

  if (event.action === 'added') {
    new CommunityDatabase().awardPoints(
      event.targetWorkosUserId,
      'wg_leadership',
      30,
      event.committeeId,
      'working_group',
    ).catch((error) => {
      logger.error({ err: error, workingGroupId: event.committeeId }, 'Failed to award leadership points');
    });
  }
}

/**
 * Authorize and commit one co-leader mutation. The provider decision is made
 * while deterministic credential/committee/target locks are held, then the
 * exact binding, epoch, grant, and leadership rows are re-read immediately
 * before the write. Any provider or database outage fails closed.
 */
export async function mutateCommitteeLeader(
  input: CommitteeLeaderMutationInput,
  dependencies: CommitteeLeaderMutationDependencies = {},
): Promise<CommitteeLeaderMutationResult> {
  const organizationId = normalizedRequiredId(input.selectedOrganizationId);
  if (!organizationId) return { status: 'forbidden', reason: 'organization_required' };
  if (input.principal.selectedOrganizationId
      && input.principal.selectedOrganizationId !== organizationId) {
    return { status: 'forbidden', reason: 'organization_mismatch' };
  }

  // Rebind a request snapshot that began without an organization only when the
  // tool input explicitly names one. Identity/epoch changes are still denied.
  let admissionSnapshot: AuthorizationSnapshot;
  try {
    const current = await loadAuthorizationSnapshot(input.principal.authenticatedUserId, organizationId);
    if (!current) return { status: 'forbidden', reason: 'credential_revoked' };
    const unchanged = input.principal.selectedOrganizationId === null
      ? sameAuthorizationIdentity(input.principal, current)
      : sameAuthorizationSnapshot(input.principal, current);
    if (!unchanged) {
      return { status: 'forbidden', reason: 'authorization_changed' };
    }
    admissionSnapshot = current;
  } catch (error) {
    logger.warn({ err: error }, 'Committee leader pre-mutation snapshot unavailable');
    return { status: 'unavailable', source: 'database' };
  }

  let workos: WorkOSAuthorizationClient;
  try {
    workos = (dependencies.getWorkos ?? getAuthorizationEnforcementWorkos)();
  } catch (error) {
    logger.warn({ err: error }, 'Committee leader WorkOS client unavailable');
    return { status: 'unavailable', source: 'workos' };
  }

  let client: PoolClient;
  try {
    client = await getPool().connect();
  } catch (error) {
    logger.warn({ err: error }, 'Committee leader database checkout unavailable');
    return { status: 'unavailable', source: 'database' };
  }

  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = '2000ms'`);
    await client.query(`SET LOCAL statement_timeout = '8000ms'`);

    const targetCredential = await resolveTargetCredential(client, input.targetUserId);
    if (!targetCredential) {
      await client.query('ROLLBACK');
      return { status: 'forbidden', reason: 'target_invalid' };
    }
    const targetWorkosUserId = targetCredential.workosUserId;

    // Committee mutations are the only participants in this advisory
    // protocol. Lock actor + target credentials in lexical order before any
    // row locks so cross-target mutations cannot each consume epoch 0 and
    // then bump the other credential. Revocation writers do not acquire this
    // advisory lock; their concrete binding/grant/leader row locks still win
    // or serialize without the late-lock inversion found in the first review.
    const credentialLockKeys = [
      `committee-credential:${input.principal.authenticatedUserId}`,
      `committee-credential:${targetWorkosUserId}`,
    ].sort();
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended(lock_key, 0))
         FROM unnest($1::text[]) AS lock_key
        ORDER BY lock_key`,
      [credentialLockKeys],
    );

    const actor = await lockActorState(client, input.principal.authenticatedUserId);
    if (!actor) {
      await client.query('ROLLBACK');
      return { status: 'forbidden', reason: 'credential_revoked' };
    }
    if (!actorMatchesSnapshot(actor, input.principal)) {
      await client.query('ROLLBACK');
      return { status: 'forbidden', reason: 'authorization_changed' };
    }

    const committeeResult = await client.query<LockedCommitteeRow>(
      `SELECT id, name, committee_type, slack_channel_id, slug
         FROM working_groups
        WHERE slug = $1
        FOR UPDATE`,
      [input.committeeSlug],
    );
    const committee = committeeResult.rows[0];
    if (!committee) {
      await client.query('ROLLBACK');
      return { status: 'forbidden', reason: 'committee_not_found' };
    }
    if (committee.slug === 'aao-admin') {
      await client.query('ROLLBACK');
      return { status: 'forbidden', reason: 'committee_forbidden' };
    }

    const credentialGrant = await getActiveCredentialGrant(
      client,
      actor.authenticated_user_id,
      organizationId,
    );
    const leadershipState = await lockCommitteeLeadershipState(
      client,
      committee.id,
      [input.targetUserId, input.slackActorUserId ?? ''],
    );
    const lockedTargetWorkosUserId = targetCredential.kind === 'slack'
      ? liveMappedWorkosUserId(leadershipState.slackMappings.get(input.targetUserId))
      : targetWorkosUserId;
    if (lockedTargetWorkosUserId !== targetWorkosUserId
        || !await lockExactTargetCredential(client, targetWorkosUserId)) {
      await client.query('ROLLBACK');
      return { status: 'forbidden', reason: 'target_invalid' };
    }
    if (input.surface === 'slack'
        && (!input.slackActorUserId
          || liveMappedWorkosUserId(leadershipState.slackMappings.get(input.slackActorUserId))
            !== actor.authenticated_user_id)) {
      await client.query('ROLLBACK');
      return { status: 'forbidden', reason: 'authorization_changed' };
    }
    const exactLeader = hasExactCommitteeLeadership(
      leadershipState,
      actor.authenticated_user_id,
    );
    if (!grantMatchesSnapshot(credentialGrant, admissionSnapshot)) {
      await client.query('ROLLBACK');
      return { status: 'forbidden', reason: 'authorization_changed' };
    }
    if (!exactLeader) {
      await client.query('ROLLBACK');
      return { status: 'forbidden', reason: 'not_committee_leader' };
    }

    // Epoch is locked only after the concrete authority rows. Existing
    // binding/grant/leadership revokers use that same resource-then-epoch
    // order, avoiding the inverse advisory-lock path this boundary replaced.
    await lockAuthorizationEpoch(client, actor.authenticated_user_id);
    const actorAfterEpochLock = await lockActorState(client, actor.authenticated_user_id);
    if (!actorAfterEpochLock || !actorMatchesSnapshot(actorAfterEpochLock, input.principal)) {
      await client.query('ROLLBACK');
      return { status: 'forbidden', reason: 'authorization_changed' };
    }

    let directMembership: boolean;
    try {
      directMembership = await hasActiveWorkOSMembership(
        workos,
        actor.authenticated_user_id,
        organizationId,
      );
    } catch (error) {
      logger.warn({ err: error }, 'Committee leader WorkOS authorization unavailable');
      await client.query('ROLLBACK');
      return { status: 'unavailable', source: 'workos' };
    }
    if (!directMembership && !credentialGrant) {
      await client.query('ROLLBACK');
      return { status: 'forbidden', reason: 'organization_forbidden' };
    }

    await dependencies.afterProviderAuthorization?.();

    // These locked reads are intentionally repeated after the external call.
    // The mutation must consume the same exact authority/epoch it admitted.
    const actorImmediatelyBeforeMutation = await lockActorState(
      client,
      input.principal.authenticatedUserId,
    );
    if (!actorImmediatelyBeforeMutation
        || !actorMatchesSnapshot(actorImmediatelyBeforeMutation, input.principal)) {
      await client.query('ROLLBACK');
      return { status: 'forbidden', reason: 'authorization_changed' };
    }
    const leadershipImmediatelyBeforeMutation = await lockCommitteeLeadershipState(
      client,
      committee.id,
      [input.targetUserId, input.slackActorUserId ?? ''],
    );
    const leaderImmediatelyBeforeMutation = hasExactCommitteeLeadership(
      leadershipImmediatelyBeforeMutation,
      actor.authenticated_user_id,
    );
    const grantImmediatelyBeforeMutation = await getActiveCredentialGrant(
      client,
      actor.authenticated_user_id,
      organizationId,
    );
    if (!leaderImmediatelyBeforeMutation) {
      await client.query('ROLLBACK');
      return { status: 'forbidden', reason: 'not_committee_leader' };
    }
    if (!grantMatchesSnapshot(grantImmediatelyBeforeMutation, admissionSnapshot)) {
      await client.query('ROLLBACK');
      return { status: 'forbidden', reason: 'authorization_changed' };
    }
    if (!directMembership && !grantImmediatelyBeforeMutation) {
      await client.query('ROLLBACK');
      return { status: 'forbidden', reason: 'organization_forbidden' };
    }

    if (targetCredential.kind === 'slack'
        && liveMappedWorkosUserId(
          leadershipImmediatelyBeforeMutation.slackMappings.get(input.targetUserId),
        ) !== targetWorkosUserId) {
      await client.query('ROLLBACK');
      return { status: 'forbidden', reason: 'target_invalid' };
    }

    if (input.surface === 'slack'
        && (!input.slackActorUserId
          || liveMappedWorkosUserId(
            leadershipImmediatelyBeforeMutation.slackMappings.get(input.slackActorUserId),
          )
            !== actor.authenticated_user_id)) {
      await client.query('ROLLBACK');
      return { status: 'forbidden', reason: 'authorization_changed' };
    }

    const commonResult = {
      committeeId: committee.id,
      committeeName: committee.name,
      committeeType: committee.committee_type,
      slackChannelId: committee.slack_channel_id,
      targetWorkosUserId,
    };

    if (input.action === 'remove'
        && await targetBelongsToActorIdentity(client, targetWorkosUserId, actor.identity_id)) {
      await client.query('ROLLBACK');
      return { status: 'forbidden', reason: 'self_removal_forbidden' };
    }

    const targetAlreadyLeads = hasExactCommitteeLeadership(
      leadershipImmediatelyBeforeMutation,
      targetWorkosUserId,
    );
    if ((input.action === 'add' && targetAlreadyLeads)
        || (input.action === 'remove' && !targetAlreadyLeads)) {
      await client.query('ROLLBACK');
      return {
        status: 'unchanged',
        reason: input.action === 'add' ? 'already_leader' : 'not_leader',
        ...commonResult,
      };
    }

    // WorkOS is deliberately consulted a second time after the revocation
    // barrier. The transaction already holds every local authority row, and
    // the local actor/epoch/grant/leadership reads above are the final DB
    // revalidation before this provider check and the write.
    let directMembershipImmediatelyBeforeMutation: boolean;
    try {
      directMembershipImmediatelyBeforeMutation = await hasActiveWorkOSMembership(
        workos,
        actor.authenticated_user_id,
        organizationId,
      );
    } catch (error) {
      logger.warn({ err: error }, 'Committee leader final WorkOS authorization unavailable');
      await client.query('ROLLBACK');
      return { status: 'unavailable', source: 'workos' };
    }
    if (!directMembershipImmediatelyBeforeMutation && !grantImmediatelyBeforeMutation) {
      await client.query('ROLLBACK');
      return { status: 'forbidden', reason: 'organization_forbidden' };
    }

    const mutation = input.action === 'add'
      ? await client.query(
          `INSERT INTO working_group_leaders (working_group_id, user_id)
           VALUES ($1, $2)
           ON CONFLICT DO NOTHING
           RETURNING user_id`,
          [committee.id, targetWorkosUserId],
        )
      : await client.query(
          `DELETE FROM working_group_leaders
            WHERE working_group_id = $1
              AND (
                user_id = $2
                OR user_id IN (
                  SELECT slack_user_id
                    FROM slack_user_mappings
                   WHERE workos_user_id = $2
                )
              )
          RETURNING user_id`,
          [committee.id, targetWorkosUserId],
        );

    if (mutation.rowCount === 0) {
      await client.query('ROLLBACK');
      return {
        status: 'unchanged',
        reason: input.action === 'add' ? 'already_leader' : 'not_leader',
        ...commonResult,
      };
    }

    if (input.action === 'add') {
      await client.query(
        `INSERT INTO working_group_memberships (
           working_group_id, workos_user_id, user_email,
           workos_organization_id, added_by_user_id, status
         ) VALUES ($1, $2, $3, $4, $5, 'active')
         ON CONFLICT (working_group_id, workos_user_id)
         DO UPDATE SET status = 'active', updated_at = NOW()`,
        [
          committee.id,
          targetWorkosUserId,
          input.targetEmail ?? null,
          organizationId,
          actor.authenticated_user_id,
        ],
      );
    }

    // Leadership changes alter the target credential's authority. The bump is
    // in this transaction after the deterministically ordered committee and
    // mapping locks, so a stale long-lived snapshot cannot survive the commit.
    const targetAuthorizationEpoch = await bumpTargetAuthorizationEpochExactlyOnce(
      client,
      targetWorkosUserId,
    );

    const auditDetails = {
      actor_authenticated_workos_user_id: actor.authenticated_user_id,
      actor_identity_id: actor.identity_id,
      actor_canonical_workos_user_id: actor.canonical_user_id,
      target_workos_user_id: targetWorkosUserId,
      target_authorization_epoch: targetAuthorizationEpoch,
      committee_slug: committee.slug,
      authorization_epoch: actor.authorization_epoch,
      authorization_source: directMembershipImmediatelyBeforeMutation
        ? 'workos'
        : 'credential_grant',
      surface: input.surface,
      ...(input.slackActorUserId ? { slack_actor_user_id: input.slackActorUserId } : {}),
    };
    const auditAction = input.action === 'add'
      ? 'add_committee_co_leader'
      : 'remove_committee_co_leader';
    const audit = await client.query<InsertedAuditRow>(
      `INSERT INTO registry_audit_log (
         workos_organization_id, workos_user_id, action,
         resource_type, resource_id, details
       ) VALUES ($1, $2, $3, 'working_group_leader', $4, $5)
       RETURNING id, workos_organization_id, workos_user_id, action,
                 resource_type, resource_id, details`,
      [
        organizationId,
        actor.authenticated_user_id,
        auditAction,
        committee.id,
        JSON.stringify(auditDetails),
      ],
    );
    const insertedAudit = audit.rows[0];
    if (audit.rowCount !== 1
        || !insertedAudit
        || !insertedAudit.id
        || insertedAudit.workos_organization_id !== organizationId
        || insertedAudit.workos_user_id !== actor.authenticated_user_id
        || insertedAudit.action !== auditAction
        || insertedAudit.resource_type !== 'working_group_leader'
        || insertedAudit.resource_id !== committee.id
        || !isDeepStrictEqual(insertedAudit.details, auditDetails)) {
      throw new Error('Committee leader audit insert did not persist exactly one matching row');
    }

    await client.query('COMMIT');
    const committedEvent: CommitteeLeaderMutationCommittedEvent = {
      action: input.action === 'add' ? 'added' : 'removed',
      committeeId: committee.id,
      organizationId,
      targetWorkosUserId,
    };
    try {
      (dependencies.afterCommit ?? scheduleLeadershipSideEffects)(committedEvent);
    } catch (error) {
      // The mutation is already committed. Preserve the historical
      // fire-and-forget contract without misreporting a committed write.
      logger.error({ err: error, workingGroupId: committee.id }, 'Leadership side effect scheduling failed');
    }
    return {
      status: 'mutated',
      action: committedEvent.action,
      ...commonResult,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    logger.warn({ err: error }, 'Committee leader mutation database transaction unavailable');
    return { status: 'unavailable', source: 'database' };
  } finally {
    client.release();
  }
}
