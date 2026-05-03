/**
 * Adopter-facing conformance client.
 *
 * Three-line integration:
 *   const client = new ConformanceClient({ url, token, server });
 *   await client.start();
 *   // ... your existing app continues running
 *
 * The client opens an outbound WebSocket to Addie's conformance
 * endpoint, authenticates with the adopter-issued JWT, and exposes
 * the supplied MCP `Server` instance over the channel. Addie then
 * drives `tools/list`, `tools/call`, etc. against it.
 *
 * Reconnect: exponential backoff up to 30s, capped. Stop via
 * `close()` to opt out of further reconnect attempts.
 */

import WebSocket from 'ws';
import type { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { AdopterWSTransport } from './ws-transport.js';

export type ConformanceStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error';

export interface ConformanceClientOptions {
  url: string;
  token: string;
  server: McpServer;
  reconnect?: boolean;
  onStatus?: (status: ConformanceStatus, detail?: { error?: Error; attempt?: number }) => void;
}

const RECONNECT_INITIAL_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

export class ConformanceClient {
  private status: ConformanceStatus = 'idle';
  private socket?: WebSocket;
  private transport?: AdopterWSTransport;
  private stopped = false;
  private reconnectAttempt = 0;
  private readonly opts: Required<Pick<ConformanceClientOptions, 'reconnect'>> & ConformanceClientOptions;

  constructor(opts: ConformanceClientOptions) {
    this.opts = { reconnect: true, ...opts };
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.transport) {
      await this.transport.close();
    } else if (this.socket) {
      this.socket.close(1000, 'adopter close');
    }
    this.setStatus('idle');
  }

  getStatus(): ConformanceStatus {
    return this.status;
  }

  private async connect(): Promise<void> {
    this.setStatus('connecting');
    const url = new URL(this.opts.url);
    url.searchParams.set('token', this.opts.token);
    const socket = new WebSocket(url.toString());
    this.socket = socket;
    const transport = new AdopterWSTransport(socket);
    this.transport = transport;

    socket.once('close', () => {
      this.setStatus('disconnected');
      if (!this.stopped && this.opts.reconnect) {
        void this.scheduleReconnect();
      }
    });

    try {
      await this.opts.server.connect(transport);
      this.reconnectAttempt = 0;
      this.setStatus('connected');
    } catch (err) {
      this.setStatus('error', { error: err as Error });
      socket.close(1011, 'connect failed');
      if (!this.stopped && this.opts.reconnect) {
        void this.scheduleReconnect();
      }
      throw err;
    }
  }

  private async scheduleReconnect(): Promise<void> {
    this.reconnectAttempt += 1;
    const delay = Math.min(
      RECONNECT_INITIAL_MS * 2 ** (this.reconnectAttempt - 1),
      RECONNECT_MAX_MS,
    );
    this.setStatus('connecting', { attempt: this.reconnectAttempt });
    await new Promise((r) => setTimeout(r, delay));
    if (this.stopped) return;
    try {
      await this.connect();
    } catch {
      // setStatus already invoked; loop continues via close handler
    }
  }

  private setStatus(status: ConformanceStatus, detail?: { error?: Error; attempt?: number }): void {
    this.status = status;
    this.opts.onStatus?.(status, detail);
  }
}
