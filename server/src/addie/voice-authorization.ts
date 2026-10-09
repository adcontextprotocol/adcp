import crypto from 'node:crypto';
import { getOrganizationAuthorizationUserId } from '../auth/organization-principal.js';
import { getAuthorizationEnforcementWorkos } from '../auth/workos-client.js';
import { getAuthorizationFingerprint } from '../db/authorization-epoch-db.js';
import { queryWithTimeout, withDatabaseDeadline } from '../db/client.js';
import { createLogger } from '../logger.js';
import type { AAOAdminPrincipal } from './admin-status-lookup.js';
import type { Thread } from './thread-service.js';

const logger = createLogger('voice-authorization');

const CALLBACK_TOKEN_DOMAIN = 'adcp:tavus-callback:v1\0';
const CALLBACK_TURN_DOMAIN = 'adcp:tavus-callback-turn:v1\0';
const verifiedCallback = Symbol('verified voice callback');
type VerifiedVoiceThread = Readonly<Omit<Thread, 'user_id'>> & {
  readonly user_id: string;
  readonly [verifiedCallback]: true;
};

interface VoiceCallbackBinding {
  version: 1;
  nonce: string;
  expires_at: number;
  provider_conversation_id?: string;
}

interface VoiceCallbackClaims extends VoiceCallbackBinding {
  thread_id: string;
  external_id: string;
}

export type VoiceCallbackDecision =
  | { status: 'verified'; thread: VerifiedVoiceThread }
  | { status: 'invalid' }
  | { status: 'unavailable' };

/**
 * Derive the database idempotency key for one provider callback. Tavus does
 * not supply a turn id, but an exact retry repeats the ordered OpenAI message
 * envelope. The verified thread separates identical transcripts in different
 * sessions; the session bearer token itself is intentionally not a receipt.
 */
function canonicalVoiceCallbackJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalVoiceCallbackJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalVoiceCallbackJson(record[key])}`
  )).join(',')}}`;
}

function normalizeSystemCapability(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(
      /\[conductor:voice_session=[A-Za-z0-9_.-]{1,1024}\]/g,
      '[conductor:voice_session]',
    );
  }
  if (Array.isArray(value)) return value.map(normalizeSystemCapability);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, normalizeSystemCapability(item)]),
  );
}

export function deriveVoiceCallbackTurnId(input: {
  threadId: string;
  externalId: string;
  providerConversationId: string;
  messages: readonly unknown[];
}): string {
  const normalizedMessages = input.messages.map((message) => {
    if (!message || typeof message !== 'object' || (message as { role?: unknown }).role !== 'system') {
      return message;
    }
    const record = message as Record<string, unknown>;
    return { ...record, content: normalizeSystemCapability(record.content) };
  });
  const digest = crypto.createHash('sha256')
    .update(CALLBACK_TURN_DOMAIN)
    .update(input.threadId)
    .update('\0')
    .update(input.externalId)
    .update('\0')
    .update(input.providerConversationId)
    .update('\0')
    .update(canonicalVoiceCallbackJson(normalizedMessages))
    .digest();
  // PostgreSQL UUID with deterministic v5/variant bits (the hash construction,
  // rather than an RFC namespace UUID, supplies the collision domain).
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * A per-session capability, independent of the mutable conversation text.
 * Only the authenticated session-creation route issues it. The shared LLM
 * secret is domain-separated from this MAC and is never put in a prompt.
 */
export function issueVoiceCallbackBinding(
  threadId: string,
  externalId: string,
  maxDurationSeconds: number,
): { token: string; binding: VoiceCallbackBinding } {
  const secret = process.env.TAVUS_LLM_SECRET;
  if (!secret || !Number.isInteger(maxDurationSeconds) || maxDurationSeconds < 60 || maxDurationSeconds > 7200) {
    throw new VoiceAuthorizationUnavailableError();
  }
  const binding: VoiceCallbackBinding = {
    version: 1,
    nonce: crypto.randomBytes(32).toString('base64url'),
    expires_at: Date.now() + maxDurationSeconds * 1000,
  };
  const claims: VoiceCallbackClaims = { ...binding, thread_id: threadId, external_id: externalId };
  const encoded = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const mac = crypto.createHmac('sha256', secret).update(CALLBACK_TOKEN_DOMAIN).update(encoded).digest('base64url');
  return { token: `${encoded}.${mac}`, binding };
}

/** A callback grant/revocation must affect exactly the intended primary row. */
export async function persistVoiceCallbackBinding(
  threadId: string,
  externalId: string,
  binding: VoiceCallbackBinding | null,
  conversationId?: string,
): Promise<void> {
  const patch = conversationId === undefined
    ? { voice_callback_binding: binding }
    : { voice_callback_binding: { ...binding, provider_conversation_id: conversationId }, tavus_conversation_id: conversationId };
  try {
    const result = await withDatabaseDeadline(Date.now() + 5000, () => queryWithTimeout(
      `UPDATE addie_threads
       SET context = COALESCE(context, '{}'::jsonb) || $3::jsonb
       WHERE thread_id = $1 AND channel = 'video' AND external_id = $2
         AND ($4::text IS NULL OR context->'voice_callback_binding'->>'nonce' = $4)
       RETURNING thread_id`,
      [threadId, externalId, JSON.stringify(patch), conversationId === undefined ? null : binding?.nonce],
      5000,
    ), { readOnly: false });
    if (result.rowCount !== 1) throw new Error('Voice callback binding update did not affect exactly one row');
  } catch (error) {
    logger.error({ code: 'voice_authorization_unavailable' }, 'Voice callback binding persistence unavailable');
    throw new VoiceAuthorizationUnavailableError({ cause: error });
  }
}

/** Canonical thread ownership is person-state, never proof of the credential. */
export function isVoiceSessionOwner(persistedContext: unknown, principal: AAOAdminPrincipal): boolean {
  const provenance = readVoiceAuthorization(persistedContext);
  return provenance !== null
    && provenance.authenticated_workos_user_id === getOrganizationAuthorizationUserId(principal);
}

/**
 * Do not treat a system-message thread id as authority: Tavus participants
 * can replace conversational context. Verify the server-issued capability,
 * then resolve its current binding on the primary database. Only database
 * values cross the branded boundary. A provider-supplied conversation id,
 * when present, is an additional consistency check, never the authority.
 */
export async function resolveVoiceCallback(
  token: unknown,
  presentedConversationId?: unknown,
): Promise<VoiceCallbackDecision> {
  const secret = process.env.TAVUS_LLM_SECRET;
  if (!secret) return { status: 'unavailable' };
  if (typeof token !== 'string' || token.length > 1024) return { status: 'invalid' };
  const parts = token.split('.');
  if (parts.length !== 2) return { status: 'invalid' };
  const [encoded, suppliedMac] = parts;
  const expectedMac = crypto.createHmac('sha256', secret).update(CALLBACK_TOKEN_DOMAIN).update(encoded).digest();
  const actualMac = Buffer.from(suppliedMac, 'base64url');
  if (actualMac.length !== expectedMac.length || !crypto.timingSafeEqual(actualMac, expectedMac)) {
    return { status: 'invalid' };
  }

  let claims: VoiceCallbackClaims;
  try {
    claims = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!claims || claims.version !== 1
      || typeof claims.thread_id !== 'string' || !/^[0-9a-f-]{36}$/.test(claims.thread_id)
      || typeof claims.external_id !== 'string' || !/^addie-[0-9a-f-]{36}$/.test(claims.external_id)
      || typeof claims.nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(claims.nonce)
      || !Number.isSafeInteger(claims.expires_at) || claims.expires_at <= Date.now()) {
      return { status: 'invalid' };
    }
  } catch {
    return { status: 'invalid' };
  }

  try {
    const result = await queryWithTimeout<Thread>(
      `SELECT * FROM addie_threads WHERE thread_id = $1 AND channel = 'video' AND external_id = $2`,
      [claims.thread_id, claims.external_id],
      5000,
    );
    const thread = result.rows[0];
    const binding = thread?.context?.voice_callback_binding as Partial<VoiceCallbackBinding> | undefined;
    const conversationId = thread?.context?.tavus_conversation_id;
    if (result.rows.length !== 1 || !thread || thread.channel !== 'video' || thread.user_type !== 'workos'
      || typeof thread.user_id !== 'string' || !thread.user_id || thread.thread_id !== claims.thread_id || thread.external_id !== claims.external_id
      || binding?.version !== 1 || binding.nonce !== claims.nonce || binding.expires_at !== claims.expires_at
      || typeof conversationId !== 'string' || conversationId.length === 0
      || binding.provider_conversation_id !== conversationId
      || (presentedConversationId !== undefined && presentedConversationId !== conversationId)
      || claims.expires_at <= Date.now()) {
      return { status: 'invalid' };
    }
    return { status: 'verified', thread: Object.freeze({ ...thread, user_id: thread.user_id, [verifiedCallback]: true as const }) };
  } catch {
    // Neither the bearer capability nor caller text belongs in logs.
    logger.error({ code: 'voice_authorization_unavailable' }, 'Voice callback binding lookup unavailable');
    return { status: 'unavailable' };
  }
}

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
