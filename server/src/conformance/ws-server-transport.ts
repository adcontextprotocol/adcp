/**
 * Server-side MCP Transport over a WebSocket connection.
 *
 * Mirrors the SDK's `WebSocketClientTransport` shape but in the server
 * direction: an inbound `ws.WebSocket` connection wrapped as the
 * MCP `Transport` interface. The MCP `Client` Addie instantiates per
 * connection drives the protocol over this transport.
 *
 * Only one bad-frame per connection is tolerated quietly — repeated
 * malformed frames are surfaced via `onerror` but do not close the
 * channel. `close()` is idempotent.
 */

import type WebSocket from 'ws';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  JSONRPCMessageSchema,
  type JSONRPCMessage,
} from '@modelcontextprotocol/sdk/types.js';
import { createLogger } from '../logger.js';

const logger = createLogger('conformance-ws-server-transport');

export class ConformanceWSServerTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  sessionId?: string;

  private closed = false;

  constructor(
    private readonly socket: WebSocket,
    public readonly orgId: string,
  ) {
    this.sessionId = `conformance-${orgId}-${Date.now()}`;
  }

  /** True when the local close path or the underlying socket has closed. */
  isClosed(): boolean {
    return this.closed;
  }

  async start(): Promise<void> {
    this.socket.on('message', (data, isBinary) => {
      if (isBinary) {
        this.onerror?.(new Error('binary frames are not supported on the conformance channel'));
        return;
      }
      const text = data.toString('utf-8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        this.onerror?.(new Error(`malformed JSON frame: ${(err as Error).message}`));
        return;
      }
      const result = JSONRPCMessageSchema.safeParse(parsed);
      if (!result.success) {
        this.onerror?.(new Error(`malformed JSON-RPC message: ${result.error.message}`));
        return;
      }
      this.onmessage?.(result.data);
    });

    this.socket.on('close', () => {
      if (this.closed) return;
      this.closed = true;
      this.onclose?.();
    });

    this.socket.on('error', (err) => {
      this.onerror?.(err);
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) {
      throw new Error('transport closed');
    }
    return new Promise((resolve, reject) => {
      this.socket.send(JSON.stringify(message), (err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.close(1000, 'transport closed');
    } catch (err) {
      logger.debug({ err, orgId: this.orgId }, 'socket close threw');
    }
    this.onclose?.();
  }
}
