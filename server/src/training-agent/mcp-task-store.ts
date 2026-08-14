import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks';
import type {
  CreateTaskOptions,
  TaskStore,
} from '@modelcontextprotocol/sdk/experimental/tasks/interfaces.js';
import type { Request, RequestId, Result, Task } from '@modelcontextprotocol/sdk/types.js';
import { PostgresTaskStore } from '@adcp/sdk';
import { getPool, isDatabaseInitialized } from '../db/client.js';

export type TrainingTaskStore = InMemoryTaskStore | PostgresTaskStore;

let taskStore: TrainingTaskStore | null = null;

/** Resolve the backing store only when the first task operation runs. Route
 * construction precedes database initialization in production. */
export function getTrainingTaskStore(): TrainingTaskStore {
  if (!taskStore) {
    taskStore = isDatabaseInitialized()
      ? new PostgresTaskStore(getPool())
      : new InMemoryTaskStore();
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
    return getTrainingTaskStore().createTask(options, requestId, request, sessionId);
  },
  getTask(taskId: string, sessionId?: string): Promise<Task | null> {
    return getTrainingTaskStore().getTask(taskId, sessionId);
  },
  storeTaskResult(
    taskId: string,
    status: 'completed' | 'failed',
    result: Result,
    sessionId?: string,
  ): Promise<void> {
    return getTrainingTaskStore().storeTaskResult(taskId, status, result, sessionId);
  },
  getTaskResult(taskId: string, sessionId?: string): Promise<Result> {
    return getTrainingTaskStore().getTaskResult(taskId, sessionId);
  },
  updateTaskStatus(
    taskId: string,
    status: Task['status'],
    statusMessage?: string,
    sessionId?: string,
  ): Promise<void> {
    return getTrainingTaskStore().updateTaskStatus(taskId, status, statusMessage, sessionId);
  },
  listTasks(cursor?: string, sessionId?: string): Promise<{ tasks: Task[]; nextCursor?: string }> {
    return getTrainingTaskStore().listTasks(cursor, sessionId);
  },
};

export function resetTrainingTaskStore(): void {
  taskStore?.cleanup();
  taskStore = null;
}
