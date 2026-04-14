import { query } from './client.js';
import { logger as baseLogger } from '../logger.js';

const logger = baseLogger.child({ module: 'outbound-log' });

export type OutboundRequestType = 'health_check' | 'discovery' | 'compliance' | 'crawl' | 'validation';

export interface OutboundRequestEntry {
  agent_url: string;
  request_type: OutboundRequestType;
  user_agent: string;
  response_time_ms?: number;
  success: boolean;
  error_message?: string;
}

export interface OutboundRequestRow extends OutboundRequestEntry {
  id: string;
  created_at: string;
}

/**
 * Fire-and-forget insert. Failures are logged but never propagated
 * so monitoring never blocks the request path.
 */
export function logOutboundRequest(entry: OutboundRequestEntry): void {
  query(
    `INSERT INTO agent_outbound_requests
       (agent_url, request_type, user_agent, response_time_ms, success, error_message)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      entry.agent_url,
      entry.request_type,
      entry.user_agent,
      entry.response_time_ms ?? null,
      entry.success,
      entry.error_message ?? null,
    ],
  ).catch(err => {
    logger.warn({ err, agentUrl: entry.agent_url }, 'Failed to log outbound request');
  });
}

export async function getRequestLog(
  agentUrl: string,
  options: { limit?: number; since?: string } = {},
): Promise<OutboundRequestRow[]> {
  const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
  const params: unknown[] = [agentUrl, limit];
  let whereClause = 'WHERE agent_url = $1';

  if (options.since) {
    const sinceDate = new Date(options.since);
    if (!isNaN(sinceDate.getTime())) {
      whereClause += ' AND created_at >= $3';
      params.push(sinceDate.toISOString());
    }
  }

  const result = await query(
    `SELECT id, agent_url, request_type, user_agent, response_time_ms,
            success, error_message, created_at
     FROM agent_outbound_requests
     ${whereClause}
     ORDER BY created_at DESC
     LIMIT $2`,
    params,
  );
  return result.rows;
}

export async function getRequestCount(agentUrl: string): Promise<number> {
  const result = await query(
    'SELECT COUNT(*) AS count FROM agent_outbound_requests WHERE agent_url = $1',
    [agentUrl],
  );
  return parseInt(result.rows[0]?.count ?? '0', 10);
}

export async function cleanupOldRequests(retentionDays: number = 30): Promise<number> {
  const days = Math.max(1, Math.floor(retentionDays));
  const result = await query(
    `DELETE FROM agent_outbound_requests WHERE created_at < NOW() - make_interval(days => $1)`,
    [days],
  );
  return result.rowCount ?? 0;
}
