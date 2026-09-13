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

export type AddieOrganizationAuthorityLookup = (
  credentialId: string,
  organizationId: string,
  minimumRole: MembershipRole,
) => Promise<'authorized' | 'forbidden' | 'unavailable'>;

export interface AddieMutationAuthoritySnapshot {
  readonly credentialId: string;
  readonly epoch: string;
  readonly principal: Readonly<AAOAdminPrincipal>;
  readonly platformAdminMutationTools: ReadonlySet<string>;
  readonly revalidateCredential?: (
    credentialId: string,
  ) => Promise<'authorized' | 'forbidden' | 'unavailable'>;
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
  platformAdminMutationTools: Iterable<string>;
  revalidateCredential?: AddieMutationAuthoritySnapshot['revalidateCredential'];
  revalidatePlatformAdmin?: AddieMutationAuthoritySnapshot['revalidatePlatformAdmin'];
  organizationAuthority?: AddieOrganizationMutationAuthority;
}): Promise<AddieMutationAuthoritySnapshot> {
  const credentialId = input.principal.authWorkosUserId ?? input.principal.id;
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
      email: input.principal.email,
    }),
    platformAdminMutationTools: new Set(input.platformAdminMutationTools),
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

  if (snapshot.platformAdminMutationTools.has(toolName)) {
    try {
      if (snapshot.revalidatePlatformAdmin) {
        const decision = await snapshot.revalidatePlatformAdmin(snapshot.credentialId);
        return decision === 'authorized'
          ? { allowed: true }
          : { allowed: false, status: decision === 'unavailable' ? 'recoverable_error' : 'access_denied' };
      }
      if (!(await isAuthenticatedUserAAOAdmin(snapshot.principal))) {
        return { allowed: false, status: 'access_denied' };
      }
    } catch (error) {
      if (error instanceof AAOAdminLookupUnavailableError) {
        return { allowed: false, status: 'recoverable_error' };
      }
      return { allowed: false, status: 'recoverable_error' };
    }
  }

  return { allowed: true };
}
