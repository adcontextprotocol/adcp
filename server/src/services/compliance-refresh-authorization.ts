import type { PoolClient } from 'pg';
import type { AAOAdminPrincipal } from '../addie/admin-status-lookup.js';
import { isBreakGlassAdminEmail } from '../auth/admin-access.js';
import { getAuthorizationEnforcementWorkos } from '../auth/workos-client.js';
import { getAuthorizationFingerprint } from '../db/authorization-epoch-db.js';
import { query, withDatabaseDeadline } from '../db/client.js';
import {
  assertComplianceRefreshAuthorizationFingerprint,
  ComplianceRefreshLeaseLostError,
  ComplianceRefreshProvenanceError,
  hasComplianceRefreshProvenance,
  type ClaimedComplianceRefreshRequest,
  type ComplianceRefreshRequest,
} from '../db/compliance-refresh-requests-db.js';
import { isOrgOwnerOfAgent, resolveOwnerOrgForUser } from './agent-ownership.js';

export class ComplianceRefreshAuthorizationError extends Error {
  constructor(readonly code: 'authorization_revoked' | 'authorization_unavailable') {
    super(code === 'authorization_revoked'
      ? 'Access changed during the refresh'
      : 'Refresh authorization is temporarily unavailable');
    this.name = 'ComplianceRefreshAuthorizationError';
  }
}

export function isComplianceRefreshAccessFailure(error: unknown): error is Error & { code: string } {
  return !!error && typeof error === 'object' && 'code' in error
    && (error.code === 'authorization_revoked' || error.code === 'authorization_unavailable'
      || error.code === 'authorization_provenance_missing' || error.code === 'lease_lost');
}

/** Preserve an unavailable authority source instead of turning it into denial. */
async function lookupAuthority<T>(lookup: () => Promise<T>): Promise<T> {
  try {
    return await withDatabaseDeadline(Date.now() + 5_000, lookup);
  } catch (error) {
    if (isComplianceRefreshAccessFailure(error)) throw error;
    throw new ComplianceRefreshAuthorizationError('authorization_unavailable');
  }
}

export function resolveRefreshOwnerOrg(principal: AAOAdminPrincipal, agentUrl: string, orgId?: string) {
  return lookupAuthority(() => resolveOwnerOrgForUser(
    principal.authWorkosUserId ?? principal.id, agentUrl, orgId, { throwOnError: true },
  ));
}

export function isRefreshOwner(principal: AAOAdminPrincipal, orgId: string, agentUrl: string) {
  return lookupAuthority(() => isOrgOwnerOfAgent(
    orgId, principal.authWorkosUserId ?? principal.id, agentUrl, { throwOnError: true },
  ));
}

/** No canonical identity resolver or process-local authorization cache. */
async function isExactCredentialAdmin(principal: AAOAdminPrincipal): Promise<boolean> {
  try {
    return await lookupAuthority(async () => {
      const result = await query<{ is_admin: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM working_group_memberships m
            WHERE m.working_group_id = g.id AND m.workos_user_id = $1 AND m.status = 'active'
         ) AS is_admin FROM working_groups g WHERE g.slug = 'aao-admin'`,
        [principal.authWorkosUserId ?? principal.id],
      );
      if (!result.rows[0]) throw new ComplianceRefreshAuthorizationError('authorization_unavailable');
      return result.rows[0].is_admin || isBreakGlassAdminEmail(principal.email);
    });
  } catch (error) {
    // Independent break-glass authority uses only the just-fetched WorkOS email.
    if (isBreakGlassAdminEmail(principal.email)) return true;
    throw error;
  }
}

async function currentCredential(credentialId: string): Promise<AAOAdminPrincipal> {
  let credential: { id: string; email: string };
  let timeout: NodeJS.Timeout | undefined;
  try {
    // Bound the whole lookup, including body decoding (the SDK timer ends at
    // headers). A late result cannot resume this authorization.
    credential = await Promise.race([
      getAuthorizationEnforcementWorkos().userManagement.getUser(credentialId),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new ComplianceRefreshAuthorizationError('authorization_unavailable')), 5_000);
      }),
    ]);
  } catch (error) {
    const deleted = error && typeof error === 'object' && 'status' in error && error.status === 404;
    throw new ComplianceRefreshAuthorizationError(deleted ? 'authorization_revoked' : 'authorization_unavailable');
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  if (credential?.id !== credentialId) throw new ComplianceRefreshAuthorizationError('authorization_revoked');
  if (typeof credential.email !== 'string' || !credential.email.trim()) {
    throw new ComplianceRefreshAuthorizationError('authorization_unavailable');
  }
  return { id: credentialId, authWorkosUserId: credentialId, email: credential.email };
}

export async function isRefreshAdmin(principal: AAOAdminPrincipal): Promise<boolean> {
  return isExactCredentialAdmin(await currentCredential(principal.authWorkosUserId ?? principal.id));
}

export type ComplianceRefreshAuthorizationContext = Pick<ComplianceRefreshRequest,
  'agent_url' | 'owner_org_id' | 'requester_type' | 'requested_by_user_id'
  | 'requested_by_auth_workos_user_id' | 'triggered_by'>;

async function fingerprint(credentialId: string): Promise<string> {
  return lookupAuthority(() => getAuthorizationFingerprint([credentialId]));
}

async function validateAuthority(
  request: ComplianceRefreshAuthorizationContext,
  admittedFingerprint: string,
): Promise<AAOAdminPrincipal> {
  if (!hasComplianceRefreshProvenance({ ...request, authorization_fingerprint: admittedFingerprint })) {
    throw new ComplianceRefreshProvenanceError();
  }
  const credentialId = request.requested_by_auth_workos_user_id!;
  if (await fingerprint(credentialId) !== admittedFingerprint) {
    throw new ComplianceRefreshAuthorizationError('authorization_revoked');
  }
  const principal = await currentCredential(credentialId);
  const authorized = request.triggered_by === 'owner_test'
    ? await isRefreshOwner(principal, request.owner_org_id!, request.agent_url)
    : await isExactCredentialAdmin(principal);
  if (!authorized || await fingerprint(credentialId) !== admittedFingerprint) {
    throw new ComplianceRefreshAuthorizationError('authorization_revoked');
  }
  return principal;
}

/** Capture only after proving the exact credential; never backfill old jobs. */
export async function captureComplianceRefreshAuthorization(
  context: ComplianceRefreshAuthorizationContext,
): Promise<string> {
  if (!hasComplianceRefreshProvenance({ ...context, authorization_fingerprint: '' })) {
    throw new ComplianceRefreshProvenanceError();
  }
  const admitted = await fingerprint(context.requested_by_auth_workos_user_id!);
  await validateAuthority(context, admitted);
  return admitted;
}

export async function authorizeComplianceRefresh(request: ComplianceRefreshRequest): Promise<void> {
  await validateAuthority(request, request.authorization_fingerprint);
}

/** Runs inside the protected write's transaction, before any mutation. */
export type ComplianceRefreshWriteGuard = (client: PoolClient, agentUrl: string) => Promise<void>;
export interface ComplianceRefreshAuthorizationGuard {
  checkpoint(): Promise<void>;
  beforeWrite: ComplianceRefreshWriteGuard;
}

export function createComplianceRefreshAuthorizationGuard(
  request: ClaimedComplianceRefreshRequest,
  lease: { assertValid(): void },
): ComplianceRefreshAuthorizationGuard {
  const checkpoint = async () => {
    lease.assertValid();
    await authorizeComplianceRefresh(request);
    lease.assertValid();
  };
  return {
    checkpoint,
    beforeWrite: async (client, agentUrl) => {
      lease.assertValid();
      if (agentUrl !== request.agent_url) throw new ComplianceRefreshAuthorizationError('authorization_revoked');
      // Remote validation precedes row locks. Local identity/membership
      // revocation and the protected write then serialize in one transaction.
      const principal = await validateAuthority(request, request.authorization_fingerprint);
      try {
        await client.query("SELECT set_config('statement_timeout', '5000ms', true)");
        await client.query("SELECT set_config('lock_timeout', '2000ms', true)");
        await assertComplianceRefreshAuthorizationFingerprint(
          client, request.requested_by_auth_workos_user_id!, request.authorization_fingerprint,
        );
        if (request.triggered_by === 'owner_test') {
          const owner = await client.query(
            `SELECT om.workos_user_id FROM organization_memberships om
             JOIN member_profiles mp ON mp.workos_organization_id = om.workos_organization_id
             WHERE om.workos_user_id = $1 AND mp.workos_organization_id = $2
               AND mp.agents @> $3::jsonb FOR SHARE OF om, mp`,
            [principal.id, request.owner_org_id, JSON.stringify([{ url: request.agent_url }])],
          );
          if (!owner.rowCount) throw new ComplianceRefreshAuthorizationError('authorization_revoked');
        } else if (!isBreakGlassAdminEmail(principal.email)) {
          const admin = await client.query(
            `SELECT m.id FROM working_group_memberships m
             JOIN working_groups g ON g.id = m.working_group_id
             WHERE g.slug = 'aao-admin' AND m.workos_user_id = $1 AND m.status = 'active'
             FOR SHARE OF m, g`,
            [principal.id],
          );
          if (!admin.rowCount) throw new ComplianceRefreshAuthorizationError('authorization_revoked');
        }
        const operation = await client.query(
          `SELECT id FROM agent_compliance_refresh_requests
           WHERE id = $1 AND agent_url = $2 AND status = 'running' AND lease_token = $3
             AND lease_expires_at > clock_timestamp() FOR SHARE`,
          [request.id, request.agent_url, request.lease_token],
        );
        if (!operation.rowCount) throw new ComplianceRefreshLeaseLostError();
        lease.assertValid();
      } catch (error) {
        if (isComplianceRefreshAccessFailure(error)) throw error;
        throw new ComplianceRefreshAuthorizationError('authorization_unavailable');
      }
    },
  };
}
