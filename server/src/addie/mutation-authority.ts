import { WorkingGroupDatabase } from '../db/working-group-db.js';
import type { AAOAdminPrincipal } from './admin-status-lookup.js';
import {
  AAOAdminLookupUnavailableError,
  isAuthenticatedUserAAOAdmin,
} from './admin-status-lookup.js';
import { readCredentialAuthorizationLifecycle, type ActiveCredentialAuthorizationSnapshot } from '../db/authorization-epoch-db.js';
import {
  loadAuthorizationSnapshot,
  sameAuthorizationSnapshot,
  type AuthorizationSnapshot,
} from '../db/user-authorization-snapshot-db.js';
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
  readonly lifecycle?: Readonly<ActiveCredentialAuthorizationSnapshot>;
  readonly captureDenial?: 'access_denied';
  readonly committeeMutationTools: ReadonlySet<string>;
  readonly capturedCommitteeIds: readonly string[];
  readonly requestAuthorization?: AuthorizationSnapshot;
  readonly principal: Readonly<AAOAdminPrincipal>;
  readonly platformAdminMutationTools: ReadonlySet<string>;
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
  principal: AAOAdminPrincipal & { readonly authorizationSnapshot?: AuthorizationSnapshot };
  platformAdminMutationTools: Iterable<string>;
  committeeMutationTools?: Iterable<string>;
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
  let lifecycle;
  try {
    lifecycle = await readCredentialAuthorizationLifecycle(credentialId);
  } catch (cause) {
    throw new AAOAdminLookupUnavailableError({ cause });
  }
  if (lifecycle.status === 'unavailable') throw new AAOAdminLookupUnavailableError();
  const captureDenial = lifecycle.status !== 'active'
    || lifecycle.snapshot.workos_user_id !== credentialId
    || lifecycle.snapshot.email?.trim().toLowerCase() !== credentialEmail;
  const committeeMutationTools = new Set(input.committeeMutationTools);
  let capturedCommitteeIds: string[] = [];
  if (!captureDenial && committeeMutationTools.size > 0) {
    try {
      capturedCommitteeIds = (await new WorkingGroupDatabase().getCommitteesLedByUser(credentialId)).map(group => group.id);
    } catch (cause) {
      throw new AAOAdminLookupUnavailableError({ cause });
    }
  }

  return Object.freeze({
    credentialId,
    lifecycle: lifecycle.status === 'active' ? Object.freeze({ ...lifecycle.snapshot }) : undefined,
    captureDenial: captureDenial ? 'access_denied' as const : undefined,
    committeeMutationTools,
    capturedCommitteeIds: Object.freeze(capturedCommitteeIds),
    requestAuthorization: input.principal.authorizationSnapshot
      ? Object.freeze(structuredClone(input.principal.authorizationSnapshot)) : undefined,
    principal: Object.freeze({
      id: credentialId,
      authWorkosUserId: credentialId,
      email: credentialEmail,
    }),
    platformAdminMutationTools: new Set(input.platformAdminMutationTools),
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
  const localDecision = await revalidateLocalLifecycle(snapshot);
  if (!localDecision.allowed) return localDecision;

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

  if (snapshot.committeeMutationTools.has(toolName)) {
    try {
      const currentIds = new Set((await new WorkingGroupDatabase().getCommitteesLedByUser(snapshot.credentialId)).map(group => group.id));
      // An unrelated surviving committee must not preserve authority for a
      // committee removed during this turn. Handlers still check the target.
      if (snapshot.capturedCommitteeIds.length === 0
        || snapshot.capturedCommitteeIds.some(id => !currentIds.has(id))) {
        return { allowed: false, status: 'access_denied' };
      }
    } catch {
      return { allowed: false, status: 'recoverable_error' };
    }
  }

  if (snapshot.platformAdminMutationTools.has(toolName)) {
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
  // Recheck the entire positive lifecycle proof after every awaited authority
  // source, including terminal markers, binding, canonical route and email.
  return revalidateLocalLifecycle(snapshot);
}

async function revalidateLocalLifecycle(
  snapshot: AddieMutationAuthoritySnapshot,
): Promise<AddieMutationAuthorityDecision> {
  if (snapshot.captureDenial || !snapshot.lifecycle) return { allowed: false, status: 'access_denied' };
  try {
    const current = await readCredentialAuthorizationLifecycle(snapshot.credentialId);
    if (current.status === 'unavailable') return { allowed: false, status: 'recoverable_error' };
    if (current.status !== 'active') return { allowed: false, status: 'access_denied' };
    const captured = snapshot.lifecycle;
    const live = current.snapshot;
    if (live.workos_user_id !== captured.workos_user_id
      || live.identity_id !== captured.identity_id
      || live.primary_workos_user_id !== captured.primary_workos_user_id
      || live.fingerprint !== captured.fingerprint
      || live.email?.trim().toLowerCase() !== captured.email?.trim().toLowerCase()) {
      return { allowed: false, status: 'access_denied' };
    }
    if (snapshot.requestAuthorization) {
      const original = snapshot.requestAuthorization;
      const currentAuthorization = await loadAuthorizationSnapshot(
        snapshot.credentialId, original.selectedOrganizationId,
      );
      if (!currentAuthorization || !sameAuthorizationSnapshot(original, currentAuthorization)) {
        return { allowed: false, status: 'access_denied' };
      }
    }
    return { allowed: true };
  } catch {
    return { allowed: false, status: 'recoverable_error' };
  }
}
