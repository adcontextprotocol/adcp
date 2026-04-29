import { query } from './client.js';
import { encrypt as encryptToken, decrypt as decryptToken } from './encryption.js';
import { createLogger } from '../logger.js';
import crypto from 'crypto';

const logger = createLogger('agent-context-db');

// =====================================================
// TYPES
// =====================================================

export type AgentType = 'brand' | 'rights' | 'measurement' | 'governance' | 'creative' | 'sales' | 'buying' | 'signals' | 'unknown';
export type Protocol = 'mcp' | 'a2a';
export type AuthType = 'bearer' | 'basic';

export interface AgentContext {
  id: string;
  organization_id: string;
  agent_url: string;
  agent_name: string | null;
  agent_type: AgentType;
  protocol: Protocol;
  // Token info (never expose actual token!)
  has_auth_token: boolean;
  auth_token_hint: string | null;
  auth_type: AuthType;
  // OAuth info (never expose actual tokens!)
  has_oauth_token: boolean;
  has_oauth_refresh_token: boolean;
  oauth_token_expires_at: Date | null;
  has_oauth_client: boolean;
  // OAuth 2.0 client-credentials (RFC 6749 §4.4). True when token_endpoint
  // + client_id + client_secret are all saved; the SDK exchanges at call time.
  has_oauth_client_credentials: boolean;
  // Discovery cache
  tools_discovered: string[] | null;
  last_discovered_at: Date | null;
  // Test history
  last_test_scenario: string | null;
  last_test_passed: boolean | null;
  last_test_summary: string | null;
  last_tested_at: Date | null;
  total_tests_run: number;
  // Metadata
  created_at: Date;
  updated_at: Date;
  created_by: string | null;
}

export interface OAuthTokens {
  access_token: string;
  refresh_token?: string;
  expires_at?: Date;
}

export interface OAuthClient {
  client_id: string;
  client_secret?: string;
  registered_redirect_uri?: string;
}

/**
 * OAuth 2.0 client-credentials configuration stored for machine-to-machine
 * agent auth (RFC 6749 §4.4). Mirrors the SDK's `AgentOAuthClientCredentials`
 * shape in `@adcp/sdk`. `client_secret` is either a literal value or a
 * `$ENV:VAR_NAME` reference — the SDK resolves the reference at exchange time.
 */
export interface OAuthClientCredentials {
  token_endpoint: string;
  client_id: string;
  client_secret: string;
  scope?: string;
  /** RFC 8707 resource indicator. Single-resource only; multi-resource tracked as #2805. */
  resource?: string;
  audience?: string;
  /**
   * Client-credentials auth placement. `basic` = HTTP Basic header
   * (RFC 6749 §2.3.1 preferred); `body` = client_id/client_secret as form
   * fields. Passed through to `@adcp/sdk`'s exchange helper.
   */
  auth_method?: 'basic' | 'body';
}

export interface AgentTestHistory {
  id: string;
  agent_context_id: string;
  scenario: string;
  overall_passed: boolean;
  steps_passed: number;
  steps_failed: number;
  total_duration_ms: number | null;
  summary: string | null;
  dry_run: boolean;
  brief: string | null;
  triggered_by: string | null;
  user_id: string | null;
  steps_json: any;
  agent_profile_json: any;
  started_at: Date;
  completed_at: Date | null;
}

export interface CreateAgentContextInput {
  organization_id: string;
  agent_url: string;
  agent_name?: string;
  agent_type?: AgentType;
  protocol?: Protocol;
  created_by?: string;
}

export interface UpdateAgentContextInput {
  agent_name?: string;
  agent_type?: AgentType;
  protocol?: Protocol;
  tools_discovered?: string[];
  last_test_scenario?: string;
  last_test_passed?: boolean;
  last_test_summary?: string;
}

export interface RecordTestInput {
  agent_context_id: string;
  scenario: string;
  overall_passed: boolean;
  steps_passed: number;
  steps_failed: number;
  total_duration_ms?: number;
  summary?: string;
  dry_run?: boolean;
  brief?: string;
  triggered_by?: string;
  user_id?: string;
  steps_json?: any;
  agent_profile_json?: any;
}

function getTokenHint(token: string, authType: AuthType = 'bearer'): string {
  if (authType === 'basic') {
    // For Basic auth, try to show username only (token is base64-encoded user:password)
    try {
      const decoded = Buffer.from(token, 'base64').toString();
      const colonIndex = decoded.indexOf(':');
      if (colonIndex > 0) {
        return decoded.substring(0, colonIndex) + ':****';
      }
    } catch {
      // Not valid base64, fall through
    }
    return '****';
  }
  if (token.length <= 4) return '****';
  return '****' + token.slice(-4);
}

// =====================================================
// AGENT CONTEXT DATABASE
// =====================================================

export class AgentContextDatabase {
  /**
   * Get all agent contexts for an organization
   */
  async getByOrganization(organizationId: string): Promise<AgentContext[]> {
    const result = await query(
      `SELECT
        id,
        organization_id,
        agent_url,
        agent_name,
        agent_type,
        protocol,
        auth_token_encrypted IS NOT NULL as has_auth_token,
        auth_token_hint,
        auth_type,
        oauth_access_token_encrypted IS NOT NULL as has_oauth_token,
        oauth_refresh_token_encrypted IS NOT NULL as has_oauth_refresh_token,
        oauth_token_expires_at,
        oauth_client_id IS NOT NULL as has_oauth_client,
        (oauth_cc_token_endpoint IS NOT NULL
          AND oauth_cc_client_id IS NOT NULL
          AND oauth_cc_client_secret_encrypted IS NOT NULL) as has_oauth_client_credentials,
        tools_discovered,
        last_discovered_at,
        last_test_scenario,
        last_test_passed,
        last_test_summary,
        last_tested_at,
        total_tests_run,
        created_at,
        updated_at,
        created_by
      FROM agent_contexts
      WHERE organization_id = $1
      ORDER BY updated_at DESC`,
      [organizationId]
    );
    return result.rows;
  }

  /**
   * Get a specific agent context by ID
   */
  async getById(id: string): Promise<AgentContext | null> {
    const result = await query(
      `SELECT
        id,
        organization_id,
        agent_url,
        agent_name,
        agent_type,
        protocol,
        auth_token_encrypted IS NOT NULL as has_auth_token,
        auth_token_hint,
        auth_type,
        oauth_access_token_encrypted IS NOT NULL as has_oauth_token,
        oauth_refresh_token_encrypted IS NOT NULL as has_oauth_refresh_token,
        oauth_token_expires_at,
        oauth_client_id IS NOT NULL as has_oauth_client,
        (oauth_cc_token_endpoint IS NOT NULL
          AND oauth_cc_client_id IS NOT NULL
          AND oauth_cc_client_secret_encrypted IS NOT NULL) as has_oauth_client_credentials,
        tools_discovered,
        last_discovered_at,
        last_test_scenario,
        last_test_passed,
        last_test_summary,
        last_tested_at,
        total_tests_run,
        created_at,
        updated_at,
        created_by
      FROM agent_contexts
      WHERE id = $1`,
      [id]
    );
    return result.rows[0] || null;
  }

  /**
   * Get agent context by organization and URL
   */
  async getByOrgAndUrl(organizationId: string, agentUrl: string): Promise<AgentContext | null> {
    const result = await query(
      `SELECT
        id,
        organization_id,
        agent_url,
        agent_name,
        agent_type,
        protocol,
        auth_token_encrypted IS NOT NULL as has_auth_token,
        auth_token_hint,
        auth_type,
        oauth_access_token_encrypted IS NOT NULL as has_oauth_token,
        oauth_refresh_token_encrypted IS NOT NULL as has_oauth_refresh_token,
        oauth_token_expires_at,
        oauth_client_id IS NOT NULL as has_oauth_client,
        (oauth_cc_token_endpoint IS NOT NULL
          AND oauth_cc_client_id IS NOT NULL
          AND oauth_cc_client_secret_encrypted IS NOT NULL) as has_oauth_client_credentials,
        tools_discovered,
        last_discovered_at,
        last_test_scenario,
        last_test_passed,
        last_test_summary,
        last_tested_at,
        total_tests_run,
        created_at,
        updated_at,
        created_by
      FROM agent_contexts
      WHERE organization_id = $1 AND agent_url = $2`,
      [organizationId, agentUrl]
    );
    return result.rows[0] || null;
  }

  /**
   * Create a new agent context
   */
  async create(input: CreateAgentContextInput): Promise<AgentContext> {
    const result = await query(
      `INSERT INTO agent_contexts (
        organization_id,
        agent_url,
        agent_name,
        agent_type,
        protocol,
        created_by
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING
        id,
        organization_id,
        agent_url,
        agent_name,
        agent_type,
        protocol,
        FALSE as has_auth_token,
        auth_token_hint,
        auth_type,
        FALSE as has_oauth_token,
        FALSE as has_oauth_refresh_token,
        oauth_token_expires_at,
        FALSE as has_oauth_client,
        tools_discovered,
        last_discovered_at,
        last_test_scenario,
        last_test_passed,
        last_test_summary,
        last_tested_at,
        total_tests_run,
        created_at,
        updated_at,
        created_by`,
      [
        input.organization_id,
        input.agent_url,
        input.agent_name || null,
        input.agent_type || 'unknown',
        input.protocol || 'mcp',
        input.created_by || null,
      ]
    );
    return result.rows[0];
  }

  /**
   * Update an agent context
   */
  async update(id: string, input: UpdateAgentContextInput): Promise<AgentContext | null> {
    const updates: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (input.agent_name !== undefined) {
      updates.push(`agent_name = $${paramIndex++}`);
      values.push(input.agent_name);
    }
    if (input.agent_type !== undefined) {
      updates.push(`agent_type = $${paramIndex++}`);
      values.push(input.agent_type);
    }
    if (input.protocol !== undefined) {
      updates.push(`protocol = $${paramIndex++}`);
      values.push(input.protocol);
    }
    if (input.tools_discovered !== undefined) {
      updates.push(`tools_discovered = $${paramIndex++}`);
      updates.push(`last_discovered_at = NOW()`);
      values.push(input.tools_discovered);
    }
    if (input.last_test_scenario !== undefined) {
      updates.push(`last_test_scenario = $${paramIndex++}`);
      values.push(input.last_test_scenario);
    }
    if (input.last_test_passed !== undefined) {
      updates.push(`last_test_passed = $${paramIndex++}`);
      values.push(input.last_test_passed);
    }
    if (input.last_test_summary !== undefined) {
      updates.push(`last_test_summary = $${paramIndex++}`);
      values.push(input.last_test_summary);
    }

    if (updates.length === 0) {
      return this.getById(id);
    }

    updates.push('updated_at = NOW()');
    values.push(id);

    const result = await query(
      `UPDATE agent_contexts
       SET ${updates.join(', ')}
       WHERE id = $${paramIndex}
       RETURNING
         id,
         organization_id,
         agent_url,
         agent_name,
         agent_type,
         protocol,
         auth_token_encrypted IS NOT NULL as has_auth_token,
         auth_token_hint,
         auth_type,
         oauth_access_token_encrypted IS NOT NULL as has_oauth_token,
         oauth_refresh_token_encrypted IS NOT NULL as has_oauth_refresh_token,
         oauth_token_expires_at,
         oauth_client_id IS NOT NULL as has_oauth_client,
         (oauth_cc_token_endpoint IS NOT NULL
           AND oauth_cc_client_id IS NOT NULL
           AND oauth_cc_client_secret_encrypted IS NOT NULL) as has_oauth_client_credentials,
         tools_discovered,
         last_discovered_at,
         last_test_scenario,
         last_test_passed,
         last_test_summary,
         last_tested_at,
         total_tests_run,
         created_at,
         updated_at,
         created_by`,
      values
    );
    return result.rows[0] || null;
  }

  /**
   * Save an auth token (encrypted)
   * IMPORTANT: Token is encrypted and never returned in queries
   */
  async saveAuthToken(id: string, token: string, authType: AuthType = 'bearer'): Promise<void> {
    // Get the org ID for key derivation
    const context = await this.getById(id);
    if (!context) {
      throw new Error(`Agent context ${id} not found`);
    }

    const { encrypted, iv } = encryptToken(token, context.organization_id);
    const hint = getTokenHint(token, authType);

    await query(
      `UPDATE agent_contexts
       SET
         auth_token_encrypted = $1,
         auth_token_iv = $2,
         auth_token_hint = $3,
         auth_type = $4,
         updated_at = NOW()
       WHERE id = $5`,
      [encrypted, iv, hint, authType, id]
    );
  }

  /**
   * Get decrypted auth token (for internal use only - NEVER expose to users)
   * Returns null if no token stored
   */
  async getAuthToken(id: string): Promise<string | null> {
    const result = await query(
      `SELECT organization_id, auth_token_encrypted, auth_token_iv
       FROM agent_contexts
       WHERE id = $1`,
      [id]
    );

    const row = result.rows[0];
    if (!row || !row.auth_token_encrypted || !row.auth_token_iv) {
      return null;
    }

    return decryptToken(row.auth_token_encrypted, row.auth_token_iv, row.organization_id);
  }

  /**
   * Get auth token and type by org and URL.
   * Used by the AdCP tool passthrough to determine Bearer vs Basic auth.
   */
  async getAuthInfoByOrgAndUrl(organizationId: string, agentUrl: string): Promise<{ token: string; authType: AuthType } | null> {
    const result = await query(
      `SELECT id, auth_token_encrypted, auth_token_iv, auth_type
       FROM agent_contexts
       WHERE organization_id = $1 AND agent_url = $2`,
      [organizationId, agentUrl]
    );

    const row = result.rows[0];
    if (!row || !row.auth_token_encrypted || !row.auth_token_iv) {
      return null;
    }

    const token = decryptToken(row.auth_token_encrypted, row.auth_token_iv, organizationId);
    return { token, authType: row.auth_type as AuthType };
  }

  /**
   * Remove auth token
   */
  async removeAuthToken(id: string): Promise<void> {
    await query(
      `UPDATE agent_contexts
       SET
         auth_token_encrypted = NULL,
         auth_token_iv = NULL,
         auth_token_hint = NULL,
         auth_type = 'bearer',
         updated_at = NOW()
       WHERE id = $1`,
      [id]
    );
  }

  // =====================================================
  // OAUTH TOKEN METHODS
  // =====================================================

  /**
   * Save OAuth tokens (encrypted)
   */
  async saveOAuthTokens(id: string, tokens: OAuthTokens): Promise<void> {
    const context = await this.getById(id);
    if (!context) {
      throw new Error(`Agent context ${id} not found`);
    }

    const accessEncrypted = encryptToken(tokens.access_token, context.organization_id);

    let refreshEncrypted = null;
    let refreshIv = null;
    if (tokens.refresh_token) {
      const result = encryptToken(tokens.refresh_token, context.organization_id);
      refreshEncrypted = result.encrypted;
      refreshIv = result.iv;
    }

    await query(
      `UPDATE agent_contexts
       SET
         oauth_access_token_encrypted = $1,
         oauth_access_token_iv = $2,
         oauth_refresh_token_encrypted = $3,
         oauth_refresh_token_iv = $4,
         oauth_token_expires_at = $5,
         updated_at = NOW()
       WHERE id = $6`,
      [
        accessEncrypted.encrypted,
        accessEncrypted.iv,
        refreshEncrypted,
        refreshIv,
        tokens.expires_at || null,
        id,
      ]
    );
  }

  /**
   * Get OAuth tokens (decrypted) - for internal use only
   */
  async getOAuthTokens(id: string): Promise<OAuthTokens | null> {
    const result = await query(
      `SELECT
        organization_id,
        oauth_access_token_encrypted,
        oauth_access_token_iv,
        oauth_refresh_token_encrypted,
        oauth_refresh_token_iv,
        oauth_token_expires_at
       FROM agent_contexts
       WHERE id = $1`,
      [id]
    );

    const row = result.rows[0];
    if (!row || !row.oauth_access_token_encrypted || !row.oauth_access_token_iv) {
      return null;
    }

    const tokens: OAuthTokens = {
      access_token: decryptToken(
        row.oauth_access_token_encrypted,
        row.oauth_access_token_iv,
        row.organization_id
      ),
    };

    if (row.oauth_refresh_token_encrypted && row.oauth_refresh_token_iv) {
      tokens.refresh_token = decryptToken(
        row.oauth_refresh_token_encrypted,
        row.oauth_refresh_token_iv,
        row.organization_id
      );
    }

    if (row.oauth_token_expires_at) {
      tokens.expires_at = new Date(row.oauth_token_expires_at);
    }

    return tokens;
  }

  /**
   * Get OAuth tokens by org and URL
   */
  async getOAuthTokensByOrgAndUrl(organizationId: string, agentUrl: string): Promise<OAuthTokens | null> {
    const result = await query(
      `SELECT
        id,
        oauth_access_token_encrypted,
        oauth_access_token_iv,
        oauth_refresh_token_encrypted,
        oauth_refresh_token_iv,
        oauth_token_expires_at
       FROM agent_contexts
       WHERE organization_id = $1 AND agent_url = $2`,
      [organizationId, agentUrl]
    );

    const row = result.rows[0];
    if (!row || !row.oauth_access_token_encrypted || !row.oauth_access_token_iv) {
      return null;
    }

    const tokens: OAuthTokens = {
      access_token: decryptToken(
        row.oauth_access_token_encrypted,
        row.oauth_access_token_iv,
        organizationId
      ),
    };

    if (row.oauth_refresh_token_encrypted && row.oauth_refresh_token_iv) {
      tokens.refresh_token = decryptToken(
        row.oauth_refresh_token_encrypted,
        row.oauth_refresh_token_iv,
        organizationId
      );
    }

    if (row.oauth_token_expires_at) {
      tokens.expires_at = new Date(row.oauth_token_expires_at);
    }

    return tokens;
  }

  /**
   * Check if OAuth tokens are valid (exist and not expired, or refreshable)
   */
  hasValidOAuthTokens(context: AgentContext): boolean {
    if (!context.has_oauth_token) return false;
    // A refresh token lets us mint a new access token on demand, so auth is
    // still valid even if the access token is near/past expiry.
    if (context.has_oauth_refresh_token) return true;
    if (!context.oauth_token_expires_at) return true;

    // Expired if within 5 minutes of expiration
    const expiresAt = new Date(context.oauth_token_expires_at);
    return expiresAt.getTime() - Date.now() > 5 * 60 * 1000;
  }

  /**
   * Save OAuth client info (from dynamic registration)
   */
  async saveOAuthClient(id: string, client: OAuthClient): Promise<void> {
    const context = await this.getById(id);
    if (!context) {
      throw new Error(`Agent context ${id} not found`);
    }

    let secretEncrypted = null;
    let secretIv = null;
    if (client.client_secret) {
      const result = encryptToken(client.client_secret, context.organization_id);
      secretEncrypted = result.encrypted;
      secretIv = result.iv;
    }

    await query(
      `UPDATE agent_contexts
       SET
         oauth_client_id = $1,
         oauth_client_secret_encrypted = $2,
         oauth_client_secret_iv = $3,
         oauth_registered_redirect_uri = $4,
         updated_at = NOW()
       WHERE id = $5`,
      [client.client_id, secretEncrypted, secretIv, client.registered_redirect_uri || null, id]
    );
  }

  /**
   * Get OAuth client info
   */
  async getOAuthClient(id: string): Promise<OAuthClient | null> {
    const result = await query(
      `SELECT
        organization_id,
        oauth_client_id,
        oauth_client_secret_encrypted,
        oauth_client_secret_iv,
        oauth_registered_redirect_uri
       FROM agent_contexts
       WHERE id = $1`,
      [id]
    );

    const row = result.rows[0];
    if (!row || !row.oauth_client_id) {
      return null;
    }

    const client: OAuthClient = {
      client_id: row.oauth_client_id,
      registered_redirect_uri: row.oauth_registered_redirect_uri || undefined,
    };

    if (row.oauth_client_secret_encrypted && row.oauth_client_secret_iv) {
      client.client_secret = decryptToken(
        row.oauth_client_secret_encrypted,
        row.oauth_client_secret_iv,
        row.organization_id
      );
    }

    return client;
  }

  /**
   * Remove OAuth tokens and client info
   */
  async removeOAuthTokens(id: string): Promise<void> {
    await query(
      `UPDATE agent_contexts
       SET
         oauth_access_token_encrypted = NULL,
         oauth_access_token_iv = NULL,
         oauth_refresh_token_encrypted = NULL,
         oauth_refresh_token_iv = NULL,
         oauth_token_expires_at = NULL,
         oauth_client_id = NULL,
         oauth_client_secret_encrypted = NULL,
         oauth_client_secret_iv = NULL,
         oauth_registered_redirect_uri = NULL,
         updated_at = NOW()
       WHERE id = $1`,
      [id]
    );
  }

  /**
   * Clear OAuth client only (keeps tokens if any exist)
   * Used when redirect_uri changes and we need to re-register
   */
  async clearOAuthClient(id: string): Promise<void> {
    await query(
      `UPDATE agent_contexts
       SET
         oauth_client_id = NULL,
         oauth_client_secret_encrypted = NULL,
         oauth_client_secret_iv = NULL,
         oauth_registered_redirect_uri = NULL,
         oauth_access_token_encrypted = NULL,
         oauth_access_token_iv = NULL,
         oauth_refresh_token_encrypted = NULL,
         oauth_refresh_token_iv = NULL,
         oauth_token_expires_at = NULL,
         updated_at = NOW()
       WHERE id = $1`,
      [id]
    );
  }

  // =====================================================
  // OAUTH CLIENT-CREDENTIALS METHODS (RFC 6749 §4.4)
  // =====================================================

  /**
   * Save OAuth 2.0 client-credentials configuration for an agent context.
   * `client_secret` is encrypted at rest regardless of whether it's a literal
   * value or a `$ENV:VAR_NAME` reference — the SDK resolves the reference at
   * exchange time, the server just stores and returns.
   */
  async saveOAuthClientCredentials(id: string, creds: OAuthClientCredentials): Promise<void> {
    const context = await this.getById(id);
    if (!context) {
      throw new Error(`Agent context ${id} not found`);
    }

    const secretEncrypted = encryptToken(creds.client_secret, context.organization_id);

    await query(
      `UPDATE agent_contexts
       SET
         oauth_cc_token_endpoint = $1,
         oauth_cc_client_id = $2,
         oauth_cc_client_secret_encrypted = $3,
         oauth_cc_client_secret_iv = $4,
         oauth_cc_scope = $5,
         oauth_cc_resource = $6,
         oauth_cc_audience = $7,
         oauth_cc_auth_method = $8,
         updated_at = NOW()
       WHERE id = $9`,
      [
        creds.token_endpoint,
        creds.client_id,
        secretEncrypted.encrypted,
        secretEncrypted.iv,
        creds.scope || null,
        creds.resource || null,
        creds.audience || null,
        creds.auth_method || null,
        id,
      ]
    );
  }

  /**
   * Get OAuth client-credentials configuration by org + URL. Returns null if
   * no credentials are saved (or if any required field is missing, which
   * shouldn't happen for a well-formed save but is defensive).
   */
  async getOAuthClientCredentialsByOrgAndUrl(
    organizationId: string,
    agentUrl: string,
  ): Promise<OAuthClientCredentials | null> {
    const result = await query(
      `SELECT
        oauth_cc_token_endpoint,
        oauth_cc_client_id,
        oauth_cc_client_secret_encrypted,
        oauth_cc_client_secret_iv,
        oauth_cc_scope,
        oauth_cc_resource,
        oauth_cc_audience,
        oauth_cc_auth_method
       FROM agent_contexts
       WHERE organization_id = $1 AND agent_url = $2`,
      [organizationId, agentUrl]
    );

    const row = result.rows[0];
    if (
      !row ||
      !row.oauth_cc_token_endpoint ||
      !row.oauth_cc_client_id ||
      !row.oauth_cc_client_secret_encrypted ||
      !row.oauth_cc_client_secret_iv
    ) {
      return null;
    }

    const creds: OAuthClientCredentials = {
      token_endpoint: row.oauth_cc_token_endpoint,
      client_id: row.oauth_cc_client_id,
      client_secret: decryptToken(
        row.oauth_cc_client_secret_encrypted,
        row.oauth_cc_client_secret_iv,
        organizationId
      ),
    };
    if (row.oauth_cc_scope) creds.scope = row.oauth_cc_scope;
    if (row.oauth_cc_resource) creds.resource = row.oauth_cc_resource;
    if (row.oauth_cc_audience) creds.audience = row.oauth_cc_audience;
    if (row.oauth_cc_auth_method === 'basic' || row.oauth_cc_auth_method === 'body') {
      creds.auth_method = row.oauth_cc_auth_method;
    } else if (row.oauth_cc_auth_method !== null && row.oauth_cc_auth_method !== undefined) {
      // Surface unexpected values rather than silently dropping — a write
      // path bypassed validation if this fires.
      logger.warn(
        { agentUrl, organizationId, value: row.oauth_cc_auth_method },
        'agent-context-db: dropped unrecognized oauth_cc_auth_method',
      );
    }
    return creds;
  }

  /**
   * Remove OAuth client-credentials configuration.
   */
  async removeOAuthClientCredentials(id: string): Promise<void> {
    await query(
      `UPDATE agent_contexts
       SET
         oauth_cc_token_endpoint = NULL,
         oauth_cc_client_id = NULL,
         oauth_cc_client_secret_encrypted = NULL,
         oauth_cc_client_secret_iv = NULL,
         oauth_cc_scope = NULL,
         oauth_cc_resource = NULL,
         oauth_cc_audience = NULL,
         oauth_cc_auth_method = NULL,
         updated_at = NOW()
       WHERE id = $1`,
      [id]
    );
  }

  /**
   * Delete an agent context
   */
  async delete(id: string): Promise<boolean> {
    const result = await query('DELETE FROM agent_contexts WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Record a test run
   */
  async recordTest(input: RecordTestInput): Promise<AgentTestHistory> {
    // Update the agent context
    await query(
      `UPDATE agent_contexts
       SET
         last_test_scenario = $1,
         last_test_passed = $2,
         last_test_summary = $3,
         last_tested_at = NOW(),
         total_tests_run = total_tests_run + 1,
         updated_at = NOW()
       WHERE id = $4`,
      [input.scenario, input.overall_passed, input.summary || null, input.agent_context_id]
    );

    // Insert history record
    const result = await query(
      `INSERT INTO agent_test_history (
        agent_context_id,
        scenario,
        overall_passed,
        steps_passed,
        steps_failed,
        total_duration_ms,
        summary,
        dry_run,
        brief,
        triggered_by,
        user_id,
        steps_json,
        agent_profile_json,
        completed_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
      RETURNING *`,
      [
        input.agent_context_id,
        input.scenario,
        input.overall_passed,
        input.steps_passed,
        input.steps_failed,
        input.total_duration_ms || null,
        input.summary || null,
        input.dry_run ?? true,
        input.brief || null,
        input.triggered_by || null,
        input.user_id || null,
        input.steps_json ? JSON.stringify(input.steps_json) : null,
        input.agent_profile_json ? JSON.stringify(input.agent_profile_json) : null,
      ]
    );

    return result.rows[0];
  }

  /**
   * Get test history for an agent
   */
  async getTestHistory(agentContextId: string, limit: number = 20): Promise<AgentTestHistory[]> {
    const result = await query(
      `SELECT *
       FROM agent_test_history
       WHERE agent_context_id = $1
       ORDER BY started_at DESC
       LIMIT $2`,
      [agentContextId, limit]
    );
    return result.rows;
  }

  /**
   * Most recent agent test the user has run, across all of their saved
   * agents. Powers the "agent not tested in X days" suggested-prompts
   * rule for builder personas.
   *
   * Returns null if the user has never tested any registered agent.
   * Tests against the public test agent or unsaved URLs are not
   * recorded in agent_test_history (they don't have an agent_context),
   * so they don't count here either — which is the right semantic for
   * the rule's audience (builders with their own seller agent).
   */
  async getLatestTestForUser(workosUserId: string): Promise<{
    started_at: Date;
    overall_passed: boolean;
  } | null> {
    const result = await query<{ started_at: Date; overall_passed: boolean }>(
      `SELECT started_at, overall_passed
         FROM agent_test_history
         WHERE user_id = $1
         ORDER BY started_at DESC
         LIMIT 1`,
      [workosUserId]
    );
    return result.rows[0] ?? null;
  }

  /**
   * Infer agent type from discovered tools
   */
  inferAgentType(tools: string[]): AgentType {
    if (tools.includes('get_products') || tools.includes('create_media_buy')) {
      return 'buying';
    }
    if (tools.includes('list_creative_formats') && !tools.includes('get_products')) {
      return 'creative';
    }
    if (tools.includes('get_signals') || tools.includes('activate_signal')) {
      return 'signals';
    }
    return 'unknown';
  }
}
