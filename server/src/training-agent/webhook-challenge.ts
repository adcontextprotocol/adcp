/**
 * Account-level webhook endpoint proof of control.
 *
 * A challenge is sent to the exact normalized candidate URL and signed with
 * the training agent's RFC 9421 webhook key. The signed body binds the
 * account, subscriber, URL, expiry, delivery authentication, and normalized
 * event set. The receiver proves control by echoing the single-use challenge
 * value before it expires.
 */

import { createHash, randomBytes } from 'node:crypto';
import { canonicalTargetUri, signWebhook, signWebhookAsync } from '@adcp/sdk/signing';
import { createLogger } from '../logger.js';
import { getAgentUrl } from './config.js';
import { createTrainingWebhookFetch } from './webhook-fetch.js';
import { getWebhookSigningMaterial } from './webhooks.js';

const logger = createLogger('training-agent-webhook-challenge');

export const ACCOUNT_WEBHOOK_CHALLENGE_TTL_MS = 60_000;
const MAX_CHALLENGE_RESPONSE_BYTES = 16 * 1024;
const CHALLENGE_TIMEOUT_MS = 10_000;

export interface AccountWebhookChallengeConfig {
  accountId: string;
  subscriberId: string;
  url: string;
  eventTypes: string[];
  authentication?: {
    schemes: string[];
    credentials?: string;
  };
}

interface ChallengeOptions {
  fetch?: typeof fetch;
  now?: () => number;
  challenge?: string;
  timeoutMs?: number;
}

export interface AccountWebhookChallengePayload {
  type: 'webhook.challenge';
  challenge: string;
  account_id: string;
  subscriber_id: string;
  seller_agent_url: string;
  delivery_auth: {
    mode: 'rfc9421' | 'Bearer' | 'HMAC-SHA256';
    credential_fingerprint?: string;
  };
  event_types: string[];
}

export interface AgentWebhookChallengeConfig {
  subscriberId: string;
  url: string;
  eventTypes: string[];
  authentication?: AccountWebhookChallengeConfig['authentication'];
}

export interface AgentWebhookChallengePayload {
  type: 'webhook.challenge';
  scope: 'agent';
  challenge: string;
  subscriber_id: string;
  seller_agent_url: string;
  delivery_auth: AccountWebhookChallengePayload['delivery_auth'];
  event_types: string[];
}

export type AccountWebhookChallengeResult =
  | { ok: true; normalizedUrl: string }
  | { ok: false };

export function normalizeAccountWebhookUrl(value: string): string {
  return canonicalTargetUri(value);
}

function deliveryAuth(
  authentication: AccountWebhookChallengeConfig['authentication'],
): AccountWebhookChallengePayload['delivery_auth'] {
  const scheme = authentication?.schemes[0];
  if (scheme === 'Bearer' || scheme === 'HMAC-SHA256') {
    return {
      mode: scheme,
      credential_fingerprint: createHash('sha256')
        .update(authentication?.credentials ?? '', 'utf8')
        .digest('hex'),
    };
  }
  return { mode: 'rfc9421' };
}

function responseEcho(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1) return undefined;
  if (keys[0] === 'challenge' && typeof record.challenge === 'string') return record.challenge;
  if (keys[0] === 'token' && typeof record.token === 'string') return record.token;
  return undefined;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_CHALLENGE_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('challenge response too large');
  }

  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let completed = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        break;
      }
      size += value.byteLength;
      if (size > MAX_CHALLENGE_RESPONSE_BYTES) {
        throw new Error('challenge response too large');
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

export async function proveAccountWebhookControl(
  config: AccountWebhookChallengeConfig,
  options: ChallengeOptions = {},
): Promise<AccountWebhookChallengeResult> {
  const now = options.now ?? Date.now;
  const issuedAt = now();
  const issuedAtSeconds = Math.floor(issuedAt / 1000);
  const normalizedUrl = normalizeAccountWebhookUrl(config.url);
  const challenge = options.challenge ?? randomBytes(32).toString('base64url');
  const expiresAtMs = (issuedAtSeconds * 1000) + ACCOUNT_WEBHOOK_CHALLENGE_TTL_MS;
  const payload: AccountWebhookChallengePayload = {
    type: 'webhook.challenge',
    challenge,
    account_id: config.accountId,
    subscriber_id: config.subscriberId,
    seller_agent_url: getAgentUrl(),
    delivery_auth: deliveryAuth(config.authentication),
    event_types: [...new Set(config.eventTypes)].sort(),
  };
  const body = JSON.stringify(payload);
  const unsignedRequest = {
    method: 'POST',
    url: normalizedUrl,
    headers: { 'content-type': 'application/json' },
    body,
  };
  const signingOptions = {
    now: () => issuedAtSeconds,
    windowSeconds: ACCOUNT_WEBHOOK_CHALLENGE_TTL_MS / 1000,
  };

  let signedHeaders: Record<string, string>;
  try {
    const material = getWebhookSigningMaterial();
    const signed = 'signerProvider' in material
      ? await signWebhookAsync(unsignedRequest, material.signerProvider, signingOptions)
      : signWebhook(unsignedRequest, material.signerKey, signingOptions);
    signedHeaders = signed.headers;
  } catch (error) {
    // Keep key-provider details out of the protocol response while retaining
    // an operator-visible signal for KMS/key configuration failures.
    logger.error({ err: error }, 'Account webhook challenge signing failed');
    return { ok: false };
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const controller = new AbortController();
    const timeoutMs = Math.min(
      CHALLENGE_TIMEOUT_MS,
      Math.max(1, options.timeoutMs ?? CHALLENGE_TIMEOUT_MS),
    );
    timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref?.();
    const response = await (options.fetch ?? createTrainingWebhookFetch())(normalizedUrl, {
      method: 'POST',
      headers: signedHeaders,
      body,
      redirect: 'manual',
      signal: controller.signal,
    });
    if (response.status < 200 || response.status >= 300 || now() >= expiresAtMs) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false };
    }
    const echoed = responseEcho(await readBoundedJson(response));
    if (echoed !== challenge || now() >= expiresAtMs) return { ok: false };
    return { ok: true, normalizedUrl };
  } catch {
    // Do not expose DNS, transport, or receiver parsing details to the caller.
    // They are useful network-probing side channels.
    return { ok: false };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/** Prove control of an agent-level subscriber before activating it. Agent
 * subscriptions intentionally omit account_id because they may be registered
 * before the caller has any seller account. */
export async function proveAgentWebhookControl(
  config: AgentWebhookChallengeConfig,
  options: ChallengeOptions = {},
): Promise<AccountWebhookChallengeResult> {
  const now = options.now ?? Date.now;
  const issuedAt = now();
  const issuedAtSeconds = Math.floor(issuedAt / 1000);
  const normalizedUrl = canonicalTargetUri(config.url);
  const challenge = options.challenge ?? randomBytes(32).toString('base64url');
  const expiresAtMs = (issuedAtSeconds * 1000) + ACCOUNT_WEBHOOK_CHALLENGE_TTL_MS;
  const payload: AgentWebhookChallengePayload = {
    type: 'webhook.challenge',
    scope: 'agent',
    challenge,
    subscriber_id: config.subscriberId,
    seller_agent_url: getAgentUrl(),
    delivery_auth: deliveryAuth(config.authentication),
    event_types: [...new Set(config.eventTypes)].sort(),
  };
  const body = JSON.stringify(payload);
  const unsignedRequest = {
    method: 'POST',
    url: normalizedUrl,
    headers: { 'content-type': 'application/json' },
    body,
  };

  let signedHeaders: Record<string, string>;
  try {
    const material = getWebhookSigningMaterial();
    const signingOptions = {
      now: () => issuedAtSeconds,
      windowSeconds: ACCOUNT_WEBHOOK_CHALLENGE_TTL_MS / 1000,
    };
    const signed = 'signerProvider' in material
      ? await signWebhookAsync(unsignedRequest, material.signerProvider, signingOptions)
      : signWebhook(unsignedRequest, material.signerKey, signingOptions);
    signedHeaders = signed.headers;
  } catch (error) {
    logger.error({ err: error }, 'Agent webhook challenge signing failed');
    return { ok: false };
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const controller = new AbortController();
    const timeoutMs = Math.min(CHALLENGE_TIMEOUT_MS, Math.max(1, options.timeoutMs ?? CHALLENGE_TIMEOUT_MS));
    timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref?.();
    const response = await (options.fetch ?? createTrainingWebhookFetch())(normalizedUrl, {
      method: 'POST',
      headers: signedHeaders,
      body,
      redirect: 'manual',
      signal: controller.signal,
    });
    if (response.status < 200 || response.status >= 300 || now() >= expiresAtMs) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false };
    }
    const echoed = responseEcho(await readBoundedJson(response));
    return echoed === challenge && now() < expiresAtMs
      ? { ok: true, normalizedUrl }
      : { ok: false };
  } catch {
    return { ok: false };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function accountWebhookProofTuple(
  accountId: string,
  config: AccountWebhookChallengeConfig,
): string {
  const auth = deliveryAuth(config.authentication);
  return JSON.stringify({
    account_id: accountId,
    subscriber_id: config.subscriberId,
    webhook_url: normalizeAccountWebhookUrl(config.url),
    delivery_auth: auth,
    event_types: [...new Set(config.eventTypes)].sort(),
  });
}

export function agentWebhookProofTuple(config: AgentWebhookChallengeConfig): string {
  return JSON.stringify({
    scope: 'agent',
    subscriber_id: config.subscriberId,
    webhook_url: canonicalTargetUri(config.url),
    delivery_auth: deliveryAuth(config.authentication),
    event_types: [...new Set(config.eventTypes)].sort(),
  });
}
