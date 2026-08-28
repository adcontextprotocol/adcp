import crypto from 'node:crypto';
import { query } from './client.js';

export const ACCOUNT_LINK_CORRELATION_TTL_MS = 10 * 60 * 1000;

export type AccountLinkSurface = 'slack' | 'web';

export interface AccountLinkOriginInput {
  surface: AccountLinkSurface;
  threadId: string;
  initiatingUserId: string;
}

export interface AccountLinkCorrelation {
  correlationId: string;
  surface: AccountLinkSurface;
  threadId: string;
  initiatingUserId: string;
  externalId: string;
}

export type ProactiveDeliveryStatus = 'delivered' | 'skipped' | 'failed';

export interface ProactiveEventInput {
  eventType: 'account_linked';
  surface: AccountLinkSurface;
  deliveryStatus: ProactiveDeliveryStatus;
  reasonCode: string;
  correlationId?: string;
  threadId?: string;
  initiatingUserId?: string;
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

export function isAccountLinkCorrelationToken(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
}

/**
 * Create a bearer correlation only when the supplied thread still belongs to
 * the initiating principal on the claimed surface. The raw token is returned
 * once and is never stored.
 */
export async function createAccountLinkCorrelation(
  input: AccountLinkOriginInput,
): Promise<string | undefined> {
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + ACCOUNT_LINK_CORRELATION_TTL_MS);

  const result = await query<{ correlation_id: string }>(
    `INSERT INTO addie_account_link_correlations (
       token_hash, surface, thread_id, initiating_user_id, external_id, expires_at
     )
     SELECT $1, $2, t.thread_id, $4, t.external_id, $5
     FROM addie_threads t
     WHERE t.thread_id = $3
       AND t.channel = $2
       AND t.user_id = $4
       AND (($2 = 'slack' AND t.user_type = 'slack')
         OR ($2 = 'web' AND t.user_type IN ('workos', 'anonymous')))
     RETURNING correlation_id`,
    [tokenHash, input.surface, input.threadId, input.initiatingUserId, expiresAt],
  );

  return result.rows[0] ? token : undefined;
}

/**
 * Atomically consume and validate a correlation. The joined thread predicates
 * prevent delivery if ownership or channel identity changed after initiation.
 */
export async function consumeAccountLinkCorrelation(
  token: string,
  expected: Pick<AccountLinkOriginInput, 'surface' | 'initiatingUserId'>,
): Promise<AccountLinkCorrelation | undefined> {
  const result = await query<{
    correlation_id: string;
    surface: AccountLinkSurface;
    thread_id: string;
    initiating_user_id: string;
    external_id: string;
  }>(
    `UPDATE addie_account_link_correlations c
     SET consumed_at = NOW()
     FROM addie_threads t
     WHERE c.token_hash = $1
       AND c.surface = $2
       AND c.initiating_user_id = $3
       AND c.expires_at > NOW()
       AND c.consumed_at IS NULL
       AND t.thread_id = c.thread_id
       AND t.channel = c.surface
       AND t.user_id = c.initiating_user_id
       AND t.external_id = c.external_id
       AND ((c.surface = 'slack' AND t.user_type = 'slack')
         OR (c.surface = 'web' AND t.user_type IN ('workos', 'anonymous')))
     RETURNING c.correlation_id, c.surface, c.thread_id,
       c.initiating_user_id, c.external_id`,
    [hashToken(token), expected.surface, expected.initiatingUserId],
  );

  const row = result.rows[0];
  if (!row) return undefined;
  return {
    correlationId: row.correlation_id,
    surface: row.surface,
    threadId: row.thread_id,
    initiatingUserId: row.initiating_user_id,
    externalId: row.external_id,
  };
}

export async function recordProactiveEvent(input: ProactiveEventInput): Promise<void> {
  await query(
    `INSERT INTO addie_proactive_events (
       event_type, correlation_id, surface, thread_id, initiating_user_id,
       delivery_status, reason_code
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.eventType,
      input.correlationId ?? null,
      input.surface,
      input.threadId ?? null,
      input.initiatingUserId ?? null,
      input.deliveryStatus,
      input.reasonCode,
    ],
  );
}

/** Retain correlation rows briefly for audit/replay diagnosis, then remove them. */
export async function cleanupAccountLinkCorrelations(retentionHours = 24): Promise<number> {
  const result = await query(
    `DELETE FROM addie_account_link_correlations
     WHERE expires_at <= NOW() - make_interval(hours => $1)`,
    [retentionHours],
  );
  return result.rowCount ?? 0;
}
