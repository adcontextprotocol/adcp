/**
 * Training agent idempotency middleware — validates the behavior documented
 * in `docs/building/implementation/security.mdx` and the universal
 * `idempotency.yaml` compliance storyboard.
 *
 * Addresses #2346: the training agent previously declared
 * `adcp.idempotency.replay_ttl_seconds` in get_adcp_capabilities but did
 * NOT enforce the replay / conflict / expired semantics that declaration
 * implies — buyers building against the reference agent never observed
 * IDEMPOTENCY_CONFLICT or IDEMPOTENCY_EXPIRED and could silently double-book
 * on retry.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  createTrainingAgentServer,
  executeTrainingAgentTool,
  invalidateCache,
  clearTaskStore,
} from '../../src/training-agent/task-handlers.js';
import { clearSessions, getProductsSessionKeyFromArgs, getSession } from '../../src/training-agent/state.js';
import {
  MUTATING_TOOLS,
  REPLAY_TTL_SECONDS,
  clearIdempotencyCache,
  getIdempotencyStore,
} from '../../src/training-agent/idempotency.js';
import type { TrainingContext } from '../../src/training-agent/types.js';
import { getTrainingTaskStore } from '../../src/training-agent/mcp-task-store.js';

const CTX: TrainingContext = { mode: 'open', principal: 'test-principal' };

const ACCOUNT = { brand: { domain: 'idem-test.example' }, operator: 'idem-op' };
const BRAND = { domain: 'idem-test.example' };

async function call(
  server: ReturnType<typeof createTrainingAgentServer>,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ parsed: Record<string, unknown>; isError?: boolean }> {
  const requestHandlers = (server as any)._requestHandlers as Map<string, Function>;
  const handler = requestHandlers.get('tools/call');
  if (!handler) throw new Error('CallTool handler not found');
  const response = await handler(
    { method: 'tools/call', params: { name: toolName, arguments: args } },
    {},
  );
  const text = response.content?.[0]?.text;
  const parsed: Record<string, unknown> = response.structuredContent
    ? (response.structuredContent as Record<string, unknown>)
    : (text ? JSON.parse(text) : {});
  return { parsed, isError: response.isError };
}

async function callAsTask(
  server: ReturnType<typeof createTrainingAgentServer>,
  toolName: string,
  args: Record<string, unknown>,
  ttl = 60_000,
): Promise<{ parsed: Record<string, unknown>; isError?: boolean }> {
  const requestHandlers = (server as any)._requestHandlers as Map<string, Function>;
  const handler = requestHandlers.get('tools/call');
  if (!handler) throw new Error('CallTool handler not found');
  const response = await handler(
    { method: 'tools/call', params: { name: toolName, arguments: args, task: { ttl } } },
    {},
  );
  return {
    parsed: (response.structuredContent ?? response) as Record<string, unknown>,
    isError: response.isError,
  };
}

async function taskResult(
  server: ReturnType<typeof createTrainingAgentServer>,
  taskId: string,
): Promise<Record<string, unknown>> {
  const requestHandlers = (server as any)._requestHandlers as Map<string, Function>;
  const handler = requestHandlers.get('tasks/result');
  if (!handler) throw new Error('tasks/result handler not found');
  return handler({ method: 'tasks/result', params: { taskId } }, {});
}

const basePayload = () => ({
  account: ACCOUNT,
  brand: BRAND,
  start_time: 'asap',
  end_time: '2027-06-30T23:59:59Z',
  packages: [{ product_id: 'test-product', budget: 5000, pricing_option_id: 'test-pricing' }],
});

async function getValidProductAndPricing(
  server: ReturnType<typeof createTrainingAgentServer>,
): Promise<{ productId: string; pricingOptionId: string }> {
  const { parsed } = await call(server, 'get_products', {
    idempotency_key: `catalog-${randomUUID()}`,
    buying_mode: 'wholesale',
    account: ACCOUNT,
    brand: BRAND,
  });
  const products = (parsed as { products?: Array<{ product_id: string; pricing_options: Array<{ pricing_option_id: string }> }> }).products ?? [];
  if (!products.length) throw new Error('no products in catalog');
  return {
    productId: products[0].product_id,
    pricingOptionId: products[0].pricing_options[0].pricing_option_id,
  };
}

describe('training agent idempotency middleware', () => {
  let server: ReturnType<typeof createTrainingAgentServer>;

  beforeEach(() => {
    clearSessions();
    invalidateCache();
    clearTaskStore();
    clearIdempotencyCache();
    server = createTrainingAgentServer(CTX);
  });

  describe('missing / malformed key', () => {
    it('rejects create_media_buy with no idempotency_key → INVALID_REQUEST', async () => {
      const { productId, pricingOptionId } = await getValidProductAndPricing(server);
      const { parsed, isError } = await call(server, 'create_media_buy', {
        ...basePayload(),
        packages: [{ product_id: productId, budget: 5000, pricing_option_id: pricingOptionId }],
      });
      expect(isError).toBe(true);
      expect((parsed as any).adcp_error?.code).toBe('INVALID_REQUEST');
      expect((parsed as any).adcp_error?.field).toBe('idempotency_key');
    });

    it('rejects create_media_buy with too-short key → INVALID_REQUEST', async () => {
      const { productId, pricingOptionId } = await getValidProductAndPricing(server);
      const { parsed, isError } = await call(server, 'create_media_buy', {
        ...basePayload(),
        packages: [{ product_id: productId, budget: 5000, pricing_option_id: pricingOptionId }],
        idempotency_key: 'short',
      });
      expect(isError).toBe(true);
      expect((parsed as any).adcp_error?.code).toBe('INVALID_REQUEST');
    });

    it('keeps keyless get_products valid throughout 3.x', async () => {
      const { parsed, isError } = await call(server, 'get_products', {
        adcp_version: '3.1-rc.15',
        buying_mode: 'wholesale',
        account: ACCOUNT,
        brand: BRAND,
      });
      expect(isError).toBeFalsy();
      expect((parsed.products as unknown[])?.length).toBeGreaterThan(0);
    });

    it('still validates keyless legacy and list product reads', async () => {
      const legacy = await call(server, 'get_products', {
        buying_mode: 'not-a-mode',
        account: ACCOUNT,
      });
      expect(legacy.isError).toBe(true);
      expect((legacy.parsed as any).adcp_error).toMatchObject({
        code: 'INVALID_REQUEST',
        field: 'buying_mode',
      });

      const list = await call(server, 'list_products', {
        account: ACCOUNT,
        pagination: { max_results: 0 },
      });
      expect(list.isError).toBe(true);
      expect((list.parsed as any).adcp_error).toMatchObject({
        code: 'INVALID_REQUEST',
        field: 'pagination.max_results',
      });
    });

    it('accepts and ignores callback configuration on synchronous list_products', async () => {
      const result = await call(server, 'list_products', {
        account: ACCOUNT,
        push_notification_config: {
          url: 'https://callbacks.example/list-products',
          operation_id: 'list-products-wrapper-envelope',
        },
      });
      expect(result.isError).toBeFalsy();
      expect(result.parsed.products).toEqual(expect.any(Array));
    });

    it('adapts only served-3.0 missing-key get_products requests to safe deterministic replay', async () => {
      const legacyPayload = {
        adcp_version: '3.0',
        buying_mode: 'wholesale',
        account: ACCOUNT,
        brand: BRAND,
      };
      const first = await call(server, 'get_products', {
        ...legacyPayload,
        context: { correlation_id: 'legacy-first' },
      });
      const replay = await call(server, 'get_products', {
        ...legacyPayload,
        adcp_major_version: 3,
        context: { correlation_id: 'legacy-retry' },
      });
      expect(first.isError).toBeFalsy();
      expect(replay.isError).toBeFalsy();
      expect(replay.parsed.replayed).toBe(true);
      expect((replay.parsed.context as { correlation_id?: string })?.correlation_id).toBe('legacy-retry');
      expect(replay.parsed.products).toEqual(first.parsed.products);

      // A materially changed legacy request gets a different derived key; it
      // executes independently instead of aliasing or conflicting.
      const changed = await call(server, 'get_products', {
        ...legacyPayload,
        buying_mode: 'brief',
        brief: 'A distinct legacy discovery request',
      });
      expect(changed.isError).toBeFalsy();
      expect(changed.parsed.replayed).toBeUndefined();
      expect(changed.parsed.products).toBeDefined();
    });

    it('routes served-3.0 compatibility requests through task replay and finalize validation', async () => {
      const legacyTask = {
        adcp_version: '3.0',
        buying_mode: 'wholesale',
        account: ACCOUNT,
      };
      const first = await callAsTask(server, 'get_products', legacyTask);
      const replay = await callAsTask(server, 'get_products', legacyTask);
      expect((replay.parsed.task as { taskId?: string })?.taskId)
        .toBe((first.parsed.task as { taskId?: string })?.taskId);
      expect(replay.parsed.replayed).toBe(true);

      const mixed = await call(server, 'get_products', {
        adcp_version: '3.0',
        buying_mode: 'refine',
        account: ACCOUNT,
        refine: [
          { scope: 'proposal', action: 'finalize', proposal_id: 'pinnacle_cross_channel' },
          { scope: 'proposal', action: 'include', proposal_id: 'pinnacle_cross_channel' },
        ],
      });
      expect(mixed.isError).toBe(true);
      expect((mixed.parsed as any).adcp_error).toMatchObject({
        code: 'INVALID_REQUEST',
        field: 'refine[1]',
      });
    });
  });

  describe('replay with same key + same payload', () => {
    it('returns the cached media_buy_id with replayed: true', async () => {
      const { productId, pricingOptionId } = await getValidProductAndPricing(server);
      const key = `idem-${randomUUID()}`;
      const payload = {
        ...basePayload(),
        packages: [{ product_id: productId, budget: 5000, pricing_option_id: pricingOptionId }],
        idempotency_key: key,
      };

      const first = await call(server, 'create_media_buy', payload);
      expect(first.isError).toBeFalsy();
      const originalMediaBuyId = (first.parsed as any).media_buy_id;
      expect(originalMediaBuyId).toBeTruthy();
      // Fresh execution: `replayed` should be false or omitted
      expect((first.parsed as any).replayed ?? false).toBe(false);

      // Replay with the same key and the same payload
      const second = await call(server, 'create_media_buy', { ...payload });
      expect(second.isError).toBeFalsy();
      expect((second.parsed as any).media_buy_id).toBe(originalMediaBuyId);
      expect((second.parsed as any).replayed).toBe(true);
    });

    it('echoes a fresh context block on replay (envelope-level, not cached)', async () => {
      const { productId, pricingOptionId } = await getValidProductAndPricing(server);
      const key = `idem-${randomUUID()}`;
      const payload = {
        ...basePayload(),
        packages: [{ product_id: productId, budget: 5000, pricing_option_id: pricingOptionId }],
        idempotency_key: key,
        context: { correlation_id: 'first-call' },
      };

      await call(server, 'create_media_buy', payload);

      const replay = await call(server, 'create_media_buy', {
        ...payload,
        context: { correlation_id: 'retry-call' },
      });
      // Context is excluded from the canonical hash (see EXCLUDED_FROM_HASH),
      // so retry with a different correlation_id is still a replay. Envelope
      // context echoes the NEW correlation_id, not the cached one.
      expect((replay.parsed as any).replayed).toBe(true);
      expect((replay.parsed as any).context?.correlation_id).toBe('retry-call');
    });

    it('treats governance_context as excluded from the hash (retry with new delegation)', async () => {
      const buyerUrl = 'https://buyer.example';
      const governedServer = createTrainingAgentServer({
        ...CTX,
        tenantId: 'sales',
        authenticatedAgentUrl: buyerUrl,
      });
      const { productId, pricingOptionId } = await getValidProductAndPricing(governedServer);
      const key = `idem-${randomUUID()}`;
      const payload = {
        ...basePayload(),
        packages: [{ product_id: productId, budget: 5000, pricing_option_id: pricingOptionId }],
        idempotency_key: key,
      };
      const planId = `plan-${randomUUID()}`;
      await call(governedServer, 'sync_plans', {
        idempotency_key: `sync-${randomUUID()}`,
        brand: BRAND,
        plans: [{
          plan_id: planId,
          brand: BRAND,
          objectives: 'Exercise governance-context idempotency exclusion.',
          budget: { total: 20_000, currency: 'USD', reallocation_threshold: 20_000 },
          flight: { start: '2026-01-01T00:00:00Z', end: '2027-12-31T23:59:59Z' },
        }],
      });
      const approve = async () => (await call(governedServer, 'check_governance', {
        idempotency_key: `check-${randomUUID()}`,
        brand: BRAND,
        plan_id: planId,
        caller: buyerUrl,
        target_agent: 'http://localhost/sales',
        tool: 'create_media_buy',
        payload,
      })).parsed.governance_context;
      const firstContext = await approve();
      const secondContext = await approve();
      expect(firstContext).toEqual(expect.any(String));
      expect(secondContext).toEqual(expect.any(String));
      expect(secondContext).not.toBe(firstContext);

      const first = await call(governedServer, 'create_media_buy', {
        ...payload,
        governance_context: firstContext,
      });
      expect(first.isError).toBeFalsy();
      const replay = await call(governedServer, 'create_media_buy', {
        ...payload,
        governance_context: secondContext,
      });
      expect((replay.parsed as any).replayed).toBe(true);
    });

    it('replays a task-augmented get_products response without allocating another task', async () => {
      const key = `products-task-${randomUUID()}`;
      const payload = {
        idempotency_key: key,
        buying_mode: 'wholesale',
        account: ACCOUNT,
        brand: BRAND,
      };

      const first = await callAsTask(server, 'get_products', payload);
      const firstTaskId = (first.parsed.task as { taskId?: string })?.taskId;
      expect(firstTaskId).toBeTruthy();

      const replay = await callAsTask(server, 'get_products', { ...payload });
      expect((replay.parsed.task as { taskId?: string })?.taskId).toBe(firstTaskId);
      expect(replay.parsed.replayed).toBe(true);

      const conflict = await call(server, 'get_products', {
        ...payload,
        buying_mode: 'brief',
        brief: 'different logical request',
      });
      expect(conflict.isError).toBe(true);
      expect((conflict.parsed as any).adcp_error?.code).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('shares replay identity between legacy wholesale discovery and list_products', async () => {
      const key = `products-list-alias-${randomUUID()}`;
      const shared = {
        idempotency_key: key,
        adcp_version: '3.2-beta.0',
        account: ACCOUNT,
        brand: BRAND,
      };

      const first = await call(server, 'get_products', {
        ...shared,
        buying_mode: 'wholesale',
      });
      expect(first.isError).toBeFalsy();

      const replay = await call(server, 'list_products', shared);
      expect(replay.isError).toBeFalsy();
      expect(replay.parsed.replayed).toBe(true);
      expect(replay.parsed.products).toEqual(first.parsed.products);

      const conflict = await call(server, 'list_products', {
        ...shared,
        fields: ['product_id'],
      });
      expect(conflict.isError).toBe(true);
      expect((conflict.parsed as any).adcp_error?.code).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('treats caller-supplied version pins as part of product request identity', async () => {
      const key = `products-version-pin-${randomUUID()}`;
      const first = await call(server, 'get_products', {
        idempotency_key: key,
        adcp_version: '3.1-rc.15',
        buying_mode: 'wholesale',
        account: ACCOUNT,
      });
      expect(first.isError).toBeFalsy();

      const conflict = await call(server, 'get_products', {
        idempotency_key: key,
        adcp_version: '3.2-beta.0',
        buying_mode: 'wholesale',
        account: ACCOUNT,
      });
      expect(conflict.isError).toBe(true);
      expect((conflict.parsed as any).adcp_error?.code).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('does not replay unpinned product aliases across different effective releases', async () => {
      const shared = {
        idempotency_key: `products-effective-version-${randomUUID()}`,
        account: ACCOUNT,
      };
      const legacy = await call(server, 'get_products', {
        ...shared,
        buying_mode: 'wholesale',
      });
      expect(legacy.isError).toBeFalsy();

      const split = await call(server, 'list_products', shared);
      expect(split.isError).toBe(true);
      expect((split.parsed as any).adcp_error?.code).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('reuses one task receipt when a brief retry switches to recommend_products', async () => {
      const key = `products-recommend-task-alias-${randomUUID()}`;
      const shared = {
        idempotency_key: key,
        adcp_version: '3.2-beta.0',
        account: ACCOUNT,
        brand: BRAND,
        brief: 'cross-channel news video and display',
      };

      const first = await callAsTask(server, 'get_products', {
        ...shared,
        buying_mode: 'brief',
      });
      const firstTaskId = (first.parsed.task as { taskId?: string })?.taskId;
      expect(firstTaskId).toBeTruthy();

      const replay = await callAsTask(server, 'recommend_products', shared);
      expect((replay.parsed.task as { taskId?: string })?.taskId).toBe(firstTaskId);
      expect(replay.parsed.replayed).toBe(true);
    });

    it('projects one cached product result across inline then task execution modes', async () => {
      const shared = {
        idempotency_key: `products-inline-task-${randomUUID()}`,
        adcp_version: '3.2-beta.0',
        account: ACCOUNT,
        brief: 'cross-channel sports',
      };
      const inline = await call(server, 'recommend_products', shared);
      expect(inline.isError).toBeFalsy();

      const task = await callAsTask(server, 'recommend_products', shared);
      expect(task.isError).toBeFalsy();
      expect(task.parsed).toMatchObject({
        replayed: true,
        task: { taskId: expect.any(String), status: 'completed' },
      });
      const result = await taskResult(server, (task.parsed.task as { taskId: string }).taskId);
      expect(result.structuredContent).toMatchObject({ products: inline.parsed.products });
    });

    it('projects one cached product result across task then inline execution modes', async () => {
      const shared = {
        idempotency_key: `products-task-inline-${randomUUID()}`,
        adcp_version: '3.2-beta.0',
        account: ACCOUNT,
        brief: 'cross-channel news',
      };
      const task = await callAsTask(server, 'recommend_products', shared);
      expect(task.parsed.task).toMatchObject({ taskId: expect.any(String), status: 'completed' });

      const inline = await call(server, 'recommend_products', shared);
      expect(inline.isError).toBeFalsy();
      expect(inline.parsed).toMatchObject({ replayed: true, products: expect.any(Array) });
      expect(inline.parsed).not.toHaveProperty('task');
    });

    it('validates the complete get_products payload before consulting the cache', async () => {
      const key = `products-schema-first-${randomUUID()}`;
      await call(server, 'get_products', {
        idempotency_key: key,
        buying_mode: 'wholesale',
        account: ACCOUNT,
      });
      const invalid = await call(server, 'get_products', {
        idempotency_key: key,
        buying_mode: 'not-a-mode',
        account: ACCOUNT,
      });
      expect(invalid.isError).toBe(true);
      expect((invalid.parsed as any).adcp_error?.code).toBe('INVALID_REQUEST');
      expect((invalid.parsed as any).adcp_error?.code).not.toBe('IDEMPOTENCY_CONFLICT');
    });

    it('rejects mixed proposal finalization before reserving the idempotency key', async () => {
      const account = { brand: { domain: 'idem-finalize-exclusive.example' }, operator: 'idem-op' };
      await call(server, 'get_products', {
        idempotency_key: `products-brief-${randomUUID()}`,
        buying_mode: 'brief',
        brief: 'cross-channel news video and display',
        account,
      });
      const key = `products-finalize-exclusive-${randomUUID()}`;
      const invalid = await call(server, 'get_products', {
        idempotency_key: key,
        buying_mode: 'refine',
        account,
        refine: [
          { scope: 'proposal', action: 'finalize', proposal_id: 'pinnacle_cross_channel' },
          { scope: 'proposal', action: 'include', proposal_id: 'pinnacle_cross_channel' },
        ],
      });
      expect(invalid.isError).toBe(true);
      expect((invalid.parsed as any).adcp_error).toMatchObject({
        code: 'INVALID_REQUEST',
        field: 'refine[1]',
      });

      // The invalid request never reserved the key, so the corrected finalize
      // can use that same key without IDEMPOTENCY_CONFLICT.
      const corrected = await call(server, 'get_products', {
        idempotency_key: key,
        buying_mode: 'refine',
        account,
        refine: [{ scope: 'proposal', action: 'finalize', proposal_id: 'pinnacle_cross_channel' }],
      });
      expect(corrected.isError).toBeFalsy();
      expect((corrected.parsed.proposals as Array<Record<string, unknown>>)
        .find(proposal => proposal.proposal_id === 'pinnacle_cross_channel'))
        .toMatchObject({ proposal_status: 'committed' });
    });

    it('allocates a fresh task when a released error key is retried with corrected input', async () => {
      const key = `products-task-correction-${randomUUID()}`;
      const failed = await callAsTask(server, 'get_products', {
        idempotency_key: key,
        buying_mode: 'refine',
        account: ACCOUNT,
        refine: [{ scope: 'proposal', action: 'finalize', proposal_id: 'proposal-does-not-exist' }],
      });
      const failedTaskId = (failed.parsed.task as { taskId?: string })?.taskId;
      expect(failedTaskId).toBeTruthy();

      const correctedPayload = {
        idempotency_key: key,
        buying_mode: 'wholesale',
        account: ACCOUNT,
      };
      const corrected = await callAsTask(server, 'get_products', correctedPayload);
      const correctedTaskId = (corrected.parsed.task as { taskId?: string })?.taskId;
      expect(correctedTaskId).toBeTruthy();
      expect(correctedTaskId).not.toBe(failedTaskId);

      const replay = await callAsTask(server, 'get_products', correctedPayload);
      expect((replay.parsed.task as { taskId?: string })?.taskId).toBe(correctedTaskId);
      expect(replay.parsed.replayed).toBe(true);
    });

    it('allocates a fresh task when the exact failed payload later succeeds', async () => {
      const account = { brand: { domain: 'idem-task-recovery.example' }, operator: 'idem-op' };
      await call(server, 'get_products', {
        idempotency_key: `products-brief-${randomUUID()}`,
        buying_mode: 'brief',
        brief: 'cross-channel news video and display',
        account,
      });
      const payloads = [
        {
          idempotency_key: `products-task-finalize-left-${randomUUID()}`,
          buying_mode: 'refine',
          account,
          refine: [{ scope: 'proposal', action: 'finalize', proposal_id: 'pinnacle_cross_channel' }],
        },
        {
          idempotency_key: `products-task-finalize-right-${randomUUID()}`,
          buying_mode: 'refine',
          account,
          refine: [{ scope: 'proposal', action: 'finalize', proposal_id: 'pinnacle_cross_channel' }],
        },
      ];
      const firstAttempts = await Promise.all(payloads.map(payload => callAsTask(server, 'get_products', payload)));
      const firstResults = await Promise.all(firstAttempts.map(async attempt => {
        const taskId = (attempt.parsed.task as { taskId: string }).taskId;
        return { taskId, result: await taskResult(server, taskId) };
      }));
      const failedIndex = firstResults.findIndex(({ result }) => result.isError === true);
      expect(failedIndex).toBeGreaterThanOrEqual(0);
      expect((firstResults[failedIndex]!.result.structuredContent as any)?.adcp_error?.code).toBe('CONFLICT');

      const recovered = await callAsTask(server, 'get_products', payloads[failedIndex]!);
      const recoveredTaskId = (recovered.parsed.task as { taskId: string }).taskId;
      expect(recoveredTaskId).not.toBe(firstResults[failedIndex]!.taskId);
      const recoveredResult = await taskResult(server, recoveredTaskId);
      expect(recoveredResult.isError).not.toBe(true);
      expect((recoveredResult.structuredContent as { proposals?: unknown[] } | undefined)?.proposals?.length)
        .toBeGreaterThan(0);

      const replay = await callAsTask(server, 'get_products', payloads[failedIndex]!);
      expect((replay.parsed.task as { taskId: string }).taskId).toBe(recoveredTaskId);
      expect(replay.parsed.replayed).toBe(true);
    });

    it('does not rerun or cache success for a cancelled orphan task', async () => {
      const key = `products-task-cancelled-orphan-${randomUUID()}`;
      const payload = {
        idempotency_key: key,
        brief: 'A retry-safe campaign recommendation',
        account: ACCOUNT,
      };
      const taskStore = getTrainingTaskStore();
      const storeFailure = vi.spyOn(taskStore, 'storeTaskResult')
        .mockRejectedValueOnce(new Error('injected task-result persistence failure'));

      await expect(callAsTask(server, 'recommend_products', payload))
        .rejects.toThrow('injected task-result persistence failure');
      storeFailure.mockRestore();

      const orphan = (await taskStore.listTasks()).tasks.find(task => task.status === 'working');
      expect(orphan?.taskId).toBeTruthy();
      await taskStore.updateTaskStatus(orphan!.taskId, 'cancelled', 'cancelled by buyer');

      const cancelledRetry = await callAsTask(server, 'recommend_products', payload);
      expect(cancelledRetry.parsed).toMatchObject({
        replayed: true,
        task: { taskId: orphan!.taskId, status: 'cancelled' },
      });

      // The cancelled receipt released the cache claim instead of publishing
      // a hidden success. A later inline request therefore executes normally.
      const inlineRetry = await call(server, 'recommend_products', payload);
      expect(inlineRetry.isError).not.toBe(true);
      expect(inlineRetry.parsed.replayed).toBeUndefined();

      const taskReplay = await callAsTask(server, 'recommend_products', payload);
      const replacementTask = taskReplay.parsed.task as { taskId: string; status: string };
      expect(replacementTask).toMatchObject({ status: 'completed' });
      expect(replacementTask.taskId).not.toBe(orphan!.taskId);
      const replacementResult = await taskResult(server, replacementTask.taskId);
      expect(replacementResult.isError).not.toBe(true);
      expect((replacementResult.structuredContent as { proposals?: unknown[] })?.proposals?.length)
        .toBeGreaterThan(0);

      const stableReplay = await callAsTask(server, 'recommend_products', payload);
      expect(stableReplay.parsed).toMatchObject({
        replayed: true,
        task: { taskId: replacementTask.taskId, status: 'completed' },
      });
    });

    it('does not collapse identical non-idempotency-protected task calls', async () => {
      const first = await callAsTask(server, 'get_signals', {});
      const second = await callAsTask(server, 'get_signals', {});
      expect((first.parsed.task as { taskId: string }).taskId).not.toBe(
        (second.parsed.task as { taskId: string }).taskId,
      );
    });

    it('recovers a persisted successful task before rerunning the handler after cache-save failure', async () => {
      const { productId, pricingOptionId } = await getValidProductAndPricing(server);
      const key = `products-task-cache-failure-${randomUUID()}`;
      const payload = {
        ...basePayload(),
        packages: [{ product_id: productId, budget: 5000, pricing_option_id: pricingOptionId }],
        idempotency_key: key,
      };
      const store = getIdempotencyStore();
      const saveFailure = vi.spyOn(store, 'save').mockRejectedValueOnce(new Error('injected cache save failure'));
      vi.useFakeTimers();
      try {
        const requestedTtl = 25;
        await expect(callAsTask(server, 'create_media_buy', payload, requestedTtl))
          .rejects.toThrow('injected cache save failure');

        // The public task request suggested a 25ms lifetime, but MCP permits
        // servers to override that suggestion. Successful idempotency receipts
        // report and retain the actual replay-window TTL; ordinary tasks still
        // honor their short requested lifetime.
        const ordinary = await callAsTask(server, 'get_signals', {}, requestedTtl);
        expect((ordinary.parsed.task as { ttl?: number }).ttl).toBe(requestedTtl);
        await vi.advanceTimersByTimeAsync(1_000);

        const recovered = await callAsTask(server, 'create_media_buy', {
          ...payload,
          context: { correlation_id: 'cache-recovery-retry' },
        }, requestedTtl);
        expect((recovered.parsed.task as { ttl?: number }).ttl)
          .toBeGreaterThanOrEqual((REPLAY_TTL_SECONDS + 60) * 1000);
        expect(recovered.parsed.replayed).toBe(true);
        expect((recovered.parsed.context as { correlation_id?: string })?.correlation_id)
          .toBe('cache-recovery-retry');
        const recoveredTaskId = (recovered.parsed.task as { taskId: string }).taskId;
        const recoveredResult = await taskResult(server, recoveredTaskId);
        const originalMediaBuyId = (recoveredResult.structuredContent as { media_buy_id?: string })?.media_buy_id;
        expect(originalMediaBuyId).toBeTruthy();

        const persistedSession = await getSession(getProductsSessionKeyFromArgs({ account: ACCOUNT }, 'open'));
        expect(persistedSession.mediaBuys.size).toBe(1);
        expect([...persistedSession.mediaBuys.keys()]).toEqual([originalMediaBuyId]);
        expect(saveFailure).toHaveBeenCalledTimes(2);
      } finally {
        saveFailure.mockRestore();
        vi.useRealTimers();
      }
    });

    it('replays proposal finalization with the original hold and insertion order', async () => {
      const account = { brand: { domain: 'idem-finalize.example' }, operator: 'idem-op' };
      await call(server, 'get_products', {
        idempotency_key: `products-brief-${randomUUID()}`,
        buying_mode: 'brief',
        brief: 'cross-channel news video and display',
        account,
      });

      const key = `products-finalize-${randomUUID()}`;
      const payload = {
        idempotency_key: key,
        buying_mode: 'refine',
        account,
        refine: [{ scope: 'proposal', action: 'finalize', proposal_id: 'pinnacle_cross_channel' }],
      };
      const first = await call(server, 'get_products', payload);
      const firstProposal = (first.parsed.proposals as Array<Record<string, unknown>>)
        .find((proposal) => proposal.proposal_id === 'pinnacle_cross_channel');
      expect(firstProposal?.proposal_status).toBe('committed');
      expect(firstProposal?.expires_at).toBeTruthy();
      expect((firstProposal?.insertion_order as Record<string, unknown>)?.io_id).toBeTruthy();

      const replay = await call(server, 'get_products', { ...payload });
      const replayProposal = (replay.parsed.proposals as Array<Record<string, unknown>>)
        .find((proposal) => proposal.proposal_id === 'pinnacle_cross_channel');
      expect(replay.parsed.replayed).toBe(true);
      expect(replayProposal).toEqual(firstProposal);

      const conflict = await call(server, 'get_products', {
        ...payload,
        refine: [{
          scope: 'proposal',
          action: 'finalize',
          proposal_id: 'pinnacle_cross_channel',
          ask: 'changed payload',
        }],
      });
      expect(conflict.isError).toBe(true);
      expect((conflict.parsed as any).adcp_error?.code).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('preserves the exact committed proposal across later brief, wholesale, and refine discovery', async () => {
      const account = { brand: { domain: 'idem-finalize-discovery.example' }, operator: 'idem-op' };
      const finalize = (idempotencyKey: string) => call(server, 'get_products', {
        idempotency_key: idempotencyKey,
        buying_mode: 'refine',
        account,
        refine: [{ scope: 'proposal', action: 'finalize', proposal_id: 'pinnacle_cross_channel' }],
      });

      const first = await finalize(`products-finalize-first-${randomUUID()}`);
      const firstProposal = (first.parsed.proposals as Array<Record<string, unknown>>)
        .find(proposal => proposal.proposal_id === 'pinnacle_cross_channel');
      expect(firstProposal).toMatchObject({ proposal_status: 'committed' });

      await call(server, 'get_products', {
        idempotency_key: `products-later-brief-${randomUUID()}`,
        buying_mode: 'brief',
        brief: 'podcast audio inventory',
        account,
      });
      const wholesale = await call(server, 'get_products', {
        idempotency_key: `products-later-wholesale-${randomUUID()}`,
        buying_mode: 'wholesale',
        account,
      });
      expect(wholesale.parsed.proposals).toBeUndefined();
      await call(server, 'get_products', {
        idempotency_key: `products-later-refine-${randomUUID()}`,
        buying_mode: 'refine',
        account,
        refine: [{
          scope: 'proposal',
          action: 'include',
          proposal_id: 'pinnacle_cross_channel',
          ask: 'Use concrete fixed CPM pricing',
        }],
      });

      const freshFinalize = await finalize(`products-finalize-fresh-${randomUUID()}`);
      const freshProposal = (freshFinalize.parsed.proposals as Array<Record<string, unknown>>)
        .find(proposal => proposal.proposal_id === 'pinnacle_cross_channel');
      expect(freshProposal).toEqual(firstProposal);
      expect(freshProposal?.expires_at).toBe(firstProposal?.expires_at);
      expect(freshProposal?.insertion_order).toEqual(firstProposal?.insertion_order);
    });

    it('rejects a malformed product cursor without changing committed proposal state', async () => {
      const domain = 'idem-finalize-cursor.example';
      const account = { brand: { domain }, operator: 'idem-op' };
      const finalize = (idempotencyKey: string) => call(server, 'get_products', {
        idempotency_key: idempotencyKey,
        buying_mode: 'refine',
        account,
        refine: [{ scope: 'proposal', action: 'finalize', proposal_id: 'pinnacle_cross_channel' }],
      });
      const first = await finalize(`products-cursor-finalize-${randomUUID()}`);
      const firstProposal = (first.parsed.proposals as Array<Record<string, unknown>>)
        .find(proposal => proposal.proposal_id === 'pinnacle_cross_channel');
      const sessionKey = getProductsSessionKeyFromArgs({ account }, 'open');
      const before = (await getSession(sessionKey)).lastGetProductsContext?.proposals;

      const malformed = await call(server, 'get_products', {
        idempotency_key: `products-malformed-cursor-${randomUUID()}`,
        buying_mode: 'wholesale',
        account,
        pagination: { cursor: 'not-a-products-cursor', max_results: 1 },
      });
      expect(malformed.isError).toBe(true);
      expect((malformed.parsed as any).adcp_error).toMatchObject({
        code: 'INVALID_REQUEST',
        field: 'pagination.cursor',
      });
      expect((await getSession(sessionKey)).lastGetProductsContext?.proposals).toEqual(before);

      const freshFinalize = await finalize(`products-cursor-refinalize-${randomUUID()}`);
      const freshProposal = (freshFinalize.parsed.proposals as Array<Record<string, unknown>>)
        .find(proposal => proposal.proposal_id === 'pinnacle_cross_channel');
      expect(freshProposal).toEqual(firstProposal);
    });

    it('allows parallel brief discovery reads in the same session', async () => {
      const account = { brand: { domain: 'idem-concurrent-brief.example' }, operator: 'idem-op' };
      const payloads = [
        'cross-channel news video and display',
        'podcast audio inventory',
        'premium streaming video',
      ].map((brief, index) => ({
        idempotency_key: `products-brief-${index}-${randomUUID()}`,
        buying_mode: 'brief',
        brief,
        account,
      }));

      const outcomes = await Promise.all(payloads.map(payload => call(server, 'get_products', payload)));

      expect(outcomes.every(outcome => outcome.isError !== true)).toBe(true);
      expect(outcomes.every(outcome => Array.isArray(outcome.parsed.products))).toBe(true);
    });

    it('does not let concurrent brief discovery conflict with or erase finalization', async () => {
      const account = { brand: { domain: 'idem-concurrent-read-finalize.example' }, operator: 'idem-op' };
      const finalizePayload = {
        idempotency_key: `products-finalize-${randomUUID()}`,
        buying_mode: 'refine',
        account,
        refine: [{ scope: 'proposal', action: 'finalize', proposal_id: 'pinnacle_cross_channel' }],
      };
      const briefPayload = {
        idempotency_key: `products-brief-${randomUUID()}`,
        buying_mode: 'brief',
        brief: 'cross-channel news video and display',
        account,
      };

      const [finalized, discovered] = await Promise.all([
        call(server, 'get_products', finalizePayload),
        call(server, 'get_products', briefPayload),
      ]);

      expect(finalized.isError).toBeFalsy();
      expect(discovered.isError).toBeFalsy();
      const persisted = (await getSession(getProductsSessionKeyFromArgs({ account }, 'open')))
        .lastGetProductsContext?.proposals?.find(proposal => proposal.proposal_id === 'pinnacle_cross_channel');
      expect(persisted).toMatchObject({ proposal_status: 'committed' });
    });

    it('does not let concurrent wholesale discovery conflict with or erase finalization', async () => {
      const account = { brand: { domain: 'idem-concurrent-wholesale-finalize.example' }, operator: 'idem-op' };
      const finalizePayload = {
        idempotency_key: `products-finalize-${randomUUID()}`,
        buying_mode: 'refine',
        account,
        refine: [{ scope: 'proposal', action: 'finalize', proposal_id: 'pinnacle_cross_channel' }],
      };
      const wholesalePayload = {
        idempotency_key: `products-wholesale-${randomUUID()}`,
        buying_mode: 'wholesale',
        account,
      };

      const [finalized, discovered] = await Promise.all([
        call(server, 'get_products', finalizePayload),
        call(server, 'get_products', wholesalePayload),
      ]);

      expect(finalized.isError).toBeFalsy();
      expect(discovered.isError).toBeFalsy();
      const finalizedProposal = (finalized.parsed.proposals as Array<Record<string, unknown>>)
        .find(proposal => proposal.proposal_id === 'pinnacle_cross_channel');
      const persisted = (await getSession(getProductsSessionKeyFromArgs({ account }, 'open')))
        .lastGetProductsContext?.proposals?.find(proposal => proposal.proposal_id === 'pinnacle_cross_channel');
      expect(persisted).toEqual(finalizedProposal);
      expect(persisted).toMatchObject({ proposal_status: 'committed' });
    });

    it('serializes parallel proposal-finalize retries into one execution and one replay', async () => {
      const account = { brand: { domain: 'idem-concurrent-finalize.example' }, operator: 'idem-op' };
      await call(server, 'get_products', {
        idempotency_key: `products-brief-${randomUUID()}`,
        buying_mode: 'brief',
        brief: 'cross-channel news video and display',
        account,
      });
      const payload = {
        idempotency_key: `products-finalize-${randomUUID()}`,
        buying_mode: 'refine',
        account,
        refine: [{ scope: 'proposal', action: 'finalize', proposal_id: 'pinnacle_cross_channel' }],
      };

      const [left, right] = await Promise.all([
        call(server, 'get_products', payload),
        call(server, 'get_products', payload),
      ]);
      const outcomes = [left, right];
      expect(outcomes.filter((outcome) => outcome.isError !== true)).toHaveLength(1);
      const successful = outcomes.find((outcome) => outcome.isError !== true)!;
      const limited = outcomes.find((outcome) => outcome.isError === true)!;
      expect((limited.parsed as any).adcp_error).toMatchObject({
        code: 'IDEMPOTENCY_IN_FLIGHT',
        retry_after: expect.any(Number),
      });

      const replay = await call(server, 'get_products', payload);
      expect(replay.parsed.replayed).toBe(true);
      const successfulProposal = (successful.parsed.proposals as Array<Record<string, unknown>>)
        .find((proposal) => proposal.proposal_id === 'pinnacle_cross_channel');
      const replayProposal = (replay.parsed.proposals as Array<Record<string, unknown>>)
        .find((proposal) => proposal.proposal_id === 'pinnacle_cross_channel');
      expect(replayProposal).toEqual(successfulProposal);
    });

    it('serializes proposal finalization across distinct request keys', async () => {
      const account = { brand: { domain: 'idem-distinct-finalize.example' }, operator: 'idem-op' };
      await call(server, 'get_products', {
        idempotency_key: `products-brief-${randomUUID()}`,
        buying_mode: 'brief',
        brief: 'cross-channel news video and display',
        account,
      });
      const base = {
        buying_mode: 'refine',
        account,
        refine: [{ scope: 'proposal', action: 'finalize', proposal_id: 'pinnacle_cross_channel' }],
      };
      const payloads = [
        { ...base, idempotency_key: `products-finalize-left-${randomUUID()}` },
        { ...base, idempotency_key: `products-finalize-right-${randomUUID()}` },
      ];
      const outcomes = await Promise.all(payloads.map(payload => call(server, 'get_products', payload)));
      const successful = outcomes.find(outcome => outcome.isError !== true)!;
      const limitedIndex = outcomes.findIndex(outcome => outcome.isError === true);
      expect(successful).toBeTruthy();
      expect(limitedIndex).toBeGreaterThanOrEqual(0);
      expect((outcomes[limitedIndex]!.parsed as any).adcp_error?.code).toBe('CONFLICT');

      const retry = await call(server, 'get_products', payloads[limitedIndex]!);
      expect(retry.isError).toBeFalsy();
      const successfulProposal = (successful.parsed.proposals as Array<Record<string, unknown>>)
        .find(proposal => proposal.proposal_id === 'pinnacle_cross_channel');
      const retryProposal = (retry.parsed.proposals as Array<Record<string, unknown>>)
        .find(proposal => proposal.proposal_id === 'pinnacle_cross_channel');
      expect(retryProposal?.insertion_order).toEqual(successfulProposal?.insertion_order);
      expect(retryProposal?.expires_at).toBe(successfulProposal?.expires_at);
    });

    it('retains both proposals when concurrent disjoint finalizations retry after a session conflict', async () => {
      const domain = 'idem-disjoint-finalize.example';
      const account = { brand: { domain }, operator: 'idem-op' };
      const proposalIds = ['pinnacle_cross_channel', 'viewpoint_multi_screen'];
      const payloads = proposalIds.map((proposalId, index) => ({
        idempotency_key: `products-disjoint-finalize-${index}-${randomUUID()}`,
        buying_mode: 'refine',
        account,
        refine: [{ scope: 'proposal', action: 'finalize', proposal_id: proposalId }],
      }));

      const outcomes = await Promise.all(payloads.map(payload => call(server, 'get_products', payload)));
      const successfulIndex = outcomes.findIndex(outcome => outcome.isError !== true);
      const conflictedIndex = outcomes.findIndex(outcome => outcome.isError === true);
      expect(successfulIndex).toBeGreaterThanOrEqual(0);
      expect(conflictedIndex).toBeGreaterThanOrEqual(0);
      expect((outcomes[conflictedIndex]!.parsed as any).adcp_error?.code).toBe('CONFLICT');

      const successfulProposal = (outcomes[successfulIndex]!.parsed.proposals as Array<Record<string, unknown>>)
        .find(proposal => proposal.proposal_id === proposalIds[successfulIndex]);
      outcomes[conflictedIndex] = await call(server, 'get_products', payloads[conflictedIndex]!);
      expect(outcomes[conflictedIndex]!.isError).toBeFalsy();

      const persistedProposals = (await getSession(getProductsSessionKeyFromArgs({ account }, 'open')))
        .lastGetProductsContext?.proposals ?? [];
      for (const proposalId of proposalIds) {
        expect(persistedProposals.find(proposal => proposal.proposal_id === proposalId))
          .toMatchObject({ proposal_status: 'committed' });
      }
      expect(persistedProposals.find(proposal => proposal.proposal_id === proposalIds[successfulIndex]))
        .toEqual(successfulProposal);
    });

    it('serializes overlapping proposal-finalize sets without double-committing either proposal', async () => {
      const account = { brand: { domain: 'idem-overlap-finalize.example' }, operator: 'idem-op' };
      const singlePayload = {
        idempotency_key: `products-finalize-single-${randomUUID()}`,
        buying_mode: 'refine',
        account,
        refine: [
          { scope: 'proposal', action: 'finalize', proposal_id: 'pinnacle_cross_channel' },
        ],
      };
      const overlappingPayload = {
        idempotency_key: `products-finalize-overlap-${randomUUID()}`,
        buying_mode: 'refine',
        account,
        refine: [
          { scope: 'proposal', action: 'finalize', proposal_id: 'pinnacle_cross_channel' },
          { scope: 'proposal', action: 'finalize', proposal_id: 'viewpoint_multi_screen' },
        ],
      };
      const payloads = [singlePayload, overlappingPayload];
      const outcomes = await Promise.all(payloads.map(payload => call(server, 'get_products', payload)));
      const limitedIndex = outcomes.findIndex(outcome => outcome.isError === true);
      expect(limitedIndex).toBeGreaterThanOrEqual(0);
      expect((outcomes[limitedIndex]!.parsed as any).adcp_error?.code).toBe('CONFLICT');

      outcomes[limitedIndex] = await call(server, 'get_products', payloads[limitedIndex]!);
      expect(outcomes.every(outcome => outcome.isError !== true)).toBe(true);

      const singleReplay = await call(server, 'get_products', singlePayload);
      const overlappingReplay = await call(server, 'get_products', overlappingPayload);
      expect(singleReplay.parsed.replayed).toBe(true);
      expect(overlappingReplay.parsed.replayed).toBe(true);

      const proposal = (result: { parsed: Record<string, unknown> }, proposalId: string) => (
        result.parsed.proposals as Array<Record<string, unknown>>
      ).find(candidate => candidate.proposal_id === proposalId);
      const firstPinnacle = proposal(outcomes[0]!, 'pinnacle_cross_channel');
      const overlappingPinnacle = proposal(outcomes[1]!, 'pinnacle_cross_channel');
      const overlappingViewpoint = proposal(outcomes[1]!, 'viewpoint_multi_screen');
      expect(firstPinnacle?.proposal_status).toBe('committed');
      expect(overlappingPinnacle?.proposal_status).toBe('committed');
      expect(overlappingViewpoint?.proposal_status).toBe('committed');
      expect(proposal(singleReplay, 'pinnacle_cross_channel')).toEqual(firstPinnacle);
      expect(proposal(overlappingReplay, 'pinnacle_cross_channel')).toEqual(overlappingPinnacle);
      expect(proposal(overlappingReplay, 'viewpoint_multi_screen')).toEqual(overlappingViewpoint);
      expect(overlappingPinnacle?.insertion_order).toEqual(firstPinnacle?.insertion_order);
      expect(overlappingPinnacle?.expires_at).toBe(firstPinnacle?.expires_at);
    });
  });

  describe('in-process Addie dispatch', () => {
    it('honors optional get_products idempotency instead of bypassing the middleware', async () => {
      const ctx: TrainingContext = { mode: 'training', principal: 'addie-test' };
      const missing = await executeTrainingAgentTool('get_products', {
        buying_mode: 'wholesale',
        account: ACCOUNT,
      }, ctx);
      expect(missing.success).toBe(true);

      const payload = {
        idempotency_key: `addie-products-${randomUUID()}`,
        buying_mode: 'wholesale',
        account: ACCOUNT,
      };
      const first = await executeTrainingAgentTool('get_products', payload, ctx);
      const replay = await executeTrainingAgentTool('get_products', payload, ctx);
      expect(first.success).toBe(true);
      expect(replay.success).toBe(true);
      expect((replay.data as Record<string, unknown>).replayed).toBe(true);
      expect((replay.data as Record<string, unknown>).products)
        .toEqual((first.data as Record<string, unknown>).products);
    });

    it('caches advisory-success results and echoes the current replay context', async () => {
      const ctx: TrainingContext = { mode: 'open', principal: 'test-principal' };
      const directive = await call(server, 'comply_test_controller', {
        account: ACCOUNT,
        scenario: 'force_upstream_unavailable',
        params: { tool: 'get_products', upstream_name: 'catalog-test' },
      });
      expect((directive.parsed as { success?: boolean }).success).toBe(true);

      const key = `addie-advisory-${randomUUID()}`;
      const first = await executeTrainingAgentTool('get_products', {
        idempotency_key: key,
        buying_mode: 'wholesale',
        account: ACCOUNT,
        context: { correlation_id: 'advisory-first' },
      }, ctx);
      const replay = await executeTrainingAgentTool('get_products', {
        idempotency_key: key,
        buying_mode: 'wholesale',
        account: ACCOUNT,
        context: { correlation_id: 'advisory-retry' },
      }, ctx);
      expect(first.success).toBe(true);
      expect((first.data as any).errors?.[0]?.code).toBe('STALE_RESPONSE');
      expect((first.data as any).context?.correlation_id).toBe('advisory-first');
      expect(replay.success).toBe(true);
      expect((replay.data as any).replayed).toBe(true);
      expect((replay.data as any).errors).toEqual((first.data as any).errors);
      expect((replay.data as any).products).toEqual((first.data as any).products);
      expect((replay.data as any).context?.correlation_id).toBe('advisory-retry');
    });

    it('persists direct Addie finalization before publishing its replay', async () => {
      const ctx: TrainingContext = { mode: 'training', principal: 'addie-finalize-test' };
      const account = { brand: { domain: 'addie-finalize.example' }, operator: 'addie-op' };
      await executeTrainingAgentTool('get_products', {
        idempotency_key: `addie-brief-${randomUUID()}`,
        buying_mode: 'brief',
        brief: 'cross-channel news video and display',
        account,
      }, ctx);
      const finalize = (idempotencyKey: string) => executeTrainingAgentTool('get_products', {
        idempotency_key: idempotencyKey,
        buying_mode: 'refine',
        account,
        refine: [{ scope: 'proposal', action: 'finalize', proposal_id: 'pinnacle_cross_channel' }],
      }, ctx);
      const key = `addie-finalize-${randomUUID()}`;
      const first = await finalize(key);
      const replay = await finalize(key);
      const reloaded = await finalize(`addie-finalize-reload-${randomUUID()}`);
      expect(first.success).toBe(true);
      expect(replay.success).toBe(true);
      expect(reloaded.success).toBe(true);
      const proposal = (result: typeof first) => (
        (result.data as { proposals?: Array<Record<string, unknown>> }).proposals ?? []
      ).find(item => item.proposal_id === 'pinnacle_cross_channel');
      expect((replay.data as Record<string, unknown>).replayed).toBe(true);
      expect(proposal(reloaded)?.insertion_order).toEqual(proposal(first)?.insertion_order);
      expect(proposal(reloaded)?.expires_at).toBe(proposal(first)?.expires_at);
    });
  });

  describe('key reuse with different payload', () => {
    it('returns IDEMPOTENCY_CONFLICT when budget changes', async () => {
      const { productId, pricingOptionId } = await getValidProductAndPricing(server);
      const key = `idem-${randomUUID()}`;
      await call(server, 'create_media_buy', {
        ...basePayload(),
        packages: [{ product_id: productId, budget: 5000, pricing_option_id: pricingOptionId }],
        idempotency_key: key,
      });

      const conflict = await call(server, 'create_media_buy', {
        ...basePayload(),
        packages: [{ product_id: productId, budget: 25000, pricing_option_id: pricingOptionId }],
        idempotency_key: key,
      });
      expect(conflict.isError).toBe(true);
      expect((conflict.parsed as any).adcp_error?.code).toBe('IDEMPOTENCY_CONFLICT');
      // Security: no payload / fingerprint / cached state leak
      expect((conflict.parsed as any).adcp_error?.details?.hash).toBeUndefined();
      expect((conflict.parsed as any).adcp_error?.details?.cached_payload).toBeUndefined();
    });

    it('returns IDEMPOTENCY_CONFLICT when end_time changes', async () => {
      const { productId, pricingOptionId } = await getValidProductAndPricing(server);
      const key = `idem-${randomUUID()}`;
      await call(server, 'create_media_buy', {
        ...basePayload(),
        packages: [{ product_id: productId, budget: 5000, pricing_option_id: pricingOptionId }],
        idempotency_key: key,
      });

      const conflict = await call(server, 'create_media_buy', {
        ...basePayload(),
        end_time: '2027-09-30T23:59:59Z',
        packages: [{ product_id: productId, budget: 5000, pricing_option_id: pricingOptionId }],
        idempotency_key: key,
      });
      expect((conflict.parsed as any).adcp_error?.code).toBe('IDEMPOTENCY_CONFLICT');
    });
  });

  describe('fresh key → new resource', () => {
    it('a different key with identical payload creates a distinct media buy', async () => {
      const { productId, pricingOptionId } = await getValidProductAndPricing(server);
      const basePkg = { product_id: productId, budget: 5000, pricing_option_id: pricingOptionId };

      const first = await call(server, 'create_media_buy', {
        ...basePayload(),
        packages: [basePkg],
        idempotency_key: `idem-${randomUUID()}`,
      });
      const firstId = (first.parsed as any).media_buy_id;

      const second = await call(server, 'create_media_buy', {
        ...basePayload(),
        packages: [basePkg],
        idempotency_key: `idem-${randomUUID()}`,
      });
      const secondId = (second.parsed as any).media_buy_id;

      expect(firstId).toBeTruthy();
      expect(secondId).toBeTruthy();
      expect(firstId).not.toBe(secondId);
    });
  });

  describe('failed executions are not cached', () => {
    it('re-executes on retry after an error (no replay cache pollution)', async () => {
      const key = `idem-${randomUUID()}`;
      const badPayload = {
        ...basePayload(),
        packages: [{ product_id: 'DOES_NOT_EXIST', budget: 100, pricing_option_id: 'bad' }],
        idempotency_key: key,
      };

      const first = await call(server, 'create_media_buy', badPayload);
      expect(first.isError).toBe(true);

      // Retry with the same key: the first was an error, so the second
      // must re-execute (and also error) — not return a cached success.
      const second = await call(server, 'create_media_buy', badPayload);
      expect(second.isError).toBe(true);
      expect((second.parsed as any).replayed).toBeUndefined();
    });
  });

  describe('principal isolation', () => {
    it('the same key used by a different auth principal is a cache miss', async () => {
      const { productId, pricingOptionId } = await getValidProductAndPricing(server);
      const key = `idem-${randomUUID()}`;
      const payload = {
        ...basePayload(),
        packages: [{ product_id: productId, budget: 5000, pricing_option_id: pricingOptionId }],
        idempotency_key: key,
      };
      const first = await call(server, 'create_media_buy', payload);
      const firstId = (first.parsed as any).media_buy_id;

      const otherServer = createTrainingAgentServer({ mode: 'open', principal: 'other-principal' });
      const second = await call(otherServer, 'create_media_buy', payload);
      const secondId = (second.parsed as any).media_buy_id;

      expect(firstId).toBeTruthy();
      expect(secondId).toBeTruthy();
      expect(secondId).not.toBe(firstId);
      expect((second.parsed as any).replayed ?? false).toBe(false);
    });

    it('partitions by account scope so shared auth tokens do not pool callers', async () => {
      // Both calls are made against the SAME server (same auth principal),
      // but the account brand.domain differs. The middleware must treat
      // these as separate cache scopes — otherwise the public sandbox
      // token would be a cross-caller oracle.
      const { productId, pricingOptionId } = await getValidProductAndPricing(server);
      const key = `shared-${randomUUID()}`;
      const pkg = { product_id: productId, budget: 5000, pricing_option_id: pricingOptionId };

      const payloadA = {
        account: { brand: { domain: 'caller-a.example' }, operator: 'op' },
        brand: { domain: 'caller-a.example' },
        start_time: 'asap',
        end_time: '2027-06-30T23:59:59Z',
        packages: [pkg],
        idempotency_key: key,
      };
      const payloadB = {
        ...payloadA,
        account: { brand: { domain: 'caller-b.example' }, operator: 'op' },
        brand: { domain: 'caller-b.example' },
      };

      const a = await call(server, 'create_media_buy', payloadA);
      const b = await call(server, 'create_media_buy', payloadB);

      expect((a.parsed as any).media_buy_id).toBeTruthy();
      expect((b.parsed as any).media_buy_id).toBeTruthy();
      // Different account scope → cache miss, new media buy, no conflict
      expect((b.parsed as any).media_buy_id).not.toBe((a.parsed as any).media_buy_id);
      expect((b.parsed as any).replayed ?? false).toBe(false);
      expect(b.isError).toBeFalsy();
    });
  });

  describe('missing key rejected for every mutating tool', () => {
    // Parameterized sanity check: for every mutating tool the training
    // agent dispatches (present in HANDLER_MAP), the middleware must reject
    // a missing idempotency_key at the dispatch layer — catching routing
    // regressions where a tool is added to HANDLER_MAP but omitted from
    // MUTATING_TOOLS. Mutating tools that this reference agent doesn't
    // dispatch (e.g. SI and sync_audiences are in the spec but not in
    // HANDLER_MAP here) surface as `Unknown tool`, which is also safe —
    // the idempotency middleware can't be bypassed via a valid path.
    for (const toolName of MUTATING_TOOLS) {
      it(`${toolName}: missing idempotency_key → INVALID_REQUEST`, async () => {
        const { parsed, isError } = await call(server, toolName, {
          account: ACCOUNT,
          brand: BRAND,
        });
        expect(isError).toBe(true);
        const err = (parsed as any).adcp_error;
        expect(err?.code).toBe('INVALID_REQUEST');
        const handledByMiddleware = err?.field === 'idempotency_key';
        const notDispatchedHere = typeof err?.message === 'string'
          && (err.message as string).startsWith('Unknown tool:');
        expect(
          handledByMiddleware || notDispatchedHere,
          `expected ${toolName} to hit idempotency middleware or be unknown-tool, got ${JSON.stringify(err)}`,
        ).toBe(true);
      });
    }
  });
});
