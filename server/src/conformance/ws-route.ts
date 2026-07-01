/**
 * WebSocket upgrade handler for the Addie conformance channel.
 *
 * Mounted on the existing http.Server via `attachConformanceWS`. Path
 * is `/conformance/connect`. Adopters open an outbound WebSocket here
 * with a token issued by `issueConformanceToken`; the handler verifies
 * the token, instantiates a `ConformanceWSServerTransport` + an MCP
 * `Client`, drives the MCP `initialize` handshake, and registers the
 * session in `conformanceSessions`.
 *
 * Tenant scoping is enforced at auth time via the JWT's `sub` claim.
 * NOT in the URL path. Single shared endpoint by design — see #3991.
 *
 * Heartbeat: ping every 30s, terminate on missing pong after two
 * intervals. Standard `ws` keepalive pattern.
 */

import type * as http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createLogger } from '../logger.js';
import { ConformanceWSServerTransport } from './ws-server-transport.js';
import { conformanceSessions } from './session-store.js';
import { verifyConformanceToken } from './token.js';

const logger = createLogger('conformance-ws-route');

const WS_PATH = '/conformance/connect';
const HEARTBEAT_INTERVAL_MS = 30_000;

interface AliveSocket extends WebSocket {
  isAlive: boolean;
}

function extractToken(req: http.IncomingMessage): string | null {
  // Prefer the `Sec-WebSocket-Protocol: adcp.conformance, <token>` form —
  // headers are not surfaced in access logs by default. Fall back to a
  // `?token=` query param for browser clients (which can't set custom
  // WebSocket headers); operators running this surface should treat
  // adopter-facing access logs as token-equivalent within the 1h TTL.
  const subprotocols = req.headers['sec-websocket-protocol'];
  if (typeof subprotocols === 'string') {
    const parts = subprotocols.split(',').map((s) => s.trim());
    const adcpIdx = parts.findIndex((p) => p === 'adcp.conformance');
    if (adcpIdx !== -1 && parts[adcpIdx + 1]) return parts[adcpIdx + 1];
  }

  const url = new URL(req.url ?? '/', 'http://placeholder');
  return url.searchParams.get('token');
}

export function attachConformanceWS(httpServer: http.Server): void {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://placeholder');
    if (url.pathname !== WS_PATH) return;

    const token = extractToken(req);
    if (!token) {
      logger.warn({ remoteAddress: req.socket.remoteAddress }, 'conformance upgrade rejected: missing token');
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    let orgId: string;
    try {
      const claims = verifyConformanceToken(token);
      orgId = claims.sub;
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'conformance upgrade rejected: invalid token');
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      void onConnection(ws as AliveSocket, orgId);
    });
  });

  const heartbeat = setInterval(() => {
    wss.clients.forEach((client) => {
      const alive = client as AliveSocket;
      if (!alive.isAlive) {
        alive.terminate();
        return;
      }
      alive.isAlive = false;
      try {
        alive.ping();
      } catch {
        // ignore: terminated sockets throw on ping
      }
    });
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  httpServer.on('close', () => {
    clearInterval(heartbeat);
    wss.close();
  });
}

async function onConnection(ws: AliveSocket, orgId: string): Promise<void> {
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  const transport = new ConformanceWSServerTransport(ws, orgId);
  const client = new Client(
    { name: 'addie-conformance', version: '0.1.0' },
    { capabilities: {} },
  );

  // Identity-keyed eviction: only remove the session entry if it still
  // points at *this* transport. A same-org reconnect closes the prior
  // socket via `register()`'s last-writer-wins displacement, which fires
  // this listener for the *prior* socket — without the identity check, it
  // would delete the freshly-registered new session and leave the org in
  // a permanently-unreachable state until the next disconnect.
  ws.once('close', () => {
    if (conformanceSessions.get(orgId)?.transport === transport) {
      conformanceSessions.remove(orgId);
    }
  });

  try {
    await client.connect(transport);
  } catch (err) {
    logger.warn({ err, orgId }, 'conformance client.connect failed');
    try {
      ws.close(1011, 'mcp initialize failed');
    } catch {
      // ignore
    }
    return;
  }

  // If the adopter disconnected during initialize, skip registration —
  // the close listener already ran (no-op against an empty store) and
  // registering now would leak a session whose underlying socket is gone.
  if (ws.readyState !== ws.OPEN) {
    logger.debug({ orgId }, 'conformance adopter disconnected during initialize');
    return;
  }

  conformanceSessions.register({
    orgId,
    transport,
    mcpClient: client,
    connectedAt: Date.now(),
  });
}
