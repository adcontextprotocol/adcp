/**
 * Adopter-side MCP `Transport` over an outbound WebSocket.
 *
 * Mirrors the server-side transport in `server/src/conformance/`.
 * Lives here in `examples/` while we prototype; will move to
 * `@adcp/conformance-client` in the adcp-client repo before publish.
 */

import WebSocket from 'ws';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  JSONRPCMessageSchema,
  type JSONRPCMessage,
} from '@modelcontextprotocol/sdk/types.js';

export class AdopterWSTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  sessionId?: string;

  private closed = false;

  constructor(private readonly socket: WebSocket) {}

  async start(): Promise<void> {
    this.socket.on('message', (data, isBinary) => {
      if (isBinary) {
        this.onerror?.(new Error('binary frames are not supported'));
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

    if (this.socket.readyState === WebSocket.CONNECTING) {
      await new Promise<void>((resolve, reject) => {
        this.socket.once('open', () => resolve());
        this.socket.once('error', reject);
      });
    }
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) throw new Error('transport closed');
    return new Promise((resolve, reject) => {
      this.socket.send(JSON.stringify(message), (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.close(1000, 'adopter close');
    } catch {
      // ignore
    }
    this.onclose?.();
  }
}
