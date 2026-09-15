import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import type { PoolClient, QueryResultRow } from 'pg';
import type { WorkOS } from '@workos-inc/node';
import { getPool } from '../db/client.js';
import { getOrganizationAuthorizationUserId, getOrganizationAuthenticationStamp } from '../auth/organization-principal.js';
import { getAuthorizationEnforcementWorkos } from '../auth/workos-client.js';
import { isInvalidWorkOSJWTError, verifyWorkOSJWT } from '../auth/workos-jwt.js';
import { DEV_USERS, isDevModeEnabled, invalidateSessionsForUsers } from '../middleware/auth.js';
import { getSeatLimits, resolveMembershipTier, type SeatType, type MembershipTierRow } from '../db/organization-db.js';
import { createLogger } from '../logger.js';

const logger = createLogger('organization-membership-mutation');
export type Role = 'owner' | 'admin' | 'member';
const rank: Record<Role, number> = { member: 1, admin: 2, owner: 3 };
export function isMembershipRole(value: unknown): value is Role {
  return value === 'owner' || value === 'admin' || value === 'member';
}

export class MembershipMutationError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export function mutationDenied(message = 'Access denied'): never {
  throw new MembershipMutationError(403, message);
}

type Snapshot = {
  credential_exists: boolean;
  identity_id: string | null;
  canonical_user_id: string;
  epoch: string | null;
  binding_version: string | null;
  membership_id: string | null;
  membership_version: string | null;
  role: string | null;
  platform_admin: boolean;
  banned: boolean;
};

type CancellationSnapshot = Pick<Snapshot,
  'credential_exists' | 'identity_id' | 'canonical_user_id' | 'epoch' | 'binding_version' | 'banned'>;

export type MutationReply = { status?: number; body: Record<string, unknown> };
type Effect = { action: string; target: Record<string, unknown>; id?: string; outcome: 'succeeded' | 'unknown'; compensate?: () => Promise<void> };

/** All selectors are assertions about one already-resolved explicit organization. */
export function assertOrganizationSelectors(req: Request, org: string): void {
  const selectors: unknown[] = [req.headers['x-organization-id'], req.headers['x-org-id']];
  for (const key of ['organization_id', 'organizationId', 'org_id', 'orgId', 'org']) {
    if (req.query && Object.hasOwn(req.query, key)) selectors.push(req.query[key]);
  }
  for (const key of ['organization_id', 'organizationId', 'org_id', 'orgId']) {
    if (req.body && Object.hasOwn(req.body, key)) selectors.push(req.body[key]);
  }
  for (const value of selectors) {
    if (value !== undefined && (typeof value !== 'string' || value !== org)) {
      mutationDenied('Organization selectors do not agree');
    }
  }
}

/** Resolve the mandatory route selector, then check every redundant selector. */
function selectedOrganization(req: Request): string {
  const org = req.params.orgId;
  if (typeof org !== 'string' || !org.trim()) mutationDenied('An organization must be selected');
  assertOrganizationSelectors(req, org);
  return org;
}

/**
 * This fence is deliberately independent of the read canary and credential
 * grants. Migration 553 has no mutation capability: a grant never supplies or
 * elevates a write role. The local active-membership mirror AND fresh WorkOS
 * membership must identify the same exact credential, organization and role.
 */
export class OrganizationMembershipMutation {
  readonly operationId = randomUUID();
  readonly effects: Effect[] = [];
  readonly afterCommit: Array<() => Promise<unknown>> = [];
  private snapshot!: Snapshot;
  private localPhase = false;
  private expiresAt?: number;
  private readonly targetChecks = new Map<string, () => Promise<void>>();
  private constructor(
    readonly db: PoolClient,
    readonly workos: WorkOS,
    readonly actorId: string,
    readonly orgId: string,
    readonly staticAdmin: boolean,
    readonly dev: boolean,
    private readonly minimumRole: Role,
    private readonly allowPlatformAdmin: boolean,
  ) {}

  get role(): Role { return this.snapshot.role as Role; }
  get platformAdmin(): boolean { return this.staticAdmin || (this.allowPlatformAdmin && this.snapshot.platform_admin); }

  private async readSnapshot(): Promise<Snapshot> {
    const result = await this.db.query<Snapshot>(
      `SELECT EXISTS (SELECT 1 FROM users WHERE workos_user_id = $1) AS credential_exists,
              iwu.identity_id, COALESCE(primary_iwu.workos_user_id, $1) AS canonical_user_id,
              ae.epoch::text AS epoch, iwu.xmin::text AS binding_version,
              om.workos_membership_id AS membership_id, om.xmin::text AS membership_version,
              om.role,
              EXISTS (SELECT 1 FROM working_group_memberships wgm
                        JOIN working_groups wg ON wg.id = wgm.working_group_id
                       WHERE wgm.workos_user_id = $1 AND wgm.status = 'active'
                         AND wg.slug = 'aao-admin' AND wg.status = 'active') AS platform_admin,
              EXISTS (SELECT 1 FROM bans WHERE scope = 'platform'
                        AND (expires_at IS NULL OR expires_at > clock_timestamp())
                        AND ((ban_type = 'user' AND entity_id = $1)
                          OR (ban_type = 'organization' AND entity_id = $2))) AS banned
         FROM (SELECT 1) anchor
         LEFT JOIN identity_workos_users iwu ON iwu.workos_user_id = $1
         LEFT JOIN identity_workos_users primary_iwu
           ON primary_iwu.identity_id = iwu.identity_id AND primary_iwu.is_primary = TRUE
         LEFT JOIN authorization_epochs ae ON ae.workos_user_id = $1
         LEFT JOIN organization_memberships om
           ON om.workos_user_id = $1 AND om.workos_organization_id = $2`,
      [this.actorId, this.orgId],
    );
    if (result.rows.length !== 1) throw new MembershipMutationError(503, 'Authorization state unavailable');
    const row = result.rows[0];
    if (row.banned) mutationDenied('Account suspended');
    if (!this.staticAdmin && !row.credential_exists) throw new MembershipMutationError(401, 'Invalid credential');
    if (!this.staticAdmin && !(this.allowPlatformAdmin && row.platform_admin)) {
      if (!isMembershipRole(row.role) || rank[row.role] < rank[this.minimumRole]) mutationDenied();
    }
    return row;
  }

  async recheck(): Promise<void> {
    if (this.expiresAt !== undefined && this.expiresAt <= Date.now() / 1000) {
      throw new MembershipMutationError(401, 'Credential expired');
    }
    const current = await this.readSnapshot();
    if (JSON.stringify(current) !== JSON.stringify(this.snapshot)) mutationDenied('Authorization changed; retry the request');
  }

  async checkProviderAuthority(): Promise<void> {
    await this.recheck();
    if (this.staticAdmin || this.dev || this.platformAdmin) return;
    let response;
    try {
      response = await this.workos.userManagement.listOrganizationMemberships({
        userId: this.actorId, organizationId: this.orgId, statuses: ['active'],
      });
    } catch {
      throw new MembershipMutationError(503, 'Membership authority unavailable');
    }
    await this.recheck();
    const rows = response.data.filter(row => row.userId === this.actorId && row.organizationId === this.orgId && row.status === 'active');
    if (rows.length !== 1 || !isMembershipRole(rows[0].role?.slug) || rows[0].role.slug !== this.snapshot.role) mutationDenied();
    if (rows[0].id !== this.snapshot.membership_id) mutationDenied('Membership changed; retry the request');
  }

  async readProvider<T>(read: () => Promise<T>): Promise<T> {
    await this.checkProviderAuthority();
    let result: T;
    try { result = await read(); }
    catch { throw new MembershipMutationError(503, 'Membership provider unavailable'); }
    await this.checkProviderAuthority();
    return result;
  }

  expectTarget(id: string, check: () => Promise<void>): void { this.targetChecks.set(id, check); }
  async checkTargets(): Promise<void> {
    for (const check of this.targetChecks.values()) await check();
    // Target reads are awaited provider boundaries too. A delayed webhook must
    // not hide an actor revocation committed while those reads were in flight.
    await this.checkProviderAuthority();
  }

  async providerWrite<T>(action: string, target: Record<string, unknown>, write: () => Promise<T>, compensate?: (value: T) => Promise<void>): Promise<T> {
    await this.checkProviderAuthority();
    await this.checkTargets();
    let result: T;
    try { result = await write(); }
    catch (error) {
      const status = (error as { status?: number; statusCode?: number }).status ?? (error as { statusCode?: number }).statusCode;
      const code = (error as { code?: string }).code;
      if (code === 'organization_membership_already_exists' || code === 'invitation_already_exists' || code === 'cannot_reactivate_pending_organization_membership') {
        throw new MembershipMutationError(409, code);
      }
      // Timeouts, transport errors and server errors do not prove no effect.
      if (!status || status === 408 || status >= 500) this.effects.push({ action, target, outcome: 'unknown' });
      throw new MembershipMutationError(status && status >= 400 && status < 500 && status !== 408 && status !== 429 ? 409 : 503, 'Membership provider did not confirm the change');
    }
    const id = (result as { id?: string } | undefined)?.id;
    this.effects.push({ action, target, id, outcome: 'succeeded', ...(compensate ? { compensate: () => compensate(result) } : {}) });
    await this.checkProviderAuthority();
    return result;
  }

  async rows<T extends QueryResultRow = QueryResultRow>(sql: string, values: unknown[] = []): Promise<T[]> {
    await this.recheck();
    return (await this.db.query<T>(sql, values)).rows;
  }

  /** Lock only at the local commit boundary; committed revokes during provider
   * waits remain visible. Writers after these locks linearize after this change.
   * No helper that opens another transaction may run inside this phase.
   */
  async local<T>(targets: string[], work: () => Promise<T>): Promise<T> {
    const ids = [...new Set([this.actorId, ...targets])].sort();
    // Existing identity/webhook writers take these rows in differing orders.
    // Never wait while holding a competing row: fail closed on contention,
    // rather than forming a cycle after an irreversible provider action.
    await this.db.query('SELECT workos_user_id FROM users WHERE workos_user_id = ANY($1) ORDER BY workos_user_id FOR UPDATE NOWAIT', [ids]);
    await this.db.query('SELECT workos_user_id FROM authorization_epochs WHERE workos_user_id = ANY($1) ORDER BY workos_user_id FOR UPDATE NOWAIT', [ids]);
    await this.db.query('SELECT workos_user_id FROM identity_workos_users WHERE workos_user_id = ANY($1) ORDER BY workos_user_id FOR UPDATE NOWAIT', [ids]);
    await this.db.query('SELECT workos_user_id FROM organization_memberships WHERE workos_organization_id = $1 ORDER BY workos_user_id FOR UPDATE NOWAIT', [this.orgId]);
    // Ban insertion has no existing row to lock. This short shared table lock
    // also covers deletes/expiry updates until the local transaction commits.
    await this.db.query('LOCK TABLE bans IN SHARE MODE NOWAIT');
    if (this.allowPlatformAdmin && !this.staticAdmin) {
      await this.db.query('LOCK TABLE working_group_memberships, working_groups IN SHARE MODE NOWAIT');
    }
    await this.checkProviderAuthority();
    await this.checkTargets();
    this.localPhase = true;
    return work();
  }

  async write<T extends QueryResultRow = QueryResultRow>(sql: string, values: unknown[], expectedRows = 1): Promise<T[]> {
    if (!this.localPhase) throw new Error('Membership writes require the local commit phase');
    await this.recheck();
    await this.checkTargets();
    const result = await this.db.query<T>(sql, values);
    if (result.rowCount !== expectedRows) throw new MembershipMutationError(409, 'Membership state changed; no change committed');
    // An allowed self-seat update changes xmin. Rows protecting this snapshot
    // are locked, so this can only incorporate our own checked local writes.
    this.snapshot = await this.readSnapshot();
    return result.rows;
  }

  async audit(action: string, resourceType: string, resourceId: string, details: Record<string, unknown> = {}): Promise<void> {
    await this.write(
      `INSERT INTO registry_audit_log (workos_organization_id, workos_user_id, action, resource_type, resource_id, details)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [this.orgId, this.actorId, action, resourceType, resourceId, JSON.stringify({
        ...details, authenticated_workos_user_id: this.actorId,
        canonical_workos_user_id: this.staticAdmin ? null : this.snapshot.canonical_user_id,
        identity_id: this.snapshot.identity_id, operation_id: this.operationId,
        authority: this.staticAdmin ? 'static_admin_key' : this.platformAdmin ? 'exact_platform_admin' : this.dev ? 'dev_membership' : 'exact_membership',
      })],
    );
  }

  /** Same business seat rules as canAddSeat, using the transaction's org lock. */
  async seatAvailable(seat: SeatType): Promise<void> {
    const [org] = await this.rows<MembershipTierRow>('SELECT * FROM organizations WHERE workos_organization_id = $1', [this.orgId]);
    const limits = getSeatLimits(resolveMembershipTier(org));
    const [usage] = await this.rows<{ contributor: string; community_only: string }>(
      `WITH seats AS (
         SELECT (om.seat_type = 'contributor'
           OR EXISTS (SELECT 1 FROM slack_user_mappings sm WHERE sm.workos_user_id = om.workos_user_id AND sm.mapping_status = 'mapped')
           OR EXISTS (SELECT 1 FROM working_group_memberships wgm JOIN working_groups wg ON wg.id = wgm.working_group_id
                       WHERE wgm.workos_user_id = om.workos_user_id AND wgm.status = 'active' AND wg.status = 'active')) AS contributor
           FROM organization_memberships om WHERE om.workos_organization_id = $1
         UNION ALL SELECT seat_type = 'contributor' FROM invitation_seat_types WHERE workos_organization_id = $1)
       SELECT COUNT(*) FILTER (WHERE contributor)::text AS contributor,
              COUNT(*) FILTER (WHERE NOT contributor)::text AS community_only FROM seats`, [this.orgId],
    );
    const limit = seat === 'contributor' ? limits.contributor : limits.community;
    if (limit !== -1 && Number(usage[seat]) >= limit) mutationDenied('Seat limit reached');
  }

  async effectiveSeat(userId: string): Promise<SeatType | null> {
    // Preserve getUserSeatType's business entitlement across organizations.
    // This value never supplies an authorization role or selects a write org.
    const [row] = await this.rows<{ contributor: boolean }>(
      `SELECT (EXISTS (SELECT 1 FROM organization_memberships other WHERE other.workos_user_id = $1 AND other.seat_type = 'contributor')
         OR EXISTS (SELECT 1 FROM slack_user_mappings sm WHERE sm.workos_user_id = om.workos_user_id AND sm.mapping_status = 'mapped')
         OR EXISTS (SELECT 1 FROM working_group_memberships wgm JOIN working_groups wg ON wg.id = wgm.working_group_id
                     WHERE wgm.workos_user_id = om.workos_user_id AND wgm.status = 'active' AND wg.status = 'active')) AS contributor
         FROM organization_memberships om WHERE om.workos_user_id = $1 LIMIT 1`, [userId],
    );
    return row ? row.contributor ? 'contributor' : 'community_only' : null;
  }

  async requireTeam(): Promise<void> {
    const [org] = await this.rows('SELECT is_personal FROM organizations WHERE workos_organization_id = $1', [this.orgId]);
    if (org?.is_personal) throw new MembershipMutationError(400, 'Personal workspaces cannot have team members');
  }

  static async run(req: Request, minimumRole: Role, allowPlatformAdmin: boolean, operation: (tx: OrganizationMembershipMutation) => Promise<MutationReply>): Promise<MutationReply> {
    const orgId = selectedOrganization(req);
    if (!req.user) throw new MembershipMutationError(401, 'Authentication required');
    const actorId = getOrganizationAuthorizationUserId(req.user);
    const staticAdmin = (req as Request & { isStaticAdminApiKey?: boolean }).isStaticAdminApiKey === true;
    if (staticAdmin && !allowPlatformAdmin) mutationDenied();
    if ((req as Request & { apiKey?: unknown }).apiKey) mutationDenied();
    const dev = isDevModeEnabled() && Object.values(DEV_USERS).some(user => user.id === actorId);
    let verified: Awaited<ReturnType<typeof verifyWorkOSJWT>> | undefined;
    if (!staticAdmin && !dev) {
      const header = req.headers.authorization;
      if (header !== undefined) {
        const match = /^Bearer[\t ]+([^\t ]+)[\t ]*$/i.exec(header);
        if (!match || match[1] !== req.accessToken) throw new MembershipMutationError(401, 'Invalid credential');
      }
      if (!req.accessToken) throw new MembershipMutationError(401, 'Invalid credential');
      try { verified = await verifyWorkOSJWT(req.accessToken); }
      catch (error) {
        const invalid = isInvalidWorkOSJWTError(error);
        throw new MembershipMutationError(invalid ? 401 : 503, invalid ? 'Invalid credential' : 'authorization_unavailable');
      }
      if (verified.isM2M || verified.sub !== actorId) throw new MembershipMutationError(401, 'Credential principal changed');
      if (verified.orgId && verified.orgId !== orgId) mutationDenied('Organization selectors do not agree');
    }
    const db = await getPool().connect();
    let tx: OrganizationMembershipMutation | undefined;
    let commitAttempted = false;
    try {
      await db.query('BEGIN');
      await db.query("SET LOCAL lock_timeout = '2s'");
      await db.query("SET LOCAL statement_timeout = '5s'");
      tx = new OrganizationMembershipMutation(db, getAuthorizationEnforcementWorkos(), actorId, orgId, staticAdmin, dev, minimumRole, allowPlatformAdmin);
      tx.expiresAt = verified?.expiresAt;
      tx.snapshot = await tx.readSnapshot();
      if (!staticAdmin && !dev) {
        const stamp = getOrganizationAuthenticationStamp(req.user);
        if (!stamp) throw new MembershipMutationError(503, 'Authentication state unavailable');
        if (stamp.credentialId !== actorId || stamp.canonicalUserId !== tx.snapshot.canonical_user_id
          || stamp.identityId !== tx.snapshot.identity_id || stamp.bindingVersion !== tx.snapshot.binding_version
          || stamp.epoch !== tx.snapshot.epoch) {
          invalidateSessionsForUsers([actorId, req.user.id]);
          mutationDenied('Authentication state changed; retry the request');
        }
      }
      if (!staticAdmin && req.user.identityId !== undefined && req.user.identityId !== tx.snapshot.identity_id) mutationDenied('Identity binding changed');
      if (!staticAdmin && req.user.id !== tx.snapshot.canonical_user_id) mutationDenied('Identity binding changed');
      // Share the existing webhook promotion lock, then serialize seat/business
      // rules on the org row. Capture precedes waiting: queued stale actors fail.
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`membership-ownerless-promote:${orgId}`]);
      const org = await db.query('SELECT workos_organization_id FROM organizations WHERE workos_organization_id = $1 FOR UPDATE', [orgId]);
      if (org.rowCount !== 1) mutationDenied();
      await tx.checkProviderAuthority();
      const result = await operation(tx);
      await tx.recheck();
      await tx.checkTargets();
      commitAttempted = true;
      await db.query('COMMIT');
      for (const notify of tx.afterCommit) void Promise.resolve().then(notify).catch(error => logger.warn({ error }, 'Membership notification failed'));
      return result;
    } catch (error) {
      await db.query('ROLLBACK').catch(() => {});
      const effects = tx?.effects ?? [];
      // A failed COMMIT acknowledgement has an unknown local outcome. Never
      // compensate it blindly: the local transaction may already have committed.
      if (!commitAttempted) {
        for (const effect of [...effects].reverse()) {
          if (effect.outcome === 'succeeded' && effect.compensate) {
            try { await effect.compensate(); }
            catch (compensationError) { logger.error({ compensationError, operationId: tx?.operationId, action: effect.action }, 'Membership compensation not confirmed'); }
          }
        }
      }
      if (effects.length || commitAttempted) {
        logger.error({ error, operationId: tx?.operationId, orgId, actorId, commitAttempted, effects: effects.map(({ action, target, id, outcome }) => ({ action, target, id, outcome })) }, 'Membership mutation requires reconciliation; provider effects are not a local rollback');
        return { status: 503, body: { error: 'Membership change requires reconciliation', reconciliation_required: true, operation_id: tx?.operationId } };
      }
      throw error;
    } finally { db.release(); }
  }
}

async function readCancellationSnapshot(db: PoolClient, actorId: string, orgId: string): Promise<CancellationSnapshot> {
  const result = await db.query<CancellationSnapshot>(
    `SELECT EXISTS (SELECT 1 FROM users WHERE workos_user_id = $1) AS credential_exists,
            iwu.identity_id, COALESCE(primary_iwu.workos_user_id, $1) AS canonical_user_id,
            ae.epoch::text AS epoch, iwu.xmin::text AS binding_version,
            EXISTS (SELECT 1 FROM bans WHERE scope = 'platform'
                      AND (expires_at IS NULL OR expires_at > clock_timestamp())
                      AND ((ban_type = 'user' AND entity_id = $1)
                        OR (ban_type = 'organization' AND entity_id = $2))) AS banned
       FROM (SELECT 1) anchor
       LEFT JOIN identity_workos_users iwu ON iwu.workos_user_id = $1
       LEFT JOIN identity_workos_users primary_iwu
         ON primary_iwu.identity_id = iwu.identity_id AND primary_iwu.is_primary = TRUE
       LEFT JOIN authorization_epochs ae ON ae.workos_user_id = $1`,
    [actorId, orgId],
  );
  if (result.rows.length !== 1) throw new MembershipMutationError(503, 'authorization_unavailable');
  return result.rows[0];
}

/** Cancel only for the immutable credential that created the request. */
export async function cancelJoinRequestForExactCredential(req: Request, requestId: string): Promise<boolean> {
  if (!req.user) throw new MembershipMutationError(401, 'Authentication required');
  if ((req as Request & { isStaticAdminApiKey?: boolean }).isStaticAdminApiKey
    || (req as Request & { apiKey?: unknown }).apiKey) mutationDenied();

  const actorId = getOrganizationAuthorizationUserId(req.user);
  const dev = isDevModeEnabled() && Object.values(DEV_USERS).some(user => user.id === actorId);
  let verified: Awaited<ReturnType<typeof verifyWorkOSJWT>> | undefined;
  if (!dev) {
    const header = req.headers.authorization;
    if (header !== undefined) {
      const match = /^Bearer[\t ]+([^\t ]+)[\t ]*$/i.exec(header);
      if (!match || match[1] !== req.accessToken) throw new MembershipMutationError(401, 'Invalid credential');
    }
    if (!req.accessToken) throw new MembershipMutationError(401, 'Invalid credential');
    try { verified = await verifyWorkOSJWT(req.accessToken); }
    catch (error) {
      const invalid = isInvalidWorkOSJWTError(error);
      throw new MembershipMutationError(invalid ? 401 : 503, invalid ? 'Invalid credential' : 'authorization_unavailable');
    }
    if (verified.isM2M || verified.sub !== actorId) throw new MembershipMutationError(401, 'Credential principal changed');
  }

  const db = await getPool().connect();
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout = '2s'");
    await db.query("SET LOCAL statement_timeout = '5s'");
    const request = await db.query<{ workos_user_id: string; workos_organization_id: string; status: string }>(
      'SELECT workos_user_id, workos_organization_id, status FROM organization_join_requests WHERE id = $1 FOR UPDATE',
      [requestId],
    );
    const row = request.rows[0];
    if (!row || row.status !== 'pending' || row.workos_user_id !== actorId) {
      await db.query('ROLLBACK');
      return false;
    }
    const orgId = row.workos_organization_id;
    if (verified?.orgId && verified.orgId !== orgId) mutationDenied('Organization selectors do not agree');
    assertOrganizationSelectors(req, orgId);

    const snapshot = await readCancellationSnapshot(db, actorId, orgId);
    if (snapshot.banned) mutationDenied('Account suspended');
    if (!snapshot.credential_exists) throw new MembershipMutationError(401, 'Invalid credential');
    const stamp = getOrganizationAuthenticationStamp(req.user);
    if (!stamp) throw new MembershipMutationError(503, 'authorization_unavailable');
    if (stamp.credentialId !== actorId || stamp.canonicalUserId !== snapshot.canonical_user_id
      || stamp.identityId !== snapshot.identity_id || stamp.bindingVersion !== snapshot.binding_version
      || stamp.epoch !== snapshot.epoch || req.user.id !== snapshot.canonical_user_id
      || (req.user.identityId !== undefined && req.user.identityId !== snapshot.identity_id)) {
      invalidateSessionsForUsers([actorId, req.user.id]);
      mutationDenied('Authentication state changed; retry the request');
    }

    await db.query('SELECT workos_user_id FROM users WHERE workos_user_id = $1 FOR UPDATE NOWAIT', [actorId]);
    await db.query('SELECT workos_user_id FROM authorization_epochs WHERE workos_user_id = $1 FOR UPDATE NOWAIT', [actorId]);
    await db.query('SELECT workos_user_id FROM identity_workos_users WHERE workos_user_id = $1 FOR UPDATE NOWAIT', [actorId]);
    await db.query('LOCK TABLE bans IN SHARE MODE NOWAIT');
    const current = await readCancellationSnapshot(db, actorId, orgId);
    if (current.banned) mutationDenied('Account suspended');
    if (JSON.stringify(current) !== JSON.stringify(snapshot)) mutationDenied('Authorization changed; retry the request');
    if (verified?.expiresAt !== undefined && verified.expiresAt <= Date.now() / 1000) {
      throw new MembershipMutationError(401, 'Credential expired');
    }
    const cancelled = await db.query(
      `UPDATE organization_join_requests SET status = 'cancelled', updated_at = NOW()
        WHERE id = $1 AND workos_user_id = $2 AND workos_organization_id = $3 AND status = 'pending'
        RETURNING id`,
      [requestId, actorId, orgId],
    );
    if (cancelled.rowCount !== 1) throw new MembershipMutationError(409, 'Join request state changed; no change committed');
    await db.query('COMMIT');
    return true;
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    if ((error as { code?: string }).code === '55P03') {
      throw new MembershipMutationError(409, 'Authorization state is busy; retry the request');
    }
    throw error;
  } finally {
    db.release();
  }
}
