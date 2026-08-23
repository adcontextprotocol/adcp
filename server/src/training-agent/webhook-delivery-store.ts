/**
 * Durable publisher-side webhook delivery state for the training agent.
 *
 * The SDK deliberately separates the immutable delivery binding from the
 * recoverable outbox snapshot. PostgreSQL supplies the authoritative clock
 * and unique-key arbitration for the former; the latter is encrypted as one
 * value so callback credentials (and any credential-like payload fields)
 * never land in plaintext.
 */

import { createHmac } from 'node:crypto';
import type {
  WebhookDeliveryKey,
  WebhookDeliveryProposal,
  WebhookDeliveryRecord,
  WebhookDeliveryRecovery,
  WebhookDeliverySnapshot,
  WebhookDeliveryStore,
  WebhookEmitParams,
} from '@adcp/sdk/server';
import { query as databaseQuery } from '../db/client.js';
import { decrypt, deriveKey, encrypt } from '../db/encryption.js';

interface QueryResultLike<T> {
  rows: T[];
  rowCount?: number | null;
}

export type WebhookDeliveryQuery = <T>(
  text: string,
  params?: unknown[],
) => Promise<QueryResultLike<T>>;

const defaultWebhookDeliveryQuery: WebhookDeliveryQuery = async <T>(text: string, params?: unknown[]) => {
  const result = await databaseQuery(text, params as never[]);
  return result as unknown as QueryResultLike<T>;
};

interface BindingRow {
  status: 'bound' | 'retired';
  idempotency_key: string | null;
  payload_fingerprint: string | null;
  first_attempt_at_ms: string | number | null;
  retain_until_ms: string | number | null;
}

interface RecoverableRow {
  publisher_scope: string;
  tenant_scope: string;
  delivery_id: string;
  snapshot_encrypted: string;
  snapshot_iv: string;
  created_at_ms: string | number;
}

export interface RecoverableWebhookDelivery {
  key: WebhookDeliveryKey;
  params: WebhookEmitParams;
  createdAtMs: number;
}

// One drain can replay 25 deliveries sequentially, each with its original
// multi-attempt policy. Keep the cross-replica lease comfortably beyond that
// bounded work so a slow receiver cannot cause a second worker to overlap it.
const DEFAULT_LEASE_MS = 30 * 60_000;

function snapshotSalt(key: Readonly<WebhookDeliveryKey>): string {
  const namespace = JSON.stringify([key.publisherScope, key.tenantScope, key.deliveryId]);
  return `adcp-webhook-outbox:${createHmac('sha256', 'namespace-v1').update(namespace).digest('hex')}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Webhook recovery snapshots must contain only finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  throw new TypeError(`Webhook recovery snapshots cannot contain ${typeof value}`);
}

function serializeSnapshot(snapshot: Readonly<WebhookDeliverySnapshot>): string {
  return canonicalJson(snapshot);
}

function snapshotDigest(serialized: string, salt: string): string {
  // A keyed digest proves exact-snapshot equality without leaving an offline
  // guessing oracle for low-entropy bearer/HMAC credentials in the database.
  return createHmac('sha256', deriveKey(salt)).update(serialized, 'utf8').digest('hex');
}

function asBinding(row: BindingRow): WebhookDeliveryRecord {
  if (row.status === 'retired') return { status: 'retired' };
  if (
    typeof row.idempotency_key !== 'string'
    || typeof row.payload_fingerprint !== 'string'
    || row.first_attempt_at_ms === null
    || row.retain_until_ms === null
  ) {
    throw new Error('Durable webhook delivery binding is incomplete');
  }
  return {
    status: 'bound',
    idempotencyKey: row.idempotency_key,
    payloadFingerprint: row.payload_fingerprint,
    firstAttemptAtMs: Number(row.first_attempt_at_ms),
    retainUntilMs: Number(row.retain_until_ms),
  };
}

function assertSnapshot(value: unknown): WebhookDeliverySnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid durable webhook recovery snapshot');
  }
  const snapshot = value as Partial<WebhookDeliverySnapshot>;
  if (
    typeof snapshot.url !== 'string'
    || !snapshot.payload
    || typeof snapshot.payload !== 'object'
    || Array.isArray(snapshot.payload)
    || !snapshot.retries
    || typeof snapshot.retries !== 'object'
    || !('authentication' in snapshot)
  ) {
    throw new Error('Invalid durable webhook recovery snapshot');
  }
  return snapshot as WebhookDeliverySnapshot;
}

/** Shared atomic binding store plus encrypted recovery outbox. */
export class PostgresWebhookDeliveryPersistence implements WebhookDeliveryStore, WebhookDeliveryRecovery {
  readonly durability = 'durable' as const;

  constructor(private readonly runQuery: WebhookDeliveryQuery = defaultWebhookDeliveryQuery) {}

  async claim(
    key: Readonly<WebhookDeliveryKey>,
    proposed: Readonly<WebhookDeliveryProposal>,
    retentionMs: number,
  ): Promise<WebhookDeliveryRecord> {
    if (!Number.isInteger(retentionMs) || retentionMs <= 0) {
      throw new TypeError('Webhook delivery retentionMs must be a positive integer');
    }
    const identity = [key.publisherScope, key.tenantScope, key.deliveryId];
    const inserted = await this.runQuery<BindingRow>(`
      INSERT INTO adcp_webhook_delivery_bindings (
        publisher_scope, tenant_scope, delivery_id, status,
        idempotency_key, payload_fingerprint, first_attempt_at, retain_until
      ) VALUES ($1, $2, $3, 'bound', $4, $5, NOW(), NOW() + ($6 * INTERVAL '1 millisecond'))
      ON CONFLICT (publisher_scope, tenant_scope, delivery_id) DO NOTHING
      RETURNING status, idempotency_key, payload_fingerprint,
        EXTRACT(EPOCH FROM first_attempt_at) * 1000 AS first_attempt_at_ms,
        EXTRACT(EPOCH FROM retain_until) * 1000 AS retain_until_ms
    `, [...identity, proposed.idempotencyKey, proposed.payloadFingerprint, retentionMs]);
    if (inserted.rows[0]) return asBinding(inserted.rows[0]);

    // Expiry never deletes a claimed identity. The first claimant after the
    // retention boundary atomically turns it into its permanent tombstone.
    const retired = await this.runQuery<BindingRow>(`
      UPDATE adcp_webhook_delivery_bindings
      SET status = 'retired', idempotency_key = NULL, payload_fingerprint = NULL,
          first_attempt_at = NULL, retain_until = NULL
      WHERE publisher_scope = $1 AND tenant_scope = $2 AND delivery_id = $3
        AND status = 'bound' AND NOW() > retain_until
      RETURNING status, idempotency_key, payload_fingerprint,
        NULL::double precision AS first_attempt_at_ms,
        NULL::double precision AS retain_until_ms
    `, identity);
    if (retired.rows[0]) return asBinding(retired.rows[0]);

    const existing = await this.runQuery<BindingRow>(`
      SELECT status, idempotency_key, payload_fingerprint,
        EXTRACT(EPOCH FROM first_attempt_at) * 1000 AS first_attempt_at_ms,
        EXTRACT(EPOCH FROM retain_until) * 1000 AS retain_until_ms
      FROM adcp_webhook_delivery_bindings
      WHERE publisher_scope = $1 AND tenant_scope = $2 AND delivery_id = $3
    `, identity);
    if (!existing.rows[0]) throw new Error('Durable webhook delivery claim disappeared after conflict');
    return asBinding(existing.rows[0]);
  }

  async checkpoint(
    key: Readonly<WebhookDeliveryKey>,
    snapshot: Readonly<WebhookDeliverySnapshot>,
  ): Promise<void> {
    const salt = snapshotSalt(key);
    const serialized = serializeSnapshot(snapshot);
    const digest = snapshotDigest(serialized, salt);
    const sealed = encrypt(serialized, salt);
    const identity = [key.publisherScope, key.tenantScope, key.deliveryId];
    const inserted = await this.runQuery<{ snapshot_digest: string }>(`
      INSERT INTO adcp_webhook_delivery_outbox (
        publisher_scope, tenant_scope, delivery_id,
        snapshot_encrypted, snapshot_iv, snapshot_digest
      ) VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (publisher_scope, tenant_scope, delivery_id) DO NOTHING
      RETURNING snapshot_digest
    `, [...identity, sealed.encrypted, sealed.iv, digest]);
    if (inserted.rows[0]) return;

    const existing = await this.runQuery<{ snapshot_digest: string }>(`
      SELECT snapshot_digest
      FROM adcp_webhook_delivery_outbox
      WHERE publisher_scope = $1 AND tenant_scope = $2 AND delivery_id = $3
    `, identity);
    if (!existing.rows[0]) {
      // A concurrent successful delivery may settle between the insert and
      // read. Re-checkpointing is safe: the immutable binding still prevents
      // payload rebinding, and a receiver deduplicates the stable wire key.
      return this.checkpoint(key, snapshot);
    }
    if (existing.rows[0].snapshot_digest !== digest) {
      throw new Error(`Webhook delivery_id "${key.deliveryId}" was checkpointed with a different snapshot`);
    }
  }

  async settle(
    key: Readonly<WebhookDeliveryKey>,
    _disposition: 'delivered' | 'terminal',
  ): Promise<void> {
    await this.runQuery(`
      DELETE FROM adcp_webhook_delivery_outbox
      WHERE publisher_scope = $1 AND tenant_scope = $2 AND delivery_id = $3
    `, [key.publisherScope, key.tenantScope, key.deliveryId]);
  }

  /** Lease pending snapshots atomically across Fly replicas. */
  async claimRecoverable(
    publisherScope: string,
    limit = 25,
    leaseMs = DEFAULT_LEASE_MS,
  ): Promise<RecoverableWebhookDelivery[]> {
    const result = await this.runQuery<RecoverableRow>(`
      WITH candidates AS (
        SELECT publisher_scope, tenant_scope, delivery_id
        FROM adcp_webhook_delivery_outbox
        WHERE publisher_scope = $1
          AND next_attempt_at <= NOW()
          AND (lease_until IS NULL OR lease_until < NOW())
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT $2
      )
      UPDATE adcp_webhook_delivery_outbox AS outbox
      SET lease_until = NOW() + ($3 * INTERVAL '1 millisecond'), updated_at = NOW()
      FROM candidates
      WHERE outbox.publisher_scope = candidates.publisher_scope
        AND outbox.tenant_scope = candidates.tenant_scope
        AND outbox.delivery_id = candidates.delivery_id
      RETURNING outbox.publisher_scope, outbox.tenant_scope, outbox.delivery_id,
        outbox.snapshot_encrypted, outbox.snapshot_iv,
        EXTRACT(EPOCH FROM outbox.created_at) * 1000 AS created_at_ms
    `, [publisherScope, limit, leaseMs]);

    return result.rows.map(row => {
      const key: WebhookDeliveryKey = {
        publisherScope: row.publisher_scope,
        tenantScope: row.tenant_scope,
        deliveryId: row.delivery_id,
      };
      const serialized = decrypt(row.snapshot_encrypted, row.snapshot_iv, snapshotSalt(key));
      const snapshot = assertSnapshot(JSON.parse(serialized));
      return {
        key,
        params: {
          url: snapshot.url,
          payload: snapshot.payload,
          delivery_id: key.deliveryId,
          authentication: snapshot.authentication,
          retries: snapshot.retries,
        },
        createdAtMs: Number(row.created_at_ms),
      };
    });
  }

  async releaseRecoverable(
    key: Readonly<WebhookDeliveryKey>,
    retryDelayMs: number,
  ): Promise<void> {
    await this.runQuery(`
      UPDATE adcp_webhook_delivery_outbox
      SET lease_until = NULL,
          next_attempt_at = NOW() + ($4 * INTERVAL '1 millisecond'),
          attempt_count = attempt_count + 1,
          updated_at = NOW()
      WHERE publisher_scope = $1 AND tenant_scope = $2 AND delivery_id = $3
    `, [key.publisherScope, key.tenantScope, key.deliveryId, retryDelayMs]);
  }
}
