import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import { InMemoryStateStore, type PutIfMatchResult } from '@adcp/sdk/server';
import { clearSessions, setStateStore, stopSessionCleanup } from '../../src/training-agent/state.js';
import { clearIdempotencyCache, getIdempotencyStore } from '../../src/training-agent/idempotency.js';

process.env.PUBLIC_TEST_AGENT_TOKEN = 'test-media-buy-ack-token';

const BUY_NAME = 'Durable acknowledgement fixture';
const ACCOUNT = {
  brand: { domain: 'acmeoutdoor.example' },
  operator: 'pinnacle-agency.example',
  sandbox: true,
};

// This is an ordering control, not a substitute for PostgreSQL qualification:
// the real HTTP route may not publish a result while its state write is held.
class ControlledStateStore extends InMemoryStateStore {
  mode: 'pass' | 'hold' | 'reject' = 'pass';
  attempts = 0;
  private enter = () => {};
  private release = () => {};
  private finish = () => {};
  readonly entered = new Promise<void>(resolve => { this.enter = resolve; });
  readonly finished = new Promise<void>(resolve => { this.finish = resolve; });
  private readonly gate = new Promise<void>(resolve => { this.release = resolve; });

  open() {
    this.mode = 'pass';
    this.release();
  }

  override async putIfMatch(
    collection: string,
    id: string,
    data: Record<string, unknown>,
    expectedVersion: number | null,
  ): Promise<PutIfMatchResult> {
    const controlled = this.mode !== 'pass'
      && collection === 'training_sessions'
      && JSON.stringify(data).includes(BUY_NAME);
    if (!controlled) return super.putIfMatch(collection, id, data, expectedVersion);
    this.attempts++;
    this.enter();
    try {
      if (this.mode === 'reject') throw new Error('Injected session persistence failure');
      await this.gate;
      return await super.putIfMatch(collection, id, data, expectedVersion);
    } finally {
      this.finish();
    }
  }
}

describe('tenant media-buy acknowledgement durability', () => {
  let server: http.Server;
  let url: string;
  let store: ControlledStateStore;
  let createResponse: http.ServerResponse | undefined;
  let rpcId = 0;
  let failNextReplaySave: () => void;
  let replaySaveAttempts: () => number;

  async function call(name: string, args: Record<string, unknown>) {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', accept: 'application/json',
        authorization: 'Bearer test-media-buy-ack-token',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: {
        name, arguments: { adcp_version: '3.1', ...args },
      } }),
    });
    return await response.json() as Record<string, any>;
  }

  async function createArgs(key: string) {
    const synced = await call('sync_accounts', {
      accounts: [{ ...ACCOUNT, billing: 'operator' }], idempotency_key: `${key}-account`,
    });
    expect(synced.result?.structuredContent?.accounts?.[0]?.account_id).toEqual(expect.any(String));
    const discovery = await call('get_products', {
      account: ACCOUNT, buying_mode: 'brief', brief: 'Outdoor lifestyle video inventory.',
    });
    const products = discovery.result?.structuredContent?.products as Array<Record<string, any>>;
    const product = products?.find(row => row.pricing_options?.[0]?.pricing_option_id);
    expect(product, JSON.stringify(discovery)).toBeDefined();
    const pricing = product!.pricing_options[0];
    return {
      name: BUY_NAME, account: ACCOUNT, total_budget: { amount: 6000, currency: 'USD' },
      start_time: '2027-06-01T00:00:00Z', end_time: '2027-06-30T23:59:59Z',
      packages: [{ product_id: product!.product_id, pricing_option_id: pricing.pricing_option_id,
        budget: 6000, bid_price: Math.max(pricing.floor_price ?? pricing.fixed_price ?? 1, 1) }],
      idempotency_key: key,
    };
  }

  beforeEach(async () => {
    await clearIdempotencyCache();
    await clearSessions();
    // Tenant registration copies the SDK adapter's save function. Install the
    // fault seam before the first HTTP request builds that tenant registry.
    const save = vi.spyOn(getIdempotencyStore(), 'save');
    failNextReplaySave = () => { save.mockRejectedValueOnce(new Error('Injected replay publication failure')); };
    replaySaveAttempts = () => save.mock.calls.length;
    store = new ControlledStateStore();
    setStateStore(store);
    const { createTrainingAgentRouter } = await import('../../src/training-agent/index.js');
    const { clearAccountStore } = await import('../../src/training-agent/account-handlers.js');
    clearAccountStore();
    createResponse = undefined;
    const app = express();
    app.use(express.json({ verify: (req, _res, bytes) => {
      (req as unknown as { rawBody: string }).rawBody = bytes.toString('utf8');
    } }));
    app.use((req, res, next) => {
      if (req.body?.method === 'tools/call' && req.body.params?.name === 'create_media_buy') createResponse = res;
      next();
    });
    app.use('/api/training-agent', createTrainingAgentRouter());
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/training-agent/sales/mcp`;
  }, 60_000);

  afterEach(async () => {
    store?.open();
    vi.restoreAllMocks();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    await clearIdempotencyCache();
    await clearSessions();
    setStateStore(null);
    stopSessionCleanup();
  });

  it('keeps the real MCP success response unpublished until its session write commits', async () => {
    const args = await createArgs('create-ack-held-0001');
    store.mode = 'hold';
    const pending = call('create_media_buy', args);
    try {
      await Promise.race([store.entered, pending.then(result => { throw new Error(`Create returned before a state write: ${JSON.stringify(result)}`); })]);
      expect(createResponse).toBeDefined();
      expect(createResponse!.writableEnded, 'MCP success must not outrun the blocked state write').toBe(false);
      expect(createResponse!.headersSent).toBe(false);
    } finally {
      store.open();
      if (store.attempts) await store.finished;
      await pending;
    }
    const created = await pending;
    expect(created.result?.isError).not.toBe(true);
    const id = created.result?.structuredContent?.media_buy_id;
    expect(id, JSON.stringify(created)).toEqual(expect.any(String));
    // This is a separate HTTP request with a fresh session context.
    const simulated = await call('comply_test_controller', {
      account: ACCOUNT, scenario: 'simulate_delivery',
      params: { media_buy_id: id, impressions: 10000, clicks: 150, reported_spend: { amount: 150, currency: 'USD' } },
    });
    expect(simulated.result?.structuredContent?.success, JSON.stringify(simulated)).toBe(true);
  });

  it('does not acknowledge or cache a successful buy when session persistence fails', async () => {
    const args = await createArgs('create-ack-rejected-0001');
    store.mode = 'reject';
    const result = await call('create_media_buy', args);
    expect(store.attempts).toBeGreaterThan(0);
    expect(result.result?.isError, JSON.stringify(result)).toBe(true);
    expect(result.result?.structuredContent?.media_buy_id).toBeUndefined();
    const attempts = store.attempts;
    const replay = await call('create_media_buy', args);
    expect(replay.result?.isError, JSON.stringify(replay)).toBe(true);
    expect(replay.result?.structuredContent?.media_buy_id).toBeUndefined();
    expect(store.attempts, 'pending claim must fence immediate re-execution').toBe(attempts);
  });

  it('retains an uncertain error and immediate retry fencing when replay publication fails', async () => {
    const args = await createArgs('create-ack-replay-failure-0001');
    const attempts = replaySaveAttempts();
    failNextReplaySave();
    const first = await call('create_media_buy', args);
    expect(replaySaveAttempts(), 'the injected failure must reach the configured SDK adapter').toBeGreaterThan(attempts);
    expect(first.result?.isError, JSON.stringify(first)).toBe(true);
    expect(first.result?.structuredContent?.media_buy_id).toBeUndefined();
    expect(JSON.stringify(first)).toMatch(/reconcil|SERVICE_UNAVAILABLE/i);
    const before = await store.list('training_sessions');
    const second = await call('create_media_buy', args);
    expect(second.result?.isError, JSON.stringify(second)).toBe(true);
    expect(second.result?.structuredContent?.media_buy_id).toBeUndefined();
    expect(await store.list('training_sessions')).toEqual(before);
    // The temporary fence is not an exactly-once crash-recovery receipt.
    // Blind retries after it expires still require natural-key reconciliation.
  });
});
