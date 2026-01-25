/**
 * SI Agent Service
 *
 * Powers default SI agents for members who don't have custom endpoints.
 * Uses Claude to generate conversational responses based on member profile data.
 */

import Anthropic from "@anthropic-ai/sdk";
import { siDb, type SiSession, type SiRelationshipMemory, type SiSkill } from "../../db/si-db.js";
import { logger } from "../../logger.js";
import { query } from "../../db/client.js";
import { ModelConfig } from "../../config/models.js";

// ============================================================================
// Types
// ============================================================================

interface SiMemberProfile {
  id: string;
  display_name: string;
  slug: string;
  tagline: string | null;
  description: string | null;
  contact_email: string | null;
  contact_website: string | null;
  offerings: string[] | null;
  si_prompt_template: string | null;
  si_skills: string[] | null;
}

interface UserIdentity {
  consent_granted: boolean;
  email?: string;
  name?: string;
  slack_id?: string;
}

interface SiResponse {
  message: string;
  ui_elements?: Array<{
    type: string;
    data: Record<string, unknown>;
  }>;
  session_status: "active" | "pending_handoff" | "complete";
  handoff?: {
    type: "transaction" | "complete";
    intent?: Record<string, unknown>;
    context_for_checkout?: Record<string, unknown>;
  };
  available_skills?: Array<{
    skill_name: string;
    skill_description: string;
    skill_type: string;
  }>;
}

/**
 * Streaming events emitted during SI agent response generation
 */
export type SiStreamEvent =
  | { type: "text"; text: string }
  | { type: "done"; response: SiResponse }
  | { type: "error"; error: string };

// ============================================================================
// Service Class
// ============================================================================

export class SiAgentService {
  private anthropic: Anthropic;

  constructor() {
    this.anthropic = new Anthropic();
  }

  /**
   * Get member profile with SI-specific fields
   */
  private async getMemberProfile(memberProfileId: string): Promise<SiMemberProfile | null> {
    const result = await query(
      `SELECT id, display_name, slug, tagline, description,
              contact_email, contact_website, offerings,
              si_prompt_template, si_skills
       FROM member_profiles
       WHERE id = $1`,
      [memberProfileId]
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      id: row.id,
      display_name: row.display_name,
      slug: row.slug,
      tagline: row.tagline,
      description: row.description,
      contact_email: row.contact_email,
      contact_website: row.contact_website,
      offerings: row.offerings,
      si_prompt_template: row.si_prompt_template,
      si_skills: row.si_skills,
    };
  }

  /**
   * Initialize a new SI session
   */
  async initiateSession(params: {
    memberProfileId: string;
    hostIdentifier: string;
    context: string;
    identity: UserIdentity;
    campaignId?: string;
    offerId?: string;
  }): Promise<{
    session: SiSession;
    response: SiResponse;
    relationship: SiRelationshipMemory;
  }> {
    const { memberProfileId, hostIdentifier, context, identity, campaignId, offerId } = params;

    // Get member profile
    const member = await this.getMemberProfile(memberProfileId);
    if (!member) {
      throw new Error(`Member profile not found: ${memberProfileId}`);
    }

    // Create or get relationship memory
    const userIdentifier = identity.email || identity.slack_id || `anon_${Date.now()}`;
    const userIdentifierType: "email" | "slack_id" | "anonymous" = identity.email
      ? "email"
      : identity.slack_id
        ? "slack_id"
        : "anonymous";

    const relationship = await siDb.getOrCreateRelationship(
      userIdentifier,
      userIdentifierType,
      memberProfileId
    );

    // Create session
    const session = await siDb.createSession({
      host_type: "addy",
      host_identifier: hostIdentifier,
      member_profile_id: memberProfileId,
      brand_name: member.display_name,
      user_slack_id: identity.slack_id,
      user_email: identity.email,
      user_name: identity.name,
      user_anonymous_id: !identity.email && !identity.slack_id ? userIdentifier : undefined,
      identity_consent_granted: identity.consent_granted,
      initial_context: context,
      campaign_id: campaignId,
      offer_id: offerId,
    });

    // Update relationship with new session
    await siDb.updateRelationship(relationship.id, {
      last_session_id: session.session_id,
      lead_status: relationship.lead_status === "new" ? "engaged" : relationship.lead_status,
    });

    // Get available skills
    const skills = await siDb.ensureDefaultSkills(memberProfileId);

    // Generate initial response
    const response = await this.generateResponse({
      member,
      session,
      relationship,
      skills,
      userMessage: context,
      isInitialMessage: true,
      identity,
    });

    // Store brand agent message
    await siDb.addMessage({
      session_id: session.session_id,
      role: "brand_agent",
      content: response.message,
      ui_elements: response.ui_elements,
    });

    return {
      session,
      response,
      relationship,
    };
  }

  /**
   * Send a message in an active session
   */
  async sendMessage(params: {
    sessionId: string;
    message?: string;
    actionResponse?: {
      action: string;
      element_id?: string;
      payload?: Record<string, unknown>;
    };
  }): Promise<SiResponse> {
    const { sessionId, message, actionResponse } = params;

    // Get session
    const session = await siDb.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    if (session.status !== "active") {
      throw new Error(`Session is not active: ${session.status}`);
    }

    // Validate session has required member profile
    if (!session.member_profile_id) {
      throw new Error(`Session ${sessionId} is missing member_profile_id`);
    }
    const memberProfileId = session.member_profile_id;

    // Get member profile
    const member = await this.getMemberProfile(memberProfileId);
    if (!member) {
      throw new Error(`Member profile not found: ${memberProfileId}`);
    }

    // Get relationship memory - require at least one user identifier
    const userIdentifier = session.user_email || session.user_slack_id || session.user_anonymous_id;
    if (!userIdentifier) {
      throw new Error(`Session ${sessionId} has no user identifier`);
    }
    const userIdentifierType: "email" | "slack_id" | "anonymous" = session.user_email
      ? "email"
      : session.user_slack_id
        ? "slack_id"
        : "anonymous";

    const relationship = await siDb.getOrCreateRelationship(
      userIdentifier,
      userIdentifierType,
      memberProfileId
    );

    // Get conversation history
    const history = await siDb.getSessionMessages(sessionId, 10);

    // Get available skills
    const skills = await siDb.ensureDefaultSkills(memberProfileId);

    // Store user message
    if (message) {
      await siDb.addMessage({
        session_id: sessionId,
        role: "user",
        content: message,
      });
    } else if (actionResponse) {
      await siDb.addMessage({
        session_id: sessionId,
        role: "user",
        content: `[Action: ${actionResponse.action}]`,
        action_response: actionResponse,
      });
    }

    // Check for skill execution
    if (actionResponse) {
      const skillResponse = await this.handleSkillAction(
        session,
        skills,
        actionResponse,
        relationship
      );
      if (skillResponse) {
        await siDb.addMessage({
          session_id: sessionId,
          role: "brand_agent",
          content: skillResponse.message,
          ui_elements: skillResponse.ui_elements,
        });
        return skillResponse;
      }
    }

    // Generate response
    const identity: UserIdentity = {
      consent_granted: session.identity_consent_granted,
      email: session.user_email || undefined,
      name: session.user_name || undefined,
      slack_id: session.user_slack_id || undefined,
    };

    const response = await this.generateResponse({
      member,
      session,
      relationship,
      skills,
      userMessage: message || `[Action: ${actionResponse?.action}]`,
      isInitialMessage: false,
      identity,
      conversationHistory: history,
    });

    // Store brand agent message
    await siDb.addMessage({
      session_id: sessionId,
      role: "brand_agent",
      content: response.message,
      ui_elements: response.ui_elements,
    });

    // Update relationship memory with conversation context
    const memoryUpdate = this.extractMemoryUpdates(message, response);
    if (Object.keys(memoryUpdate).length > 0) {
      await siDb.updateRelationship(relationship.id, {
        memory: memoryUpdate,
      });
    }

    // Update session status if handoff
    if (response.session_status !== "active") {
      await siDb.updateSessionStatus(
        sessionId,
        response.session_status,
        response.handoff?.type === "transaction" ? "handoff_transaction" : "handoff_complete",
        response.handoff
      );
    }

    return response;
  }

  /**
   * Send a message in an active session with streaming response
   * Yields text chunks as they're generated, then a final done event
   */
  async *sendMessageStream(params: {
    sessionId: string;
    message?: string;
    actionResponse?: {
      action: string;
      element_id?: string;
      payload?: Record<string, unknown>;
    };
  }): AsyncGenerator<SiStreamEvent> {
    const { sessionId, message, actionResponse } = params;

    // Get session
    const session = await siDb.getSession(sessionId);
    if (!session) {
      yield { type: "error", error: `Session not found: ${sessionId}` };
      return;
    }

    if (session.status !== "active") {
      yield { type: "error", error: `Session is not active: ${session.status}` };
      return;
    }

    // Validate session has required member profile
    if (!session.member_profile_id) {
      yield { type: "error", error: `Session ${sessionId} is missing member_profile_id` };
      return;
    }
    const memberProfileId = session.member_profile_id;

    // Get member profile
    const member = await this.getMemberProfile(memberProfileId);
    if (!member) {
      yield { type: "error", error: `Member profile not found: ${memberProfileId}` };
      return;
    }

    // Get relationship memory - require at least one user identifier
    const userIdentifier = session.user_email || session.user_slack_id || session.user_anonymous_id;
    if (!userIdentifier) {
      yield { type: "error", error: `Session ${sessionId} has no user identifier` };
      return;
    }
    const userIdentifierType: "email" | "slack_id" | "anonymous" = session.user_email
      ? "email"
      : session.user_slack_id
        ? "slack_id"
        : "anonymous";

    const relationship = await siDb.getOrCreateRelationship(
      userIdentifier,
      userIdentifierType,
      memberProfileId
    );

    // Get conversation history
    const history = await siDb.getSessionMessages(sessionId, 10);

    // Get available skills
    const skills = await siDb.ensureDefaultSkills(memberProfileId);

    // Store user message
    if (message) {
      await siDb.addMessage({
        session_id: sessionId,
        role: "user",
        content: message,
      });
    } else if (actionResponse) {
      await siDb.addMessage({
        session_id: sessionId,
        role: "user",
        content: `[Action: ${actionResponse.action}]`,
        action_response: actionResponse,
      });
    }

    // Check for skill execution - not streamed since these are quick
    if (actionResponse) {
      const skillResponse = await this.handleSkillAction(
        session,
        skills,
        actionResponse,
        relationship
      );
      if (skillResponse) {
        await siDb.addMessage({
          session_id: sessionId,
          role: "brand_agent",
          content: skillResponse.message,
          ui_elements: skillResponse.ui_elements,
        });
        // For skill responses, emit text then done
        yield { type: "text", text: skillResponse.message };
        yield { type: "done", response: skillResponse };
        return;
      }
    }

    // Generate response with streaming
    const identity: UserIdentity = {
      consent_granted: session.identity_consent_granted,
      email: session.user_email || undefined,
      name: session.user_name || undefined,
      slack_id: session.user_slack_id || undefined,
    };

    // Use streaming generation
    let fullText = "";
    for await (const event of this.generateResponseStream({
      member,
      session,
      relationship,
      skills,
      userMessage: message || `[Action: ${actionResponse?.action}]`,
      isInitialMessage: false,
      identity,
      conversationHistory: history,
    })) {
      if (event.type === "text") {
        fullText += event.text;
        yield event;
      } else if (event.type === "done") {
        // Store brand agent message
        await siDb.addMessage({
          session_id: sessionId,
          role: "brand_agent",
          content: event.response.message,
          ui_elements: event.response.ui_elements,
        });

        // Update relationship memory with conversation context
        const memoryUpdate = this.extractMemoryUpdates(message, event.response);
        if (Object.keys(memoryUpdate).length > 0) {
          await siDb.updateRelationship(relationship.id, {
            memory: memoryUpdate,
          });
        }

        // Update session status if handoff
        if (event.response.session_status !== "active") {
          await siDb.updateSessionStatus(
            sessionId,
            event.response.session_status,
            event.response.handoff?.type === "transaction" ? "handoff_transaction" : "handoff_complete",
            event.response.handoff
          );
        }

        yield event;
      } else if (event.type === "error") {
        yield event;
      }
    }
  }

  /**
   * Terminate a session
   */
  async terminateSession(
    sessionId: string,
    reason: string
  ): Promise<{ terminated: boolean; follow_up?: Record<string, unknown> }> {
    const session = await siDb.getSession(sessionId);
    if (!session) {
      return { terminated: false };
    }

    await siDb.updateSessionStatus(
      sessionId,
      reason === "handoff_transaction" ? "pending_handoff" : "complete",
      reason
    );

    // Generate follow-up suggestion based on conversation
    const followUp = reason === "user_exit" ? {
      suggested_action: "remind_later",
      message: `Feel free to come back anytime if you have questions about ${session.brand_name}!`,
    } : undefined;

    return { terminated: true, follow_up: followUp };
  }

  // --------------------------------------------------------------------------
  // Private Methods
  // --------------------------------------------------------------------------

  private async generateResponse(params: {
    member: SiMemberProfile;
    session: SiSession;
    relationship: SiRelationshipMemory;
    skills: SiSkill[];
    userMessage: string;
    isInitialMessage: boolean;
    identity: UserIdentity;
    conversationHistory?: Array<{ role: string; content: string }>;
  }): Promise<SiResponse> {
    const {
      member,
      session,
      relationship,
      skills,
      userMessage,
      isInitialMessage,
      identity,
      conversationHistory,
    } = params;

    // Build system prompt
    const systemPrompt = this.buildSystemPrompt(member, skills, relationship, identity);

    // Build messages
    const messages: Array<{ role: "user" | "assistant"; content: string }> = [];

    // Add conversation history
    if (conversationHistory && conversationHistory.length > 0) {
      for (const msg of conversationHistory) {
        messages.push({
          role: msg.role === "user" ? "user" : "assistant",
          content: msg.content,
        });
      }
    }

    // Add current message
    const userContext = isInitialMessage
      ? `[New conversation. User context: ${userMessage}]${session.offer_id ? ` [Active offer: ${session.offer_id}]` : ""}`
      : userMessage;

    messages.push({ role: "user", content: userContext });

    try {
      const response = await this.anthropic.messages.create({
        model: ModelConfig.primary,
        max_tokens: 1024,
        system: systemPrompt,
        messages,
      });

      // Parse response
      const textContent = response.content.find((c) => c.type === "text");
      const rawText = textContent?.type === "text" ? textContent.text : "";

      // Try to parse as JSON response (for structured output)
      const parsed = this.parseAgentResponse(rawText, member, skills, isInitialMessage);

      return parsed;
    } catch (error) {
      logger.error({ error, sessionId: session.session_id }, "SI Agent: Error generating response");

      return {
        message: `I'm sorry, I'm having trouble right now. Please try again or contact ${member.display_name} directly at ${member.contact_email || member.contact_website || "their website"}.`,
        session_status: "active",
      };
    }
  }

  /**
   * Streaming version of generateResponse - yields text chunks as they arrive
   */
  private async *generateResponseStream(params: {
    member: SiMemberProfile;
    session: SiSession;
    relationship: SiRelationshipMemory;
    skills: SiSkill[];
    userMessage: string;
    isInitialMessage: boolean;
    identity: UserIdentity;
    conversationHistory?: Array<{ role: string; content: string }>;
  }): AsyncGenerator<SiStreamEvent> {
    const {
      member,
      session,
      relationship,
      skills,
      userMessage,
      isInitialMessage,
      identity,
      conversationHistory,
    } = params;

    // Build system prompt
    const systemPrompt = this.buildSystemPrompt(member, skills, relationship, identity);

    // Build messages
    const messages: Array<{ role: "user" | "assistant"; content: string }> = [];

    // Add conversation history
    if (conversationHistory && conversationHistory.length > 0) {
      for (const msg of conversationHistory) {
        messages.push({
          role: msg.role === "user" ? "user" : "assistant",
          content: msg.content,
        });
      }
    }

    // Add current message
    const userContext = isInitialMessage
      ? `[New conversation. User context: ${userMessage}]${session.offer_id ? ` [Active offer: ${session.offer_id}]` : ""}`
      : userMessage;

    messages.push({ role: "user", content: userContext });

    try {
      // Use streaming API
      const stream = this.anthropic.messages.stream({
        model: ModelConfig.primary,
        max_tokens: 1024,
        system: systemPrompt,
        messages,
      });

      const textChunks: string[] = [];

      // Process stream events and yield text chunks
      for await (const event of stream) {
        if (event.type === "content_block_delta") {
          const delta = event.delta;
          if ("text" in delta && delta.text) {
            textChunks.push(delta.text);
            yield { type: "text", text: delta.text };
          }
        }
      }

      // Get the final complete text
      const rawText = textChunks.join("");

      // Parse the complete response
      const parsed = this.parseAgentResponse(rawText, member, skills, isInitialMessage);

      yield { type: "done", response: parsed };
    } catch (error) {
      logger.error({ error, sessionId: session.session_id }, "SI Agent: Error in streaming response");

      yield {
        type: "error",
        error: `I'm sorry, I'm having trouble right now. Please try again or contact ${member.display_name} directly.`,
      };
    }
  }

  private buildSystemPrompt(
    member: SiMemberProfile,
    skills: SiSkill[],
    relationship: SiRelationshipMemory,
    identity: UserIdentity
  ): string {
    // Use custom template if available
    if (member.si_prompt_template) {
      return member.si_prompt_template
        .replace("{{company_name}}", member.display_name)
        .replace("{{tagline}}", member.tagline || "")
        .replace("{{description}}", member.description || "")
        .replace("{{user_name}}", identity.name || "there");
    }

    // Build default prompt
    const skillsText = skills.length > 0
      ? `\n\nAvailable actions you can offer:\n${skills.map((s) => `- ${s.skill_name}: ${s.skill_description}`).join("\n")}`
      : "";

    const memoryText = Object.keys(relationship.memory).length > 0
      ? `\n\nWhat you remember about this user from previous conversations:\n${JSON.stringify(relationship.memory, null, 2)}`
      : "";

    const returningUser = relationship.total_sessions > 0
      ? `\n\nThis is a returning user (${relationship.total_sessions} previous sessions).`
      : "";

    return `You are the AI assistant for ${member.display_name}.
${member.tagline ? `\nTagline: ${member.tagline}` : ""}
${member.description ? `\nAbout the company: ${member.description}` : ""}
${member.offerings?.length ? `\nServices/Products: ${member.offerings.join(", ")}` : ""}
${member.contact_website ? `\nWebsite: ${member.contact_website}` : ""}
${skillsText}
${memoryText}
${returningUser}

Your role is to:
1. Help users understand what ${member.display_name} offers
2. Answer questions about products, services, and capabilities
3. Guide users toward relevant actions (${skills.length > 0 ? skills.map((s) => s.skill_name).join(", ") : "learning more"})
4. Be helpful, professional, and represent the ${member.display_name} brand well

${identity.name ? `The user's name is ${identity.name}.` : ""}

Guidelines:
- Be conversational and helpful
- Don't make up information you don't have
- If asked about pricing or specific details you don't know, suggest contacting the company directly
- If the user wants to take an action (sign up, request demo, etc.), respond with a JSON object containing "action" field
- For normal responses, just respond naturally
- If the user asks about adding you as a tool, integrating you with their workflow, using MCP, or "taking you with them", offer integration options

When offering actions, format your response as JSON:
{
  "message": "Your message to the user",
  "action": "skill_name_to_trigger",
  "action_data": { ... any relevant data ... }
}

When offering integration options (MCP/A2A), format as:
{
  "message": "Your message about integration options",
  "show_integration_options": true
}

For normal conversation, just respond with plain text.`;
  }

  private parseAgentResponse(
    rawText: string,
    member: SiMemberProfile,
    skills: SiSkill[],
    isInitialMessage: boolean = false
  ): SiResponse {
    // Try to parse as JSON
    try {
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);

        // Check for action trigger
        if (parsed.action) {
          const skill = skills.find((s) => s.skill_name === parsed.action);

          return {
            message: parsed.message || `Let me help you with ${parsed.action}.`,
            ui_elements: skill
              ? [
                  {
                    type: "action_button",
                    data: {
                      label: this.getSkillButtonLabel(skill.skill_type),
                      action: skill.skill_name,
                      payload: parsed.action_data || {},
                    },
                  },
                ]
              : undefined,
            session_status: "active",
            available_skills: skills.map((s) => ({
              skill_name: s.skill_name,
              skill_description: s.skill_description,
              skill_type: s.skill_type,
            })),
          };
        }

        // Check if this is asking to add as tool
        if (parsed.show_integration_options) {
          return {
            message: parsed.message || rawText,
            ui_elements: [this.generateIntegrationActions(member)],
            session_status: "active",
          };
        }

        // Just a message response
        return {
          message: parsed.message || rawText,
          session_status: "active",
        };
      }
    } catch {
      // Not JSON, use as plain text
    }

    // For initial message, add rich UI elements
    if (isInitialMessage) {
      const welcomeElements = this.generateWelcomeUiElements(member, skills);
      return {
        message: rawText,
        ui_elements: welcomeElements.length > 0 ? welcomeElements : undefined,
        session_status: "active",
      };
    }

    // Check for specific phrases that indicate integration intent
    // Using precise phrases to avoid false positives (e.g., "mcp" alone could appear in other contexts)
    const lowerText = rawText.toLowerCase();
    const integrationPhrases = [
      "add me as a tool",
      "add as mcp tool",
      "add as an mcp tool",
      "take me with you",
      "install as tool",
      "add to your workflow",
      "connect via a2a",
      "connect via mcp",
    ];
    const hasIntegrationIntent = integrationPhrases.some((phrase) => lowerText.includes(phrase));

    if (hasIntegrationIntent) {
      return {
        message: rawText,
        ui_elements: [this.generateIntegrationActions(member)],
        session_status: "active",
      };
    }

    // Plain text response
    return {
      message: rawText,
      session_status: "active",
    };
  }

  private getSkillButtonLabel(skillType: string): string {
    switch (skillType) {
      case "signup":
        return "Sign Up";
      case "demo_request":
        return "Request Demo";
      case "implementation_help":
        return "Get Implementation Help";
      case "contact_sales":
        return "Contact Sales";
      case "documentation":
        return "View Documentation";
      default:
        return "Continue";
    }
  }

  /**
   * Generate a rich welcome message with UI components
   */
  private generateWelcomeUiElements(
    member: SiMemberProfile,
    skills: SiSkill[]
  ): Array<{ type: string; data: Record<string, unknown> }> {
    const elements: Array<{ type: string; data: Record<string, unknown> }> = [];

    // Add product carousel if member has offerings
    if (member.offerings && member.offerings.length > 1) {
      elements.push({
        type: "carousel",
        data: {
          title: `Explore ${member.display_name}`,
          items: member.offerings.slice(0, 5).map((offering, index) => ({
            title: offering,
            subtitle: member.display_name,
            action: "learn_more",
          })),
        },
      });
    }

    // Add quick action buttons based on available skills
    const quickActions = skills.filter(s =>
      ["demo_request", "contact_sales", "documentation"].includes(s.skill_type)
    ).slice(0, 3);

    if (quickActions.length > 0) {
      for (const skill of quickActions) {
        elements.push({
          type: "action_button",
          data: {
            label: this.getSkillButtonLabel(skill.skill_type),
            action: skill.skill_name,
            variant: skill.skill_type === "demo_request" ? "primary" : "secondary",
          },
        });
      }
    }

    return elements;
  }

  /**
   * Generate integration actions (MCP/A2A handoff options)
   */
  private generateIntegrationActions(
    member: SiMemberProfile
  ): { type: string; data: Record<string, unknown> } {
    return {
      type: "integration_actions",
      data: {
        actions: [
          {
            type: "mcp",
            label: `Add ${member.display_name} as MCP Tool`,
            highlighted: true,
            endpoint: member.contact_website ? `${member.contact_website}/mcp` : null,
          },
          {
            type: "a2a",
            label: "Connect via A2A",
          },
        ],
      },
    };
  }

  private async handleSkillAction(
    session: SiSession,
    skills: SiSkill[],
    actionResponse: { action: string; payload?: Record<string, unknown> },
    relationship: SiRelationshipMemory
  ): Promise<SiResponse | null> {
    const skill = skills.find((s) => s.skill_name === actionResponse.action);
    if (!skill) {
      return null;
    }

    // Record skill execution
    const execution = await siDb.executeSkill(
      session.session_id,
      skill.id,
      actionResponse.payload || {}
    );

    // Handle based on skill type
    let response: SiResponse;

    switch (skill.skill_type) {
      case "signup":
        response = await this.handleSignupSkill(session, skill, actionResponse.payload, relationship);
        break;

      case "demo_request":
        response = await this.handleDemoRequestSkill(session, skill, actionResponse.payload, relationship);
        break;

      case "implementation_help":
        response = await this.handleImplementationHelpSkill(session, skill, relationship);
        break;

      case "contact_sales":
        response = await this.handleContactSalesSkill(session, skill, relationship);
        break;

      case "documentation":
        response = await this.handleDocumentationSkill(skill);
        break;

      default:
        response = {
          message: "I've noted your interest. Someone from the team will follow up with you.",
          session_status: "active",
        };
    }

    // Complete skill execution
    await siDb.completeSkillExecution(execution.id, "completed", {
      skill_type: skill.skill_type,
      response_message: response.message,
    });

    // Update lead status based on skill
    const newLeadStatus = this.getLeadStatusForSkill(skill.skill_type);
    if (newLeadStatus) {
      await siDb.updateRelationship(relationship.id, {
        lead_status: newLeadStatus,
        memory: { last_skill_used: skill.skill_name, last_skill_at: new Date().toISOString() },
      });
    }

    return response;
  }

  private async handleSignupSkill(
    session: SiSession,
    skill: SiSkill,
    payload: Record<string, unknown> | undefined,
    relationship: SiRelationshipMemory
  ): Promise<SiResponse> {
    const config = skill.config as {
      redirect_url?: string;
      confirmation_message?: string;
    };

    // If we have user email, they're already identified
    if (session.user_email) {
      return {
        message: config.confirmation_message ||
          `Great! I've noted your interest in signing up. You'll receive information at ${session.user_email}. In the meantime, you can also sign up directly at our website.`,
        ui_elements: config.redirect_url
          ? [
              {
                type: "link",
                data: {
                  url: config.redirect_url,
                  label: "Sign Up Now",
                },
              },
            ]
          : undefined,
        session_status: "active",
      };
    }

    // Need to collect email
    return {
      message: "I'd be happy to help you sign up! Could you share your email address so we can create your account?",
      session_status: "active",
    };
  }

  private async handleDemoRequestSkill(
    session: SiSession,
    skill: SiSkill,
    payload: Record<string, unknown> | undefined,
    relationship: SiRelationshipMemory
  ): Promise<SiResponse> {
    const config = skill.config as {
      calendar_link?: string;
      sales_email?: string;
    };

    const userName = session.user_name || "there";

    if (config.calendar_link) {
      return {
        message: `Excellent, ${userName}! I'd love to show you what we can do. You can book a demo directly using the link below, or I can have someone reach out to you.`,
        ui_elements: [
          {
            type: "link",
            data: {
              url: config.calendar_link,
              label: "Schedule Demo",
            },
          },
        ],
        session_status: "active",
      };
    }

    if (session.user_email) {
      return {
        message: `Thanks ${userName}! I've passed your demo request to our team. They'll reach out to ${session.user_email} shortly to schedule a time that works for you.`,
        session_status: "active",
      };
    }

    return {
      message: "I'd be happy to set up a demo for you! Could you share your email address so our team can reach out?",
      session_status: "active",
    };
  }

  private async handleImplementationHelpSkill(
    session: SiSession,
    skill: SiSkill,
    relationship: SiRelationshipMemory
  ): Promise<SiResponse> {
    return {
      message: `I can help guide you through implementation! What specific aspect are you working on? Are you:
- Just getting started and need an overview?
- Working on a specific integration?
- Troubleshooting an issue?

Let me know and I'll point you in the right direction.`,
      session_status: "active",
    };
  }

  private async handleContactSalesSkill(
    session: SiSession,
    skill: SiSkill,
    relationship: SiRelationshipMemory
  ): Promise<SiResponse> {
    const config = skill.config as {
      sales_email?: string;
      sales_phone?: string;
    };

    if (session.user_email) {
      return {
        message: `I've flagged your interest to our sales team. They'll reach out to ${session.user_email} shortly!`,
        session_status: "active",
      };
    }

    return {
      message: `I'd be happy to connect you with our sales team. Could you share your email address so they can reach out?${config.sales_email ? ` You can also email them directly at ${config.sales_email}.` : ""}`,
      session_status: "active",
    };
  }

  private async handleDocumentationSkill(skill: SiSkill): Promise<SiResponse> {
    const config = skill.config as {
      docs_url?: string;
    };

    return {
      message: "Here's our documentation where you can find detailed guides and API references.",
      ui_elements: config.docs_url
        ? [
            {
              type: "link",
              data: {
                url: config.docs_url,
                label: "View Documentation",
              },
            },
          ]
        : undefined,
      session_status: "active",
    };
  }

  private getLeadStatusForSkill(
    skillType: string
  ): "engaged" | "qualified" | null {
    switch (skillType) {
      case "signup":
      case "demo_request":
      case "contact_sales":
        return "qualified";
      case "implementation_help":
      case "documentation":
        return "engaged";
      default:
        return null;
    }
  }

  private extractMemoryUpdates(
    userMessage: string | undefined,
    response: SiResponse
  ): Record<string, unknown> {
    const updates: Record<string, unknown> = {};

    if (!userMessage) return updates;

    // Extract topics discussed
    const lowerMessage = userMessage.toLowerCase();

    if (lowerMessage.includes("pricing") || lowerMessage.includes("cost")) {
      updates.discussed_pricing = true;
    }

    if (lowerMessage.includes("demo") || lowerMessage.includes("trial")) {
      updates.interested_in_demo = true;
    }

    if (lowerMessage.includes("implement") || lowerMessage.includes("integrat")) {
      updates.interested_in_implementation = true;
    }

    updates.last_message_at = new Date().toISOString();

    return updates;
  }
}

// Export singleton
export const siAgentService = new SiAgentService();
