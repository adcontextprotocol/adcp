import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import { ConformanceWSServerTransport } from '../../src/conformance/ws-server-transport.js';

class FakeSocket extends EventEmitter {
  sent: string[] = [];
  closed = false;

  send(data: string, cb?: (err?: Error) => void): void {
    this.sent.push(data);
    cb?.();
  }

  close(_code?: number, _reason?: string): void {
    this.closed = true;
    this.emit('close');
  }
}

function makeTransport(orgId = 'org_a'): { transport: ConformanceWSServerTransport; socket: FakeSocket } {
  const socket = new FakeSocket();
  const transport = new ConformanceWSServerTransport(socket as unknown as WebSocket, orgId);
  return { transport, socket };
}

describe('ConformanceWSServerTransport', () => {
  it('exposes a deterministic-shape sessionId for the org', () => {
    const { transport } = makeTransport('org_xyz');
    expect(transport.sessionId).toMatch(/^conformance-org_xyz-\d+$/);
    expect(transport.orgId).toBe('org_xyz');
  });

  it('parses inbound JSON-RPC frames and dispatches via onmessage', async () => {
    const { transport, socket } = makeTransport();
    const received: unknown[] = [];
    transport.onmessage = (msg) => received.push(msg);
    await transport.start();

    const frame = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    socket.emit('message', Buffer.from(frame), false);

    expect(received).toHaveLength(1);
    expect((received[0] as { method: string }).method).toBe('tools/list');
  });

  it('reports malformed JSON via onerror without closing', async () => {
    const { transport, socket } = makeTransport();
    const onerror = vi.fn();
    transport.onmessage = vi.fn();
    transport.onerror = onerror;
    await transport.start();

    socket.emit('message', Buffer.from('not json'), false);
    expect(onerror).toHaveBeenCalled();
    expect(transport.onmessage).not.toHaveBeenCalled();
    expect(socket.closed).toBe(false);
  });

  it('rejects binary frames', async () => {
    const { transport, socket } = makeTransport();
    const onerror = vi.fn();
    transport.onerror = onerror;
    await transport.start();

    socket.emit('message', Buffer.from([1, 2, 3]), true);
    expect(onerror).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/binary/) }));
  });

  it('serializes outbound frames as JSON', async () => {
    const { transport, socket } = makeTransport();
    await transport.start();
    await transport.send({ jsonrpc: '2.0', id: 1, result: { ok: true } });
    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0])).toEqual({ jsonrpc: '2.0', id: 1, result: { ok: true } });
  });

  it('throws on send after close', async () => {
    const { transport } = makeTransport();
    await transport.start();
    await transport.close();
    await expect(transport.send({ jsonrpc: '2.0', id: 1, result: {} })).rejects.toThrow(/closed/);
  });

  it('close is idempotent', async () => {
    const { transport } = makeTransport();
    const onclose = vi.fn();
    transport.onclose = onclose;
    await transport.start();
    await transport.close();
    await transport.close();
    expect(onclose).toHaveBeenCalledTimes(1);
  });

  it('fires onclose when the underlying socket closes', async () => {
    const { transport, socket } = makeTransport();
    const onclose = vi.fn();
    transport.onclose = onclose;
    await transport.start();
    socket.emit('close');
    expect(onclose).toHaveBeenCalledTimes(1);
  });
});
