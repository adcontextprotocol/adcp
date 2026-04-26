import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import {
  createTrainingAgentServer,
  invalidateCache,
  clearTaskStore,
} from '../../src/training-agent/task-handlers.js';
import { clearSessions } from '../../src/training-agent/state.js';
import { MUTATING_TOOLS, clearIdempotencyCache } from '../../src/training-agent/idempotency.js';
import {
  clearForcedTaskCompletions,
  getForcedTaskCompletions,
} from '../../src/training-agent/comply-test-controller.js';
import type { TrainingContext } from '../../src/training-agent/types.js';

const DEFAULT_CTX: TrainingContext = { mode: 'open' };
const ACCOUNT_A = { brand: { domain: 'force-completion-a.example' }, operator: 'tester-a', sandbox: true };
const BRAND_A = { domain: 'force-completion-a.example' };
const ACCOUNT_B = { brand: { domain: 'force-completion-b.example' }, operator: 'tester-b', sandbox: true };
const BRAND_B = { domain: 'force-completion-b.example' };

const SAMPLE_RESULT = {
  media_buy_id: 'mb_async_signed_io_q2',
  status: 'active',
  packages: [
    { package_id: 'pkg-0', product_id: 'async_signed_io_q2', budget: 30000 },
  ],
};

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

describe('force_task_completion', () => {
  let server: ReturnType<typeof createTrainingAgentServer>;

  beforeEach(async () => {
    await clearSessions();
    clearIdempotencyCache();
    invalidateCache();
    clearTaskStore();
    clearForcedTaskCompletions();
    server = createTrainingAgentServer(DEFAULT_CTX);
  });

  describe('directive registration', () => {
    it('registers a completion with task_id and result, returns StateTransitionSuccess', async () => {
      const result = await callTool(server, 'comply_test_controller', {
        scenario: 'force_task_completion',
        params: { task_id: 'task_async_signed_io_q2', result: SAMPLE_RESULT },
        account: ACCOUNT_A,
        brand: BRAND_A,
      });

      expect(result.success).toBe(true);
      expect(result.previous_state).toBe('submitted');
      expect(result.current_state).toBe('completed');

      // Recorded in the process-global pool.
      const recorded = getForcedTaskCompletions().get('task_async_signed_io_q2');
      expect(recorded).toBeDefined();
      expect(recorded!.result).toEqual(SAMPLE_RESULT);
    });

    it('rejects missing task_id with INVALID_PARAMS', async () => {
      const result = await callTool(server, 'comply_test_controller', {
        scenario: 'force_task_completion',
        params: { result: SAMPLE_RESULT },
        account: ACCOUNT_A,
        brand: BRAND_A,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('INVALID_PARAMS');
      expect(result.error_detail).toMatch(/task_id/);
    });

    it('rejects missing result with INVALID_PARAMS', async () => {
      const result = await callTool(server, 'comply_test_controller', {
        scenario: 'force_task_completion',
        params: { task_id: 'task_no_result' },
        account: ACCOUNT_A,
        brand: BRAND_A,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('INVALID_PARAMS');
      expect(result.error_detail).toMatch(/result/);
    });

    it('rejects task_id over 128 chars', async () => {
      const result = await callTool(server, 'comply_test_controller', {
        scenario: 'force_task_completion',
        params: { task_id: 'x'.repeat(129), result: SAMPLE_RESULT },
        account: ACCOUNT_A,
        brand: BRAND_A,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('INVALID_PARAMS');
      expect(result.error_detail).toMatch(/task_id/);
    });

    it('rejects result over 256 KB', async () => {
      // Build a result with one giant string field. JSON-stringified size > 256KB.
      const huge = { media_buy_id: 'mb_huge', status: 'active', packages: [], filler: 'x'.repeat(260 * 1024) };
      const result = await callTool(server, 'comply_test_controller', {
        scenario: 'force_task_completion',
        params: { task_id: 'task_huge', result: huge },
        account: ACCOUNT_A,
        brand: BRAND_A,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('INVALID_PARAMS');
      expect(result.error_detail).toMatch(/256 KB/);
    });
  });

  describe('replay semantics', () => {
    it('replays with identical params are idempotent no-ops', async () => {
      const args = {
        scenario: 'force_task_completion',
        params: { task_id: 'task_replay', result: SAMPLE_RESULT },
        account: ACCOUNT_A,
        brand: BRAND_A,
      };

      const first = await callTool(server, 'comply_test_controller', args);
      expect(first.success).toBe(true);
      expect(first.previous_state).toBe('submitted');

      const replay = await callTool(server, 'comply_test_controller', args);
      expect(replay.success).toBe(true);
      // Same-params replay reports both states as 'completed' — idempotent no-op.
      expect(replay.previous_state).toBe('completed');
      expect(replay.current_state).toBe('completed');
    });

    it('replays with diverging params return INVALID_TRANSITION', async () => {
      await callTool(server, 'comply_test_controller', {
        scenario: 'force_task_completion',
        params: { task_id: 'task_diverge', result: SAMPLE_RESULT },
        account: ACCOUNT_A,
        brand: BRAND_A,
      });

      const replay = await callTool(server, 'comply_test_controller', {
        scenario: 'force_task_completion',
        params: { task_id: 'task_diverge', result: { ...SAMPLE_RESULT, media_buy_id: 'mb_different' } },
        account: ACCOUNT_A,
        brand: BRAND_A,
      });

      expect(replay.success).toBe(false);
      expect(replay.error).toBe('INVALID_TRANSITION');
      expect(replay.current_state).toBe('completed');
    });
  });

  describe('cross-account isolation', () => {
    it('returns NOT_FOUND when account B tries to re-complete account A\'s task with diverging result', async () => {
      // Account A registers the task.
      await callTool(server, 'comply_test_controller', {
        scenario: 'force_task_completion',
        params: { task_id: 'task_cross_tenant', result: SAMPLE_RESULT },
        account: ACCOUNT_A,
        brand: BRAND_A,
      });

      // Account B tries to overwrite.
      const result = await callTool(server, 'comply_test_controller', {
        scenario: 'force_task_completion',
        params: { task_id: 'task_cross_tenant', result: { ...SAMPLE_RESULT, media_buy_id: 'mb_hijack' } },
        account: ACCOUNT_B,
        brand: BRAND_B,
      });

      expect(result.success).toBe(false);
      // Per spec MUST: cross-account → NOT_FOUND, not FORBIDDEN.
      expect(result.error).toBe('NOT_FOUND');

      // Original record unchanged.
      const recorded = getForcedTaskCompletions().get('task_cross_tenant');
      expect(recorded?.result).toEqual(SAMPLE_RESULT);
    });
  });

  describe('list_scenarios advertisement', () => {
    it('includes force_task_completion in the supported scenarios list', async () => {
      const result = await callTool(server, 'comply_test_controller', {
        scenario: 'list_scenarios',
        account: ACCOUNT_A,
        brand: BRAND_A,
      });

      expect(result.success).toBe(true);
      const scenarios = (result as { scenarios: string[] }).scenarios;
      expect(scenarios).toContain('force_task_completion');
      expect(scenarios).toContain('force_create_media_buy_arm');
    });
  });
});
