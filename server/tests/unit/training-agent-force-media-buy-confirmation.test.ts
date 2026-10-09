import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import {
  createTrainingAgentServer,
  invalidateCache,
  clearTaskStore,
} from '../../src/training-agent/task-handlers.js';
import { clearSessions } from '../../src/training-agent/state.js';
import { MUTATING_TOOLS, clearIdempotencyCache } from '../../src/training-agent/idempotency.js';
import type { TrainingContext } from '../../src/training-agent/types.js';

const DEFAULT_CTX: TrainingContext = { mode: 'open' };
const ACCOUNT = { brand: { domain: 'hold-review.example.com' }, operator: 'hold-tester', sandbox: true };
const BRAND = { domain: 'hold-review.example.com', name: 'Hold Review Test' };

type Server = ReturnType<typeof createTrainingAgentServer>;
type Result = Record<string, unknown>;

function withIdempotencyKey(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  if (!MUTATING_TOOLS.has(toolName)) return args;
  if (args.idempotency_key !== undefined) return args;
  return { ...args, idempotency_key: `test-${crypto.randomUUID()}` };
}

async function callTool(server: Server, toolName: string, args: Record<string, unknown>): Promise<Result> {
  const requestHandlers = (server as unknown as { _requestHandlers: Map<string, Function> })._requestHandlers;
  const handler = requestHandlers.get('tools/call');
  if (!handler) throw new Error('CallTool handler not found');
  const response = await handler(
    { method: 'tools/call', params: { name: toolName, arguments: withIdempotencyKey(toolName, args) } },
    {},
  );
  const text = response.content?.[0]?.text;
  const parsed: Result = response.structuredContent
    ? (response.structuredContent as Result)
    : (text ? JSON.parse(text) : {});
  return (parsed.adcp_error as Result | undefined) ?? parsed;
}

const VERSION = { adcp_version: '3.2' };

// The reference catalog has no fixed-price non-guaranteed product, so seed one
// the way the sales_fixed_rate storyboard does.
async function getFixedPricePackage(
  server: Server,
  account: Result = ACCOUNT,
  brand: Result = BRAND,
): Promise<{ product_id: string; pricing_option_id: string }> {
  const seededProduct = await callTool(server, 'comply_test_controller', {
    ...VERSION,
    scenario: 'seed_product',
    account,
    brand,
    params: {
      product_id: 'hold_fixed_rate_display',
      fixture: { delivery_type: 'non_guaranteed', channels: ['display'] },
    },
  });
  expect(seededProduct.success).toBe(true);
  const seededOption = await callTool(server, 'comply_test_controller', {
    ...VERSION,
    scenario: 'seed_pricing_option',
    account,
    brand,
    params: {
      product_id: 'hold_fixed_rate_display',
      pricing_option_id: 'vcpm_fixed_rate',
      fixture: { pricing_model: 'vcpm', currency: 'USD', fixed_price: 11 },
    },
  });
  expect(seededOption.success).toBe(true);
  return { product_id: 'hold_fixed_rate_display', pricing_option_id: 'vcpm_fixed_rate' };
}

function createArgs(pkg: { product_id: string; pricing_option_id: string }, extra: Result = {}): Result {
  return {
    ...VERSION,
    account: ACCOUNT,
    brand: BRAND,
    start_time: 'asap',
    end_time: '2099-07-01T00:00:00Z',
    packages: [{ ...pkg, budget: 10000 }],
    ...extra,
  };
}

async function readBuy(server: Server, mediaBuyId: string): Promise<Result> {
  const result = await callTool(server, 'get_media_buys', {
    ...VERSION,
    account: ACCOUNT,
    brand: BRAND,
    media_buy_ids: [mediaBuyId],
  });
  return (result as { media_buys: Result[] }).media_buys[0];
}

const hold = (server: Server) => callTool(server, 'comply_test_controller', {
  ...VERSION,
  scenario: 'force_media_buy_confirmation',
  params: { action: 'hold' },
  account: ACCOUNT,
  brand: BRAND,
});

const confirm = (server: Server, mediaBuyId: string) => callTool(server, 'comply_test_controller', {
  ...VERSION,
  scenario: 'force_media_buy_confirmation',
  params: { action: 'confirm', media_buy_id: mediaBuyId },
  account: ACCOUNT,
  brand: BRAND,
});

describe('force_media_buy_confirmation', () => {
  let server: Server;

  beforeEach(async () => {
    await clearSessions();
    clearIdempotencyCache();
    invalidateCache();
    clearTaskStore();
    server = createTrainingAgentServer(DEFAULT_CTX);
  });

  describe('hold', () => {
    it('registers a hold directive and echoes simulated.action', async () => {
      const result = await hold(server);
      expect(result.success).toBe(true);
      expect((result as { simulated: Result }).simulated).toEqual({ action: 'hold' });
    });

    it('makes the next create_media_buy a synchronous provisional buy with confirmed_at null', async () => {
      const pkg = await getFixedPricePackage(server);
      await hold(server);

      const created = await callTool(server, 'create_media_buy', createArgs(pkg));

      // Synchronous success with an immediate media_buy_id; not the submitted arm.
      expect(created.status).not.toBe('submitted');
      expect(created.task_id).toBeUndefined();
      expect(typeof created.media_buy_id).toBe('string');
      expect(created.confirmed_at).toBeNull();
      expect(['pending_creatives', 'pending_start']).toContain(created.media_buy_status);
      // A fixed-price buy sends and echoes no bid.
      expect((created.packages as Result[])[0].bid_price).toBeUndefined();
      expect((created.packages as Result[])[0].pricing_option_id).toBe(pkg.pricing_option_id);
    });

    it('is single-shot: the second create commits immediately', async () => {
      const pkg = await getFixedPricePackage(server);
      await hold(server);

      const held = await callTool(server, 'create_media_buy', createArgs(pkg));
      expect(held.confirmed_at).toBeNull();

      const second = await callTool(server, 'create_media_buy', createArgs(pkg));
      expect(typeof second.confirmed_at).toBe('string');
    });

    it('a second hold before consumption leaves a single directive', async () => {
      const pkg = await getFixedPricePackage(server);
      await hold(server);
      await hold(server);

      const held = await callTool(server, 'create_media_buy', createArgs(pkg));
      expect(held.confirmed_at).toBeNull();
      const next = await callTool(server, 'create_media_buy', createArgs(pkg));
      expect(typeof next.confirmed_at).toBe('string');
    });

    it('does not consume the directive on a request that fails validation', async () => {
      const pkg = await getFixedPricePackage(server);
      await hold(server);

      const invalid = await callTool(server, 'create_media_buy', createArgs(pkg, {
        packages: [{ ...pkg, budget: -5 }],
      }));
      expect(invalid.media_buy_id).toBeUndefined();

      const held = await callTool(server, 'create_media_buy', createArgs(pkg));
      expect(held.confirmed_at).toBeNull();
    });

    it('does not apply a directive registered for a different account', async () => {
      const pkg = await getFixedPricePackage(server);
      await hold(server);

      const otherAccount = { brand: { domain: 'other-hold.example.com' }, operator: 'other-tester', sandbox: true };
      const otherBrand = { domain: 'other-hold.example.com' };
      const otherPkg = await getFixedPricePackage(server, otherAccount, otherBrand);
      const other = await callTool(server, 'create_media_buy', createArgs(otherPkg, {
        account: otherAccount,
        brand: otherBrand,
      }));
      expect(typeof other.confirmed_at).toBe('string');

      const own = await callTool(server, 'create_media_buy', createArgs(pkg));
      expect(own.confirmed_at).toBeNull();
    });

    it('reads back as a provisional buy that is never active', async () => {
      const pkg = await getFixedPricePackage(server);
      await hold(server);
      const created = await callTool(server, 'create_media_buy', createArgs(pkg));

      const read = await readBuy(server, created.media_buy_id as string);
      expect(read.confirmed_at).toBeNull();
      expect(['pending_creatives', 'pending_start']).toContain(read.status);
      expect(read.revision).toBe(created.revision);
    });

    it('stays pending_start, never active, when the buyer pauses and resumes a held buy', async () => {
      const pkg = await getFixedPricePackage(server);
      await hold(server);
      const created = await callTool(server, 'create_media_buy', createArgs(pkg));

      await callTool(server, 'update_media_buy', {
        ...VERSION,
        account: ACCOUNT,
        brand: BRAND,
        media_buy_id: created.media_buy_id,
        paused: false,
      });

      const read = await readBuy(server, created.media_buy_id as string);
      expect(read.confirmed_at).toBeNull();
      expect(read.status).not.toBe('active');
    });
  });

  describe('confirm', () => {
    it('sets confirmed_at once and increments revision', async () => {
      const pkg = await getFixedPricePackage(server);
      await hold(server);
      const created = await callTool(server, 'create_media_buy', createArgs(pkg));
      const mediaBuyId = created.media_buy_id as string;

      const result = await confirm(server, mediaBuyId);
      expect(result.success).toBe(true);
      expect(result.previous_state).toBe('unconfirmed');
      expect(result.current_state).toBe('confirmed');

      const read = await readBuy(server, mediaBuyId);
      expect(typeof read.confirmed_at).toBe('string');
      expect(read.revision).toBe((created.revision as number) + 1);
      expect(['pending_creatives', 'pending_start', 'active']).toContain(read.status);
    });

    it('is idempotent: re-confirming keeps confirmed_at and revision', async () => {
      const pkg = await getFixedPricePackage(server);
      await hold(server);
      const created = await callTool(server, 'create_media_buy', createArgs(pkg));
      const mediaBuyId = created.media_buy_id as string;

      await confirm(server, mediaBuyId);
      const first = await readBuy(server, mediaBuyId);

      const again = await confirm(server, mediaBuyId);
      expect(again.success).toBe(true);
      expect(again.previous_state).toBe('confirmed');
      expect(again.current_state).toBe('confirmed');

      const second = await readBuy(server, mediaBuyId);
      expect(second.confirmed_at).toBe(first.confirmed_at);
      expect(second.revision).toBe(first.revision);
    });

    it('replays the original create response, including confirmed_at null, after confirmation', async () => {
      const pkg = await getFixedPricePackage(server);
      await hold(server);
      const idempotencyKey = `hold-replay-${crypto.randomUUID()}`;
      const args = createArgs(pkg, { idempotency_key: idempotencyKey });

      const created = await callTool(server, 'create_media_buy', args);
      expect(created.confirmed_at).toBeNull();
      await confirm(server, created.media_buy_id as string);

      const replay = await callTool(server, 'create_media_buy', args);
      expect(replay.media_buy_id).toBe(created.media_buy_id);
      expect(replay.confirmed_at).toBeNull();
      expect(replay.revision).toBe(created.revision);
    });

    it('returns NOT_FOUND for an unknown media buy', async () => {
      const result = await confirm(server, 'mb_does_not_exist');
      expect(result.success).toBe(false);
      expect(result.error).toBe('NOT_FOUND');
    });

    it('requires media_buy_id when action is confirm', async () => {
      const result = await callTool(server, 'comply_test_controller', {
        ...VERSION,
        scenario: 'force_media_buy_confirmation',
        params: { action: 'confirm' },
        account: ACCOUNT,
        brand: BRAND,
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe('INVALID_PARAMS');
    });

    it('rejects an action outside the hold and confirm enum', async () => {
      const result = await callTool(server, 'comply_test_controller', {
        ...VERSION,
        scenario: 'force_media_buy_confirmation',
        params: { action: 'release' },
        account: ACCOUNT,
        brand: BRAND,
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe('INVALID_PARAMS');
    });

    it('rejects missing params', async () => {
      const result = await callTool(server, 'comply_test_controller', {
        ...VERSION,
        scenario: 'force_media_buy_confirmation',
        account: ACCOUNT,
        brand: BRAND,
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe('INVALID_PARAMS');
    });
  });

  describe('directive precedence and confirm edge cases', () => {
    it('a forced submitted arm wins the create and the hold stays registered for the next real create', async () => {
      const pkg = await getFixedPricePackage(server);
      await hold(server);
      const arm = await callTool(server, 'comply_test_controller', {
        ...VERSION,
        scenario: 'force_create_media_buy_arm',
        params: { arm: 'submitted', task_id: 'task_hold_precedence' },
        account: ACCOUNT,
        brand: BRAND,
      });
      expect(arm.success).toBe(true);

      const submitted = await callTool(server, 'create_media_buy', createArgs(pkg));
      expect(submitted.status).toBe('submitted');
      expect(submitted.task_id).toBe('task_hold_precedence');
      expect(submitted.media_buy_id).toBeUndefined();

      const held = await callTool(server, 'create_media_buy', createArgs(pkg));
      expect(typeof held.media_buy_id).toBe('string');
      expect(held.confirmed_at).toBeNull();
    });

    it('confirm on an already confirmed buy that later reached a terminal state is idempotent success', async () => {
      const pkg = await getFixedPricePackage(server);
      await hold(server);
      const created = await callTool(server, 'create_media_buy', createArgs(pkg));
      const mediaBuyId = created.media_buy_id as string;
      await confirm(server, mediaBuyId);
      const before = await readBuy(server, mediaBuyId);

      await callTool(server, 'update_media_buy', {
        ...VERSION,
        account: ACCOUNT,
        brand: BRAND,
        media_buy_id: mediaBuyId,
        canceled: true,
      });

      const again = await confirm(server, mediaBuyId);
      expect(again.success).toBe(true);
      expect(again.previous_state).toBe('confirmed');
      const after = await readBuy(server, mediaBuyId);
      expect(after.confirmed_at).toBe(before.confirmed_at);
    });
  });

  describe('held buy outcomes other than confirmation', () => {
    it('a held buy rejected through force_media_buy_status ends rejected with confirmed_at null', async () => {
      const pkg = await getFixedPricePackage(server);
      await hold(server);
      const created = await callTool(server, 'create_media_buy', createArgs(pkg));
      const mediaBuyId = created.media_buy_id as string;

      const rejected = await callTool(server, 'comply_test_controller', {
        ...VERSION,
        scenario: 'force_media_buy_status',
        params: { media_buy_id: mediaBuyId, status: 'rejected', rejection_reason: 'Seller review declined the buy' },
        account: ACCOUNT,
        brand: BRAND,
      });
      expect(rejected.success).toBe(true);

      const read = await readBuy(server, mediaBuyId);
      expect(read.status).toBe('rejected');
      expect(read.confirmed_at).toBeNull();

      const lateConfirm = await confirm(server, mediaBuyId);
      expect(lateConfirm.success).toBe(false);
      expect(lateConfirm.error).toBe('INVALID_TRANSITION');
    });

    it('the buyer can cancel a held buy; confirmed_at stays null', async () => {
      const pkg = await getFixedPricePackage(server);
      await hold(server);
      const created = await callTool(server, 'create_media_buy', createArgs(pkg));
      const mediaBuyId = created.media_buy_id as string;

      const canceled = await callTool(server, 'update_media_buy', {
        ...VERSION,
        account: ACCOUNT,
        brand: BRAND,
        media_buy_id: mediaBuyId,
        canceled: true,
        cancellation_reason: 'Buyer withdrew the order',
      });
      expect(canceled.errors).toBeUndefined();

      const read = await readBuy(server, mediaBuyId);
      expect(read.status).toBe('canceled');
      expect(read.confirmed_at).toBeNull();

      const lateConfirm = await confirm(server, mediaBuyId);
      expect(lateConfirm.success).toBe(false);
      expect(lateConfirm.error).toBe('INVALID_TRANSITION');
    });
  });

  describe('list_scenarios advertisement', () => {
    it('advertises force_media_buy_confirmation alongside the existing controller scenarios', async () => {
      const result = await callTool(server, 'comply_test_controller', {
        ...VERSION,
        scenario: 'list_scenarios',
        account: ACCOUNT,
        brand: BRAND,
      });
      expect(result.success).toBe(true);
      const scenarios = (result as { scenarios: string[] }).scenarios;
      expect(scenarios).toContain('force_media_buy_confirmation');
      expect(scenarios).toContain('force_media_buy_status');
      expect(scenarios).toContain('force_create_media_buy_arm');
    });
  });

  describe('version gating', () => {
    it('is not advertised or accepted for a 3.1 pin', async () => {
      const listed = await callTool(server, 'comply_test_controller', {
        adcp_version: '3.1',
        scenario: 'list_scenarios',
        account: ACCOUNT,
        brand: BRAND,
      });
      expect((listed as { scenarios: string[] }).scenarios).not.toContain('force_media_buy_confirmation');

      const result = await callTool(server, 'comply_test_controller', {
        adcp_version: '3.1',
        scenario: 'force_media_buy_confirmation',
        params: { action: 'hold' },
        account: ACCOUNT,
        brand: BRAND,
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe('UNKNOWN_SCENARIO');
    });
  });
});
