import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks';
import type {
  CreateTaskOptions,
  TaskStore,
} from '@modelcontextprotocol/sdk/experimental/tasks/interfaces.js';
import type { Request, RequestId, Result, Task } from '@modelcontextprotocol/sdk/types.js';
import { PostgresTaskStore } from '@adcp/sdk';
import { getPool, isDatabaseInitialized } from '../db/client.js';

export type TrainingTaskStore = InMemoryTaskStore | PostgresTaskStore;

class ScopedInMemoryTaskStore extends InMemoryTaskStore {
  private readonly owners = new Map<string, string>();

  private async pruneExpiredOwners(): Promise<void> {
    for (const taskId of this.owners.keys()) {
      if (await super.getTask(taskId) === null) this.owners.delete(taskId);
    }
  }

  override async createTask(
    options: CreateTaskOptions,
    requestId: RequestId,
    request: Request,
    sessionId?: string,
  ): Promise<Task> {
    await this.pruneExpiredOwners();
    const task = await super.createTask(options, requestId, request, sessionId);
    if (sessionId) this.owners.set(task.taskId, sessionId);
    return task;
  }

  private owned(taskId: string, sessionId?: string): boolean {
    return !sessionId || this.owners.get(taskId) === sessionId;
  }

  override async getTask(taskId: string, sessionId?: string): Promise<Task | null> {
    if (!this.owned(taskId, sessionId)) return Promise.resolve(null);
    const task = await super.getTask(taskId, sessionId);
    if (task === null) this.owners.delete(taskId);
    return task;
  }

  override async storeTaskResult(
    taskId: string,
    status: 'completed' | 'failed',
    result: Result,
    sessionId?: string,
  ): Promise<void> {
    if (!this.owned(taskId, sessionId)) throw new Error(`Task with ID ${taskId} not found`);
    await super.storeTaskResult(taskId, status, result, sessionId);
  }

  override async getTaskResult(taskId: string, sessionId?: string): Promise<Result> {
    if (!this.owned(taskId, sessionId)) throw new Error(`Task with ID ${taskId} not found`);
    return super.getTaskResult(taskId, sessionId);
  }

  override async updateTaskStatus(
    taskId: string,
    status: Task['status'],
    statusMessage?: string,
    sessionId?: string,
  ): Promise<void> {
    if (!this.owned(taskId, sessionId)) throw new Error(`Task with ID ${taskId} not found`);
    await super.updateTaskStatus(taskId, status, statusMessage, sessionId);
  }

  override async listTasks(cursor?: string, sessionId?: string): Promise<{ tasks: Task[]; nextCursor?: string }> {
    if (!sessionId) return super.listTasks(cursor, sessionId);
    await this.pruneExpiredOwners();
    const ownedIds = [...this.owners.entries()]
      .filter(([, owner]) => owner === sessionId)
      .map(([taskId]) => taskId);
    const startIndex = cursor === undefined ? 0 : ownedIds.indexOf(cursor) + 1;
    if (cursor !== undefined && startIndex === 0) throw new Error(`Invalid cursor: ${cursor}`);
    const pageIds = ownedIds.slice(startIndex, startIndex + 10);
    const tasks = (await Promise.all(pageIds.map(taskId => super.getTask(taskId, sessionId))))
      .filter((task): task is Task => task !== null);
    const nextCursor = startIndex + 10 < ownedIds.length ? pageIds.at(-1) : undefined;
    return { tasks, ...(nextCursor && { nextCursor }) };
  }

  override cleanup(): void {
    this.owners.clear();
    super.cleanup();
  }
}

let taskStore: TrainingTaskStore | null = null;
const taskScopeStorage = new AsyncLocalStorage<string>();

export function trainingTaskScope(tenantId: string, principal: string): string {
  return `training_${createHash('sha256').update(`${tenantId}\0${principal}`).digest('hex')}`;
}

export function runWithTrainingTaskScope<T>(scope: string, callback: () => T): T {
  return taskScopeStorage.run(scope, callback);
}

function requiredClientScope(sessionId: string | undefined): string {
  const scope = sessionId ?? taskScopeStorage.getStore();
  if (!scope) throw new Error('Training task access requires a trusted caller scope');
  return scope;
}

/** Resolve the backing store only when the first task operation runs. Route
 * construction precedes database initialization in production. */
export function getTrainingTaskStore(): TrainingTaskStore {
  if (!taskStore) {
    taskStore = isDatabaseInitialized()
      ? new PostgresTaskStore(getPool(), { allowUnscopedAccess: true })
      : new ScopedInMemoryTaskStore();
  }
  return taskStore;
}

/** One MCP TaskStore shared by the SDK tenant facade and the native 3.2
 * product dispatcher. The proxy preserves lazy database selection. */
export const sharedTrainingTaskStore: TaskStore = {
  createTask(
    options: CreateTaskOptions,
    requestId: RequestId,
    request: Request,
    sessionId?: string,
  ): Promise<Task> {
    return getTrainingTaskStore().createTask(options, requestId, request, requiredClientScope(sessionId));
  },
  getTask(taskId: string, sessionId?: string): Promise<Task | null> {
    return getTrainingTaskStore().getTask(taskId, requiredClientScope(sessionId));
  },
  storeTaskResult(
    taskId: string,
    status: 'completed' | 'failed',
    result: Result,
    sessionId?: string,
  ): Promise<void> {
    return getTrainingTaskStore().storeTaskResult(taskId, status, result, requiredClientScope(sessionId));
  },
  getTaskResult(taskId: string, sessionId?: string): Promise<Result> {
    return getTrainingTaskStore().getTaskResult(taskId, requiredClientScope(sessionId));
  },
  updateTaskStatus(
    taskId: string,
    status: Task['status'],
    statusMessage?: string,
    sessionId?: string,
  ): Promise<void> {
    return getTrainingTaskStore().updateTaskStatus(taskId, status, statusMessage, requiredClientScope(sessionId));
  },
  listTasks(cursor?: string, sessionId?: string): Promise<{ tasks: Task[]; nextCursor?: string }> {
    return getTrainingTaskStore().listTasks(cursor, requiredClientScope(sessionId));
  },
};

/** Per-request facade for the legacy server. A Proxy preserves the concrete
 * store identity used by the deterministic Postgres receipt recovery path. */
export function getScopedTrainingTaskStore(scope: string): TrainingTaskStore {
  const store = getTrainingTaskStore();
  return new Proxy(store, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      if (property === 'createTask') {
        return (options: CreateTaskOptions, requestId: RequestId, request: Request, sessionId?: string) =>
          target.createTask(options, requestId, request, sessionId ?? scope);
      }
      if (property === 'getTask') {
        return (taskId: string, sessionId?: string) => target.getTask(taskId, sessionId ?? scope);
      }
      if (property === 'storeTaskResult') {
        return (taskId: string, status: 'completed' | 'failed', result: Result, sessionId?: string) =>
          target.storeTaskResult(taskId, status, result, sessionId ?? scope);
      }
      if (property === 'getTaskResult') {
        return (taskId: string, sessionId?: string) => target.getTaskResult(taskId, sessionId ?? scope);
      }
      if (property === 'updateTaskStatus') {
        return (taskId: string, status: Task['status'], statusMessage?: string, sessionId?: string) =>
          target.updateTaskStatus(taskId, status, statusMessage, sessionId ?? scope);
      }
      if (property === 'listTasks') {
        return (cursor?: string, sessionId?: string) => target.listTasks(cursor, sessionId ?? scope);
      }
      return value.bind(target);
    },
  });
}

export function resetTrainingTaskStore(): void {
  taskStore?.cleanup();
  taskStore = null;
}
