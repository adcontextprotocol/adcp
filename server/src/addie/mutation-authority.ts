import type { AAOAdminPrincipal } from './admin-status-lookup.js';
import {
  AAOAdminLookupUnavailableError,
  isAuthenticatedUserAAOAdmin,
} from './admin-status-lookup.js';
import { getExactCredentialAuthorizationEpoch } from '../db/authorization-epoch-db.js';
import { getAuthorizationEnforcementWorkos } from '../auth/workos-client.js';
import {
  evaluateUserOrgRoleAuthorization,
  resolveUserOrgAuthorization,
  type MembershipRole,
} from '../utils/resolve-user-org-authorization.js';
import type { MemberContext } from './member-context.js';

export type AddieMutationAuthorityDecision =
  | { allowed: true }
  | { allowed: false; status: 'access_denied' | 'recoverable_error' };

export type AddieCredentialAuthorityDecision = 'authorized' | 'forbidden' | 'unavailable';

export type AddieCredentialAuthorityLookup = (
  credentialId: string,
) => Promise<AddieCredentialAuthorityDecision>;

export type AddieOrganizationAuthorityLookup = (
  credentialId: string,
  organizationId: string,
  minimumRole: MembershipRole,
) => Promise<'authorized' | 'forbidden' | 'unavailable'>;

export interface AddieMutationAuthoritySnapshot {
  readonly credentialId: string;
  readonly epoch: string;
  readonly principal: Readonly<AAOAdminPrincipal>;
  readonly platformAdminTools: ReadonlySet<string>;
  /** Authoritative WorkOS lifecycle and email proof. Always present. */
  readonly revalidateCredentialLifecycle: AddieCredentialAuthorityLookup;
  /** Optional surface binding proof, such as the live Slack mapping. */
  readonly revalidateCredential?: AddieCredentialAuthorityLookup;
  readonly revalidatePlatformAdmin?: (
    credentialId: string,
  ) => Promise<'authorized' | 'forbidden' | 'unavailable'>;
  readonly organizationAuthority?: Readonly<{
    organizationId: string;
    minimumRole: MembershipRole;
    revalidate: AddieOrganizationAuthorityLookup;
  }>;
}

export interface AddieOrganizationMutationAuthority {
  organizationId: string;
  minimumRole: MembershipRole;
  revalidate?: AddieOrganizationAuthorityLookup;
}

function workosStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as { status?: unknown; statusCode?: unknown };
  const status = candidate.status ?? candidate.statusCode;
  return typeof status === 'number' ? status : undefined;
}

/**
 * Re-read the exact credential from WorkOS at the dispatch boundary. Local
 * webhook state and persisted epochs cannot detect provider deletion before
 * its webhook arrives. Comparing the captured email also prevents a cached
 * break-glass email from surviving an authoritative provider-side change.
 */
export async function revalidateExactCredentialLifecycle(
  credentialId: string,
  capturedEmail: string,
): Promise<AddieCredentialAuthorityDecision> {
  try {
    const credential = await getAuthorizationEnforcementWorkos().userManagement.getUser(credentialId);
    if (!credential || credential.id !== credentialId || typeof credential.email !== 'string') {
      return 'unavailable';
    }
    return credential.email.trim().toLowerCase() === capturedEmail
      ? 'authorized'
      : 'forbidden';
  } catch (error) {
    return workosStatus(error) === 404 ? 'forbidden' : 'unavailable';
  }
}

/** Freeze the exact selected organization and role used to assemble handlers. */
export function organizationMutationAuthorityFromMemberContext(
  memberContext: MemberContext | null,
): AddieOrganizationMutationAuthority | undefined {
  const organizationId = memberContext?.organization?.workos_organization_id;
  const role = memberContext?.org_membership?.role;
  if (!organizationId && !role) return undefined;
  if (
    !organizationId
    || (role !== 'owner' && role !== 'admin' && role !== 'member')
  ) {
    throw new AAOAdminLookupUnavailableError();
  }
  return { organizationId, minimumRole: role };
}

/**
 * Re-prove the exact credential's selected-organization authority against
 * both live WorkOS membership and persisted credential grants. WorkOS is a
 * required live signal at dispatch, even when a local grant is sufficient:
 * a provider outage is uncertainty, not permission.
 */
export async function revalidateExactOrganizationAuthority(
  credentialId: string,
  organizationId: string,
  minimumRole: MembershipRole,
): Promise<'authorized' | 'forbidden' | 'unavailable'> {
  let resolution;
  try {
    resolution = await resolveUserOrgAuthorization(
      getAuthorizationEnforcementWorkos(),
      { id: credentialId, authWorkosUserId: credentialId },
      organizationId,
    );
  } catch {
    return 'unavailable';
  }

  if (resolution.status === 'unavailable') return 'unavailable';
  if (
    resolution.status === 'authorized'
    && resolution.unavailableSources.includes('workos')
  ) {
    return 'unavailable';
  }
  const decision = evaluateUserOrgRoleAuthorization(resolution, minimumRole);
  return decision.status;
}

/**
 * Capture authority only after the request-local tool surface is assembled.
 * A missing credential or unavailable epoch is not a usable snapshot.
 */
export async function captureAddieMutationAuthority(input: {
  principal: AAOAdminPrincipal;
  platformAdminTools: Iterable<string>;
  revalidateCredentialLifecycle?: AddieCredentialAuthorityLookup;
  revalidateCredential?: AddieMutationAuthoritySnapshot['revalidateCredential'];
  revalidatePlatformAdmin?: AddieMutationAuthoritySnapshot['revalidatePlatformAdmin'];
  organizationAuthority?: AddieOrganizationMutationAuthority;
}): Promise<AddieMutationAuthoritySnapshot> {
  const credentialId = input.principal.authWorkosUserId ?? input.principal.id;
  const credentialEmail = input.principal.email?.trim().toLowerCase();
  if (!credentialId || credentialId.trim() !== credentialId || !credentialEmail) {
    throw new AAOAdminLookupUnavailableError();
  }
  let epoch: string | null;
  try {
    epoch = await getExactCredentialAuthorizationEpoch(credentialId);
  } catch (cause) {
    throw new AAOAdminLookupUnavailableError({ cause });
  }
  if (epoch === null) throw new AAOAdminLookupUnavailableError();

  return Object.freeze({
    credentialId,
    epoch,
    principal: Object.freeze({
      id: credentialId,
      authWorkosUserId: credentialId,
      email: credentialEmail,
    }),
    platformAdminTools: new Set(input.platformAdminTools),
    revalidateCredentialLifecycle: input.revalidateCredentialLifecycle
      ?? ((exactCredentialId) => revalidateExactCredentialLifecycle(exactCredentialId, credentialEmail)),
    revalidateCredential: input.revalidateCredential,
    revalidatePlatformAdmin: input.revalidatePlatformAdmin,
    organizationAuthority: input.organizationAuthority
      ? Object.freeze({
          organizationId: input.organizationAuthority.organizationId,
          minimumRole: input.organizationAuthority.minimumRole,
          revalidate: input.organizationAuthority.revalidate
            ?? revalidateExactOrganizationAuthority,
        })
      : undefined,
  });
}

/** Re-prove the exact credential and its request-time authority at mutation time. */
export async function revalidateAddieMutationAuthority(
  snapshot: AddieMutationAuthoritySnapshot,
  toolName: string,
): Promise<AddieMutationAuthorityDecision> {
  let currentEpoch: string | null;
  try {
    currentEpoch = await getExactCredentialAuthorizationEpoch(snapshot.credentialId);
  } catch {
    return { allowed: false, status: 'recoverable_error' };
  }
  if (currentEpoch === null || currentEpoch !== snapshot.epoch) {
    return { allowed: false, status: 'access_denied' };
  }

  try {
    const decision = await snapshot.revalidateCredentialLifecycle(snapshot.credentialId);
    if (decision !== 'authorized') {
      return {
        allowed: false,
        status: decision === 'unavailable' ? 'recoverable_error' : 'access_denied',
      };
    }
  } catch {
    return { allowed: false, status: 'recoverable_error' };
  }

  if (snapshot.revalidateCredential) {
    try {
      const decision = await snapshot.revalidateCredential(snapshot.credentialId);
      if (decision !== 'authorized') {
        return {
          allowed: false,
          status: decision === 'unavailable' ? 'recoverable_error' : 'access_denied',
        };
      }
    } catch {
      return { allowed: false, status: 'recoverable_error' };
    }
  }

  if (snapshot.organizationAuthority) {
    try {
      const decision = await snapshot.organizationAuthority.revalidate(
        snapshot.credentialId,
        snapshot.organizationAuthority.organizationId,
        snapshot.organizationAuthority.minimumRole,
      );
      if (decision !== 'authorized') {
        return {
          allowed: false,
          status: decision === 'unavailable' ? 'recoverable_error' : 'access_denied',
        };
      }
    } catch {
      return { allowed: false, status: 'recoverable_error' };
    }
  }

  if (snapshot.platformAdminTools.has(toolName)) {
    try {
      if (snapshot.revalidatePlatformAdmin) {
        const decision = await snapshot.revalidatePlatformAdmin(snapshot.credentialId);
        if (decision !== 'authorized') {
          return {
            allowed: false,
            status: decision === 'unavailable' ? 'recoverable_error' : 'access_denied',
          };
        }
      } else if (!(await isAuthenticatedUserAAOAdmin(snapshot.principal))) {
        return { allowed: false, status: 'access_denied' };
      }
    } catch (error) {
      if (error instanceof AAOAdminLookupUnavailableError) {
        return { allowed: false, status: 'recoverable_error' };
      }
      return { allowed: false, status: 'recoverable_error' };
    }
  }
  // Every proof above can await an external authority source. Re-read the
  // exact local epoch afterwards so a concurrent webhook or local authority
  // writer cannot commit between the first epoch read and dispatch.
  try {
    currentEpoch = await getExactCredentialAuthorizationEpoch(snapshot.credentialId);
  } catch {
    return { allowed: false, status: 'recoverable_error' };
  }
  if (currentEpoch === null || currentEpoch !== snapshot.epoch) {
    return { allowed: false, status: 'access_denied' };
  }

  return { allowed: true };
}
