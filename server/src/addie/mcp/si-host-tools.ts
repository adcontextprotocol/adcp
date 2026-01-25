/**
 * Sponsored Intelligence (SI) Host Tools
 *
 * Enables Addy to act as an SI host, connecting users with AAO member brand agents.
 * When a user says "connect me with BidCliq" or "I want to talk to Scope3's agent",
 * Addy can establish an SI session and facilitate the conversation.
 */

import type { AddieTool } from "../types.js";
import type { MemberContext } from "../member-context.js";
import { siDb } from "../../db/si-db.js";
import { siAgentService } from "../services/si-agent-service.js";
import { logger } from "../../logger.js";

type ToolHandler = (input: Record<string, unknown>) => Promise<string>;

// Session timeout in milliseconds (5 minutes)
const SESSION_TIMEOUT_MS = 5 * 60 * 1000;

// Cache cleanup interval (1 minute)
const CACHE_CLEANUP_INTERVAL_MS = 60 * 1000;

// Maximum cache entries before forcing cleanup
const MAX_CACHE_ENTRIES = 10000;

// Cache entry with timestamp for TTL management
interface ThreadSessionEntry {
  sessionId: string;
  createdAt: number;
}

// Cache for active session lookups by thread ID (maps thread -> session entry)
const threadSessionMap = new Map<string, ThreadSessionEntry>();

// Track when we last cleaned up
let lastCleanupTime = Date.now();

/**
 * Clean up expired entries from the thread session cache
 */
function cleanupExpiredSessions(): void {
  const now = Date.now();
  let cleanedCount = 0;

  for (const [threadId, entry] of threadSessionMap) {
    if (now - entry.createdAt > SESSION_TIMEOUT_MS) {
      threadSessionMap.delete(threadId);
      cleanedCount++;
    }
  }

  if (cleanedCount > 0) {
    logger.debug({ cleanedCount, remainingCount: threadSessionMap.size }, "SI Host: Cleaned expired session cache entries");
  }

  lastCleanupTime = now;
}

/**
 * Get session ID from cache, triggering cleanup if needed
 */
function getCachedSession(threadId: string): string | undefined {
  // Trigger cleanup if it's been too long or cache is too large
  const now = Date.now();
  if (now - lastCleanupTime > CACHE_CLEANUP_INTERVAL_MS || threadSessionMap.size > MAX_CACHE_ENTRIES) {
    cleanupExpiredSessions();
  }

  const entry = threadSessionMap.get(threadId);
  if (!entry) return undefined;

  // Check if this specific entry is expired
  if (now - entry.createdAt > SESSION_TIMEOUT_MS) {
    threadSessionMap.delete(threadId);
    return undefined;
  }

  return entry.sessionId;
}

/**
 * Set session ID in cache with timestamp
 */
function setCachedSession(threadId: string, sessionId: string): void {
  threadSessionMap.set(threadId, {
    sessionId,
    createdAt: Date.now(),
  });
}

/**
 * Remove session from cache
 */
function removeCachedSession(threadId: string): void {
  threadSessionMap.delete(threadId);
}

/**
 * SI Host tools for Addy
 */
export const SI_HOST_TOOLS: AddieTool[] = [
  {
    name: "get_si_availability",
    description:
      "Check if an offer or product is available from a brand agent before connecting. This is an anonymous pre-flight check that doesn't share user data.",
    usage_hints:
      "Use before connect_to_si_agent when you have a specific offer or product to check, especially for sponsored results or campaign offers",
    input_schema: {
      type: "object" as const,
      properties: {
        brand_name: {
          type: "string",
          description: "Name of the brand/member to check availability with",
        },
        offer_id: {
          type: "string",
          description: "Campaign offer identifier to check availability for",
        },
        product_id: {
          type: "string",
          description: "Product identifier to check availability for",
        },
        context: {
          type: "string",
          description: "Optional natural language context about user intent (no PII)",
        },
      },
      required: ["brand_name"],
    },
  },
  {
    name: "list_si_agents",
    description:
      "List AAO member brand agents that support Sponsored Intelligence protocol. Shows which brands users can have conversations with.",
    usage_hints:
      "Use when user asks about available brand agents, who they can talk to, or wants to explore SI-enabled members",
    input_schema: {
      type: "object" as const,
      properties: {
        category: {
          type: "string",
          description:
            "Optional filter by category (e.g., 'dsp', 'ssp', 'data', 'measurement')",
        },
      },
      required: [],
    },
  },
  {
    name: "connect_to_si_agent",
    description:
      "Connect user with an SI-hosted brand agent. Initiates a conversational session where the brand agent can interact with the user.",
    usage_hints:
      "Use when user explicitly wants to talk to a specific brand agent, like 'connect me with BidCliq' or 'I want to chat with Scope3'",
    input_schema: {
      type: "object" as const,
      properties: {
        brand_name: {
          type: "string",
          description: "Name of the brand/member to connect with",
        },
        context: {
          type: "string",
          description:
            "Natural language description of what the user wants to discuss with the brand",
        },
        share_identity: {
          type: "boolean",
          description:
            "Whether to share the user's identity with the brand agent (requires user consent)",
        },
      },
      required: ["brand_name", "context"],
    },
  },
  {
    name: "send_to_si_agent",
    description:
      "Send a message to an active SI session with a brand agent. Use this when the user is already connected and wants to continue the conversation.",
    usage_hints:
      "Use when there's an active SI session and user sends a message intended for the brand agent",
    input_schema: {
      type: "object" as const,
      properties: {
        message: {
          type: "string",
          description: "The user's message to send to the brand agent",
        },
        action_response: {
          type: "object",
          description:
            "Response to a UI action (button click, selection) from the brand agent",
          properties: {
            action: { type: "string" },
            element_id: { type: "string" },
            payload: { type: "object" },
          },
        },
      },
      required: [],
    },
  },
  {
    name: "end_si_session",
    description:
      "End the current SI session with a brand agent. Use when user is done talking to the brand or wants to return to normal conversation.",
    usage_hints:
      "Use when user says they're done with the brand conversation, changes topic, or explicitly asks to disconnect",
    input_schema: {
      type: "object" as const,
      properties: {
        reason: {
          type: "string",
          enum: [
            "user_exit",
            "handoff_transaction",
            "handoff_complete",
            "session_timeout",
          ],
          description: "Why the session is ending",
        },
      },
      required: ["reason"],
    },
  },
  {
    name: "get_si_session_status",
    description:
      "Check if there's an active SI session and get its current status.",
    usage_hints: "Use to check if user is currently in an SI conversation",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
];


/**
 * Create SI host tool handlers
 */
export function createSiHostToolHandlers(
  getMemberContext: () => MemberContext | null,
  getThreadExternalId: () => string
): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();

  /**
   * Check SI availability (anonymous pre-flight)
   */
  handlers.set("get_si_availability", async (args: Record<string, unknown>) => {
    try {
      const brandName = args.brand_name as string;
      const offerId = args.offer_id as string | undefined;
      const productId = args.product_id as string | undefined;
      const context = args.context as string | undefined;

      if (!offerId && !productId) {
        return JSON.stringify({
          available: false,
          error: "Either offer_id or product_id must be provided",
        });
      }

      // Find the brand agent by name or slug
      const members = await siDb.getSiEnabledMembers();
      const lowerBrandName = brandName.toLowerCase();
      const brand = members.find(
        (m) =>
          m.display_name.toLowerCase() === lowerBrandName ||
          m.slug.toLowerCase() === lowerBrandName
      );

      if (!brand) {
        return JSON.stringify({
          available: false,
          error: `No SI agent found for "${brandName}". Use list_si_agents to see available agents.`,
        });
      }

      // Generate availability token
      const checkedAt = new Date().toISOString();
      const availabilityToken = await siDb.createAvailabilityCheck({
        memberProfileId: brand.id,
        offerId,
        productId,
        context,
      });

      // For now, all offers from SI-enabled members are considered available
      // In the future, this could call the brand's endpoint to verify
      return JSON.stringify({
        available: true,
        availability_token: availabilityToken,
        ttl_seconds: 3600, // 1 hour
        checked_at: checkedAt,
        offer_details: {
          brand_name: brand.display_name,
          summary: brand.tagline || `Connect with ${brand.display_name}`,
        },
      });
    } catch (error) {
      logger.error({ error }, "SI Host: Error checking availability");
      return JSON.stringify({
        available: false,
        error: "Failed to check availability. Please try again.",
      });
    }
  });

  /**
   * List available SI agents
   */
  handlers.set("list_si_agents", async (args: Record<string, unknown>) => {
    try {
      const searchTerm = args.category as string | undefined;
      const members = await siDb.getSiEnabledMembers();

      // Filter by search term if provided (searches name, description, tagline)
      let filtered = members;
      if (searchTerm) {
        const lowerSearch = searchTerm.toLowerCase();
        filtered = members.filter(
          (m) =>
            m.display_name.toLowerCase().includes(lowerSearch) ||
            m.description?.toLowerCase().includes(lowerSearch) ||
            m.tagline?.toLowerCase().includes(lowerSearch)
        );
      }

      if (filtered.length === 0) {
        return JSON.stringify({
          agents: [],
          message: searchTerm
            ? `No SI-enabled agents found matching "${searchTerm}".`
            : "No SI-enabled agents are currently available.",
        });
      }

      return JSON.stringify({
        agents: filtered.map((m) => ({
          id: m.id,
          name: m.display_name,
          slug: m.slug,
          tagline: m.tagline,
          description: m.description,
          has_custom_endpoint: !!m.si_endpoint_url,
          skills: m.si_skills,
        })),
        message: `Found ${filtered.length} SI-enabled agent${filtered.length > 1 ? "s" : ""}. Users can connect with any of these to have a direct conversation.`,
      });
    } catch (error) {
      logger.error({ error }, "SI Host: Error listing agents");
      return JSON.stringify({
        agents: [],
        error: "Failed to fetch available agents. Please try again.",
      });
    }
  });

  /**
   * Connect to an SI agent
   */
  handlers.set("connect_to_si_agent", async (args: Record<string, unknown>) => {
    try {
      const brandName = args.brand_name as string;
      const context = args.context as string;
      const shareIdentity = args.share_identity as boolean | undefined;

      const threadId = getThreadExternalId();
      const memberContext = getMemberContext();

      // Check for existing session in this thread
      const existingSessionId = getCachedSession(threadId);
      if (existingSessionId) {
        const existingSession = await siDb.getSession(existingSessionId);
        if (existingSession && existingSession.status === "active") {
          return JSON.stringify({
            success: false,
            error: `Already connected to ${existingSession.brand_name}. End that session first with end_si_session.`,
          });
        }
        // Session not active, clear the mapping
        removeCachedSession(threadId);
      }

      // Find the brand agent by name or slug
      const members = await siDb.getSiEnabledMembers();
      const lowerBrandName = brandName.toLowerCase();
      const brand = members.find(
        (m) =>
          m.display_name.toLowerCase() === lowerBrandName ||
          m.slug.toLowerCase() === lowerBrandName
      );

      if (!brand) {
        return JSON.stringify({
          success: false,
          error: `No SI agent found for "${brandName}". Use list_si_agents to see available agents.`,
          available_agents: members.map((m) => m.display_name),
        });
      }

      // Build identity object based on consent
      const identity = {
        consent_granted: shareIdentity ?? false,
        email: shareIdentity
          ? memberContext?.workos_user?.email ||
            memberContext?.slack_user?.email ||
            undefined
          : undefined,
        name: shareIdentity
          ? [
              memberContext?.workos_user?.first_name,
              memberContext?.workos_user?.last_name,
            ]
              .filter(Boolean)
              .join(" ") ||
            memberContext?.slack_user?.display_name ||
            undefined
          : undefined,
        slack_id: memberContext?.slack_user?.slack_user_id || undefined,
      };

      // Check if brand has a custom SI endpoint
      if (brand.si_endpoint_url) {
        // TODO: Call the brand's custom SI endpoint via MCP
        // For now, fall through to default agent
        logger.info(
          { brand: brand.display_name, endpoint: brand.si_endpoint_url },
          "SI Host: Brand has custom endpoint (not yet supported, using default)"
        );
      }

      // Use the default Claude-powered SI agent
      const result = await siAgentService.initiateSession({
        memberProfileId: brand.id,
        hostIdentifier: threadId,
        context,
        identity,
      });

      // Store thread -> session mapping
      setCachedSession(threadId, result.session.session_id);

      return JSON.stringify({
        success: true,
        session_id: result.session.session_id,
        brand_name: brand.display_name,
        brand_response: result.response,
        identity_shared: shareIdentity ?? false,
        relationship: {
          is_returning: result.relationship.total_sessions > 0,
          total_sessions: result.relationship.total_sessions,
          lead_status: result.relationship.lead_status,
        },
        message: `Connected to ${brand.display_name}'s SI agent. The conversation is now active.`,
      });
    } catch (error) {
      logger.error({ error }, "SI Host: Error connecting to agent");
      return JSON.stringify({
        success: false,
        error: "Failed to connect to the brand agent. Please try again.",
      });
    }
  });

  /**
   * Send message to active SI session
   */
  handlers.set("send_to_si_agent", async (args: Record<string, unknown>) => {
    try {
      const message = args.message as string | undefined;
      const actionResponse = args.action_response as
        | { action: string; element_id?: string; payload?: Record<string, unknown> }
        | undefined;

      if (!message && !actionResponse) {
        return JSON.stringify({
          success: false,
          error: "Either message or action_response must be provided",
        });
      }

      const threadId = getThreadExternalId();
      const sessionId = getCachedSession(threadId);

      if (!sessionId) {
        return JSON.stringify({
          success: false,
          error:
            "No active SI session. Use connect_to_si_agent to start a conversation.",
        });
      }

      const session = await siDb.getSession(sessionId);

      if (!session || session.status !== "active") {
        removeCachedSession(threadId);
        return JSON.stringify({
          success: false,
          error:
            "No active SI session. Use connect_to_si_agent to start a conversation.",
        });
      }

      // Check for session timeout
      const timeSinceLastActivity =
        Date.now() - session.last_activity_at.getTime();
      if (timeSinceLastActivity > SESSION_TIMEOUT_MS) {
        await siDb.updateSessionStatus(sessionId, "timeout", "session_timeout");
        removeCachedSession(threadId);
        return JSON.stringify({
          success: false,
          error: `Session with ${session.brand_name} timed out. Use connect_to_si_agent to start a new conversation.`,
        });
      }

      // Check if brand has custom endpoint
      // TODO: Call custom endpoint if available
      // For now, use the default agent service

      // Send message through the SI agent service
      const response = await siAgentService.sendMessage({
        sessionId,
        message,
        actionResponse,
      });

      // Check if session ended
      if (response.session_status !== "active") {
        removeCachedSession(threadId);
      }

      return JSON.stringify({
        success: true,
        session_id: sessionId,
        brand_name: session.brand_name,
        brand_response: response,
        session_status: response.session_status,
        handoff: response.handoff,
      });
    } catch (error) {
      logger.error({ error }, "SI Host: Error sending message");
      return JSON.stringify({
        success: false,
        error: "Failed to send message to the brand agent. Please try again.",
      });
    }
  });

  /**
   * End SI session
   */
  handlers.set("end_si_session", async (args: Record<string, unknown>) => {
    try {
      const reason = (args.reason as string) || "user_exit";
      const threadId = getThreadExternalId();
      const sessionId = getCachedSession(threadId);

      if (!sessionId) {
        return JSON.stringify({
          success: false,
          error: "No active SI session to end.",
        });
      }

      const session = await siDb.getSession(sessionId);
      if (!session) {
        removeCachedSession(threadId);
        return JSON.stringify({
          success: false,
          error: "No active SI session to end.",
        });
      }

      // Terminate the session
      const result = await siAgentService.terminateSession(sessionId, reason);

      // Clear thread mapping
      removeCachedSession(threadId);

      return JSON.stringify({
        success: true,
        terminated: result.terminated,
        session_id: sessionId,
        brand_name: session.brand_name,
        reason,
        message: `Ended conversation with ${session.brand_name}. You're back to normal Addy mode.`,
        follow_up: result.follow_up,
      });
    } catch (error) {
      logger.error({ error }, "SI Host: Error ending session");
      return JSON.stringify({
        success: false,
        error: "Failed to end the session. Please try again.",
      });
    }
  });

  /**
   * Get current session status
   */
  handlers.set(
    "get_si_session_status",
    async (_args: Record<string, unknown>) => {
      try {
        const threadId = getThreadExternalId();
        const sessionId = getCachedSession(threadId);

        if (!sessionId) {
          return JSON.stringify({
            has_active_session: false,
            message: "No active SI session.",
          });
        }

        const session = await siDb.getSession(sessionId);

        if (!session) {
          removeCachedSession(threadId);
          return JSON.stringify({
            has_active_session: false,
            message: "No active SI session.",
          });
        }

        // Check for timeout
        const timeSinceLastActivity =
          Date.now() - session.last_activity_at.getTime();
        if (timeSinceLastActivity > SESSION_TIMEOUT_MS) {
          await siDb.updateSessionStatus(sessionId, "timeout", "session_timeout");
          removeCachedSession(threadId);
          return JSON.stringify({
            has_active_session: false,
            message: `Previous session with ${session.brand_name} has timed out.`,
          });
        }

        if (session.status !== "active") {
          removeCachedSession(threadId);
          return JSON.stringify({
            has_active_session: false,
            message: `Session with ${session.brand_name} is ${session.status}.`,
          });
        }

        return JSON.stringify({
          has_active_session: true,
          session_id: session.session_id,
          brand_name: session.brand_name,
          status: session.status,
          started_at: session.created_at.toISOString(),
          last_activity: session.last_activity_at.toISOString(),
          message_count: session.message_count,
          handoff: session.handoff_data,
        });
      } catch (error) {
        logger.error({ error }, "SI Host: Error getting session status");
        return JSON.stringify({
          has_active_session: false,
          error: "Failed to get session status.",
        });
      }
    }
  );

  return handlers;
}
