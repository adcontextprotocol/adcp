/**
 * In-memory session store for live Addie Socket Mode connections.
 *
 * Keyed by WorkOS organization id. One session per org at a time —
 * a duplicate connect from the same org displaces the prior session
 * (last-writer-wins). Sessions auto-evict on transport close.
 *
 * Single-process. The conformance channel is dev/staging only and
 * does not need cross-process state; if the server restarts, adopters
 * reconnect on their next chat session.
 */

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { ConformanceWSServerTransport } from './ws-server-transport.js';
import { createLogger } from '../logger.js';

const logger = createLogger('conformance-session-store');

export interface ConformanceSession {
  orgId: string;
  transport: ConformanceWSServerTransport;
  mcpClient: Client;
  connectedAt: number;
}

class ConformanceSessionStore {
  private sessions = new Map<string, ConformanceSession>();

  register(session: ConformanceSession): void {
    const prior = this.sessions.get(session.orgId);
    if (prior) {
      logger.warn(
        { orgId: session.orgId, priorConnectedAt: prior.connectedAt },
        'displacing prior conformance session for org',
      );
      prior.transport.close().catch((err) =>
        logger.debug({ err, orgId: session.orgId }, 'prior session close threw'),
      );
    }
    this.sessions.set(session.orgId, session);
    logger.info(
      { orgId: session.orgId, sessionId: session.transport.sessionId },
      'conformance session registered',
    );
  }

  get(orgId: string): ConformanceSession | undefined {
    return this.sessions.get(orgId);
  }

  remove(orgId: string): void {
    if (this.sessions.delete(orgId)) {
      logger.info({ orgId }, 'conformance session removed');
    }
  }

  size(): number {
    return this.sessions.size;
  }

  list(): Array<Pick<ConformanceSession, 'orgId' | 'connectedAt'> & { sessionId?: string }> {
    return Array.from(this.sessions.values()).map((s) => ({
      orgId: s.orgId,
      connectedAt: s.connectedAt,
      sessionId: s.transport.sessionId,
    }));
  }

  async closeAll(): Promise<void> {
    const transports = Array.from(this.sessions.values()).map((s) => s.transport);
    this.sessions.clear();
    await Promise.all(
      transports.map((t) =>
        t.close().catch((err) => logger.debug({ err }, 'shutdown close threw')),
      ),
    );
  }
}

export const conformanceSessions = new ConformanceSessionStore();

export type { ConformanceSessionStore };
