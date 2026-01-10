/**
 * Chat with Addie MCP Tool
 *
 * Exposes Addie's conversational AI as a single MCP tool.
 * This allows external partners to embed Addie in their applications
 * without needing to call individual knowledge tools.
 *
 * For anonymous/partner access (safe tools only):
 * - search_docs, get_doc: Public documentation
 * - search_repos: Public GitHub repos (OpenRTB, MCP, A2A specs, etc.)
 * - search_resources, get_recent_news: Curated public content
 * - Directory tools: Public member/agent/publisher info
 *
 * NOT available to anonymous (require Slack membership):
 * - search_slack, get_channel_activity: Internal community discussions
 * - bookmark_resource: Writes to database
 */

import { AddieClaudeClient, type RequestTools } from '../addie/claude-client.js';
import { AddieModelConfig } from '../config/models.js';
import {
  KNOWLEDGE_TOOLS,
  createKnowledgeToolHandlers,
  isKnowledgeReady,
} from '../addie/mcp/knowledge-search.js';
import {
  DIRECTORY_TOOLS,
  createDirectoryToolHandlers,
} from '../addie/mcp/directory-tools.js';
import { createLogger } from '../logger.js';
import type { AddieTool } from '../addie/types.js';

const logger = createLogger('mcp-chat');

/**
 * Knowledge tools safe for anonymous users (no Slack access, no writes)
 * Directory tools are also available to anonymous users (public data)
 * but are registered separately below.
 */
const ANONYMOUS_SAFE_KNOWLEDGE_TOOLS = new Set([
  'search_docs',
  'get_doc',
  'search_repos',
  'search_resources',
  'get_recent_news',
]);

/**
 * Conversation message for history
 */
interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Chat tool input schema
 */
interface ChatInput {
  message: string;
  history?: ConversationMessage[];
}

/**
 * Chat tool response
 */
interface ChatResponse {
  response: string;
  tools_used: string[];
}

/**
 * Lazy-initialized Claude client for chat tool
 * Uses a separate instance from the main Addie handler to avoid state conflicts
 */
let chatClient: AddieClaudeClient | null = null;

function getChatClient(): AddieClaudeClient {
  if (!chatClient) {
    const apiKey = process.env.ADDIE_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('Anthropic API key not configured');
    }

    chatClient = new AddieClaudeClient(apiKey, AddieModelConfig.chat);

    // Register only safe knowledge tools (no Slack, no writes)
    const knowledgeHandlers = createKnowledgeToolHandlers();
    for (const tool of KNOWLEDGE_TOOLS) {
      if (ANONYMOUS_SAFE_KNOWLEDGE_TOOLS.has(tool.name)) {
        const handler = knowledgeHandlers.get(tool.name);
        if (handler) {
          chatClient.registerTool(tool, handler);
        }
      }
    }

    // Register directory tools (public member/agent/publisher lookup - safe for anonymous)
    const directoryHandlers = createDirectoryToolHandlers();
    for (const tool of DIRECTORY_TOOLS) {
      const handler = directoryHandlers.get(tool.name);
      if (handler) {
        chatClient.registerTool(tool, handler);
      }
    }

    logger.info({ tools: chatClient.getRegisteredTools() }, 'MCP Chat: Client initialized');
  }

  return chatClient;
}

/**
 * The chat_with_addie tool definition
 */
export const CHAT_TOOL: AddieTool = {
  name: 'chat_with_addie',
  description: `Chat with Addie, the AgenticAdvertising.org community assistant. Addie is an expert on:
- AdCP (Advertising Context Protocol) - the open standard for AI-powered advertising
- MCP (Model Context Protocol) and A2A (Agent-to-Agent) protocols
- IAB Tech Lab specifications (OpenRTB, VAST, etc.)
- Ad tech industry trends and best practices
- AgenticAdvertising.org member directory, registered agents, and publishers

Addie can search documentation, code repositories, the member directory, and curated industry resources to answer questions.

Use this for conversational questions about ad tech, protocols, member organizations, and the advertising industry.
Include 'history' for multi-turn conversations.`,
  usage_hints: 'Use when the user wants to have a conversation about ad tech topics or needs help understanding protocols.',
  input_schema: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: 'The message to send to Addie',
      },
      history: {
        type: 'array',
        description: 'Optional conversation history for context (most recent last)',
        items: {
          type: 'object',
          properties: {
            role: {
              type: 'string',
              enum: ['user', 'assistant'],
              description: 'Who sent the message',
            },
            content: {
              type: 'string',
              description: 'The message content',
            },
          },
          required: ['role', 'content'],
        },
      },
    },
    required: ['message'],
  },
};

/**
 * Handle the chat_with_addie tool call
 */
export async function handleChatTool(args: Record<string, unknown>): Promise<string> {
  const message = args.message;
  const history = args.history as ConversationMessage[] | undefined;

  if (!message || typeof message !== 'string') {
    return JSON.stringify({
      error: 'message is required and must be a string',
    });
  }

  // Check if knowledge search is ready
  if (!isKnowledgeReady()) {
    return JSON.stringify({
      error: 'Addie is still initializing. Please try again in a moment.',
    });
  }

  try {
    const client = getChatClient();

    // Convert history to thread context format expected by AddieClaudeClient
    const threadContext = history?.map((msg) => ({
      user: msg.role === 'user' ? 'user' : 'assistant',
      text: msg.content,
    }));

    // Process the message
    const response = await client.processMessage(
      message,
      threadContext,
      undefined, // No request-specific tools for anonymous
      undefined, // No rules override
      { maxIterations: 5 } // Lower iteration limit for anonymous users
    );

    const result: ChatResponse = {
      response: response.text,
      tools_used: response.tools_used,
    };

    return JSON.stringify(result);
  } catch (error) {
    logger.error({ error }, 'MCP Chat: Error processing message');
    return JSON.stringify({
      error: error instanceof Error ? error.message : 'Failed to process message',
    });
  }
}

/**
 * Create the chat tool handler map
 */
export function createChatToolHandler(): Map<string, (args: Record<string, unknown>) => Promise<string>> {
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<string>>();
  handlers.set(CHAT_TOOL.name, handleChatTool);
  return handlers;
}
