import type { AAOAdminPrincipal } from './admin-status-lookup.js';
import {
  AAOAdminLookupUnavailableError,
  isAuthenticatedUserAAOAdmin,
} from './admin-status-lookup.js';
import { getExactCredentialAuthorizationEpoch } from '../db/authorization-epoch-db.js';

export type AddieMutationAuthorityDecision =
  | { allowed: true }
  | { allowed: false; status: 'access_denied' | 'recoverable_error' };

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
