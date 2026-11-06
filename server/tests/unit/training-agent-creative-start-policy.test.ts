import crypto from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  clearTaskStore,
  createTrainingAgentServer,
  handleControlMediaBuy,
  handleCreateMediaBuy,
  handleGetMediaBuys,
  handleUpdateMediaBuy,
  invalidateCache,
} from '../../src/training-agent/task-handlers.js';
import {
  clearSessions,
  flushDirtySessions,
  getSession,
  runWithSessionContext,
  sessionKeyFromArgs,
  stopSessionCleanup,
} from '../../src/training-agent/state.js';
import { clearIdempotencyCache } from '../../src/training-agent/idempotency.js';
import { handleComplyTestController } from '../../src/training-agent/comply-test-controller.js';
import type { ToolArgs, TrainingContext } from '../../src/training-agent/types.js';

const FIELD = 'start_requires_all_creatives_approved';
const ACCOUNT = { brand: { domain: 'nova-start-policy.example' }, operator: 'pinnacle-agency.example', sandbox: true };
const BRAND = { domain: 'nova-start-policy.example' };
const CANDIDATE_CTX: TrainingContext = { mode: 'open', servedAdcpVersion: '3.3-beta.1' };
const STABLE_CTX: TrainingContext = { mode: 'open', servedAdcpVersion: '3.2' };
const PRODUCT = { product_id: 'start_policy_display', pricing_option_id: 'fixed_cpm' };
type Result = Record<string, unknown>;
type Handler = (args: ToolArgs, ctx: TrainingContext) => Promise<unknown>;

async function direct(handler: Handler, args: Result, ctx = CANDIDATE_CTX): Promise<Result> {
  return runWithSessionContext(async () => {
    const result = await handler({
      account: ACCOUNT,
      brand: BRAND,
      idempotency_key: `start-policy-${crypto.randomUUID()}`,
      ...args,
    } as ToolArgs, ctx);
    await flushDirtySessions();
    return result as Result;
  });
}

function createArgs(extra: Result = {}): Result {
  return {
    name: 'Nova launch',
    start_time: 'asap',
    end_time: '2099-07-01T00:00:00Z',
    packages: [{ ...PRODUCT, budget: 10_000 }, { ...PRODUCT, budget: 10_000 }],
    ...extra,
  };
}

async function snapshot() {
  return runWithSessionContext(async () => {
    const session = await getSession(sessionKeyFromArgs({ account: ACCOUNT }, 'open'));
    return structuredClone({ buys: session.mediaBuys, creatives: session.creatives });
  });
}

async function read(mediaBuyId: string, ctx = CANDIDATE_CTX) {
  const result = await direct(handleGetMediaBuys, { media_buy_ids: [mediaBuyId] }, ctx);
  return (result.media_buys as Result[])[0]!;
}

function packageIds(created: Result): string[] {
  return (created.packages as Array<{ package_id: string }>).map(pkg => pkg.package_id);
}

const inlineCreative = {
  creative_id: 'startup_candidate',
  name: 'Nova launch image',
  format_kind: 'image',
  assets: {},
};

describe('reference seller creative start policy', () => {
  beforeEach(async () => {
    await clearSessions();
    clearIdempotencyCache();
    invalidateCache();
    clearTaskStore();
    // Reuse the deterministic synchronous fixture used by seller-confirmation
    // tests; a guaranteed catalog offer could enter the submitted task arm.
    const server = createTrainingAgentServer({ mode: 'open' });
    const call = (server as unknown as { _requestHandlers: Map<string, Function> })
      ._requestHandlers.get('tools/call')!;
    for (const [scenario, params] of [
      ['seed_product', {
        product_id: PRODUCT.product_id,
        fixture: { delivery_type: 'non_guaranteed', channels: ['display'] },
      }],
      ['seed_pricing_option', {
        ...PRODUCT,
        fixture: { pricing_model: 'cpm', currency: 'USD', fixed_price: 11 },
      }],
    ] as const) {
      const response = await call({ method: 'tools/call', params: {
        name: 'comply_test_controller',
        arguments: { adcp_version: '3.2', account: ACCOUNT, brand: BRAND, scenario, params },
      } }, {});
      const result = response.structuredContent ?? JSON.parse(response.content[0].text);
      expect(result.success, JSON.stringify(result)).toBe(true);
    }
    await server.close();
  });

  afterAll(stopSessionCleanup);

  it('rejects a true create before creating a buy, library creative, or assignment', async () => {
    const before = await snapshot();
    const result = await direct(handleCreateMediaBuy, createArgs({
      packages: [
        { ...PRODUCT, budget: 10_000, creatives: [inlineCreative] },
        { ...PRODUCT, budget: 10_000, [FIELD]: true },
      ],
    }));
    expect(result).toMatchObject({ errors: [{ code: 'UNSUPPORTED_FEATURE', field: `packages[1].${FIELD}` }] });
    expect(result.media_buy_id).toBeUndefined();
    expect(await snapshot()).toEqual(before);
  });

  it.each(['packages', 'new_packages'])('rejects true in update.%s without any sibling mutations', async field => {
    const created = await direct(handleCreateMediaBuy, createArgs());
    expect(created.errors).toBeUndefined();
    const [firstId, secondId] = packageIds(created);
    const before = await snapshot();
    const result = await direct(handleUpdateMediaBuy, {
      media_buy_id: created.media_buy_id,
      revision: created.revision,
      name: 'A name that must not commit',
      packages: [{ package_id: firstId, budget: 5_000, creatives: [inlineCreative] }],
      ...(field === 'packages' ? {
        packages: [
          { package_id: firstId, budget: 5_000, creatives: [inlineCreative] },
          { package_id: secondId, [FIELD]: true },
        ],
      } : {
        new_packages: [{ ...PRODUCT, budget: 1_000 }, { ...PRODUCT, budget: 1_000, [FIELD]: true }],
      }),
    });
    expect(result).toMatchObject({ errors: [{ code: 'UNSUPPORTED_FEATURE', field: `${field}[1].${FIELD}` }] });
    // Covers the name, package budgets, revision, inline library entries, and
    // all package assignment sets, rather than only the response shape.
    expect(await snapshot()).toEqual(before);
  });

  it('preserves root cancellation precedence over an ignored unsupported gate', async () => {
    const created = await direct(handleCreateMediaBuy, createArgs());
    const [firstId] = packageIds(created);
    const result = await direct(handleUpdateMediaBuy, {
      media_buy_id: created.media_buy_id,
      revision: created.revision,
      canceled: true,
      name: 'Ignored rename',
      packages: [{ package_id: firstId, budget: 1, [FIELD]: true }],
      new_packages: [{ ...PRODUCT, budget: 1, [FIELD]: true }],
    });
    expect(result.errors).toBeUndefined();
    expect(result.media_buy_status).toBe('canceled');
    const current = await read(created.media_buy_id as string);
    expect(current.name).toBe('Nova launch');
    expect((current.packages as Result[]).map(pkg => pkg.budget)).toEqual([10_000, 10_000]);
    expect((current.packages as Result[]).every(pkg => (pkg.creative_approvals as unknown[]).length === 0)).toBe(true);
  });

  it.each([
    ['3.3 candidate', CANDIDATE_CTX, false],
    ['3.2 stable', STABLE_CTX, undefined],
  ] as const)('reports only the effective policy defined by the %s served release', async (_label, ctx, expected) => {
    const created = await direct(handleCreateMediaBuy, createArgs({
      packages: [{ ...PRODUCT, budget: 10_000, [FIELD]: false }],
    }), ctx);
    expect(created.errors).toBeUndefined();
    expect((created.packages as Result[])[0]![FIELD]).toBe(expected);
    const [packageId] = packageIds(created);
    const updated = await direct(handleUpdateMediaBuy, {
      media_buy_id: created.media_buy_id,
      revision: created.revision,
      packages: [{ package_id: packageId, budget: 8_000, [FIELD]: false }],
    }, ctx);
    expect(updated.errors).toBeUndefined();
    expect((updated.affected_packages as Result[])[0]![FIELD]).toBe(expected);
    const current = await read(created.media_buy_id as string, ctx);
    expect((current.packages as Result[])[0]![FIELD]).toBe(expected);
  });

  it('rejects the same unsupported true through compact package control', async () => {
    const created = await direct(handleCreateMediaBuy, createArgs());
    const [packageId] = packageIds(created);
    const before = await snapshot();
    const result = await direct((args, ctx) => handleControlMediaBuy(
      args as Parameters<typeof handleControlMediaBuy>[0], ctx,
    ), {
      media_buy_id: created.media_buy_id,
      revision: created.revision,
      name: 'Ignored compact rename',
      packages: [{ package_id: packageId, paused: true, [FIELD]: true }],
    });
    expect(result).toMatchObject({ errors: [{ code: 'UNSUPPORTED_FEATURE', field: `packages[0].${FIELD}` }] });
    expect(await snapshot()).toEqual(before);
  });

  it('accepts compact false without requiring an unavailable creative-change action', async () => {
    const created = await direct(handleCreateMediaBuy, createArgs());
    const [packageId] = packageIds(created);
    const result = await direct((args, ctx) => handleControlMediaBuy(
      args as Parameters<typeof handleControlMediaBuy>[0], ctx,
    ), {
      media_buy_id: created.media_buy_id,
      revision: created.revision,
      packages: [{ package_id: packageId, [FIELD]: false }],
    });
    expect(result.errors).toBeUndefined();
    const current = await read(created.media_buy_id as string);
    expect((current.packages as Result[])[0]![FIELD]).toBe(false);
  });

  it.each([
    ['3.3 candidate', CANDIDATE_CTX, true],
    ['3.2 stable', STABLE_CTX, false],
  ] as const)('allows a pre-activation rejection cycle only on the %s served release', async (_label, ctx, allowed) => {
    const hold = await direct(handleComplyTestController, {
      scenario: 'force_media_buy_confirmation', params: { action: 'hold' },
    }, ctx);
    expect(hold.success).toBe(true);
    const created = await direct(handleCreateMediaBuy, createArgs(), ctx);
    expect(created.confirmed_at).toBeNull();
    const pending = await direct(handleComplyTestController, {
      scenario: 'force_media_buy_status',
      params: { media_buy_id: created.media_buy_id, status: 'pending_start' },
    }, ctx);
    expect(pending.success).toBe(true);
    const rejectedCreative = await direct(handleComplyTestController, {
      scenario: 'force_media_buy_status',
      params: { media_buy_id: created.media_buy_id, status: 'pending_creatives' },
    }, ctx);
    expect(rejectedCreative.success).toBe(allowed);
    if (allowed) expect(rejectedCreative.current_state).toBe('pending_creatives');
    else expect(rejectedCreative.error).toBe('INVALID_TRANSITION');
  });

  it.each(['active', 'paused'])('never permits an activated %s buy to rewind for creative rejection', async status => {
    const created = await direct(handleCreateMediaBuy, createArgs());
    const force = (next: string) => direct(handleComplyTestController, {
      scenario: 'force_media_buy_status',
      params: { media_buy_id: created.media_buy_id, status: next },
    });
    // A pause/resume sequence makes the controller's active lifecycle explicit
    // even though this fixture intentionally has no creative coverage.
    expect((await force('paused')).success).toBe(true);
    if (status === 'active') expect((await force('active')).success).toBe(true);
    expect((await read(created.media_buy_id as string)).status).toBe(status);
    const result = await force('pending_creatives');
    expect(result).toMatchObject({ success: false, error: 'INVALID_TRANSITION' });
    expect((await read(created.media_buy_id as string)).status).toBe(status);
  });
});
