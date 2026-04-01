/**
 * Feed poller that bootstraps from the registry API and polls for incremental updates.
 */

import type { CatalogEvent, FeedResult, FeedError } from '../db/catalog-events-db.js';

export interface PollerConfig {
  apiKey: string;
  baseUrl: string;
  pollIntervalMs: number;
  types?: string[];
  persistCursor: boolean;
  cursorPath?: string;
  onError?: (err: Error) => void;
}

export interface PollerCallbacks {
  onEvents: (events: CatalogEvent[]) => void;
  onBootstrapAgents: (agents: unknown[]) => void;
  onBootstrapProperties: (properties: unknown[]) => void;
}

export class FeedPoller {
  private config: PollerConfig;
  private callbacks: PollerCallbacks;
  private cursor: string | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private backoffMs = 1000;
  private maxBackoffMs = 60_000;

  constructor(config: PollerConfig, callbacks: PollerCallbacks) {
    this.config = config;
    this.callbacks = callbacks;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Load persisted cursor if configured
    if (this.config.persistCursor && this.config.cursorPath) {
      this.cursor = await this.loadCursor();
    }

    // Bootstrap
    await this.bootstrap();

    // Start polling
    this.schedulePoll();
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  getCursor(): string | null {
    return this.cursor;
  }

  private async bootstrap(): Promise<void> {
    try {
      // Bootstrap agents — paginate through all results
      let agentCursor: string | undefined;
      do {
        const params = new URLSearchParams({ limit: '200' });
        if (agentCursor) params.set('cursor', agentCursor);
        const res = await this.apiFetch(`/registry/agents/search?${params}`);
        if (!res.ok) break;
        const data = await res.json() as { results?: unknown[]; cursor?: string; has_more?: boolean };
        if (data.results?.length) {
          this.callbacks.onBootstrapAgents(data.results);
        }
        agentCursor = data.has_more ? (data.cursor ?? undefined) : undefined;
      } while (agentCursor);

      // Bootstrap properties — paginate through all results
      let propOffset = 0;
      const PROP_PAGE = 1000;
      let propCount: number;
      do {
        const res = await this.apiFetch(`/catalog/sync?limit=${PROP_PAGE}&offset=${propOffset}`);
        if (!res.ok) break;
        const data = await res.json() as { properties?: unknown[] };
        propCount = data.properties?.length ?? 0;
        if (propCount > 0) {
          this.callbacks.onBootstrapProperties(data.properties!);
        }
        propOffset += propCount;
      } while (propCount === PROP_PAGE);

      this.backoffMs = 1000;
    } catch (err) {
      this.config.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private schedulePoll(): void {
    if (!this.running) return;

    const interval = Math.max(this.config.pollIntervalMs, this.backoffMs);
    this.pollTimer = setTimeout(async () => {
      await this.poll();
      this.schedulePoll();
    }, interval);
  }

  private async poll(): Promise<void> {
    let hasMore = true;

    while (hasMore && this.running) {
      try {
        const params = new URLSearchParams();
        if (this.cursor) params.set('cursor', this.cursor);
        if (this.config.types?.length) params.set('types', this.config.types.join(','));
        params.set('limit', '1000');

        const res = await this.apiFetch(`/registry/feed?${params}`);
        if (!res.ok) {
          throw new Error(`Feed returned ${res.status}`);
        }

        const data = await res.json() as FeedResult | FeedError;

        if ('error' in data) {
          if (data.error === 'cursor_expired') {
            this.cursor = null;
            await this.bootstrap();
            return;
          }
          throw new Error(data.message ?? data.error);
        }

        if (data.events.length > 0) {
          this.callbacks.onEvents(data.events);
        }

        if (data.cursor) {
          this.cursor = data.cursor;
          if (this.config.persistCursor && this.config.cursorPath) {
            await this.saveCursor(this.cursor);
          }
        }

        hasMore = data.has_more;
        this.backoffMs = 1000;
      } catch (err) {
        this.config.onError?.(err instanceof Error ? err : new Error(String(err)));
        this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
        hasMore = false;
      }
    }
  }

  private async apiFetch(path: string): Promise<Response> {
    return fetch(`${this.config.baseUrl}/api${path}`, {
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
        'Accept': 'application/json',
      },
    });
  }

  private async loadCursor(): Promise<string | null> {
    try {
      const { readFile } = await import('node:fs/promises');
      const content = await readFile(this.config.cursorPath!, 'utf-8');
      return content.trim() || null;
    } catch {
      return null;
    }
  }

  private async saveCursor(cursor: string): Promise<void> {
    // Validate cursor is a UUID before writing to disk (defense against untrusted API data)
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cursor)) {
      return;
    }
    try {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(this.config.cursorPath!, cursor, 'utf-8');
    } catch (err) {
      this.config.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }
}
