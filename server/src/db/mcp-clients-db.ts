/**
 * Database layer for MCP OAuth registered clients
 *
 * Persists dynamic client registrations (RFC 7591) so they survive
 * server restarts. MCP clients cache their client_id and reuse it
 * across sessions.
 */

import { OAuthClientInformationFullSchema } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { query } from './client.js';
import { createLogger } from '../logger.js';

const logger = createLogger('mcp-clients-db');

interface MCPClientRow {
  client_info: unknown;
}

/**
 * Look up a registered MCP client by ID
 */
export async function getClient(
  clientId: string,
): Promise<OAuthClientInformationFull | undefined> {
  try {
    const result = await query<MCPClientRow>(
      `SELECT client_info FROM mcp_oauth_clients WHERE client_id = $1`,
      [clientId],
    );
    const raw = result.rows[0]?.client_info;
    if (!raw) return undefined;
    return OAuthClientInformationFullSchema.parse(raw);
  } catch (err) {
    logger.error({ err, clientId }, 'Failed to look up MCP client');
    throw err;
  }
}

/**
 * Register (or re-register) an MCP client
 */
export async function registerClient(
  clientInfo: OAuthClientInformationFull,
): Promise<OAuthClientInformationFull> {
  try {
    await query(
      `INSERT INTO mcp_oauth_clients (client_id, client_info)
       VALUES ($1, $2)
       ON CONFLICT (client_id)
       DO UPDATE SET client_info = EXCLUDED.client_info, updated_at = NOW()`,
      [clientInfo.client_id, JSON.stringify(clientInfo)],
    );
    return clientInfo;
  } catch (err) {
    logger.error({ err, clientId: clientInfo.client_id }, 'Failed to register MCP client');
    throw err;
  }
}
