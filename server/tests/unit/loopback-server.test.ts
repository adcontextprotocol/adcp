/**
 * Test servers started with listenOnLoopback() keep serving a client that
 * reuses an idle connection after the worker stalls, and every unit test
 * starts its servers that way.
 *
 * The client and the server share one event loop. When the loop stalls
 * (CPU-starved worker, a synchronous schema compile) right after the client
 * writes a request on a pooled connection, the next loop iteration runs
 * timers before it polls sockets: Node's idle reaper (keepAliveTimeout 5 s
 * plus its 1 s buffer) destroys the socket with the request unread, and the
 * client sees `fetch failed` (read ECONNRESET).
 */
import { readdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { listenOnLoopback } from '../../src/testing/loopback-server.js';

const SERVER_ROOT = path.resolve(import.meta.dirname, '../..');

/** Blocks this thread without using CPU, as a descheduled worker would. */
function stall(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const servers: http.Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

describe('listenOnLoopback', () => {
  it('serves a request written on a reused connection just before a stall past the idle reaper', async () => {
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => res.end('ok'));
    });
    servers.push(server);
    const { origin } = await listenOnLoopback(server);
    const post = () => fetch(`${origin}/`, { method: 'POST', body: '{}' }).then(response => response.text());

    expect(await post()).toBe('ok');
    // Idle for less than the client's reuse window (the server's 5 s hint
    // minus undici's threshold), so the next request reuses the connection.
    await new Promise(resolve => setTimeout(resolve, 2_500));
    const second = post();
    // The request is written; the loop stalls before the server reads it,
    // until 7 s have passed since the connection went idle.
    stall(4_500);
    expect(await second).toBe('ok');
  });

  it('listens on an ephemeral 127.0.0.1 port and reports its origin', async () => {
    const server = http.createServer((_req, res) => res.end('ok'));
    servers.push(server);
    const { port, origin } = await listenOnLoopback(server);
    expect(port).toBeGreaterThan(0);
    expect(origin).toBe(`http://127.0.0.1:${port}`);
    expect(await (await fetch(origin)).text()).toBe('ok');
  });
});

/** A listen call: `.listen(`, also with whitespace or a line break around the dot or before the paren. */
const RAW_LISTEN = /\.\s*listen\s*\(/;

/** True when `source` starts a server with a raw listen call. */
function hasRawListen(source: string): boolean {
  return RAW_LISTEN.test(source);
}

// Test files whose listen call is not an in-process server a client reuses
// connections to.
const RAW_LISTEN_ALLOWED: Record<string, string> = {
  'tests/unit/loopback-server.test.ts': "this guard's own samples below",
  'tests/unit/supertest-conductor-loopback.test.ts': 'checks the loopback address family the supertest fix binds; one request per server',
  'tests/unit/hosted-webhook-receiver-ingress.test.ts': 'binds the port under test; one request per server',
  'tests/unit/storyboard-candidate-schema-root.test.ts': 'the server runs in a child-process script that sets keepAliveTimeout = 0 itself',
};

function testFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(path.join(SERVER_ROOT, dir), { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const file = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) testFiles(file, out);
    else if (/\.test\.[cm]?[jt]s$/.test(entry.name)) out.push(file);
  }
  return out;
}

describe('server unit tests', () => {
  it('start their HTTP servers with listenOnLoopback', () => {
    const files = [...testFiles('tests/unit'), ...testFiles('src')];
    expect(files.length).toBeGreaterThan(100);
    const raw = files.filter(file => !(file in RAW_LISTEN_ALLOWED)
      && hasRawListen(readFileSync(path.join(SERVER_ROOT, file), 'utf8')));
    expect(raw, 'start these servers with listenOnLoopback() from src/testing/loopback-server.ts').toEqual([]);
    for (const file of Object.keys(RAW_LISTEN_ALLOWED)) {
      expect(hasRawListen(readFileSync(path.join(SERVER_ROOT, file), 'utf8')), `${file} no longer needs its allowlist entry`).toBe(true);
    }
  });

  it('flags raw listen calls, including the spaced and chained forms', () => {
    expect(hasRawListen("await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()));")).toBe(true);
    expect(hasRawListen("const server = app.listen(0, '127.0.0.1');")).toBe(true);
    expect(hasRawListen('server?.listen(port)')).toBe(true);
    // Would slip a pattern that requires `.listen(` adjacent.
    expect(hasRawListen("http.createServer(app)\n  .listen (0, '127.0.0.1');")).toBe(true);
  });

  it('accepts the helper and listening-event code', () => {
    expect(hasRawListen('await listenOnLoopback(server);')).toBe(false);
    expect(hasRawListen("await once(server, 'listening');")).toBe(false);
    expect(hasRawListen("server.once('listening', resolve);")).toBe(false);
    expect(hasRawListen('const listener = http.createServer(app);')).toBe(false);
  });
});
