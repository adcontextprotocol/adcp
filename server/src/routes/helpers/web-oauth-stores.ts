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
 * The PKCE verifier and confidential client secret are encrypted with the org's salt;
 * `carry.organization_id` is the trust boundary. `consume` rejects rows
 * that arrive without a matching salt because we cannot decrypt them.
 */

import { OAuthError } from '@adcp/sdk/auth';
import type {
  AgentConfig,
  OAuthConfigStorage,
  PendingWebFlow,
  PendingWebFlowStore,
} from '@adcp/sdk/auth';
import { query, isDatabaseInitialized } from '../../db/client.js';
import { encrypt, decrypt } from '../../db/encryption.js';
import { AgentContextDatabase } from '../../db/agent-context-db.js';
import {
  captureAgentOAuthState, assertAgentOAuthState, completeOwnerOAuthIfUnchanged,
  parseAgentOAuthState, OAuthStateChangedError, type AgentOAuthState,
} from '../../db/agent-oauth-state-db.js';
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
  authorizationServerIssuer?: string;
  resourceOverrideSnapshot?: string | null;
  clientSecretEncrypted?: string;
  clientSecretIv?: string;
  ownerState?: AgentOAuthState;
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
  constructor(private readonly owner?: {
    capture: (flow: PendingWebFlow) => Promise<AgentOAuthState>;
    restore: (flow: PendingWebFlow, state: AgentOAuthState) => void;
  }) {}

  async put(flow: PendingWebFlow): Promise<void> {
    const salt = carrySalt(flow.carry);
    if (!flow.authorizationServerIssuer) throw new OAuthStateChangedError();
    const enc = encrypt(flow.codeVerifier, salt);
    const { client_secret: secret, ...publicClient } = flow.clientInformation;
    const protectedSecret = secret === undefined ? undefined : encrypt(secret, salt);
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
      authorizationServerIssuer: flow.authorizationServerIssuer,
      ...(Object.prototype.hasOwnProperty.call(flow, 'resourceOverrideSnapshot') && {
        resourceOverrideSnapshot: flow.resourceOverrideSnapshot,
      }),
      clientInformation: publicClient,
      ...(protectedSecret && { clientSecretEncrypted: protectedSecret.encrypted, clientSecretIv: protectedSecret.iv }),
      ...(this.owner && { ownerState: await this.owner.capture(flow) }),
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

    // Historical plaintext/missing-binding rows require restart; never infer trust.
    if (!stored.authorizationServerIssuer || stored.clientInformation.client_secret !== undefined) {
      throw new OAuthStateChangedError();
    }
    if (Boolean(stored.clientSecretEncrypted) !== Boolean(stored.clientSecretIv)) throw new OAuthStateChangedError();
    const salt = carrySalt(stored.carry);
    const codeVerifier = decrypt(stored.codeVerifierEncrypted, stored.codeVerifierIv, salt);

    const flow: PendingWebFlow = {
      state: stored.state,
      agentId: stored.agentId,
      agentUrl: stored.agentUrl,
      codeVerifier,
      redirectUri: stored.redirectUri,
      ...(stored.resource !== undefined && { resource: stored.resource }),
      ...(stored.scope !== undefined && { scope: stored.scope }),
      authorizationServerUrl: stored.authorizationServerUrl,
      authorizationServerIssuer: stored.authorizationServerIssuer,
      ...(Object.prototype.hasOwnProperty.call(stored, 'resourceOverrideSnapshot') && {
        resourceOverrideSnapshot: stored.resourceOverrideSnapshot,
      }),
      clientInformation: {
        ...stored.clientInformation,
        ...(stored.clientSecretEncrypted && stored.clientSecretIv && {
          client_secret: decrypt(stored.clientSecretEncrypted, stored.clientSecretIv, salt),
        }),
      },
      createdAt: new Date(stored.createdAt),
      expiresAt: new Date(stored.expiresAt),
      ...(stored.carry !== undefined && { carry: stored.carry }),
    };
    if (this.owner) this.owner.restore(flow, parseAgentOAuthState(stored.ownerState));
    return flow;
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

/** Owner flow storage. Prior grants are read only in ordinary bound reuse;
 * explicit fresh recovery omits them. Registration is never early-persisted. */
class AgentContextOAuthStorage implements OAuthConfigStorage {
  private state?: AgentOAuthState;
  private stagedClient?: AgentConfig['oauth_client'];
  private completed = false;
  private initialViewLoaded = false;
  private initialTokens?: AgentConfig['oauth_tokens'];

  constructor(private readonly options: {
    agentContextDb: Pick<AgentContextDatabase, 'getById' | 'getOAuthClient' | 'getOAuthTokens'>;
    redirectUri: string;
    userId: string;
    ownerStart?: { id: string; organizationId: string; agentUrl: string; fresh: boolean };
    authorize: (organizationId: string) => Promise<boolean>;
  }) {}

  async capture(flow: PendingWebFlow): Promise<AgentOAuthState> {
    if (!this.state || flow.agentId !== this.state.id || flow.agentUrl !== this.state.agent_url ||
        flow.redirectUri !== this.options.redirectUri ||
        flow.carry?.organization_id !== this.state.organization_id || flow.carry?.user_id !== this.options.userId) {
      throw new OAuthStateChangedError();
    }
    await this.loadAgent(flow.agentId); // Recheck after discovery, before redirect/pending storage.
    return { ...this.state };
  }

  restore(flow: PendingWebFlow, state: AgentOAuthState): void {
    if (this.state || !flow.authorizationServerIssuer || flow.agentId !== state.id || flow.agentUrl !== state.agent_url ||
        flow.redirectUri !== this.options.redirectUri || flow.carry?.organization_id !== state.organization_id ||
        flow.carry?.user_id !== this.options.userId) throw new OAuthStateChangedError();
    this.state = { ...state };
    this.stagedClient = { ...flow.clientInformation };
  }

  async loadAgent(agentId: string): Promise<AgentConfig | undefined> {
    if (!this.state) {
      const owner = this.options.ownerStart;
      if (!owner || owner.id !== agentId) throw new OAuthStateChangedError();
      this.state = await captureAgentOAuthState(owner.id, owner.organizationId, owner.agentUrl);
    }
    if (this.completed || agentId !== this.state.id ||
        !(await this.options.authorize(this.state.organization_id))) throw new OAuthStateChangedError();
    await assertAgentOAuthState(this.state);
    const ctx = await this.options.agentContextDb.getById(agentId);
    if (!ctx || ctx.organization_id !== this.state.organization_id || ctx.agent_url !== this.state.agent_url) {
      throw new OAuthStateChangedError();
    }
    if (!this.initialViewLoaded && this.options.ownerStart) {
      const fresh = this.options.ownerStart.fresh;
      const saved = this.state;
      const hasTokens = Boolean(saved.oauth_access_token_encrypted || saved.oauth_access_token_iv ||
        saved.oauth_refresh_token_encrypted || saved.oauth_refresh_token_iv);
      const hasClient = Boolean(saved.oauth_client_id || saved.oauth_client_secret_encrypted || saved.oauth_client_secret_iv);
      const canReuseClient = Boolean(saved.oauth_client_id && saved.oauth_client_issuer &&
        saved.oauth_registered_redirect_uri === this.options.redirectUri);
      const requireOwner = () => new OAuthError(
        'Saved OAuth credentials need owner authorization. Start a new sign-in; a server without dynamic registration requires an independently trusted client configuration.',
        'owner_reauthorization_required',
      );
      if (!fresh && ((hasClient && !canReuseClient) || (hasTokens && (!saved.oauth_token_issuer || !canReuseClient)))) {
        throw requireOwner();
      }
      if (canReuseClient) {
        if (Boolean(saved.oauth_client_secret_encrypted) !== Boolean(saved.oauth_client_secret_iv)) throw requireOwner();
        const client = await this.options.agentContextDb.getOAuthClient(agentId);
        if (!client?.issuer || client.registered_redirect_uri !== this.options.redirectUri) throw requireOwner();
        this.stagedClient = { client_id: client.client_id, issuer: client.issuer,
          ...(client.client_secret !== undefined && { client_secret: client.client_secret }) };
      }
      if (!fresh && hasTokens) {
        if (!saved.oauth_access_token_encrypted || !saved.oauth_access_token_iv ||
            Boolean(saved.oauth_refresh_token_encrypted) !== Boolean(saved.oauth_refresh_token_iv)) throw requireOwner();
        const tokens = await this.options.agentContextDb.getOAuthTokens(agentId);
        if (!tokens?.issuer) throw requireOwner();
        this.initialTokens = { access_token: tokens.access_token, issuer: tokens.issuer,
          ...(tokens.refresh_token !== undefined && { refresh_token: tokens.refresh_token }),
          ...(tokens.expires_at !== undefined && { expires_at: tokens.expires_at.toISOString() }) };
      }
      // A replacement between snapshot validation and the separate secret read
      // must refuse before the SDK receives the credential-bearing view.
      await assertAgentOAuthState(saved);
      this.initialViewLoaded = true;
    }
    return {
      id: ctx.id, name: ctx.agent_name ?? 'Agent', agent_uri: ctx.agent_url,
      protocol: ctx.protocol === 'a2a' ? 'a2a' : 'mcp',
      // Explicit fresh mode omits prior tokens. Reused client metadata is only
      // exposed with its existing issuer/redirect; SDK discovery validates it.
      ...(this.initialTokens && { oauth_tokens: { ...this.initialTokens } }),
      ...(this.stagedClient && { oauth_client: { ...this.stagedClient } }),
    };
  }

  async saveAgent(agent: AgentConfig): Promise<void> {
    if (!this.state || this.completed || agent.id !== this.state.id || agent.agent_uri !== this.state.agent_url) {
      throw new OAuthStateChangedError();
    }
    await this.loadAgent(agent.id); // Includes current access and exact durable snapshot.
    const client = agent.oauth_client;
    if (!client?.client_id || !client.issuer) throw new OAuthStateChangedError();
    if (!agent.oauth_tokens) {
      if (this.stagedClient) throw new OAuthStateChangedError();
      this.stagedClient = { ...client }; // Private DCR staging; zero owner SQL writes.
      return;
    }
    const staged = this.stagedClient;
    if (!staged || client.client_id !== staged.client_id || client.client_secret !== staged.client_secret ||
        client.client_secret_expires_at !== staged.client_secret_expires_at || client.issuer !== staged.issuer) {
      throw new OAuthStateChangedError();
    }
    const tokens = agent.oauth_tokens;
    await completeOwnerOAuthIfUnchanged(this.state, client, {
      access_token: tokens.access_token,
      ...(tokens.refresh_token !== undefined && { refresh_token: tokens.refresh_token }),
      ...(tokens.issuer !== undefined && { issuer: tokens.issuer }),
      ...(tokens.expires_at !== undefined && { expires_at: new Date(tokens.expires_at) }),
    }, this.options.redirectUri);
    this.completed = true;
  }
}

export function createWebOAuthAdapters(opts: {
  agentContextDb: Pick<AgentContextDatabase, 'getById' | 'getOAuthClient' | 'getOAuthTokens'>;
  redirectUri: string;
  userId: string;
  ownerStart?: { id: string; organizationId: string; agentUrl: string; fresh: boolean };
  authorize: (organizationId: string) => Promise<boolean>;
}): {
  pendingFlowStore: PendingWebFlowStore;
  agentStorage: OAuthConfigStorage;
} {
  const storage = new AgentContextOAuthStorage(opts);
  return {
    pendingFlowStore: new AgentOAuthPendingFlowStore({
      capture: flow => storage.capture(flow), restore: (flow, state) => storage.restore(flow, state),
    }),
    agentStorage: storage,
  };
}

export { AgentOAuthPendingFlowStore, AgentContextOAuthStorage };
