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
const ACCOUNT = { brand: { domain: 'force-arm.example.com' }, operator: 'force-tester', sandbox: true };
const BRAND = { domain: 'force-arm.example.com', name: 'Force Arm Test' };

function withIdempotencyKey(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  if (!MUTATING_TOOLS.has(toolName)) return args;
  if (args.idempotency_key !== undefined) return args;
  return { ...args, idempotency_key: `test-${crypto.randomUUID()}` };
}

async function callTool(
  server: ReturnType<typeof createTrainingAgentServer>,
  toolName: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const requestHandlers = (server as unknown as { _requestHandlers: Map<string, Function> })._requestHandlers;
  const handler = requestHandlers.get('tools/call');
  if (!handler) throw new Error('CallTool handler not found');
  const response = await handler(
    { method: 'tools/call', params: { name: toolName, arguments: withIdempotencyKey(toolName, args) } },
    {},
  );
  const text = response.content?.[0]?.text;
  const parsed: Record<string, unknown> = response.structuredContent
    ? (response.structuredContent as Record<string, unknown>)
    : (text ? JSON.parse(text) : {});
  return (parsed.adcp_error as Record<string, unknown> | undefined) ?? parsed;
}

async function getValidPackage(server: ReturnType<typeof createTrainingAgentServer>): Promise<{ product_id: string; pricing_option_id: string }> {
  const products = await callTool(server, 'get_products', {
    buying_mode: 'wholesale',
    account: ACCOUNT,
    brand: BRAND,
  });
  const list = (products as { products?: Array<{ product_id: string; pricing_options: Array<{ pricing_option_id: string }> }> }).products ?? [];
  if (list.length === 0) throw new Error('No products');
  return {
    product_id: list[0].product_id,
    pricing_option_id: list[0].pricing_options[0].pricing_option_id,
  };
}

function buildCreateMediaBuyArgs(pkg: { product_id: string; pricing_option_id: string }): Record<string, unknown> {
  const now = new Date();
  const end = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  return {
    account: ACCOUNT,
    brand: BRAND,
    start_time: now.toISOString(),
    end_time: end.toISOString(),
    packages: [{ ...pkg, budget: 10000 }],
  };
}

describe('force_create_media_buy_arm', () => {
  let server: ReturnType<typeof createTrainingAgentServer>;

  beforeEach(async () => {
    await clearSessions();
    clearIdempotencyCache();
    invalidateCache();
    clearTaskStore();
    server = createTrainingAgentServer(DEFAULT_CTX);
  });

  describe('directive registration', () => {
    it('registers a submitted-arm directive with task_id and message', async () => {
      const result = await callTool(server, 'comply_test_controller', {
        scenario: 'force_create_media_buy_arm',
        params: {
          arm: 'submitted',
          task_id: 'task_async_signed_io_q2',
          message: 'Awaiting IO signature; typical turnaround 2-4 hours',
        },
        account: ACCOUNT,
        brand: BRAND,
      });

      expect(result.success).toBe(true);
      expect((result as { forced: { arm: string; task_id: string } }).forced.arm).toBe('submitted');
      expect((result as { forced: { arm: string; task_id: string } }).forced.task_id).toBe('task_async_signed_io_q2');
    });

    it("rejects arm: 'input-required' as INVALID_PARAMS — reserved in spec but not yet modelable on a conformant response", async () => {
      const result = await callTool(server, 'comply_test_controller', {
        scenario: 'force_create_media_buy_arm',
        params: { arm: 'input-required' },
        account: ACCOUNT,
        brand: BRAND,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('INVALID_PARAMS');
      expect(result.error_detail).toMatch(/input-required/);
    });

    it('rejects an arm value outside the spec enum', async () => {
      const result = await callTool(server, 'comply_test_controller', {
        scenario: 'force_create_media_buy_arm',
        params: { arm: 'completed' },
        account: ACCOUNT,
        brand: BRAND,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('INVALID_PARAMS');
    });

    it('rejects submitted arm without task_id', async () => {
      const result = await callTool(server, 'comply_test_controller', {
        scenario: 'force_create_media_buy_arm',
        params: { arm: 'submitted' },
        account: ACCOUNT,
        brand: BRAND,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('INVALID_PARAMS');
      expect(result.error_detail).toMatch(/task_id/);
    });

    it('rejects task_id over 128 chars', async () => {
      const result = await callTool(server, 'comply_test_controller', {
        scenario: 'force_create_media_buy_arm',
        params: { arm: 'submitted', task_id: 'x'.repeat(129) },
        account: ACCOUNT,
        brand: BRAND,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('INVALID_PARAMS');
      expect(result.error_detail).toMatch(/maxLength/);
    });
  });

  describe('directive consumption on next create_media_buy', () => {
    it('drives the next create_media_buy into the submitted envelope shape', async () => {
      const pkg = await getValidPackage(server);

      const directive = await callTool(server, 'comply_test_controller', {
        scenario: 'force_create_media_buy_arm',
        params: {
          arm: 'submitted',
          task_id: 'task_async_signed_io_q2',
          message: 'Awaiting IO signature',
        },
        account: ACCOUNT,
        brand: BRAND,
      });
      expect(directive.success).toBe(true);

      const buy = await callTool(server, 'create_media_buy', buildCreateMediaBuyArgs(pkg));

      // Wire shape — anchors the spec invariant for the submitted envelope.
      expect(buy.status).toBe('submitted');
      expect(buy.task_id).toBe('task_async_signed_io_q2');
      expect(buy.message).toBe('Awaiting IO signature');
      // Absent on the envelope — they land on the task's completion artifact.
      expect(buy.media_buy_id).toBeUndefined();
      expect(buy.packages).toBeUndefined();
    });

    it('is single-shot — the second create_media_buy returns the default arm', async () => {
      const pkg = await getValidPackage(server);

      await callTool(server, 'comply_test_controller', {
        scenario: 'force_create_media_buy_arm',
        params: { arm: 'submitted', task_id: 'task_one_shot' },
        account: ACCOUNT,
        brand: BRAND,
      });

      const first = await callTool(server, 'create_media_buy', buildCreateMediaBuyArgs(pkg));
      expect(first.status).toBe('submitted');
      expect(first.task_id).toBe('task_one_shot');

      const second = await callTool(server, 'create_media_buy', buildCreateMediaBuyArgs(pkg));
      // Default arm — synchronous completion, no submitted/task_id.
      expect(second.status).not.toBe('submitted');
      expect(second.task_id).toBeUndefined();
      expect(second.media_buy_id).toBeDefined();
    });

    it('overwrites a prior directive when called twice before consumption', async () => {
      const pkg = await getValidPackage(server);

      await callTool(server, 'comply_test_controller', {
        scenario: 'force_create_media_buy_arm',
        params: { arm: 'submitted', task_id: 'task_first' },
        account: ACCOUNT,
        brand: BRAND,
      });
      await callTool(server, 'comply_test_controller', {
        scenario: 'force_create_media_buy_arm',
        params: { arm: 'submitted', task_id: 'task_second' },
        account: ACCOUNT,
        brand: BRAND,
      });

      const buy = await callTool(server, 'create_media_buy', buildCreateMediaBuyArgs(pkg));
      expect(buy.task_id).toBe('task_second');
    });

  });

  describe('list_scenarios advertisement', () => {
    it('includes force_create_media_buy_arm in the supported scenarios list', async () => {
      const result = await callTool(server, 'comply_test_controller', {
        scenario: 'list_scenarios',
        account: ACCOUNT,
        brand: BRAND,
      });

      expect(result.success).toBe(true);
      const scenarios = (result as { scenarios: string[] }).scenarios;
      expect(scenarios).toContain('force_create_media_buy_arm');
      // Existing SDK scenarios still present.
      expect(scenarios).toContain('force_media_buy_status');
    });
  });
});
