import { beforeEach, describe, expect, it, vi } from 'vitest';

const proveAgentWebhookControlMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/training-agent/webhook-challenge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/training-agent/webhook-challenge.js')>();
  return {
    ...actual,
    proveAgentWebhookControl: proveAgentWebhookControlMock,
  };
});

const {
  resolveAgentNotificationScope,
  syncAgentNotificationConfigs,
} = await import('../../src/training-agent/agent-notification-configs.js');

type SyncRequest = Parameters<typeof syncAgentNotificationConfigs>[0];
type SyncContext = Parameters<typeof syncAgentNotificationConfigs>[1];
type StoredDocument = Record<string, unknown>;

function notificationConfig(overrides: Record<string, unknown> = {}) {
  return {
    subscriber_id: 'registry-cache',
    url: 'https://buyer.example:443/hooks/../webhooks/capabilities',
    event_types: ['capabilities.changed'],
    active: false,
    ...overrides,
  };
}

function request(
  notificationConfigs: Array<Record<string, unknown>>,
  overrides: Record<string, unknown> = {},
): SyncRequest {
  return {
    idempotency_key: 'agent-notifications-test-0001',
    notification_configs: notificationConfigs,
    ...overrides,
  } as unknown as SyncRequest;
}

function memoryStore() {
  const documents = new Map<string, StoredDocument>();
  const get = vi.fn(async (_collection: string, id: string) => documents.get(id) ?? null);
  const put = vi.fn(async (_collection: string, id: string, value: StoredDocument) => {
    documents.set(id, structuredClone(value));
  });
  return { documents, get, put };
}

function context(
  store: ReturnType<typeof memoryStore>,
  principalId = 'agent:https://buyer.example',
): SyncContext {
  return {
    store,
    callerMutationScope: {
      tenant_id: 'training-agent',
      principal_id: principalId,
    },
  } as unknown as SyncContext;
}

describe('agent notification configuration', () => {
  beforeEach(() => {
    proveAgentWebhookControlMock.mockReset();
    proveAgentWebhookControlMock.mockResolvedValue({
      ok: true,
      normalizedUrl: 'https://buyer.example/webhooks/capabilities',
    });
  });

  it('requires an authenticated caller and prefers an authenticated agent identity', () => {
    expect(() => resolveAgentNotificationScope({} as never)).toThrowError(
      /requires an authenticated caller principal/,
    );
    expect(resolveAgentNotificationScope({
      agent: { agent_url: 'https://buyer.example' },
      authInfo: { clientId: 'fallback-client' },
    } as never)).toEqual({
      tenant_id: 'training-agent',
      principal_id: 'agent:https://buyer.example',
    });
    expect(resolveAgentNotificationScope({
      authInfo: { credential: { kind: 'api_key', key_id: 'key-123' } },
    } as never)).toEqual({
      tenant_id: 'training-agent',
      principal_id: 'api_key:key-123',
    });
  });

  it('keeps declarative replacement and clear isolated by caller principal', async () => {
    const store = memoryStore();
    const callerA = context(store, 'agent:https://a.example');
    const callerB = context(store, 'agent:https://b.example');

    await syncAgentNotificationConfigs(request([
      notificationConfig({ subscriber_id: 'caller-a', url: 'https://a.example/hooks' }),
    ]), callerA);
    await syncAgentNotificationConfigs(request([
      notificationConfig({ subscriber_id: 'caller-b', url: 'https://b.example/hooks' }),
    ]), callerB);

    const clearedA = await syncAgentNotificationConfigs(request([]), callerA);
    const unchangedB = await syncAgentNotificationConfigs(request([
      notificationConfig({ subscriber_id: 'caller-b', url: 'https://b.example/hooks' }),
    ]), callerB);

    expect(clearedA).toMatchObject({ action: 'cleared', notification_configs: [] });
    expect(unchangedB).toMatchObject({
      action: 'unchanged',
      notification_configs: [{ subscriber_id: 'caller-b' }],
    });
    expect(store.documents).toHaveLength(2);
  });

  it('validates dry runs without proof or persistence and echoes context', async () => {
    const store = memoryStore();
    const result = await syncAgentNotificationConfigs(request([
      notificationConfig({ active: true }),
    ], {
      dry_run: true,
      context: { correlation_id: 'dry-run-001' },
    }), context(store));

    expect(result).toEqual({
      status: 'completed',
      dry_run: true,
      action: 'updated',
      notification_configs: [],
      context: { correlation_id: 'dry-run-001' },
    });
    expect(proveAgentWebhookControlMock).not.toHaveBeenCalled();
    expect(store.put).not.toHaveBeenCalled();
    expect(store.documents).toHaveLength(0);
  });

  it('replaces, redacts, and clears a caller-owned subscriber set', async () => {
    const store = memoryStore();
    const syncContext = context(store);
    const credentials = 'a-write-only-bearer-credential-000000000000';
    const created = await syncAgentNotificationConfigs(request([
      notificationConfig({
        authentication: { schemes: ['Bearer'], credentials },
      }),
    ]), syncContext);

    expect(created).toMatchObject({
      action: 'updated',
      notification_configs: [{
        subscriber_id: 'registry-cache',
        url: 'https://buyer.example/webhooks/capabilities',
        authentication: { schemes: ['Bearer'] },
      }],
    });
    expect(created.notification_configs?.[0]?.authentication).not.toHaveProperty('credentials');
    expect(JSON.stringify(created)).not.toContain(credentials);
    expect(JSON.stringify([...store.documents.values()])).toContain(credentials);

    const replaced = await syncAgentNotificationConfigs(request([
      notificationConfig({ subscriber_id: 'replacement', url: 'https://replacement.example/hooks' }),
    ]), syncContext);
    expect(replaced).toMatchObject({
      action: 'updated',
      notification_configs: [{ subscriber_id: 'replacement' }],
    });

    const cleared = await syncAgentNotificationConfigs(request([]), syncContext);
    expect(cleared).toMatchObject({ action: 'cleared', notification_configs: [] });
  });

  it.each([
    ['non-HTTPS', 'http://buyer.example/hooks'],
    ['loopback', 'https://127.0.0.1/hooks'],
    ['private network', 'https://10.20.30.40/hooks'],
    ['malformed hostname', 'https://buyer..example/hooks'],
  ])('rejects a %s URL even for an inactive subscriber', async (_label, url) => {
    const store = memoryStore();
    const result = await syncAgentNotificationConfigs(request([
      notificationConfig({ url }),
    ]), context(store));

    expect(result).toMatchObject({
      action: 'failed',
      notification_configs: [],
      errors: [{ code: 'VALIDATION_ERROR' }],
    });
    expect(proveAgentWebhookControlMock).not.toHaveBeenCalled();
    expect(store.put).not.toHaveBeenCalled();
  });

  it('reactivates a paused subscriber only after successful endpoint proof', async () => {
    const store = memoryStore();
    const syncContext = context(store);
    await syncAgentNotificationConfigs(request([
      notificationConfig({ active: false }),
    ]), syncContext);
    store.put.mockClear();

    const result = await syncAgentNotificationConfigs(request([
      notificationConfig({ active: true }),
    ]), syncContext);

    expect(proveAgentWebhookControlMock).toHaveBeenCalledOnce();
    expect(proveAgentWebhookControlMock).toHaveBeenCalledWith({
      subscriberId: 'registry-cache',
      url: 'https://buyer.example/webhooks/capabilities',
      eventTypes: ['capabilities.changed'],
    });
    expect(result).toMatchObject({
      action: 'updated',
      notification_configs: [{ active: true }],
    });
    expect(store.put).toHaveBeenCalledOnce();

    const unchanged = await syncAgentNotificationConfigs(request([
      notificationConfig({ active: true }),
    ]), syncContext);
    expect(unchanged.action).toBe('unchanged');
    expect(proveAgentWebhookControlMock).toHaveBeenCalledOnce();
  });

  it('leaves the prior subscriber set unchanged when endpoint proof fails', async () => {
    const store = memoryStore();
    const syncContext = context(store);
    await syncAgentNotificationConfigs(request([
      notificationConfig({ active: false }),
    ]), syncContext);
    store.put.mockClear();
    proveAgentWebhookControlMock.mockResolvedValueOnce({ ok: false });

    const result = await syncAgentNotificationConfigs(request([
      notificationConfig({ active: true }),
    ]), syncContext);

    expect(result).toMatchObject({
      action: 'failed',
      notification_configs: [{ subscriber_id: 'registry-cache', active: false }],
      errors: [{
        code: 'SERVICE_UNAVAILABLE',
        field: 'notification_configs',
      }],
    });
    expect(store.put).not.toHaveBeenCalled();

    const prior = [...store.documents.values()][0] as {
      notification_configs: Array<{ active: boolean }>;
    };
    expect(prior.notification_configs[0]?.active).toBe(false);
  });
});
