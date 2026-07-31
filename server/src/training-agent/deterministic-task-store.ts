import {
  InMemoryTaskStore,
  isTerminal,
  type CreateTaskOptions,
} from '@modelcontextprotocol/sdk/experimental/tasks';
import type { Request, RequestId, Result, Task } from '@modelcontextprotocol/sdk/types.js';

type StoredDeterministicTask = {
  task: Task;
  result?: Result;
};

/**
 * Extends the SDK's test/development task store with caller-supplied task IDs.
 * Production uses PostgresTaskStore, which supports these IDs natively.
 */
export class DeterministicInMemoryTaskStore extends InMemoryTaskStore {
  private readonly deterministicTasks = new Map<string, StoredDeterministicTask>();
  private readonly deterministicCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

  async createTaskWithId(
    taskId: string,
    taskParams: CreateTaskOptions,
    _requestId: RequestId,
    _request: Request,
  ): Promise<Task> {
    if (!taskId || taskId.length > 128) {
      throw new Error('taskId must be a non-empty string no longer than 128 characters');
    }
    if (this.deterministicTasks.has(taskId) || await super.getTask(taskId) || this.deterministicTasks.has(taskId)) {
      throw new Error(`Task with ID ${taskId} already exists`);
    }

    const createdAt = new Date().toISOString();
    const ttl = taskParams.ttl ?? null;
    const task: Task = {
      taskId,
      status: 'working',
      ttl,
      createdAt,
      lastUpdatedAt: createdAt,
      pollInterval: taskParams.pollInterval ?? 1000,
    };
    this.deterministicTasks.set(taskId, { task });
    this.scheduleCleanup(taskId, ttl);
    return { ...task };
  }

  override async getTask(taskId: string, sessionId?: string): Promise<Task | null> {
    const stored = this.deterministicTasks.get(taskId);
    return stored ? { ...stored.task } : super.getTask(taskId, sessionId);
  }

  override async storeTaskResult(
    taskId: string,
    status: 'completed' | 'failed',
    result: Result,
    sessionId?: string,
  ): Promise<void> {
    const stored = this.deterministicTasks.get(taskId);
    if (!stored) {
      return super.storeTaskResult(taskId, status, result, sessionId);
    }
    if (isTerminal(stored.task.status)) {
      throw new Error(`Cannot store result for task ${taskId} in terminal status '${stored.task.status}'`);
    }
    stored.result = result;
    stored.task.status = status;
    stored.task.lastUpdatedAt = new Date().toISOString();
    this.scheduleCleanup(taskId, stored.task.ttl);
  }

  override async getTaskResult(taskId: string, sessionId?: string): Promise<Result> {
    const stored = this.deterministicTasks.get(taskId);
    if (!stored) {
      return super.getTaskResult(taskId, sessionId);
    }
    if (!stored.result) {
      throw new Error(`Task ${taskId} has no result stored`);
    }
    return stored.result;
  }

  override async updateTaskStatus(
    taskId: string,
    status: Task['status'],
    statusMessage?: string,
    sessionId?: string,
  ): Promise<void> {
    const stored = this.deterministicTasks.get(taskId);
    if (!stored) {
      return super.updateTaskStatus(taskId, status, statusMessage, sessionId);
    }
    if (isTerminal(stored.task.status)) {
      throw new Error(`Cannot update task ${taskId} from terminal status '${stored.task.status}' to '${status}'`);
    }
    stored.task.status = status;
    stored.task.lastUpdatedAt = new Date().toISOString();
    if (statusMessage) stored.task.statusMessage = statusMessage;
    if (isTerminal(status)) this.scheduleCleanup(taskId, stored.task.ttl);
  }

  override async listTasks(cursor?: string): Promise<{ tasks: Task[]; nextCursor?: string }> {
    const tasks = [
      ...super.getAllTasks(),
      ...Array.from(this.deterministicTasks.values(), ({ task }) => ({ ...task })),
    ];
    let startIndex = 0;
    if (cursor) {
      const cursorIndex = tasks.findIndex(task => task.taskId === cursor);
      if (cursorIndex < 0) throw new Error(`Invalid cursor: ${cursor}`);
      startIndex = cursorIndex + 1;
    }
    const page = tasks.slice(startIndex, startIndex + 10);
    const nextCursor = startIndex + 10 < tasks.length ? page.at(-1)?.taskId : undefined;
    return { tasks: page, ...(nextCursor && { nextCursor }) };
  }

  override cleanup(): void {
    super.cleanup();
    for (const timer of this.deterministicCleanupTimers.values()) clearTimeout(timer);
    this.deterministicCleanupTimers.clear();
    this.deterministicTasks.clear();
  }

  private scheduleCleanup(taskId: string, ttl: number | null): void {
    const existing = this.deterministicCleanupTimers.get(taskId);
    if (existing) clearTimeout(existing);
    if (!ttl) return;
    const timer = setTimeout(() => {
      this.deterministicTasks.delete(taskId);
      this.deterministicCleanupTimers.delete(taskId);
    }, ttl);
    this.deterministicCleanupTimers.set(taskId, timer);
  }
}
