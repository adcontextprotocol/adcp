/**
 * Unified MCP Server for Addie
 *
 * Public MCP interface exposing:
 * - chat_with_addie: Conversational AI (wraps knowledge + directory tools internally)
 * - Directory tools: Programmatic lookup (list_members, list_agents, etc.)
 *
 * Knowledge and billing tools are NOT exposed directly - they're available
 * through chat_with_addie for conversational access, or internal Slack use only.
 *
 * This is the public MCP interface for:
 * - External partners embedding Addie in their apps
 * - End users adding Addie to Claude/ChatGPT (OAuth 2.1 auth code flow)
 *
 * Authentication is handled by WorkOS AuthKit (optional - anonymous allowed).
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createLogger } from '../logger.js';
import type { AddieTool } from '../addie/types.js';
import type { MCPAuthContext } from './auth.js';

// Knowledge tools (for initialization check only - not exposed directly)
import {
  initializeKnowledgeSearch,
  isKnowledgeReady,
} from '../addie/mcp/knowledge-search.js';

// Directory tools
import { MCPToolHandler, TOOL_DEFINITIONS, RESOURCE_DEFINITIONS } from '../mcp-tools.js';

// Chat tool - conversational AI wrapper (has knowledge + directory tools internally)
import { CHAT_TOOL, createChatToolHandler } from './chat-tool.js';

const logger = createLogger('mcp-server');

/**
 * Convert AddieTool format to MCP SDK tool format
 */
function convertToMCPTool(tool: AddieTool) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.input_schema,
  };
}

/**
 * All tools available in the unified MCP server
 *
 * Only exposes:
 * - chat_with_addie: Conversational wrapper (uses knowledge + directory tools internally)
 * - Directory tools: Programmatic member/agent/publisher lookup
 *
 * Knowledge and billing tools are NOT exposed - use chat_with_addie instead.
 */
export function getAllTools() {
  const chatTool = convertToMCPTool(CHAT_TOOL);

  // Directory tools are already in MCP format
  const directoryTools = TOOL_DEFINITIONS;

  return {
    directory: directoryTools,
    chat: chatTool,
    all: [chatTool, ...directoryTools],
  };
}

/**
 * Create all tool handlers
 *
 * Only creates handlers for publicly exposed tools:
 * - chat_with_addie
 * - Directory tools (list_members, list_agents, etc.)
 */
function createAllHandlers() {
  const handlers = new Map<string, (args: Record<string, unknown>, authContext?: MCPAuthContext) => Promise<unknown>>();

  // Directory tool handlers use the existing MCPToolHandler
  const directoryHandler = new MCPToolHandler();
  for (const tool of TOOL_DEFINITIONS) {
    handlers.set(tool.name, async (args, auth) => {
      return directoryHandler.handleToolCall(tool.name, args, auth);
    });
  }

  // Chat tool handler (conversational AI wrapper)
  const chatHandlers = createChatToolHandler();
  for (const [name, handler] of chatHandlers) {
    handlers.set(name, async (args) => {
      const result = await handler(args);
      return { content: [{ type: 'text', text: result }] };
    });
  }

  return { handlers, directoryHandler };
}

/**
 * MCP Server instance with lazy initialization
 */
let serverInstance: {
  handlers: Map<string, (args: Record<string, unknown>, authContext?: MCPAuthContext) => Promise<unknown>>;
  directoryHandler: MCPToolHandler;
} | null = null;

function getHandlers() {
  if (!serverInstance) {
    serverInstance = createAllHandlers();
  }
  return serverInstance;
}

/**
 * Create and configure the unified MCP Server
 *
 * This server exposes Addie capabilities via MCP:
 * - chat_with_addie: Conversational AI with knowledge + directory access
 * - Directory tools: Programmatic lookup of members, agents, publishers
 */
export function createUnifiedMCPServer(authContext?: MCPAuthContext): Server {
  const server = new Server(
    {
      name: 'addie',
      version: '1.0.0',
    },
    {
      capabilities: {
        resources: {},
        tools: {},
      },
    }
  );

  const tools = getAllTools();
  const { handlers, directoryHandler } = getHandlers();

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    logger.debug({ toolCount: tools.all.length }, 'MCP: Listing tools');
    return { tools: tools.all };
  });

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    logger.debug({ tool: name }, 'MCP: Tool call');

    const handler = handlers.get(name);
    if (!handler) {
      logger.warn({ tool: name }, 'MCP: Unknown tool');
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
        isError: true,
      };
    }

    try {
      const result = await handler(args as Record<string, unknown> || {}, authContext);
      return result as {
        content: Array<{ type: string; text?: string; resource?: { uri: string; mimeType: string; text: string } }>;
        isError?: boolean;
      };
    } catch (error) {
      logger.error({ error, tool: name }, 'MCP: Tool execution error');
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }) }],
        isError: true,
      };
    }
  });

  // List available resources (from directory)
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return { resources: RESOURCE_DEFINITIONS };
  });

  // Read resource contents (from directory)
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    return directoryHandler.handleResourceRead(request.params.uri);
  });

  return server;
}

/**
 * Initialize the MCP server (call at startup)
 *
 * Note: Knowledge search is shared with Addie and initialized when Addie starts.
 * This just pre-creates handlers and verifies readiness.
 */
export async function initializeMCPServer(): Promise<void> {
  logger.info('MCP: Initializing unified server...');

  // Initialize knowledge search if not already done (e.g., in tests or standalone mode)
  if (!isKnowledgeReady()) {
    await initializeKnowledgeSearch();
  }

  // Pre-create handlers
  getHandlers();

  logger.info({ ready: isKnowledgeReady() }, 'MCP: Unified server ready');
}

/**
 * Check if MCP server is ready
 */
export function isMCPServerReady(): boolean {
  return isKnowledgeReady();
}
