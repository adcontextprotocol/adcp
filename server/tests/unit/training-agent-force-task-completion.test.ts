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
  waitForForcedTaskCompletion,
} from '../../src/training-agent/comply-test-controller.js';
import type { TrainingContext } from '../../src/training-agent/types.js';
import { syntheticAccountIdFromRef } from '../../src/training-agent/account-scope.js';
import {
  taskRegistryNamespaceForTenant,
  type TaskRegistryTenant,
} from '../../src/training-agent/task-registry-scope.js';

const DEFAULT_CTX: TrainingContext = { mode: 'open' };
const ACCOUNT_A = { brand: { domain: 'force-completion-a.example' }, operator: 'tester-a', sandbox: true };
const BRAND_A = { domain: 'force-completion-a.example' };
const ACCOUNT_B = { brand: { domain: 'force-completion-b.example' }, operator: 'tester-b', sandbox: true };
const BRAND_B = { domain: 'force-completion-b.example' };
const ACCOUNT_A_OPERATOR_B = { ...ACCOUNT_A, operator: 'tester-b' };

const SAMPLE_RESULT = {
  media_buy_id: 'mb_async_signed_io_q2',
  status: 'active',
  packages: [
    { package_id: 'pkg-0', product_id: 'async_signed_io_q2', budget: 30000 },
  ],
};

function taskScope(
  account: { account_id: string } | typeof ACCOUNT_A = ACCOUNT_A,
  ownerScope?: string,
  tenantId: TaskRegistryTenant = 'sales',
) {
  const accountId = 'account_id' in account ? account.account_id : syntheticAccountIdFromRef(account);
  return {
    registryNamespace: taskRegistryNamespaceForTenant(tenantId),
    accountId,
    ownerScope: ownerScope ?? `account:${accountId}`,
  };
}

function awaitForcedTask(taskId: string, account = ACCOUNT_A): Promise<Record<string, unknown>> {
  return waitForForcedTaskCompletion(taskId, taskScope(account));
}

function forcedCompletionKey(taskId: string, account = ACCOUNT_A): string {
  const scope = taskScope(account);
  return JSON.stringify([scope.registryNamespace, scope.accountId, scope.ownerScope, taskId]);
}

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
    it('completes an owned pending task and returns StateTransitionSuccess', async () => {
      const pending = awaitForcedTask('task_async_signed_io_q2');
      const result = await callTool(server, 'comply_test_controller', {
        scenario: 'force_task_completion',
        params: { task_id: 'task_async_signed_io_q2', result: SAMPLE_RESULT },
        account: ACCOUNT_A,
        brand: BRAND_A,
      });

      expect(result.success).toBe(true);
      expect(result.previous_state).toBe('submitted');
      expect(result.current_state).toBe('completed');
      await expect(pending).resolves.toEqual(SAMPLE_RESULT);

      // Recorded in the process-global pool.
      const recorded = getForcedTaskCompletions().get(forcedCompletionKey('task_async_signed_io_q2'));
      expect(recorded).toBeDefined();
      expect(recorded!.result).toEqual(SAMPLE_RESULT);
    });

    it('completes a principal-scoped opaque account task with a sandbox assertion', async () => {
      const principal = 'opaque-account-principal';
      const account = { account_id: 'opaque_completion_account' };
      const assertedAccount = { ...account, sandbox: true };
      server = createTrainingAgentServer({ mode: 'open', principal });
      const scope = taskScope(account, `client:${principal}`);
      const pending = waitForForcedTaskCompletion('task_opaque_account', scope);

      const result = await callTool(server, 'comply_test_controller', {
        scenario: 'force_task_completion',
        params: { task_id: 'task_opaque_account', result: SAMPLE_RESULT },
        account: assertedAccount,
      });

      expect(result).toMatchObject({ success: true, current_state: 'completed' });
      await expect(pending).resolves.toEqual(SAMPLE_RESULT);
      expect(getForcedTaskCompletions().get(JSON.stringify([
        scope.registryNamespace,
        scope.accountId,
        scope.ownerScope,
        'task_opaque_account',
      ]))?.result)
        .toEqual(SAMPLE_RESULT);
    });

    it('rejects a guessed task_id that has no owned pending waiter', async () => {
      const result = await callTool(server, 'comply_test_controller', {
        scenario: 'force_task_completion',
        params: { task_id: 'task_not_registered', result: SAMPLE_RESULT },
        account: ACCOUNT_A,
        brand: BRAND_A,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('NOT_FOUND');
      expect(getForcedTaskCompletions().has(forcedCompletionKey('task_not_registered'))).toBe(false);
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

      const pending = awaitForcedTask('task_replay');
      const first = await callTool(server, 'comply_test_controller', args);
      expect(first.success).toBe(true);
      expect(first.previous_state).toBe('submitted');
      await expect(pending).resolves.toEqual(SAMPLE_RESULT);

      const replay = await callTool(server, 'comply_test_controller', args);
      expect(replay.success).toBe(true);
      // Same-params replay reports both states as 'completed' — idempotent no-op.
      expect(replay.previous_state).toBe('completed');
      expect(replay.current_state).toBe('completed');
    });

    it('replays with diverging params return INVALID_TRANSITION', async () => {
      const pending = awaitForcedTask('task_diverge');
      await callTool(server, 'comply_test_controller', {
        scenario: 'force_task_completion',
        params: { task_id: 'task_diverge', result: SAMPLE_RESULT },
        account: ACCOUNT_A,
        brand: BRAND_A,
      });
      await expect(pending).resolves.toEqual(SAMPLE_RESULT);

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
    it('isolates identical task IDs across sales and signals registries', async () => {
      const taskId = 'task_shared_across_surfaces';
      const principal = 'workos:cross-surface-organization';
      const agentUrl = 'https://training.example/authenticated/shared-key';
      const ownerScope = `agent:${agentUrl}`;
      const salesScope = taskScope(ACCOUNT_A, ownerScope, 'sales');
      const signalsScope = taskScope(ACCOUNT_A, ownerScope, 'signals');
      const salesServer = createTrainingAgentServer({
        mode: 'open',
        tenantId: 'sales',
        principal,
        authenticatedAgentUrl: agentUrl,
      });
      const signalsServer = createTrainingAgentServer({
        mode: 'open',
        tenantId: 'signals',
        principal,
        authenticatedAgentUrl: agentUrl,
      });
      const salesResult = { ...SAMPLE_RESULT, media_buy_id: 'mb_sales_surface' };
      const signalsResult = { signals: [], cache_scope: 'public' };
      const pendingSales = waitForForcedTaskCompletion(taskId, salesScope);
      const pendingSignals = waitForForcedTaskCompletion(taskId, signalsScope);

      expect(await callTool(salesServer, 'comply_test_controller', {
        scenario: 'force_task_completion',
        params: { task_id: taskId, result: salesResult },
        account: ACCOUNT_A,
        brand: BRAND_A,
      })).toMatchObject({ success: true, current_state: 'completed' });
      expect(await callTool(signalsServer, 'comply_test_controller', {
        scenario: 'force_task_completion',
        params: { task_id: taskId, result: signalsResult },
        account: ACCOUNT_A,
        brand: BRAND_A,
      })).toMatchObject({ success: true, current_state: 'completed' });

      await expect(pendingSales).resolves.toEqual(salesResult);
      await expect(pendingSignals).resolves.toEqual(signalsResult);
    });

    it('isolates two credentials with one organization principal by buyer-agent owner scope', async () => {
      const taskId = 'task_shared_org_distinct_keys';
      const principal = 'workos:shared-organization';
      const ownerA = 'agent:https://training.example/authenticated/key-a';
      const ownerB = 'agent:https://training.example/authenticated/key-b';
      const scopeA = taskScope(ACCOUNT_A, ownerA);
      const scopeB = taskScope(ACCOUNT_A, ownerB);
      const serverA = createTrainingAgentServer({
        mode: 'open',
        principal,
        authenticatedAgentUrl: ownerA.slice('agent:'.length),
      });
      const serverB = createTrainingAgentServer({
        mode: 'open',
        principal,
        authenticatedAgentUrl: ownerB.slice('agent:'.length),
      });
      const resultA = { ...SAMPLE_RESULT, media_buy_id: 'mb_key_a' };
      const resultB = { ...SAMPLE_RESULT, media_buy_id: 'mb_key_b' };
      const pendingA = waitForForcedTaskCompletion(taskId, scopeA);
      const pendingB = waitForForcedTaskCompletion(taskId, scopeB);

      expect(await callTool(serverA, 'comply_test_controller', {
        scenario: 'force_task_completion',
        params: { task_id: taskId, result: resultA },
        account: ACCOUNT_A,
        brand: BRAND_A,
      })).toMatchObject({ success: true, current_state: 'completed' });
      expect(await callTool(serverB, 'comply_test_controller', {
        scenario: 'force_task_completion',
        params: { task_id: taskId, result: resultB },
        account: ACCOUNT_A,
        brand: BRAND_A,
      })).toMatchObject({ success: true, current_state: 'completed' });

      await expect(pendingA).resolves.toEqual(resultA);
      await expect(pendingB).resolves.toEqual(resultB);
    });

    it('completes the same public task_id independently for two operators', async () => {
      const taskId = 'task_shared_across_operators';
      const resultA = { ...SAMPLE_RESULT, media_buy_id: 'mb_operator_a' };
      const resultB = { ...SAMPLE_RESULT, media_buy_id: 'mb_operator_b' };
      const pendingA = awaitForcedTask(taskId, ACCOUNT_A);
      const pendingB = awaitForcedTask(taskId, ACCOUNT_A_OPERATOR_B);

      expect(await callTool(server, 'comply_test_controller', {
        scenario: 'force_task_completion',
        params: { task_id: taskId, result: resultA },
        account: ACCOUNT_A,
        brand: BRAND_A,
      })).toMatchObject({ success: true, current_state: 'completed' });
      expect(await callTool(server, 'comply_test_controller', {
        scenario: 'force_task_completion',
        params: { task_id: taskId, result: resultB },
        account: ACCOUNT_A_OPERATOR_B,
        brand: BRAND_A,
      })).toMatchObject({ success: true, current_state: 'completed' });

      await expect(pendingA).resolves.toEqual(resultA);
      await expect(pendingB).resolves.toEqual(resultB);
      expect(getForcedTaskCompletions().get(forcedCompletionKey(taskId, ACCOUNT_A))?.result).toEqual(resultA);
      expect(getForcedTaskCompletions().get(forcedCompletionKey(taskId, ACCOUNT_A_OPERATOR_B))?.result).toEqual(resultB);
    });

    it('returns NOT_FOUND when account B tries to re-complete account A\'s task with diverging result', async () => {
      // Account A registers the task.
      const pending = awaitForcedTask('task_cross_tenant');
      await callTool(server, 'comply_test_controller', {
        scenario: 'force_task_completion',
        params: { task_id: 'task_cross_tenant', result: SAMPLE_RESULT },
        account: ACCOUNT_A,
        brand: BRAND_A,
      });
      await expect(pending).resolves.toEqual(SAMPLE_RESULT);

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
      const recorded = getForcedTaskCompletions().get(forcedCompletionKey('task_cross_tenant'));
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
