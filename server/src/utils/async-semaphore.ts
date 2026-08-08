/**
 * Bounds how much concurrent work a process will take on, and how much it will
 * hold in memory waiting. Once the wait list is full, `run` rejects with
 * `SemaphoreOverloadedError` so the caller can shed load instead of queueing
 * work nobody is still waiting for.
 */
export class SemaphoreOverloadedError extends Error {
  constructor(maxQueued: number) {
    super(`Work queue is full (${maxQueued} waiting)`);
    this.name = 'SemaphoreOverloadedError';
  }
}

export class AsyncSemaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(
    private readonly limit: number,
    private readonly maxQueued: number,
  ) {
    if (limit < 1) throw new Error('AsyncSemaphore limit must be at least 1');
    if (maxQueued < 0) throw new Error('AsyncSemaphore maxQueued cannot be negative');
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    if (this.queue.length >= this.maxQueued) {
      return Promise.reject(new SemaphoreOverloadedError(this.maxQueued));
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) {
      // Transfer the released permit directly to the oldest waiter.
      next();
      return;
    }
    this.active--;
  }
}
