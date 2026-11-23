import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createPersistentNotificationRuntime,
  memoryNotificationSubscriptionStore,
  type NotificationSubscriptionScope,
  type PersistentNotificationRuntime,
} from '@adcp/sdk/server';
import { TrainingGcsReporting, setNotificationSubscriberActive } from '../../src/training-agent/gcs-reporting.js';

const scope: NotificationSubscriptionScope = { kind: 'account', tenantId: 'sales', principalId: 'p', accountId: 'acc-1' };
const EVENT = 'reporting.status_changed';

function build() {
  const prove = vi.fn(async () => ({ proved: true as const }));
  const fetched: string[] = [];
  const contexts: Array<Record<string, unknown> | undefined> = [];
  const runtime: PersistentNotificationRuntime = createPersistentNotificationRuntime({
    store: memoryNotificationSubscriptionStore(),
    proofAdapter: { prove },
    validateDestination: async () => ({ allowed: true }),
    authorizeDelivery: async () => ({ authorized: true }),
    createEmitter: (authorize) => {
      // Stand-in for the SDK emitter: asks the runtime's live authorizer before every
      // "POST", exactly as the real emitter does, and records what would be fetched.
      const emit = async (params: any) => {
        contexts.push(params.attemptAuthorizationContext);
        const decision = await authorize({
          delivery_id: params.delivery_id, idempotency_key: 'k'.repeat(20), attempt: 1,
          url: params.url, payload_size_bytes: 10, attemptAuthorizationContext: params.attemptAuthorizationContext,
        });
        if (decision.decision === 'suppress') {
          return { delivery_id: params.delivery_id, idempotency_key: 'k', attempts: 0, delivered: false, errors: [], suppression: { reason: decision.reason } };
        }
        fetched.push(params.url);
        return { delivery_id: params.delivery_id, idempotency_key: 'k', attempts: 1, delivered: true, final_status: 204, errors: [] };
      };
      const emitter: any = { emit, emitRecovered: emit, forTenantScope: () => emitter };
      return emitter;
    },
  });
  return { runtime, prove, fetched, contexts };
}

async function seed(runtime: PersistentNotificationRuntime) {
  const result = await runtime.replace(scope, [
    { subscriber_id: 'a', url: 'https://a.example.com/hook?token=secret', event_types: [EVENT] },
    { subscriber_id: 'b', url: 'https://b.example.com/hook', event_types: [EVENT] },
  ]);
  expect(result.outcome).toBe('applied');
}

const emitEvent = (runtime: PersistentNotificationRuntime, id: string) => runtime.emit({
  emissionId: `em-${id}`, notificationId: `n-${id}`, notificationType: EVENT, anchor: 'account',
  tenantId: 'sales', principalId: 'p', accountId: 'acc-1', payload: { status: 'x' },
});

const find = async (runtime: PersistentNotificationRuntime, id: string) =>
  (await runtime.read(scope)).notificationConfigs.find(c => c.subscriber_id === id)!;

describe('setNotificationSubscriberActive against the SDK runtime', () => {
  let h: ReturnType<typeof build>;
  beforeEach(async () => { h = build(); await seed(h.runtime); });

  it('suspends one subscriber, leaving the other and the proofs untouched', async () => {
    const before = await h.runtime.read(scope);
    expect(await setNotificationSubscriberActive(h.runtime, scope, 'a', false)).toBe('applied');
    const after = await h.runtime.read(scope);
    const a = after.notificationConfigs.find(c => c.subscriber_id === 'a')!;
    const b = after.notificationConfigs.find(c => c.subscriber_id === 'b')!;
    const a0 = before.notificationConfigs.find(c => c.subscriber_id === 'a')!;
    const b0 = before.notificationConfigs.find(c => c.subscriber_id === 'b')!;
    expect(a.active).toBe(false);
    expect(b).toEqual(b0);
    expect(a.destination_generation).toBe(a0.destination_generation);
    expect(a.proof_generation).toBe(a0.proof_generation);
    expect(await setNotificationSubscriberActive(h.runtime, scope, 'a', false)).toBe('unchanged');
  });

  it('resumes without a new proof challenge and is idempotent', async () => {
    await setNotificationSubscriberActive(h.runtime, scope, 'a', false);
    const proveCalls = h.prove.mock.calls.length;
    expect(await setNotificationSubscriberActive(h.runtime, scope, 'a', true)).toBe('applied');
    expect(h.prove.mock.calls.length).toBe(proveCalls);
    expect((await find(h.runtime, 'a')).active).toBe(true);
    expect(await setNotificationSubscriberActive(h.runtime, scope, 'a', true)).toBe('unchanged');
  });

  it('returns not_found for an unknown subscriber and for an empty scope', async () => {
    expect(await setNotificationSubscriberActive(h.runtime, scope, 'nope', false)).toBe('not_found');
    const empty = { ...scope, accountId: 'acc-empty' };
    expect(await setNotificationSubscriberActive(h.runtime, empty, 'a', false)).toBe('not_found');
  });

  it('stops new dispatches to the suspended subscriber and restores them on resume', async () => {
    await emitEvent(h.runtime, '1');
    expect(h.fetched.sort()).toEqual(['https://a.example.com/hook?token=secret', 'https://b.example.com/hook']);
    h.fetched.length = 0;

    await setNotificationSubscriberActive(h.runtime, scope, 'a', false);
    const during = await emitEvent(h.runtime, '2');
    expect(during.matched).toBe(1);
    expect(during.deliveries.map(d => d.subscriberId)).toEqual(['b']);
    expect(h.fetched).toEqual(['https://b.example.com/hook']);
    h.fetched.length = 0;

    await setNotificationSubscriberActive(h.runtime, scope, 'a', true);
    const after = await emitEvent(h.runtime, '3');
    expect(after.deliveries.map(d => d.subscriberId).sort()).toEqual(['a', 'b']);
    expect(h.fetched).toHaveLength(2);
  });

  it('suppresses an outbox retry of an in-flight delivery as subscription_inactive', async () => {
    await emitEvent(h.runtime, '1');
    const ctx = h.contexts.find(c => c?.subscriberId === 'a');
    expect(ctx?.kind).toBe('adcp_notification_subscription');
    const attempt = {
      delivery_id: 'd', idempotency_key: 'k'.repeat(20), attempt: 2,
      url: 'https://a.example.com/hook?token=secret', payload_size_bytes: 10, attemptAuthorizationContext: ctx,
    };
    expect((await h.runtime.authorizeWebhookAttempt(attempt)).decision).toBe('allow');
    await setNotificationSubscriberActive(h.runtime, scope, 'a', false);
    expect(await h.runtime.authorizeWebhookAttempt(attempt)).toMatchObject({ decision: 'suppress', reason: 'subscription_inactive' });
    // The other subscriber's retries are unaffected.
    const bCtx = h.contexts.find(c => c?.subscriberId === 'b');
    expect((await h.runtime.authorizeWebhookAttempt({ ...attempt, url: 'https://b.example.com/hook', attemptAuthorizationContext: bCtx })).decision).toBe('allow');
  });

  describe('compare-and-set', () => {
    it('re-reads and applies after a conflicting replace', async () => {
      const replace = vi.fn(h.runtime.replace.bind(h.runtime))
        .mockResolvedValueOnce({ outcome: 'conflict' } as any);
      const read = vi.fn(h.runtime.read.bind(h.runtime));
      expect(await setNotificationSubscriberActive({ read, replace }, scope, 'a', false)).toBe('applied');
      expect(replace).toHaveBeenCalledTimes(2);
      expect(read).toHaveBeenCalledTimes(2);
      expect((await find(h.runtime, 'a')).active).toBe(false);
    });

    it('passes the generation it read and never overwrites a concurrent replacement', async () => {
      const read = vi.fn(h.runtime.read.bind(h.runtime));
      let interleaved = false;
      const replace: PersistentNotificationRuntime['replace'] = async (s, configs, opts) => {
        if (!interleaved) {
          interleaved = true;
          // The owning principal replaces the set between our read and write.
          await h.runtime.replace(s, [
            { subscriber_id: 'a', url: 'https://a.example.com/hook?token=secret', event_types: [EVENT] },
            { subscriber_id: 'c', url: 'https://c.example.com/hook', event_types: [EVENT] },
          ]);
        }
        return h.runtime.replace(s, configs, opts);
      };
      expect(await setNotificationSubscriberActive({ read, replace }, scope, 'a', false)).toBe('applied');
      const configs = (await h.runtime.read(scope)).notificationConfigs;
      expect(configs.map(c => c.subscriber_id).sort()).toEqual(['a', 'c']);
      expect(configs.find(c => c.subscriber_id === 'a')!.active).toBe(false);
      expect(configs.find(c => c.subscriber_id === 'c')!.active).toBe(true);
    });

    it('gives up with an error after 3 conflicts', async () => {
      const replace = vi.fn(async () => ({ outcome: 'conflict' }) as any);
      const read = vi.fn(h.runtime.read.bind(h.runtime));
      await expect(setNotificationSubscriberActive({ read, replace }, scope, 'a', false))
        .rejects.toThrow(/conflicting/);
      expect(replace).toHaveBeenCalledTimes(3);
    });
  });
});

describe('TrainingGcsReporting operator methods', () => {
  function host(h: ReturnType<typeof build>, activity: (q: any) => Promise<any[]>) {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('WHERE account_id')) {
        return { rows: params?.[0] === 'acc-1' ? [{ principal_id: 'p' }] : [] };
      }
      return { rows: [{ principal_id: 'p', account_id: 'acc-1' }] };
    });
    const instance = Object.create(TrainingGcsReporting.prototype) as TrainingGcsReporting;
    Object.assign(instance, {
      db: { query },
      service: { notifications: h.runtime, webhookActivity: { listActivity: vi.fn(activity) } },
    });
    return { instance, query };
  }

  it('lists url_host only, with recent_attempts counted per subscriber', async () => {
    const h = build();
    await seed(h.runtime);
    await setNotificationSubscriberActive(h.runtime, scope, 'b', false);
    const records = [
      { subscriber_id: 'a', status: 'failed', fired_at: '2026-01-02T00:00:00Z', http_status_code: 500 },
      { subscriber_id: 'b', status: 'success', fired_at: '2026-01-02T00:00:01Z', http_status_code: 204 },
      { subscriber_id: 'a', status: 'success', fired_at: '2026-01-01T00:00:00Z', http_status_code: 204 },
      { subscriber_id: 'a', status: 'timeout', fired_at: '2026-01-01T00:00:00Z' },
    ];
    const { instance } = host(h, async () => records);
    const list = await instance.listNotificationSubscribers();
    expect(list).toHaveLength(2);
    const a = list.find(s => s.subscriber_id === 'a')!;
    expect(a).toMatchObject({ account_id: 'acc-1', active: true, url_host: 'a.example.com', event_types: [EVENT] });
    expect(a.recent_attempts).toEqual({
      success: 1, failed: 1, timeout: 1, connection_error: 0, pending: 0,
      last_fired_at: '2026-01-02T00:00:00Z', last_status: 'failed', last_http_status_code: 500,
    });
    expect(list.find(s => s.subscriber_id === 'b')).toMatchObject({ active: false, recent_attempts: { success: 1, failed: 0 } });
    const json = JSON.stringify(list);
    expect(json).not.toMatch(/https?:\/\//);
    expect(json).not.toContain('secret');
    expect(json).not.toContain('/hook');
  });

  it('omits recent_attempts when webhook activity cannot be read', async () => {
    const h = build();
    await seed(h.runtime);
    const { instance } = host(h, async () => { throw new Error('nope'); });
    const list = await instance.listNotificationSubscribers();
    expect(list).toHaveLength(2);
    expect(list.every(s => !('recent_attempts' in s))).toBe(true);
  });

  it('resolves the owning principal for setNotificationSubscriberActive, and 404s an unknown account', async () => {
    const h = build();
    await seed(h.runtime);
    const { instance } = host(h, async () => []);
    expect(await instance.setNotificationSubscriberActive('acc-1', 'a', false)).toBe('applied');
    expect((await find(h.runtime, 'a')).active).toBe(false);
    expect(await instance.setNotificationSubscriberActive('acc-missing', 'a', false)).toBe('not_found');
  });
});
