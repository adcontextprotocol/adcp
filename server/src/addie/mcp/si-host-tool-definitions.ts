// SI_HOST_TOOLS: the tool definitions of si-host-tools.ts, moved here verbatim so that
// readers of the catalog (the router, tool sets, eval harnesses) do not load
// the handlers and their service, database and SDK dependencies.
import type { AddieTool } from '../types.js';

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
