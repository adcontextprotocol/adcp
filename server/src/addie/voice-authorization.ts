import { getOrganizationAuthorizationUserId } from '../auth/organization-principal.js';
import { getAuthorizationEnforcementWorkos } from '../auth/workos-client.js';
import { getAuthorizationFingerprint } from '../db/authorization-epoch-db.js';
import { createLogger } from '../logger.js';
import type { AAOAdminPrincipal } from './admin-status-lookup.js';

const logger = createLogger('voice-authorization');

/** Only server-created, persisted thread context may supply this provenance. */
export interface VoiceAuthorizationContext {
  version: 1;
  authenticated_workos_user_id: string;
  authorization_fingerprint: string;
}

export type VoiceAuthorizationDecision =
  | { status: 'authorized'; principal: AAOAdminPrincipal }
  | { status: 'stale'; reason: 'missing_provenance' | 'epoch_changed' | 'credential_deleted' }
  | { status: 'unavailable'; source: 'authorization_epoch' | 'workos' };

export class VoiceAuthorizationUnavailableError extends Error {
  readonly code = 'voice_authorization_unavailable';
  readonly statusCode = 503;

  constructor(options?: ErrorOptions) {
    super('Voice authorization is temporarily unavailable. Please try again.', options);
    this.name = 'VoiceAuthorizationUnavailableError';
  }
}

/** Capture the actual credential at the authenticated session-creation boundary. */
export async function captureVoiceAuthorization(
  principal: Pick<AAOAdminPrincipal, 'id' | 'authWorkosUserId'>,
): Promise<VoiceAuthorizationContext> {
  const authenticatedUserId = getOrganizationAuthorizationUserId(principal);
  try {
    return {
      version: 1,
      authenticated_workos_user_id: authenticatedUserId,
      authorization_fingerprint: await getAuthorizationFingerprint([authenticatedUserId]),
    };
  } catch (error) {
    logger.error({ error, code: 'voice_authorization_unavailable' }, 'Voice authorization epoch capture unavailable');
    throw new VoiceAuthorizationUnavailableError({ cause: error });
  }
}

function readVoiceAuthorization(value: unknown): VoiceAuthorizationContext | null {
  if (!value || typeof value !== 'object') return null;
  const context = value as Partial<VoiceAuthorizationContext>;
  if (context.version !== 1
    || typeof context.authenticated_workos_user_id !== 'string'
    || !context.authenticated_workos_user_id.trim()
    || typeof context.authorization_fingerprint !== 'string') {
    return null;
  }
  return context as VoiceAuthorizationContext;
}

/**
 * Revalidate every voice turn. A thread's canonical user id, old email, or
 * caller-provided conversational context cannot substitute for provenance.
 * Legacy and rebound sessions must restart through authenticated creation.
 */
export async function resolveVoiceAuthorization(
  persistedContext: unknown,
): Promise<VoiceAuthorizationDecision> {
  const context = readVoiceAuthorization(persistedContext);
  if (!context) return { status: 'stale', reason: 'missing_provenance' };

  const userId = context.authenticated_workos_user_id;
  const fingerprintIsCurrent = async (): Promise<boolean> => (
    await getAuthorizationFingerprint([userId])
  ) === context.authorization_fingerprint;

  try {
    if (!await fingerprintIsCurrent()) return { status: 'stale', reason: 'epoch_changed' };
  } catch (error) {
    logger.error({ error, code: 'voice_authorization_unavailable' }, 'Voice authorization epoch lookup unavailable');
    return { status: 'unavailable', source: 'authorization_epoch' };
  }

  let credential: { id: string; email: string };
  try {
    // This client bounds retries/timeouts. Read the current email from the
    // exact credential so a stale/canonical break-glass email never grants.
    credential = await getAuthorizationEnforcementWorkos().userManagement.getUser(userId);
    if (credential.id !== userId || typeof credential.email !== 'string') {
      throw new Error('WorkOS returned a mismatched voice credential');
    }
  } catch (error) {
    if (error && typeof error === 'object' && 'status' in error && error.status === 404) {
      return { status: 'stale', reason: 'credential_deleted' };
    }
    logger.error({ error, code: 'voice_authorization_unavailable' }, 'Voice credential lookup unavailable');
    return { status: 'unavailable', source: 'workos' };
  }

  try {
    // WorkOS is an external await: reject a concurrent binding change that
    // happened after the first epoch read instead of stamping stale state.
    if (!await fingerprintIsCurrent()) return { status: 'stale', reason: 'epoch_changed' };
  } catch (error) {
    logger.error({ error, code: 'voice_authorization_unavailable' }, 'Voice authorization epoch recheck unavailable');
    return { status: 'unavailable', source: 'authorization_epoch' };
  }

  return {
    status: 'authorized',
    principal: { id: userId, authWorkosUserId: userId, email: credential.email },
  };
}
