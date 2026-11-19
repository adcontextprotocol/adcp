import type http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Starts a test's in-process HTTP server on an ephemeral port of `host` and
 * returns its origin. Every server a unit test starts goes through here
 * (tests/unit/loopback-server.test.ts checks that). It lives in src because
 * tsc checks the test files under src with rootDir src, so they can import
 * only from src.
 *
 * The server keeps idle connections open (`keepAliveTimeout = 0`). The test
 * and the server share one event loop: when the loop stalls right after the
 * client writes a request on a pooled connection (a CPU-starved worker, a
 * synchronous schema compile), the next iteration runs timers before it
 * polls sockets, and Node's idle reaper (keepAliveTimeout plus its 1 s
 * buffer) destroys the socket with the request unread. The client then sees
 * `fetch failed` (read ECONNRESET). Without the reaper, the client retires
 * idle connections itself, and the test closes the rest at teardown
 * (`server.close()` or `server.closeAllConnections()`).
 */
export async function listenOnLoopback(
  server: http.Server,
  host = '127.0.0.1',
): Promise<{ port: number; origin: string }> {
  server.keepAliveTimeout = 0;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  return { port, origin: `http://${host.includes(':') ? `[${host}]` : host}:${port}` };
}
