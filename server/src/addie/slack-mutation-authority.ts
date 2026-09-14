import { AAOAdminLookupUnavailableError } from './admin-status-lookup.js';
import {
  captureAddieMutationAuthority,
  revalidateAddieMutationAuthority,
  type AddieMutationAuthorityDecision,
  type AddieOrganizationMutationAuthority,
} from './mutation-authority.js';

export type SlackCredentialAuthorityDecision =
  | { status: 'authorized'; credentialId: string }
  | { status: 'forbidden' }
  | { status: 'unavailable'; cause?: unknown };

export type SlackCredentialAuthorityLookup = () => Promise<SlackCredentialAuthorityDecision>;

type SlackAdminAuthorityLookup = (
  credentialId: string,
) => Promise<'authorized' | 'forbidden' | 'unavailable'>;

/**
 * Capture Slack's live WorkOS binding after tool assembly, then bind every
 * mutation check to that exact credential and its persisted epoch.
 */
export async function captureSlackMutationAuthority(input: {
  assembledCredentialId: string | undefined;
  credentialEmail?: string;
  platformAdminMutationTools: readonly string[];
  organizationAuthority?: AddieOrganizationMutationAuthority;
  lookupCredential: SlackCredentialAuthorityLookup;
  revalidatePlatformAdmin: SlackAdminAuthorityLookup;
}): Promise<(request: { toolName: string }) => Promise<AddieMutationAuthorityDecision>> {
  const captured = await input.lookupCredential();
  if (captured.status === 'unavailable') {
    throw new AAOAdminLookupUnavailableError({ cause: captured.cause });
  }
  if (captured.status === 'forbidden') {
    return async () => ({ allowed: false, status: 'access_denied' });
  }
  if (!input.assembledCredentialId || captured.credentialId !== input.assembledCredentialId) {
    return async () => ({ allowed: false, status: 'access_denied' });
  }

  if (input.platformAdminMutationTools.length > 0) {
    const adminDecision = await input.revalidatePlatformAdmin(captured.credentialId);
    if (adminDecision === 'unavailable') throw new AAOAdminLookupUnavailableError();
    if (adminDecision === 'forbidden') {
      return async () => ({ allowed: false, status: 'access_denied' });
    }
  }

  const snapshot = await captureAddieMutationAuthority({
    principal: {
      id: captured.credentialId,
      authWorkosUserId: captured.credentialId,
      email: input.credentialEmail ?? '',
    },
    platformAdminMutationTools: input.platformAdminMutationTools,
    revalidateCredential: async (credentialId) => {
      const current = await input.lookupCredential();
      if (current.status === 'unavailable') return 'unavailable';
      return current.status === 'authorized' && current.credentialId === credentialId
        ? 'authorized'
        : 'forbidden';
    },
    revalidatePlatformAdmin: input.revalidatePlatformAdmin,
    organizationAuthority: input.organizationAuthority,
  });

  return ({ toolName }) => revalidateAddieMutationAuthority(snapshot, toolName);
}
