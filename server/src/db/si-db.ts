/**
 * SI (Sponsored Intelligence) Database
 *
 * Handles storage and retrieval of SI sessions, messages, relationship memory,
 * and skill configurations.
 */

import { query } from "./client.js";
import { v4 as uuidv4 } from "uuid";
import { createLogger } from "../logger.js";

const logger = createLogger("si-db");

/**
 * Check if an error is a PostgreSQL "undefined table" error (code 42P01)
 */
function isUndefinedTableError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: string }).code === "42P01"
  );
}

// ============================================================================
// Types
// ============================================================================

export interface SiSession {
  id: string;
  session_id: string;
  host_type: "addy" | "external";
  host_identifier: string;
  member_profile_id: string | null;
  brand_name: string;
  user_slack_id: string | null;
  user_email: string | null;
  user_name: string | null;
  user_anonymous_id: string | null;
  identity_consent_granted: boolean;
  status: "active" | "pending_handoff" | "complete" | "timeout" | "error";
  termination_reason: string | null;
  initial_context: string | null;
  campaign_id: string | null;
  offer_id: string | null;
  handoff_data: Record<string, unknown> | null;
  message_count: number;
  created_at: Date;
  last_activity_at: Date;
  terminated_at: Date | null;
}

export interface SiSessionMessage {
  id: string;
  session_id: string;
  role: "user" | "brand_agent" | "system";
  content: string;
  ui_elements: unknown[] | null;
  action_response: Record<string, unknown> | null;
  created_at: Date;
}

export interface SiRelationshipMemory {
  id: string;
  user_identifier: string;
  user_identifier_type: "email" | "slack_id" | "anonymous";
  member_profile_id: string | null;
  total_sessions: number;
  last_session_id: string | null;
  memory: Record<string, unknown>;
  first_interaction_at: Date;
  last_interaction_at: Date;
  lead_status: "new" | "engaged" | "qualified" | "converted" | "churned" | null;
  lead_status_updated_at: Date | null;
  notes: string | null;
}

export interface SiSkill {
  id: string;
  member_profile_id: string | null;
  skill_name: string;
  skill_description: string;
  skill_type:
    | "signup"
    | "demo_request"
    | "implementation_help"
    | "contact_sales"
    | "documentation"
    | "custom";
  config: Record<string, unknown>;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface SiSkillExecution {
  id: string;
  session_id: string;
  skill_id: string;
  input_data: Record<string, unknown> | null;
  output_data: Record<string, unknown> | null;
  status: "pending" | "completed" | "failed";
  error_message: string | null;
  executed_at: Date;
  completed_at: Date | null;
}

// Input types
export interface CreateSessionInput {
  host_type: "addy" | "external";
  host_identifier: string;
  member_profile_id?: string;
  brand_name: string;
  user_slack_id?: string;
  user_email?: string;
  user_name?: string;
  user_anonymous_id?: string;
  identity_consent_granted?: boolean;
  initial_context?: string;
  campaign_id?: string;
  offer_id?: string;
}

export interface AddMessageInput {
  session_id: string;
  role: "user" | "brand_agent" | "system";
  content: string;
  ui_elements?: unknown[];
  action_response?: Record<string, unknown>;
}

export interface UpdateMemoryInput {
  user_identifier: string;
  user_identifier_type: "email" | "slack_id" | "anonymous";
  member_profile_id?: string;
  memory_updates: Record<string, unknown>;
  lead_status?: "new" | "engaged" | "qualified" | "converted" | "churned";
  notes?: string;
}

export interface CreateAvailabilityCheckInput {
  memberProfileId: string;
  offerId?: string;
  productId?: string;
  context?: string;
}

export interface SiAvailabilityCheck {
  id: string;
  token: string;
  member_profile_id: string;
  offer_id: string | null;
  product_id: string | null;
  context: string | null;
  available: boolean;
  checked_at: Date;
  expires_at: Date;
  used_in_session_id: string | null;
}

// ============================================================================
// Database Class
// ============================================================================

export class SiDatabase {
  // --------------------------------------------------------------------------
  // Sessions
  // --------------------------------------------------------------------------

  async createSession(input: CreateSessionInput): Promise<SiSession> {
    const sessionId = `si_${Date.now()}_${uuidv4().slice(0, 8)}`;

    const result = await query(
      `INSERT INTO si_sessions (
        session_id, host_type, host_identifier, member_profile_id, brand_name,
        user_slack_id, user_email, user_name, user_anonymous_id, identity_consent_granted,
        initial_context, campaign_id, offer_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING *`,
      [
        sessionId,
        input.host_type,
        input.host_identifier,
        input.member_profile_id || null,
        input.brand_name,
        input.user_slack_id || null,
        input.user_email || null,
        input.user_name || null,
        input.user_anonymous_id || null,
        input.identity_consent_granted || false,
        input.initial_context || null,
        input.campaign_id || null,
        input.offer_id || null,
      ]
    );

    return this.deserializeSession(result.rows[0]);
  }

  async getSession(sessionId: string): Promise<SiSession | null> {
    const result = await query(
      "SELECT * FROM si_sessions WHERE session_id = $1",
      [sessionId]
    );

    if (result.rows.length === 0) return null;
    return this.deserializeSession(result.rows[0]);
  }

  async updateSessionActivity(sessionId: string): Promise<void> {
    await query(
      `UPDATE si_sessions
       SET last_activity_at = NOW(), message_count = message_count + 1
       WHERE session_id = $1`,
      [sessionId]
    );
  }

  async updateSessionStatus(
    sessionId: string,
    status: SiSession["status"],
    terminationReason?: string,
    handoffData?: Record<string, unknown>
  ): Promise<SiSession | null> {
    const result = await query(
      `UPDATE si_sessions
       SET status = $2,
           termination_reason = $3,
           handoff_data = $4,
           terminated_at = CASE WHEN $2 IN ('complete', 'timeout', 'error') THEN NOW() ELSE NULL END
       WHERE session_id = $1
       RETURNING *`,
      [
        sessionId,
        status,
        terminationReason || null,
        handoffData ? JSON.stringify(handoffData) : null,
      ]
    );

    if (result.rows.length === 0) return null;
    return this.deserializeSession(result.rows[0]);
  }

  async getActiveSessions(hostIdentifier?: string): Promise<SiSession[]> {
    let sql = "SELECT * FROM si_sessions WHERE status = 'active'";
    const params: string[] = [];

    if (hostIdentifier) {
      sql += " AND host_identifier = $1";
      params.push(hostIdentifier);
    }

    sql += " ORDER BY last_activity_at DESC";

    const result = await query(sql, params);
    return result.rows.map((row) => this.deserializeSession(row));
  }

  async getSessionsByUser(
    userIdentifier: string,
    identifierType: "slack_id" | "email" | "anonymous"
  ): Promise<SiSession[]> {
    let column: string;
    switch (identifierType) {
      case "slack_id":
        column = "user_slack_id";
        break;
      case "email":
        column = "user_email";
        break;
      case "anonymous":
        column = "user_anonymous_id";
        break;
    }

    const result = await query(
      `SELECT * FROM si_sessions WHERE ${column} = $1 ORDER BY created_at DESC`,
      [userIdentifier]
    );

    return result.rows.map((row) => this.deserializeSession(row));
  }

  // --------------------------------------------------------------------------
  // Messages
  // --------------------------------------------------------------------------

  async addMessage(input: AddMessageInput): Promise<SiSessionMessage> {
    const result = await query(
      `INSERT INTO si_session_messages (session_id, role, content, ui_elements, action_response)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        input.session_id,
        input.role,
        input.content,
        input.ui_elements ? JSON.stringify(input.ui_elements) : null,
        input.action_response ? JSON.stringify(input.action_response) : null,
      ]
    );

    // Update session activity
    await this.updateSessionActivity(input.session_id);

    return this.deserializeMessage(result.rows[0]);
  }

  async getSessionMessages(
    sessionId: string,
    limit?: number
  ): Promise<SiSessionMessage[]> {
    let sql =
      "SELECT * FROM si_session_messages WHERE session_id = $1 ORDER BY created_at ASC";
    const params: (string | number)[] = [sessionId];

    if (limit) {
      sql =
        "SELECT * FROM si_session_messages WHERE session_id = $1 ORDER BY created_at DESC LIMIT $2";
      params.push(limit);
    }

    const result = await query(sql, params);
    const messages = result.rows.map((row) => this.deserializeMessage(row));

    // If we limited, reverse to get chronological order
    if (limit) {
      messages.reverse();
    }

    return messages;
  }

  // --------------------------------------------------------------------------
  // Relationship Memory
  // --------------------------------------------------------------------------

  async getOrCreateRelationship(
    userIdentifier: string,
    userIdentifierType: "email" | "slack_id" | "anonymous",
    memberProfileId?: string
  ): Promise<SiRelationshipMemory> {
    // Try to get existing
    const existing = await query(
      `SELECT * FROM si_relationship_memory
       WHERE user_identifier = $1 AND user_identifier_type = $2 AND member_profile_id IS NOT DISTINCT FROM $3`,
      [userIdentifier, userIdentifierType, memberProfileId || null]
    );

    if (existing.rows.length > 0) {
      return this.deserializeRelationship(existing.rows[0]);
    }

    // Create new
    const result = await query(
      `INSERT INTO si_relationship_memory (user_identifier, user_identifier_type, member_profile_id, lead_status)
       VALUES ($1, $2, $3, 'new')
       RETURNING *`,
      [userIdentifier, userIdentifierType, memberProfileId || null]
    );

    return this.deserializeRelationship(result.rows[0]);
  }

  async updateRelationship(
    relationshipId: string,
    updates: {
      memory?: Record<string, unknown>;
      lead_status?: SiRelationshipMemory["lead_status"];
      notes?: string;
      last_session_id?: string;
    }
  ): Promise<SiRelationshipMemory | null> {
    const setClauses: string[] = ["last_interaction_at = NOW()"];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (updates.memory !== undefined) {
      // Merge with existing memory using JSONB concat
      setClauses.push(`memory = memory || $${paramIndex}::jsonb`);
      params.push(JSON.stringify(updates.memory));
      paramIndex++;
    }

    if (updates.lead_status !== undefined) {
      setClauses.push(
        `lead_status = $${paramIndex}, lead_status_updated_at = NOW()`
      );
      params.push(updates.lead_status);
      paramIndex++;
    }

    if (updates.notes !== undefined) {
      setClauses.push(`notes = $${paramIndex}`);
      params.push(updates.notes);
      paramIndex++;
    }

    if (updates.last_session_id !== undefined) {
      setClauses.push(
        `last_session_id = $${paramIndex}, total_sessions = total_sessions + 1`
      );
      params.push(updates.last_session_id);
      paramIndex++;
    }

    params.push(relationshipId);

    const result = await query(
      `UPDATE si_relationship_memory
       SET ${setClauses.join(", ")}
       WHERE id = $${paramIndex}
       RETURNING *`,
      params
    );

    if (result.rows.length === 0) return null;
    return this.deserializeRelationship(result.rows[0]);
  }

  async getRelationshipsByMember(
    memberProfileId: string
  ): Promise<SiRelationshipMemory[]> {
    const result = await query(
      `SELECT * FROM si_relationship_memory
       WHERE member_profile_id = $1
       ORDER BY last_interaction_at DESC`,
      [memberProfileId]
    );

    return result.rows.map((row) => this.deserializeRelationship(row));
  }

  // --------------------------------------------------------------------------
  // Skills
  // --------------------------------------------------------------------------

  async getSkillsForMember(memberProfileId: string): Promise<SiSkill[]> {
    const result = await query(
      `SELECT * FROM si_skills
       WHERE member_profile_id = $1 AND is_active = true
       ORDER BY skill_name`,
      [memberProfileId]
    );

    return result.rows.map((row) => this.deserializeSkill(row));
  }

  async createSkill(
    memberProfileId: string,
    skill: {
      skill_name: string;
      skill_description: string;
      skill_type: SiSkill["skill_type"];
      config?: Record<string, unknown>;
    }
  ): Promise<SiSkill> {
    const result = await query(
      `INSERT INTO si_skills (member_profile_id, skill_name, skill_description, skill_type, config)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (member_profile_id, skill_name)
       DO UPDATE SET skill_description = $3, skill_type = $4, config = $5, is_active = true, updated_at = NOW()
       RETURNING *`,
      [
        memberProfileId,
        skill.skill_name,
        skill.skill_description,
        skill.skill_type,
        JSON.stringify(skill.config || {}),
      ]
    );

    return this.deserializeSkill(result.rows[0]);
  }

  /**
   * Create default SI skills for a member if they don't have any
   */
  async ensureDefaultSkills(memberProfileId: string): Promise<SiSkill[]> {
    // Check if member already has skills
    const existingSkills = await this.getSkillsForMember(memberProfileId);
    if (existingSkills.length > 0) {
      return existingSkills;
    }

    // Create default skills
    const defaultSkills = [
      {
        skill_name: "request_demo",
        skill_description: "Schedule a product demo with our team",
        skill_type: "demo_request" as const,
        config: {},
      },
      {
        skill_name: "contact_sales",
        skill_description: "Connect with our sales team to discuss your needs",
        skill_type: "contact_sales" as const,
        config: {},
      },
      {
        skill_name: "view_docs",
        skill_description: "Access our documentation and implementation guides",
        skill_type: "documentation" as const,
        config: {},
      },
      {
        skill_name: "get_started",
        skill_description: "Sign up for an account or start a trial",
        skill_type: "signup" as const,
        config: {},
      },
      {
        skill_name: "implementation_support",
        skill_description: "Get help with integration and implementation",
        skill_type: "implementation_help" as const,
        config: {},
      },
    ];

    const createdSkills: SiSkill[] = [];
    for (const skill of defaultSkills) {
      const created = await this.createSkill(memberProfileId, skill);
      createdSkills.push(created);
    }

    return createdSkills;
  }

  async executeSkill(
    sessionId: string,
    skillId: string,
    inputData: Record<string, unknown>
  ): Promise<SiSkillExecution> {
    const result = await query(
      `INSERT INTO si_skill_executions (session_id, skill_id, input_data, status)
       VALUES ($1, $2, $3, 'pending')
       RETURNING *`,
      [sessionId, skillId, JSON.stringify(inputData)]
    );

    return this.deserializeSkillExecution(result.rows[0]);
  }

  async completeSkillExecution(
    executionId: string,
    status: "completed" | "failed",
    outputData?: Record<string, unknown>,
    errorMessage?: string
  ): Promise<SiSkillExecution | null> {
    const result = await query(
      `UPDATE si_skill_executions
       SET status = $2, output_data = $3, error_message = $4, completed_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [
        executionId,
        status,
        outputData ? JSON.stringify(outputData) : null,
        errorMessage || null,
      ]
    );

    if (result.rows.length === 0) return null;
    return this.deserializeSkillExecution(result.rows[0]);
  }

  // --------------------------------------------------------------------------
  // Availability Checks
  // --------------------------------------------------------------------------

  /**
   * Create an availability check record and return the token
   * For now, this is a simple in-memory token generator
   * In production, this would be stored in a database table
   */
  async createAvailabilityCheck(input: CreateAvailabilityCheckInput): Promise<string> {
    // Generate a unique token
    const token = `avail_${Date.now()}_${uuidv4().slice(0, 8)}`;

    // For now, we're not persisting to database - just generating a token
    // The token encodes enough info for correlation
    // In the future, we could store this in an si_availability_checks table

    // Log the check for analytics
    // Note: This is anonymous - no user data included
    await query(
      `INSERT INTO si_availability_checks (
        token, member_profile_id, offer_id, product_id, context, available, expires_at
      ) VALUES ($1, $2, $3, $4, $5, true, NOW() + INTERVAL '1 hour')
      ON CONFLICT (token) DO NOTHING`,
      [
        token,
        input.memberProfileId,
        input.offerId || null,
        input.productId || null,
        input.context || null,
      ]
    ).catch((error) => {
      if (!isUndefinedTableError(error)) {
        logger.warn({ error }, "SI DB: Failed to insert availability check");
      }
      // Table may not exist yet - that's OK, token still works
    });

    return token;
  }

  /**
   * Get an availability check by token
   */
  async getAvailabilityCheck(token: string): Promise<SiAvailabilityCheck | null> {
    try {
      const result = await query(
        `SELECT * FROM si_availability_checks WHERE token = $1 AND expires_at > NOW()`,
        [token]
      );

      if (result.rows.length === 0) return null;
      return this.deserializeAvailabilityCheck(result.rows[0]);
    } catch (error) {
      if (!isUndefinedTableError(error)) {
        logger.warn({ error }, "SI DB: Failed to get availability check");
      }
      // Table may not exist yet
      return null;
    }
  }

  /**
   * Mark an availability token as used in a session
   */
  async markAvailabilityUsed(token: string, sessionId: string): Promise<void> {
    try {
      await query(
        `UPDATE si_availability_checks SET used_in_session_id = $2 WHERE token = $1`,
        [token, sessionId]
      );
    } catch (error) {
      if (!isUndefinedTableError(error)) {
        logger.warn({ error }, "SI DB: Failed to mark availability token as used");
      }
      // Table may not exist yet - that's OK
    }
  }

  // --------------------------------------------------------------------------
  // Member SI Configuration
  // --------------------------------------------------------------------------

  async getSiEnabledMembers(): Promise<
    Array<{
      id: string;
      display_name: string;
      slug: string;
      tagline: string | null;
      description: string | null;
      si_enabled: boolean;
      si_endpoint_url: string | null;
      si_capabilities: Record<string, unknown>;
      si_skills: string[];
      contact_email: string | null;
      contact_website: string | null;
    }>
  > {
    const result = await query(
      `SELECT mp.id, mp.display_name, mp.slug, mp.tagline, mp.description,
              mp.si_enabled, mp.si_endpoint_url, mp.si_capabilities, mp.si_skills,
              mp.contact_email, mp.contact_website
       FROM member_profiles mp
       JOIN organizations o ON mp.workos_organization_id = o.workos_organization_id
       WHERE mp.is_public = true
         AND mp.si_enabled = true
         AND o.subscription_status = 'active'
       ORDER BY mp.display_name`
    );

    return result.rows.map((row) => ({
      ...row,
      si_capabilities: row.si_capabilities || {},
      si_skills: row.si_skills || [],
    }));
  }

  async updateMemberSiConfig(
    memberProfileId: string,
    config: {
      si_enabled?: boolean;
      si_endpoint_url?: string | null;
      si_capabilities?: Record<string, unknown>;
      si_prompt_template?: string | null;
      si_skills?: string[];
    }
  ): Promise<void> {
    const setClauses: string[] = ["updated_at = NOW()"];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (config.si_enabled !== undefined) {
      setClauses.push(`si_enabled = $${paramIndex}`);
      params.push(config.si_enabled);
      paramIndex++;
    }

    if (config.si_endpoint_url !== undefined) {
      setClauses.push(`si_endpoint_url = $${paramIndex}`);
      params.push(config.si_endpoint_url);
      paramIndex++;
    }

    if (config.si_capabilities !== undefined) {
      setClauses.push(`si_capabilities = $${paramIndex}::jsonb`);
      params.push(JSON.stringify(config.si_capabilities));
      paramIndex++;
    }

    if (config.si_prompt_template !== undefined) {
      setClauses.push(`si_prompt_template = $${paramIndex}`);
      params.push(config.si_prompt_template);
      paramIndex++;
    }

    if (config.si_skills !== undefined) {
      setClauses.push(`si_skills = $${paramIndex}`);
      params.push(config.si_skills);
      paramIndex++;
    }

    params.push(memberProfileId);

    await query(
      `UPDATE member_profiles SET ${setClauses.join(", ")} WHERE id = $${paramIndex}`,
      params
    );
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private deserializeSession(row: Record<string, unknown>): SiSession {
    return {
      id: row.id as string,
      session_id: row.session_id as string,
      host_type: row.host_type as "addy" | "external",
      host_identifier: row.host_identifier as string,
      member_profile_id: row.member_profile_id as string | null,
      brand_name: row.brand_name as string,
      user_slack_id: row.user_slack_id as string | null,
      user_email: row.user_email as string | null,
      user_name: row.user_name as string | null,
      user_anonymous_id: row.user_anonymous_id as string | null,
      identity_consent_granted: row.identity_consent_granted as boolean,
      status: row.status as SiSession["status"],
      termination_reason: row.termination_reason as string | null,
      initial_context: row.initial_context as string | null,
      campaign_id: row.campaign_id as string | null,
      offer_id: row.offer_id as string | null,
      handoff_data: row.handoff_data
        ? (typeof row.handoff_data === "string"
            ? JSON.parse(row.handoff_data as string)
            : row.handoff_data)
        : null,
      message_count: row.message_count as number,
      created_at: new Date(row.created_at as string),
      last_activity_at: new Date(row.last_activity_at as string),
      terminated_at: row.terminated_at
        ? new Date(row.terminated_at as string)
        : null,
    };
  }

  private deserializeMessage(row: Record<string, unknown>): SiSessionMessage {
    return {
      id: row.id as string,
      session_id: row.session_id as string,
      role: row.role as "user" | "brand_agent" | "system",
      content: row.content as string,
      ui_elements: row.ui_elements
        ? typeof row.ui_elements === "string"
          ? JSON.parse(row.ui_elements as string)
          : row.ui_elements
        : null,
      action_response: row.action_response
        ? typeof row.action_response === "string"
          ? JSON.parse(row.action_response as string)
          : row.action_response
        : null,
      created_at: new Date(row.created_at as string),
    };
  }

  private deserializeRelationship(
    row: Record<string, unknown>
  ): SiRelationshipMemory {
    return {
      id: row.id as string,
      user_identifier: row.user_identifier as string,
      user_identifier_type: row.user_identifier_type as
        | "email"
        | "slack_id"
        | "anonymous",
      member_profile_id: row.member_profile_id as string | null,
      total_sessions: row.total_sessions as number,
      last_session_id: row.last_session_id as string | null,
      memory:
        typeof row.memory === "string"
          ? JSON.parse(row.memory as string)
          : (row.memory as Record<string, unknown>) || {},
      first_interaction_at: new Date(row.first_interaction_at as string),
      last_interaction_at: new Date(row.last_interaction_at as string),
      lead_status: row.lead_status as SiRelationshipMemory["lead_status"],
      lead_status_updated_at: row.lead_status_updated_at
        ? new Date(row.lead_status_updated_at as string)
        : null,
      notes: row.notes as string | null,
    };
  }

  private deserializeSkill(row: Record<string, unknown>): SiSkill {
    return {
      id: row.id as string,
      member_profile_id: row.member_profile_id as string | null,
      skill_name: row.skill_name as string,
      skill_description: row.skill_description as string,
      skill_type: row.skill_type as SiSkill["skill_type"],
      config:
        typeof row.config === "string"
          ? JSON.parse(row.config as string)
          : (row.config as Record<string, unknown>) || {},
      is_active: row.is_active as boolean,
      created_at: new Date(row.created_at as string),
      updated_at: new Date(row.updated_at as string),
    };
  }

  private deserializeSkillExecution(
    row: Record<string, unknown>
  ): SiSkillExecution {
    return {
      id: row.id as string,
      session_id: row.session_id as string,
      skill_id: row.skill_id as string,
      input_data: row.input_data
        ? typeof row.input_data === "string"
          ? JSON.parse(row.input_data as string)
          : row.input_data
        : null,
      output_data: row.output_data
        ? typeof row.output_data === "string"
          ? JSON.parse(row.output_data as string)
          : row.output_data
        : null,
      status: row.status as "pending" | "completed" | "failed",
      error_message: row.error_message as string | null,
      executed_at: new Date(row.executed_at as string),
      completed_at: row.completed_at
        ? new Date(row.completed_at as string)
        : null,
    };
  }

  private deserializeAvailabilityCheck(
    row: Record<string, unknown>
  ): SiAvailabilityCheck {
    return {
      id: row.id as string,
      token: row.token as string,
      member_profile_id: row.member_profile_id as string,
      offer_id: row.offer_id as string | null,
      product_id: row.product_id as string | null,
      context: row.context as string | null,
      available: row.available as boolean,
      checked_at: new Date(row.checked_at as string),
      expires_at: new Date(row.expires_at as string),
      used_in_session_id: row.used_in_session_id as string | null,
    };
  }
}

// Export singleton
export const siDb = new SiDatabase();
