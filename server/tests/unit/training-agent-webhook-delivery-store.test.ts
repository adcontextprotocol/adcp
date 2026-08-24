import { describe, expect, it, vi } from 'vitest';
import type { WebhookDeliveryKey, WebhookDeliverySnapshot } from '@adcp/sdk/server';
import {
  PostgresWebhookDeliveryPersistence,
  type WebhookDeliveryQuery,
} from '../../src/training-agent/webhook-delivery-store.js';

const KEY: WebhookDeliveryKey = {
  publisherScope: 'adcp-training-agent',
  tenantScope: 'tenant-abc',
  deliveryId: 'delivery-00000001',
};

const SNAPSHOT: WebhookDeliverySnapshot = {
  url: 'https://buyer.example/webhook',
  payload: { operation_id: 'op-1', status: 'completed' },
  authentication: { type: 'bearer', token: 'super-secret-token' },
  retries: { maxAttempts: 5, initialDelayMs: 1_000, maxDelayMs: 60_000, jitter: 0.25 },
};

function queryMock(): ReturnType<typeof vi.fn<WebhookDeliveryQuery>> {
  return vi.fn<WebhookDeliveryQuery>();
}

describe('PostgresWebhookDeliveryPersistence', () => {
  it('uses a unique insert and the database clock for the first immutable binding', async () => {
    const runQuery = queryMock();
    runQuery.mockResolvedValueOnce({
      rows: [{
        status: 'bound',
        idempotency_key: 'wire-key-00000001',
        payload_fingerprint: 'a'.repeat(64),
        first_attempt_at_ms: '1787500000000',
        retain_until_ms: '1787586400000',
      }],
    });
    const store = new PostgresWebhookDeliveryPersistence(runQuery);

    await expect(store.claim(KEY, {
      idempotencyKey: 'wire-key-00000001',
      payloadFingerprint: 'a'.repeat(64),
    }, 86_400_000)).resolves.toEqual({
      status: 'bound',
      idempotencyKey: 'wire-key-00000001',
      payloadFingerprint: 'a'.repeat(64),
      firstAttemptAtMs: 1787500000000,
      retainUntilMs: 1787586400000,
    });

    expect(runQuery).toHaveBeenCalledOnce();
    expect(runQuery.mock.calls[0][0]).toContain('ON CONFLICT (publisher_scope, tenant_scope, delivery_id) DO NOTHING');
    expect(runQuery.mock.calls[0][0]).toContain('NOW()');
    expect(runQuery.mock.calls[0][1]).toEqual([
      KEY.publisherScope,
      KEY.tenantScope,
      KEY.deliveryId,
      'wire-key-00000001',
      'a'.repeat(64),
      86_400_000,
    ]);
  });

  it('atomically retires an expired binding instead of making its delivery id reusable', async () => {
    const runQuery = queryMock();
    runQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        status: 'retired',
        idempotency_key: null,
        payload_fingerprint: null,
        first_attempt_at_ms: null,
        retain_until_ms: null,
      }] });
    const store = new PostgresWebhookDeliveryPersistence(runQuery);

    await expect(store.claim(KEY, {
      idempotencyKey: 'wire-key-00000002',
      payloadFingerprint: 'b'.repeat(64),
    }, 86_400_000)).resolves.toEqual({ status: 'retired' });
    expect(runQuery.mock.calls[1][0]).toContain("SET status = 'retired'");
    expect(runQuery).toHaveBeenCalledTimes(2);
  });

  it('encrypts the complete recovery snapshot and keeps plaintext credentials out of SQL parameters', async () => {
    const runQuery = queryMock();
    runQuery.mockResolvedValueOnce({ rows: [{ snapshot_digest: 'stored' }] });
    const store = new PostgresWebhookDeliveryPersistence(runQuery);

    await store.checkpoint(KEY, SNAPSHOT);

    const params = runQuery.mock.calls[0][1] ?? [];
    expect(params.slice(0, 3)).toEqual([KEY.publisherScope, KEY.tenantScope, KEY.deliveryId]);
    expect(params[3]).toEqual(expect.any(String));
    expect(params[4]).toEqual(expect.any(String));
    expect(params[5]).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(params)).not.toContain('super-secret-token');
    expect(JSON.stringify(params)).not.toContain('buyer.example');
  });

  it('rejects a changed exact snapshot for an already-checkpointed delivery id', async () => {
    const runQuery = queryMock();
    runQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ snapshot_digest: 'not-the-new-digest' }] });
    const store = new PostgresWebhookDeliveryPersistence(runQuery);

    await expect(store.checkpoint(KEY, SNAPSHOT)).rejects.toThrow(
      'was checkpointed with a different snapshot',
    );
  });

  it('leases recoverable snapshots and reconstructs the exact emit parameters', async () => {
    const insertQuery = queryMock();
    insertQuery.mockResolvedValueOnce({ rows: [{ snapshot_digest: 'stored' }] });
    const writer = new PostgresWebhookDeliveryPersistence(insertQuery);
    await writer.checkpoint(KEY, SNAPSHOT);
    const checkpointParams = insertQuery.mock.calls[0][1] ?? [];

    const recoveryQuery = queryMock();
    recoveryQuery.mockResolvedValueOnce({ rows: [{
      publisher_scope: KEY.publisherScope,
      tenant_scope: KEY.tenantScope,
      delivery_id: KEY.deliveryId,
      snapshot_encrypted: checkpointParams[3],
      snapshot_iv: checkpointParams[4],
      created_at_ms: '1787500000000',
    }] });
    const reader = new PostgresWebhookDeliveryPersistence(recoveryQuery);

    await expect(reader.claimRecoverable(KEY.publisherScope)).resolves.toEqual([{
      key: KEY,
      params: {
        url: SNAPSHOT.url,
        payload: SNAPSHOT.payload,
        delivery_id: KEY.deliveryId,
        authentication: SNAPSHOT.authentication,
        retries: SNAPSHOT.retries,
      },
      createdAtMs: 1787500000000,
    }]);
    expect(recoveryQuery.mock.calls[0][0]).toContain('FOR UPDATE SKIP LOCKED');
    expect(recoveryQuery.mock.calls[0][1]).toEqual([KEY.publisherScope, 25, 1_800_000]);
  });
});
