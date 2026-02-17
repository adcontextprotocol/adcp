import { query } from './client.js';
import { encrypt as encryptToken, decrypt as decryptToken } from './encryption.js';
import crypto from 'crypto';

// =====================================================
// TYPES
// =====================================================

export type AgentType = 'sales' | 'creative' | 'signals' | 'unknown';
export type Protocol = 'mcp' | 'a2a';

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
  // OAuth info (never expose actual tokens!)
  has_oauth_token: boolean;
  oauth_token_expires_at: Date | null;
  has_oauth_client: boolean;
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

function getTokenHint(token: string): string {
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
        oauth_access_token_encrypted IS NOT NULL as has_oauth_token,
        oauth_token_expires_at,
        oauth_client_id IS NOT NULL as has_oauth_client,
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
        oauth_access_token_encrypted IS NOT NULL as has_oauth_token,
        oauth_token_expires_at,
        oauth_client_id IS NOT NULL as has_oauth_client,
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
        oauth_access_token_encrypted IS NOT NULL as has_oauth_token,
        oauth_token_expires_at,
        oauth_client_id IS NOT NULL as has_oauth_client,
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
        FALSE as has_oauth_token,
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
         oauth_access_token_encrypted IS NOT NULL as has_oauth_token,
         oauth_token_expires_at,
         oauth_client_id IS NOT NULL as has_oauth_client,
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
  async saveAuthToken(id: string, token: string): Promise<void> {
    // Get the org ID for key derivation
    const context = await this.getById(id);
    if (!context) {
      throw new Error(`Agent context ${id} not found`);
    }

    const { encrypted, iv } = encryptToken(token, context.organization_id);
    const hint = getTokenHint(token);

    await query(
      `UPDATE agent_contexts
       SET
         auth_token_encrypted = $1,
         auth_token_iv = $2,
         auth_token_hint = $3,
         updated_at = NOW()
       WHERE id = $4`,
      [encrypted, iv, hint, id]
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
   * Get auth token by org and URL (for test_adcp_agent tool)
   */
  async getAuthTokenByOrgAndUrl(organizationId: string, agentUrl: string): Promise<string | null> {
    const result = await query(
      `SELECT id, auth_token_encrypted, auth_token_iv
       FROM agent_contexts
       WHERE organization_id = $1 AND agent_url = $2`,
      [organizationId, agentUrl]
    );

    const row = result.rows[0];
    if (!row || !row.auth_token_encrypted || !row.auth_token_iv) {
      return null;
    }

    return decryptToken(row.auth_token_encrypted, row.auth_token_iv, organizationId);
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
   * Check if OAuth tokens are valid (exist and not expired)
   */
  hasValidOAuthTokens(context: AgentContext): boolean {
    if (!context.has_oauth_token) return false;
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
   * Infer agent type from discovered tools
   */
  inferAgentType(tools: string[]): AgentType {
    if (tools.includes('get_products') || tools.includes('create_media_buy')) {
      return 'sales';
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
