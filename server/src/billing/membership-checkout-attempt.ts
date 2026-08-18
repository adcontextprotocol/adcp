import { randomUUID } from 'node:crypto';
import { query } from '../db/client.js';
import type { CheckoutSessionData } from './stripe-client.js';

const CHECKOUT_ATTEMPT_TTL_MS = 24 * 60 * 60 * 1000;

interface CheckoutAttemptRow {
  organization_id: string;
  payload_fingerprint: string;
  idempotency_key: string;
  initiated_by_user_id: string;
  stripe_session_id: string | null;
  stripe_session_url: string | null;
  expires_at: Date;
}

export type MembershipCheckoutClaim =
  | { kind: 'create'; idempotencyKey: string }
  | { kind: 'replay'; sessionId: string; url: string }
  | { kind: 'conflict' };

/** Build a deterministic equality fingerprint for one immutable checkout payload. */
export function fingerprintMembershipCheckoutPayload(data: CheckoutSessionData): string {
  const immutablePayload = {
    priceId: data.priceId,
    customerId: data.customerId ?? null,
    customerEmail: data.customerEmail ?? null,
    successUrl: data.successUrl,
    cancelUrl: data.cancelUrl,
    workosOrganizationId: data.workosOrganizationId ?? null,
    workosUserId: data.workosUserId ?? null,
    isPersonalWorkspace: data.isPersonalWorkspace ?? null,
    couponId: data.couponId ?? null,
    promotionCode: data.promotionCode ?? null,
  };
  // This is deliberately serialized rather than cryptographically hashed. It
  // is non-secret equality data, and retaining the fixed-shape serialization
  // avoids both hash collisions and any implication of password protection.
  return JSON.stringify(immutablePayload);
}

/**
 * Claim or resume the one pending membership checkout for an organization.
 * Call this while holding the per-org intake lock.
 */
export async function claimMembershipCheckoutAttempt(input: {
  organizationId: string;
  userId: string;
  payloadFingerprint: string;
}): Promise<MembershipCheckoutClaim> {
  const existing = await query<CheckoutAttemptRow>(
    `SELECT * FROM membership_checkout_attempts
     WHERE organization_id = $1 AND expires_at > NOW()`,
    [input.organizationId],
  );
  const attempt = existing.rows[0];

  if (attempt) {
    if (attempt.payload_fingerprint !== input.payloadFingerprint) return { kind: 'conflict' };
    if (attempt.stripe_session_id && attempt.stripe_session_url) {
      return {
        kind: 'replay',
        sessionId: attempt.stripe_session_id,
        url: attempt.stripe_session_url,
      };
    }
    return { kind: 'create', idempotencyKey: attempt.idempotency_key };
  }

  const idempotencyKey = `aao:membership-checkout:${randomUUID()}`;
  const expiresAt = new Date(Date.now() + CHECKOUT_ATTEMPT_TTL_MS);
  await query(
    `INSERT INTO membership_checkout_attempts (
       organization_id, payload_fingerprint, idempotency_key,
       initiated_by_user_id, expires_at
     ) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (organization_id) DO UPDATE SET
       payload_fingerprint = EXCLUDED.payload_fingerprint,
       idempotency_key = EXCLUDED.idempotency_key,
       initiated_by_user_id = EXCLUDED.initiated_by_user_id,
       stripe_session_id = NULL,
       stripe_session_url = NULL,
       expires_at = EXCLUDED.expires_at,
       updated_at = NOW()
     WHERE membership_checkout_attempts.expires_at <= NOW()`,
    [input.organizationId, input.payloadFingerprint, idempotencyKey, input.userId, expiresAt],
  );
  return { kind: 'create', idempotencyKey };
}

export async function completeMembershipCheckoutAttempt(input: {
  organizationId: string;
  idempotencyKey: string;
  sessionId: string;
  url: string;
}): Promise<boolean> {
  const result = await query(
    `UPDATE membership_checkout_attempts
     SET stripe_session_id = $3, stripe_session_url = $4, updated_at = NOW()
     WHERE organization_id = $1 AND idempotency_key = $2
       AND stripe_session_id IS NULL
     RETURNING organization_id`,
    [input.organizationId, input.idempotencyKey, input.sessionId, input.url],
  );
  return result.rows.length > 0;
}

export async function clearMembershipCheckoutAttempt(
  organizationId: string,
  idempotencyKey: string,
): Promise<void> {
  await query(
    `DELETE FROM membership_checkout_attempts
     WHERE organization_id = $1 AND idempotency_key = $2`,
    [organizationId, idempotencyKey],
  );
}

/** Clear only failures that prove Stripe did not create a Checkout session. */
export function isDefinitiveCheckoutFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const type = 'type' in error ? String(error.type) : '';
  return type === 'StripeInvalidRequestError'
    || type === 'StripeAuthenticationError'
    || type === 'StripePermissionError';
}

/** Call inside the per-org lock before another billing intake creates a sub. */
export async function hasPendingMembershipCheckoutAttempt(organizationId: string): Promise<boolean> {
  const result = await query(
    `SELECT 1 FROM membership_checkout_attempts
     WHERE organization_id = $1 AND expires_at > NOW()
     LIMIT 1`,
    [organizationId],
  );
  return result.rows.length > 0;
}
