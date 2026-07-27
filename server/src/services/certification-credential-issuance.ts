import type { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { getDedicatedClient } from '../db/client.js';
import { createLogger } from '../logger.js';
import { resolveUserNameWithFallbacks } from '../utils/resolve-user-name.js';
import {
  buildRecipientName,
  createCredentialDraft,
  getCredential,
  getCredentialBadgeUrl,
  isCertifierConfigured,
  isDefinitiveCertifierNonDelivery,
  issueCredentialDraft,
  sendCredential,
  type CertifierCredential,
} from './certifier-client.js';

const logger = createLogger('certification-credential-issuance');

export const NAME_REQUIRED_MARKER = 'NAME_REQUIRED';

export class CredentialNotEarnedError extends Error {}
export class CredentialNameRequiredError extends Error {}
export class CertifierNotConfiguredError extends Error {}
export class CredentialRecoveryConflictError extends Error {}

interface AwardedCredentialRow {
  first_name: string | null;
  last_name: string | null;
  email: string;
  tier: number;
  certifier_group_id: string | null;
  certifier_credential_id: string | null;
  certifier_public_id: string | null;
  certifier_badge_url: string | null;
  certifier_issuance_key: string | null;
  certifier_issuance_state: 'not_started' | 'creating' | 'draft_created' | 'issuing' | 'issued' | 'complete' | 'reconcile_required';
  certifier_delivery_state: 'not_started' | 'sending' | 'sent' | 'unknown';
}

export interface EnsureCertifierCredentialResult {
  outcome: 'issued' | 'metadata_refreshed' | 'badge_refreshed' | 'already_complete' | 'badge_pending';
  credentialId: string;
  publicId: string | null;
  badgeUrl: string | null;
  emailDelivery: 'sent' | 'not_attempted' | 'unknown';
}

export function credentialExpiryDate(tier: number, now: Date = new Date()): string | undefined {
  if (tier === 1) return undefined;
  const expiry = new Date(now);
  expiry.setUTCFullYear(expiry.getUTCFullYear() + 2);
  return expiry.toISOString().slice(0, 10);
}

async function loadAwardedCredential(
  client: Client,
  userId: string,
  credentialId: string,
): Promise<AwardedCredentialRow | null> {
  const result = await client.query<AwardedCredentialRow>(
    `SELECT u.first_name, u.last_name, u.email,
            cc.tier, cc.certifier_group_id,
            uc.certifier_credential_id, uc.certifier_public_id, uc.certifier_badge_url,
            uc.certifier_issuance_key, uc.certifier_issuance_state, uc.certifier_delivery_state
       FROM user_credentials uc
       JOIN users u ON u.workos_user_id = uc.workos_user_id
       JOIN certification_credentials cc ON cc.id = uc.credential_id
      WHERE uc.workos_user_id = $1 AND uc.credential_id = $2`,
    [userId, credentialId],
  );
  return result.rows[0] ?? null;
}

async function persistDraftId(
  client: Client,
  userId: string,
  credentialId: string,
  issuanceKey: string,
  credential: CertifierCredential,
): Promise<void> {
  const result = await client.query(
    `UPDATE user_credentials
        SET certifier_credential_id = $3,
            certifier_public_id = COALESCE($4, certifier_public_id),
            certifier_issuance_state = 'draft_created'
      WHERE workos_user_id = $1
        AND credential_id = $2
        AND certifier_credential_id IS NULL
        AND certifier_issuance_key = $5
        AND certifier_issuance_state = 'creating'
      RETURNING id`,
    [userId, credentialId, credential.id, credential.publicId || null, issuanceKey],
  );
  if (result.rowCount !== 1) {
    throw new CredentialRecoveryConflictError(
      'Credential award changed while the external draft was being created; reconcile in Certifier before retrying',
    );
  }
}

async function setIssuanceState(
  client: Client,
  userId: string,
  credentialId: string,
  externalCredentialId: string,
  state: AwardedCredentialRow['certifier_issuance_state'],
): Promise<void> {
  const result = await client.query(
    `UPDATE user_credentials
        SET certifier_issuance_state = $4
      WHERE workos_user_id = $1 AND credential_id = $2 AND certifier_credential_id = $3
      RETURNING id`,
    [userId, credentialId, externalCredentialId, state],
  );
  if (result.rowCount !== 1) {
    throw new CredentialRecoveryConflictError('Credential award changed during issuance');
  }
}

async function setDeliveryState(
  client: Client,
  userId: string,
  credentialId: string,
  externalCredentialId: string,
  state: AwardedCredentialRow['certifier_delivery_state'],
): Promise<void> {
  const result = await client.query(
    `UPDATE user_credentials
        SET certifier_delivery_state = $4
      WHERE workos_user_id = $1 AND credential_id = $2 AND certifier_credential_id = $3
      RETURNING id`,
    [userId, credentialId, externalCredentialId, state],
  );
  if (result.rowCount !== 1) {
    throw new CredentialRecoveryConflictError('Credential award changed during delivery');
  }
}

async function persistProviderState(
  client: Client,
  userId: string,
  credentialId: string,
  externalCredentialId: string,
  publicId: string | null,
  badgeUrl: string | null,
): Promise<void> {
  const result = await client.query(
    `UPDATE user_credentials
        SET certifier_public_id = COALESCE($4, certifier_public_id),
            certifier_badge_url = COALESCE($5, certifier_badge_url)
      WHERE workos_user_id = $1
        AND credential_id = $2
        AND certifier_credential_id = $3
      RETURNING id`,
    [userId, credentialId, externalCredentialId, publicId, badgeUrl],
  );
  if (result.rowCount !== 1) {
    throw new CredentialRecoveryConflictError(
      'Credential award changed during external recovery; the local mapping was not overwritten',
    );
  }
}

/**
 * Ensure an earned credential has one issued Certifier credential and a badge.
 *
 * All issuance entry points use this helper. A session-level advisory lock
 * serializes the learner/credential pair across app processes. New credentials
 * are created as drafts and their IDs are conditionally persisted before they
 * are issued or emailed, eliminating the duplicate-active-credential window in
 * the former create/issue/send all-in-one flow.
 */
export async function ensureCertifierCredential(input: {
  userId: string;
  credentialId: string;
  now?: Date;
}): Promise<EnsureCertifierCredentialResult> {
  if (!isCertifierConfigured()) {
    throw new CertifierNotConfiguredError('Certifier not configured');
  }

  // A dedicated connection keeps the session-scoped advisory lock from
  // consuming one of the application's pooled request connections while
  // Certifier calls are in flight.
  const client = await getDedicatedClient();
  const lockKey = `certifier:${input.userId}:${input.credentialId}`;
  let lockHeld = false;

  try {
    const lock = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked',
      [lockKey],
    );
    if (lock.rows[0]?.locked !== true) {
      throw new CredentialRecoveryConflictError('Credential recovery is already in progress');
    }
    lockHeld = true;

    const awarded = await loadAwardedCredential(client, input.userId, input.credentialId);
    if (!awarded) {
      throw new CredentialNotEarnedError('Learner has not earned this credential');
    }
    if (!awarded.certifier_group_id) {
      throw new CredentialRecoveryConflictError('Credential is not configured for Certifier issuance');
    }

    const wasComplete = Boolean(
      awarded.certifier_credential_id && awarded.certifier_public_id && awarded.certifier_badge_url,
    );
    const hadBadge = Boolean(awarded.certifier_badge_url);
    const hadPublicId = Boolean(awarded.certifier_public_id);
    let external: CertifierCredential;
    let issuedInThisCall = false;
    const deliveryState = awarded.certifier_delivery_state;
    let emailDelivery: EnsureCertifierCredentialResult['emailDelivery'] = deliveryState === 'sent'
      ? 'sent'
      : deliveryState === 'unknown' || deliveryState === 'sending'
        ? 'unknown'
        : 'not_attempted';

    if (!awarded.certifier_credential_id) {
      const resolved = await resolveUserNameWithFallbacks(
        client,
        input.userId,
        awarded.first_name,
        awarded.last_name,
      );
      if (!(resolved.firstName ?? '').trim()) {
        throw new CredentialNameRequiredError('Learner name is required before issuance');
      }
      if (awarded.certifier_issuance_state !== 'not_started') {
        throw new CredentialRecoveryConflictError(
          'A prior Certifier creation attempt requires manual reconciliation before retrying',
        );
      }
      const issuanceKey = awarded.certifier_issuance_key || randomUUID();
      const claim = await client.query(
        `UPDATE user_credentials
            SET certifier_issuance_key = $3,
                certifier_issuance_state = 'creating'
          WHERE workos_user_id = $1
            AND credential_id = $2
            AND certifier_credential_id IS NULL
            AND certifier_issuance_state = 'not_started'
          RETURNING id`,
        [input.userId, input.credentialId, issuanceKey],
      );
      if (claim.rowCount !== 1) {
        throw new CredentialRecoveryConflictError('Credential issuance was claimed by another recovery');
      }

      const expiryDate = credentialExpiryDate(awarded.tier, input.now);
      try {
        external = await createCredentialDraft({
          groupId: awarded.certifier_group_id,
          recipient: {
            name: buildRecipientName({
              first_name: resolved.firstName,
              last_name: resolved.lastName,
              email: awarded.email,
            }),
            email: awarded.email,
          },
          ...(expiryDate && { expiryDate }),
        });
      } catch (error) {
        await client.query(
          `UPDATE user_credentials
              SET certifier_issuance_state = 'reconcile_required'
            WHERE workos_user_id = $1 AND credential_id = $2
              AND certifier_issuance_key = $3 AND certifier_issuance_state = 'creating'`,
          [input.userId, input.credentialId, issuanceKey],
        );
        throw error;
      }
      await persistDraftId(client, input.userId, input.credentialId, issuanceKey, external);
    } else {
      external = await getCredential(awarded.certifier_credential_id);
      if (external.groupId !== awarded.certifier_group_id) {
        throw new CredentialRecoveryConflictError(
          'Stored Certifier credential belongs to a different credential group',
        );
      }
      if (external.recipient?.email?.trim().toLowerCase() !== awarded.email.trim().toLowerCase()) {
        throw new CredentialRecoveryConflictError(
          'Stored Certifier credential belongs to a different recipient',
        );
      }
    }

    if (external.status === 'draft') {
      await setIssuanceState(client, input.userId, input.credentialId, external.id, 'issuing');
      external = await issueCredentialDraft(external.id);
      await setIssuanceState(client, input.userId, input.credentialId, external.id, 'issued');
      issuedInThisCall = true;
    } else if (external.status === 'issued') {
      await setIssuanceState(client, input.userId, input.credentialId, external.id, 'issued');
    } else {
      throw new CredentialRecoveryConflictError(
        `Certifier credential has unsupported recovery status: ${external.status}`,
      );
    }

    if (deliveryState === 'not_started') {
      await setDeliveryState(client, input.userId, input.credentialId, external.id, 'sending');
      try {
        external = await sendCredential(external.id);
        await setDeliveryState(client, input.userId, input.credentialId, external.id, 'sent');
        emailDelivery = 'sent';
      } catch (error) {
        const definitiveNonDelivery = isDefinitiveCertifierNonDelivery(error);
        await setDeliveryState(
          client,
          input.userId,
          input.credentialId,
          external.id,
          definitiveNonDelivery ? 'not_started' : 'unknown',
        );
        emailDelivery = definitiveNonDelivery ? 'not_attempted' : 'unknown';
        const context = {
          error,
          userId: input.userId,
          credentialId: input.credentialId,
          externalCredentialId: external.id,
        };
        if (definitiveNonDelivery) {
          logger.warn(context, 'Credential issued but email was not dispatched; retry remains available');
        } else {
          logger.error(context, 'Credential issued but email delivery outcome is unknown; automatic resend suppressed');
        }
      }
    } else if (deliveryState === 'sending') {
      await setDeliveryState(client, input.userId, input.credentialId, external.id, 'unknown');
      emailDelivery = 'unknown';
    }

    let badgeUrl = awarded.certifier_badge_url;
    if (!badgeUrl) {
      try {
        badgeUrl = await getCredentialBadgeUrl(external.id);
      } catch (error) {
        logger.warn(
          { error, userId: input.userId, credentialId: input.credentialId, externalCredentialId: external.id },
          'Credential issued but badge lookup failed',
        );
      }
    }

    const publicId = external.publicId || awarded.certifier_public_id;
    await persistProviderState(
      client,
      input.userId,
      input.credentialId,
      external.id,
      publicId || null,
      badgeUrl || null,
    );
    await setIssuanceState(
      client,
      input.userId,
      input.credentialId,
      external.id,
      badgeUrl ? 'complete' : 'issued',
    );

    const outcome: EnsureCertifierCredentialResult['outcome'] = issuedInThisCall
      ? 'issued'
      : wasComplete
        ? 'already_complete'
        : !hadPublicId && publicId
          ? 'metadata_refreshed'
          : !hadBadge && badgeUrl
            ? 'badge_refreshed'
            : 'badge_pending';

    return {
      outcome,
      credentialId: external.id,
      publicId: publicId || null,
      badgeUrl: badgeUrl || null,
      emailDelivery,
    };
  } finally {
    if (lockHeld) {
      try {
        const unlock = await client.query<{ unlocked: boolean }>(
          'SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked',
          [lockKey],
        );
        if (unlock.rows[0]?.unlocked !== true) {
          logger.error({ lockKey }, 'Credential issuance advisory unlock returned false; closing dedicated client');
        }
      } catch (error) {
        logger.error({ error, lockKey }, 'Failed to release credential issuance advisory lock');
      }
    }
    await client.end().catch((error) => {
      logger.error({ error, lockKey }, 'Failed to close credential issuance database connection');
    });
  }
}
