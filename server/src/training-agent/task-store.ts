import { createHash, randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { PostgresTaskStore } from '@adcp/sdk';
import type { CreateTaskOptions, TaskStore } from '@modelcontextprotocol/sdk/experimental/tasks';
import type { CallToolResult, Request, RequestId, Result, Task } from '@modelcontextprotocol/sdk/types.js';
import { isDatabaseInitialized, getPool } from '../db/client.js';
import type { ToolArgs } from './types.js';
import { DeterministicInMemoryTaskStore } from './deterministic-task-store.js';

/**
 * Shared task store across per-request MCP Server instances.
 *
 * Production uses Postgres so tasks survive across Fly.io instances. Tests and
 * local development use the SDK's in-memory store with deterministic-ID support.
 */
let sdkTaskStore: DeterministicInMemoryTaskStore | PostgresTaskStore | null = null;

const DETERMINISTIC_TASK_PREFIX = 'dt_';
const EXTERNAL_ID_MARKER = 'adcp-external-task-id:';

function accountScope(args: Record<string, unknown>): string {
  const account = args.account as { account_id?: unknown; brand?: { domain?: unknown } } | undefined;
  if (typeof account?.account_id === 'string' && account.account_id) return `a:${account.account_id}`;
  const domain = account?.brand?.domain ?? (args.brand as { domain?: unknown } | undefined)?.domain;
  return typeof domain === 'string' && domain ? `b:${domain.toLowerCase()}` : 'default';
}

export function taskOwnerKey(principal: string, args: Record<string, unknown>): string {
  return `${principal}\0${accountScope(args)}`;
}

export function pendingTaskKey(principal: string, args: Record<string, unknown>, taskId: string): string {
  return `${taskOwnerKey(principal, args)}\0${taskId}`;
}

function ownerPrefix(owner: string): string {
  return `${DETERMINISTIC_TASK_PREFIX}${createHash('sha256').update(owner).digest('hex').slice(0, 16)}_`;
}

function internalTaskId(owner: string, taskId: string): string {
  return `${ownerPrefix(owner)}${createHash('sha256').update(taskId).digest('hex')}`;
}

function principalMarker(principal: string): string {
  return createHash('sha256').update(principal).digest('hex').slice(0, 16);
}

function externalIdStatus(taskId: string, principal: string): string {
  return `${EXTERNAL_ID_MARKER}${principalMarker(principal)}:${Buffer.from(taskId).toString('base64url')}`;
}

function parseExternalIdStatus(statusMessage: string | undefined): { principal: string; taskId: string } | null {
  const marker = statusMessage?.split('\n', 1)[0];
  if (!marker?.startsWith(EXTERNAL_ID_MARKER)) return null;
  const encoded = marker.slice(EXTERNAL_ID_MARKER.length);
  const separator = encoded.indexOf(':');
  if (separator < 1) return null;
  return {
    principal: encoded.slice(0, separator),
    taskId: Buffer.from(encoded.slice(separator + 1), 'base64url').toString(),
  };
}

function externalizeTask(task: Task, taskId: string): Task {
  const external = { ...task, taskId };
  if (external.statusMessage?.startsWith(EXTERNAL_ID_MARKER)) {
    const separator = external.statusMessage.indexOf('\n');
    if (separator >= 0) external.statusMessage = external.statusMessage.slice(separator + 1);
    else delete external.statusMessage;
  }
  return external;
}

export function getTaskStore(): DeterministicInMemoryTaskStore | PostgresTaskStore {
  if (!sdkTaskStore) {
    sdkTaskStore = isDatabaseInitialized()
      ? new PostgresTaskStore(getPool())
      : new DeterministicInMemoryTaskStore();
  }
  return sdkTaskStore;
}

export async function getRegisteredTask(
  taskId: string,
  requestArgs: ToolArgs,
  principal: string,
): Promise<Task | null> {
  const storedTaskId = internalTaskId(taskOwnerKey(principal, requestArgs as Record<string, unknown>), taskId);
  return getTaskStore().getTask(storedTaskId);
}

export type RegisterSubmittedTaskResult =
  | { registered: true }
  | { registered: false; existingStatus?: Task['status'] };

export async function registerSubmittedTask(
  taskId: string,
  requestArgs: ToolArgs,
  principal: string,
  toolName: 'get_products' | 'create_media_buy',
): Promise<RegisterSubmittedTaskResult> {
  const taskStore = getTaskStore();
  const taskParams = { ttl: 15 * 60 * 1000, pollInterval: 1000 };
  const storedTaskId = internalTaskId(taskOwnerKey(principal, requestArgs as Record<string, unknown>), taskId);
  const request = {
    method: 'tools/call',
    params: { name: toolName, arguments: requestArgs },
  } as const;

  if (taskStore instanceof PostgresTaskStore) await taskStore.cleanupExpired();
  const existing = await taskStore.getTask(storedTaskId);
  if (existing) return { registered: false, existingStatus: existing.status };

  try {
    if (taskStore instanceof DeterministicInMemoryTaskStore) {
      await taskStore.createTaskWithId(storedTaskId, taskParams, 0, request);
    } else {
      await taskStore.createTask({ ...taskParams, taskId: storedTaskId }, 0, request);
    }
  } catch (error) {
    const racedTask = await taskStore.getTask(storedTaskId);
    if (racedTask) return { registered: false, existingStatus: racedTask.status };
    if (error instanceof Error && error.message.includes('already exists')) {
      return { registered: false };
    }
    throw error;
  }
  await taskStore.updateTaskStatus(storedTaskId, 'working', externalIdStatus(taskId, principal));
  return { registered: true };
}

/** Complete a task when the compliance controller recognizes its deterministic ID. */
export async function completeRegisteredTask(
  taskId: string,
  result: Record<string, unknown>,
  principal: string,
  requestArgs: ToolArgs,
): Promise<
  | { found: false }
  | { found: true; previousStatus: Task['status']; existingResult?: Record<string, unknown> }
> {
  const taskStore = getTaskStore();
  const storedTaskId = internalTaskId(taskOwnerKey(principal, requestArgs as Record<string, unknown>), taskId);
  const task = await taskStore.getTask(storedTaskId);
  if (!task) return { found: false };
  if (task.status === 'completed') {
    const storedResult = await taskStore.getTaskResult(storedTaskId) as CallToolResult;
    return {
      found: true,
      previousStatus: task.status,
      existingResult: storedResult.structuredContent,
    };
  }
  if (task.status === 'failed' || task.status === 'cancelled') {
    return { found: true, previousStatus: task.status };
  }

  const toolResult: CallToolResult = {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result,
  };
  await taskStore.storeTaskResult(storedTaskId, 'completed', toolResult);
  return { found: true, previousStatus: task.status };
}

export class PrincipalTaskStore implements TaskStore {
  private readonly accountContext = new AsyncLocalStorage<{ scope: string; explicit: boolean }>();

  constructor(
    private readonly delegate: TaskStore,
    private readonly principal: string,
  ) {}

  runWithAccountScope<T>(args: Record<string, unknown>, callback: () => T): T {
    return this.accountContext.run({
      scope: accountScope(args),
      explicit: args.account !== undefined || args.brand !== undefined,
    }, callback);
  }

  private currentOwnerKey(): string {
    return `${this.principal}\0${this.accountContext.getStore()?.scope ?? 'default'}`;
  }

  async createTask(
    taskParams: CreateTaskOptions,
    requestId: RequestId,
    request: Request,
    _sessionId?: string,
  ): Promise<Task> {
    const taskId = randomBytes(16).toString('hex');
    const storedTaskId = internalTaskId(this.currentOwnerKey(), taskId);
    let task: Task;
    if (this.delegate instanceof DeterministicInMemoryTaskStore) {
      task = await this.delegate.createTaskWithId(storedTaskId, taskParams, requestId, request);
    } else {
      task = await (this.delegate as PostgresTaskStore).createTask(
        { ...taskParams, taskId: storedTaskId },
        requestId,
        request,
      );
    }
    await this.delegate.updateTaskStatus(storedTaskId, 'working', externalIdStatus(taskId, this.principal));
    return externalizeTask(task, taskId);
  }

  async getTask(taskId: string, sessionId?: string): Promise<Task | null> {
    const scoped = await this.findOwnedTask(taskId, sessionId);
    if (scoped) return externalizeTask(scoped, taskId);
    if (taskId.startsWith(DETERMINISTIC_TASK_PREFIX)) return null;
    return this.delegate.getTask(taskId, sessionId);
  }

  async storeTaskResult(
    taskId: string,
    status: 'completed' | 'failed',
    result: Result,
    sessionId?: string,
  ): Promise<void> {
    const resolved = await this.resolveTaskId(taskId, sessionId);
    await this.delegate.storeTaskResult(resolved, status, result, sessionId);
  }

  async getTaskResult(taskId: string, sessionId?: string): Promise<Result> {
    const resolved = await this.resolveTaskId(taskId, sessionId);
    return this.delegate.getTaskResult(resolved, sessionId);
  }

  async updateTaskStatus(
    taskId: string,
    status: Task['status'],
    statusMessage?: string,
    sessionId?: string,
  ): Promise<void> {
    const scoped = await this.findOwnedTask(taskId, sessionId);
    if (scoped) {
      const marker = scoped.statusMessage?.split('\n', 1)[0] ?? externalIdStatus(taskId, this.principal);
      const storedStatusMessage = statusMessage ? `${marker}\n${statusMessage}` : marker;
      await this.delegate.updateTaskStatus(scoped.taskId, status, storedStatusMessage, sessionId);
      return;
    }
    if (taskId.startsWith(DETERMINISTIC_TASK_PREFIX)) {
      throw new Error(`Task with ID ${taskId} not found`);
    }
    await this.delegate.updateTaskStatus(taskId, status, statusMessage, sessionId);
  }

  async listTasks(cursor?: string, sessionId?: string): Promise<{ tasks: Task[]; nextCursor?: string }> {
    const visible: Task[] = [];
    let delegateCursor: string | undefined;
    do {
      const page = await this.delegate.listTasks(delegateCursor, sessionId);
      for (const task of page.tasks) {
        if (!task.taskId.startsWith(DETERMINISTIC_TASK_PREFIX)) {
          visible.push(task);
          continue;
        }
        const external = parseExternalIdStatus(task.statusMessage);
        if (!external || external.principal !== principalMarker(this.principal)) continue;
        if (!task.taskId.startsWith(ownerPrefix(this.currentOwnerKey()))) continue;
        visible.push(externalizeTask(task, external.taskId));
      }
      delegateCursor = page.nextCursor;
    } while (delegateCursor);

    let startIndex = 0;
    if (cursor) {
      const cursorIndex = visible.findIndex(task => task.taskId === cursor);
      if (cursorIndex < 0) throw new Error(`Invalid cursor: ${cursor}`);
      startIndex = cursorIndex + 1;
    }
    const tasks = visible.slice(startIndex, startIndex + 10);
    const nextCursor = startIndex + 10 < visible.length ? tasks.at(-1)?.taskId : undefined;
    return { tasks, ...(nextCursor && { nextCursor }) };
  }

  private async resolveTaskId(taskId: string, sessionId?: string): Promise<string> {
    const scoped = await this.findOwnedTask(taskId, sessionId);
    if (scoped) return scoped.taskId;
    if (taskId.startsWith(DETERMINISTIC_TASK_PREFIX)) {
      throw new Error(`Task with ID ${taskId} not found`);
    }
    return taskId;
  }

  private async findOwnedTask(taskId: string, sessionId?: string): Promise<Task | null> {
    const exact = await this.delegate.getTask(internalTaskId(this.currentOwnerKey(), taskId), sessionId);
    if (exact) return exact;
    if (this.accountContext.getStore()?.explicit === true) return null;

    let cursor: string | undefined;
    let found: Task | null = null;
    do {
      const page = await this.delegate.listTasks(cursor, sessionId);
      for (const task of page.tasks) {
        const external = parseExternalIdStatus(task.statusMessage);
        if (external?.principal !== principalMarker(this.principal) || external.taskId !== taskId) continue;
        if (found) return null;
        found = task;
      }
      cursor = page.nextCursor;
    } while (cursor);
    return found;
  }
}

export function getTaskStoreForPrincipal(principal: string): PrincipalTaskStore {
  return new PrincipalTaskStore(getTaskStore(), principal);
}

/** Clear the task store and its TTL timers (test and graceful-shutdown helper). */
export function clearTaskStore(): void {
  sdkTaskStore?.cleanup();
  sdkTaskStore = null;
}
