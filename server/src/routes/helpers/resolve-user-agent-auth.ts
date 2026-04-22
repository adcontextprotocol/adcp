/**
 * Resolve Test-your-agent auth for a storyboard endpoint.
 *
 * Uses the authenticated user's org context (matching the "Auth configured
 * via OAuth" label the UI shows), returns the full `{tokens, client}` shape
 * for OAuth when a refresh token is saved so the SDK can refresh transparently,
 * and falls back to the raw access token as a bearer otherwise so the agent
 * returns a clear 401 rather than the server dropping the Authorization header.
 *
 * Callers must have confirmed the user belongs to `orgId` and that `orgId`
 * owns the agent; by construction no further fallback is needed.
 */

import type { AgentContextDatabase } from '../../db/agent-context-db.js';
import { decodeBasicCredentials, type ResolvedOwnerAuth } from '../../db/compliance-db.js';

interface WarnLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export async function resolveUserAgentAuth(
  agentContextDb: AgentContextDatabase,
  orgId: string,
  agentUrl: string,
  logger: WarnLogger,
): Promise<ResolvedOwnerAuth | undefined> {
  // Static token lookup throwing falls through to the OAuth branch below —
  // the connect-form token and the OAuth token are independent paths.
  try {
    const staticAuth = await agentContextDb.getAuthInfoByOrgAndUrl(orgId, agentUrl);
    if (staticAuth) {
      if (staticAuth.authType === 'basic') {
        const basic = decodeBasicCredentials(staticAuth.token);
        if (basic) return basic;
      }
      return { type: 'bearer', token: staticAuth.token };
    }
  } catch (err) {
    logger.warn({ err, agentUrl, orgId }, 'resolveUserAgentAuth: static token lookup failed');
  }

  try {
    const context = await agentContextDb.getByOrgAndUrl(orgId, agentUrl);
    if (!context?.has_oauth_token) return undefined;

    const tokens = await agentContextDb.getOAuthTokensByOrgAndUrl(orgId, agentUrl);
    if (!tokens?.access_token) return undefined;

    if (!tokens.refresh_token) {
      return { type: 'bearer', token: tokens.access_token };
    }

    const oauth: Extract<ResolvedOwnerAuth, { type: 'oauth' }> = {
      type: 'oauth',
      tokens: {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        ...(tokens.expires_at && { expires_at: tokens.expires_at.toISOString() }),
      },
    };

    const client = await agentContextDb.getOAuthClient(context.id);
    if (client) {
      oauth.client = {
        client_id: client.client_id,
        ...(client.client_secret && { client_secret: client.client_secret }),
      };
    }
    return oauth;
  } catch (err) {
    logger.warn({ err, agentUrl, orgId }, 'resolveUserAgentAuth: OAuth token lookup failed');
    return undefined;
  }
}
