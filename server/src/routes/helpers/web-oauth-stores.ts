/**
 * `@adcp/sdk` storage adapters for the web OAuth flow.
 *
 * Backs `startWebOAuthFlow` / `completeWebOAuthFlow` with our existing
 * `agent_contexts` and `agent_oauth_pending_flows` tables. The SDK owns
 * the protocol (PRM discovery, RFC 8707 `resource`, SEP-835 scope
 * priority, refresh-with-resource); these adapters are pure persistence.
 *
 * `redirectUri` is closed over per request so the same value used to
 * build the authorization URL also lands in
 * `agent_contexts.oauth_registered_redirect_uri`. That column drives the
 * stale-client check in the /start handler.
 *
 * The PKCE verifier is encrypted at rest with the calling org's salt;
 * `carry.organization_id` is the trust boundary. `consume` rejects rows
 * that arrive without a matching salt because we cannot decrypt them.
 */

import type {
  AgentConfig,
  OAuthConfigStorage,
  PendingWebFlow,
  PendingWebFlowStore,
} from '@adcp/sdk/auth';
import { query, isDatabaseInitialized } from '../../db/client.js';
import { encrypt, decrypt } from '../../db/encryption.js';
import { AgentContextDatabase } from '../../db/agent-context-db.js';
import { createLogger } from '../../logger.js';

const logger = createLogger('web-oauth-stores');

interface StoredFlow {
  state: string;
  agentId: string;
  agentUrl: string;
  codeVerifierEncrypted: string;
  codeVerifierIv: string;
  redirectUri: string;
  resource?: string;
  scope?: string;
  authorizationServerUrl: string;
  clientInformation: PendingWebFlow['clientInformation'];
  createdAt: string;
  expiresAt: string;
  carry?: Record<string, unknown>;
}

function carrySalt(carry: Record<string, unknown> | undefined): string {
  const orgId = carry?.organization_id;
  if (typeof orgId !== 'string' || orgId.length === 0) {
    throw new Error('web OAuth flow requires carry.organization_id for verifier encryption');
  }
  return orgId;
}

class AgentOAuthPendingFlowStore implements PendingWebFlowStore {
  async put(flow: PendingWebFlow): Promise<void> {
    const salt = carrySalt(flow.carry);
    const enc = encrypt(flow.codeVerifier, salt);
    const stored: StoredFlow = {
      state: flow.state,
      agentId: flow.agentId,
      agentUrl: flow.agentUrl,
      codeVerifierEncrypted: enc.encrypted,
      codeVerifierIv: enc.iv,
      redirectUri: flow.redirectUri,
      ...(flow.resource !== undefined && { resource: flow.resource }),
      ...(flow.scope !== undefined && { scope: flow.scope }),
      authorizationServerUrl: flow.authorizationServerUrl,
      clientInformation: flow.clientInformation,
      createdAt: flow.createdAt.toISOString(),
      expiresAt: flow.expiresAt.toISOString(),
      ...(flow.carry !== undefined && { carry: flow.carry }),
    };
    await query(
      `INSERT INTO agent_oauth_pending_flows (state, data, expires_at)
       VALUES ($1, $2, $3)`,
      [flow.state, JSON.stringify(stored), flow.expiresAt],
    );
  }

  async consume(state: string): Promise<PendingWebFlow | null> {
    const result = await query<{ data: StoredFlow }>(
      `DELETE FROM agent_oauth_pending_flows
       WHERE state = $1 AND expires_at > NOW()
       RETURNING data`,
      [state],
    );
    const stored = result.rows[0]?.data;
    if (!stored) return null;

    const salt = carrySalt(stored.carry);
    const codeVerifier = decrypt(stored.codeVerifierEncrypted, stored.codeVerifierIv, salt);

    return {
      state: stored.state,
      agentId: stored.agentId,
      agentUrl: stored.agentUrl,
      codeVerifier,
      redirectUri: stored.redirectUri,
      ...(stored.resource !== undefined && { resource: stored.resource }),
      ...(stored.scope !== undefined && { scope: stored.scope }),
      authorizationServerUrl: stored.authorizationServerUrl,
      clientInformation: stored.clientInformation,
      createdAt: new Date(stored.createdAt),
      expiresAt: new Date(stored.expiresAt),
      ...(stored.carry !== undefined && { carry: stored.carry }),
    };
  }

  async cleanupExpired(): Promise<number> {
    if (!isDatabaseInitialized()) return 0;
    try {
      const result = await query(
        `DELETE FROM agent_oauth_pending_flows WHERE expires_at <= NOW()`,
      );
      const count = result.rowCount ?? 0;
      if (count > 0) {
        logger.info({ deleted: count }, 'Cleaned up expired agent OAuth flows');
      }
      return count;
    } catch (err) {
      const isPoolTimeout = err instanceof Error && /timeout|connect/i.test(err.message);
      if (isPoolTimeout) {
        logger.warn({ err }, 'Agent OAuth flow cleanup skipped — DB pool busy');
      } else {
        logger.error({ err }, 'Failed to clean up expired agent OAuth flows');
      }
      return 0;
    }
  }
}

class AgentContextOAuthStorage implements OAuthConfigStorage {
  constructor(
    private readonly agentContextDb: AgentContextDatabase,
    private readonly redirectUri: string,
  ) {}

  async loadAgent(agentId: string): Promise<AgentConfig | undefined> {
    const ctx = await this.agentContextDb.getById(agentId);
    if (!ctx) return undefined;

    const agent: AgentConfig = {
      id: ctx.id,
      name: ctx.agent_name ?? 'Agent',
      agent_uri: ctx.agent_url,
      protocol: (ctx.protocol === 'a2a' ? 'a2a' : 'mcp'),
    };

    // Only surface oauth_client when its registered redirect_uri matches
    // the current request — otherwise the SDK would skip DCR and reuse a
    // client registered against a stale callback URL. The /start handler
    // also clears stale rows up front; this is defense in depth.
    const client = await this.agentContextDb.getOAuthClient(agentId);
    if (client && client.registered_redirect_uri === this.redirectUri) {
      agent.oauth_client = {
        client_id: client.client_id,
        ...(client.client_secret && { client_secret: client.client_secret }),
      };
    }

    const tokens = await this.agentContextDb.getOAuthTokens(agentId);
    if (tokens?.access_token) {
      agent.oauth_tokens = {
        access_token: tokens.access_token,
        ...(tokens.refresh_token && { refresh_token: tokens.refresh_token }),
        ...(tokens.expires_at && { expires_at: tokens.expires_at.toISOString() }),
      };
    }

    return agent;
  }

  async saveAgent(agent: AgentConfig): Promise<void> {
    if (agent.oauth_client) {
      await this.agentContextDb.saveOAuthClient(agent.id, {
        client_id: agent.oauth_client.client_id,
        ...(agent.oauth_client.client_secret && { client_secret: agent.oauth_client.client_secret }),
        registered_redirect_uri: this.redirectUri,
      });
    }
    if (agent.oauth_tokens) {
      await this.agentContextDb.saveOAuthTokens(agent.id, {
        access_token: agent.oauth_tokens.access_token,
        ...(agent.oauth_tokens.refresh_token && { refresh_token: agent.oauth_tokens.refresh_token }),
        ...(agent.oauth_tokens.expires_at && { expires_at: new Date(agent.oauth_tokens.expires_at) }),
      });
    }
  }
}

export function createWebOAuthAdapters(opts: {
  agentContextDb: AgentContextDatabase;
  redirectUri: string;
}): {
  pendingFlowStore: PendingWebFlowStore;
  agentStorage: OAuthConfigStorage;
} {
  return {
    pendingFlowStore: new AgentOAuthPendingFlowStore(),
    agentStorage: new AgentContextOAuthStorage(opts.agentContextDb, opts.redirectUri),
  };
}

export { AgentOAuthPendingFlowStore, AgentContextOAuthStorage };
