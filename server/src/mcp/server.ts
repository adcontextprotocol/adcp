/**
 * Unified MCP Server for Addie
 *
 * Public MCP interface exposing:
 * - chat_with_addie: Conversational AI (wraps knowledge + directory tools internally)
 * - Directory tools: Programmatic lookup (list_members, list_agents, etc.)
 * - Evaluation tools: Agent testing (probe, compliance, RFP response, IO execution)
 * - Agent context tools: Save/list/remove agent credentials
 * - Validation tools: Schema validation and adagents.json checking
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
import { ToolError } from '../addie/tool-error.js';
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

// Exposed tools - internal tools promoted to first-class MCP tools
import {
  ALL_EXPOSED_TOOL_DEFINITIONS,
  EVAL_TOOL_DEFINITIONS,
  AGENT_CONTEXT_TOOL_DEFINITIONS,
  createMemberToolHandler,
  createStatelessToolHandlers,
} from './exposed-tools.js';

const logger = createLogger('mcp-server');
const MAX_REPORTED_UNSUPPORTED_ARGUMENTS = 20;
const MAX_REPORTED_ARGUMENT_NAME_LENGTH = 80;

interface StrictToolArguments {
  allowed: Set<string>;
  supported: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Build opt-in top-level argument allowlists from advertised tool schemas.
 * JSON Schema permits additional properties by default, so only an explicit
 * `additionalProperties: false` makes a tool strict.
 */
function buildStrictToolArguments(
  tools: ReadonlyArray<{ name: string; inputSchema: unknown }>,
): Map<string, StrictToolArguments> {
  const result = new Map<string, StrictToolArguments>();

  for (const tool of tools) {
    if (!isRecord(tool.inputSchema) || tool.inputSchema.additionalProperties !== false) continue;

    const properties = isRecord(tool.inputSchema.properties)
      ? tool.inputSchema.properties
      : {};
    const supported = Object.keys(properties).sort();
    result.set(tool.name, { allowed: new Set(supported), supported });
  }

  return result;
}

/**
 * Argument names are caller-controlled. Keep diagnostics identifier-like and
 * bounded so a malformed key cannot inject markup or amplify the response.
 */
function sanitizeArgumentName(name: string): string {
  let result = '';
  let length = 0;
  let truncated = false;

  for (const character of name) {
    if (length >= MAX_REPORTED_ARGUMENT_NAME_LENGTH) {
      truncated = true;
      break;
    }

    const codePoint = character.codePointAt(0) ?? 0;
    const isAsciiLetter = (codePoint >= 65 && codePoint <= 90)
      || (codePoint >= 97 && codePoint <= 122);
    const isDigit = codePoint >= 48 && codePoint <= 57;
    const isSafePunctuation = character === '_' || character === '.' || character === '-';
    result += isAsciiLetter || isDigit || isSafePunctuation ? character : '?';
    length++;
  }

  return truncated ? `${result}…` : result;
}

/** Keep only the lexicographically first reportable names in sorted order. */
function retainUnsupportedArgument(reported: string[], argumentName: string): void {
  let low = 0;
  let high = reported.length;

  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (reported[middle] < argumentName) low = middle + 1;
    else high = middle;
  }

  if (low >= MAX_REPORTED_UNSUPPORTED_ARGUMENTS) return;
  reported.splice(low, 0, argumentName);
  if (reported.length > MAX_REPORTED_UNSUPPORTED_ARGUMENTS) reported.pop();
}

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
 * Exposes:
 * - chat_with_addie: Conversational wrapper (uses knowledge + directory tools internally)
 * - Directory tools: Programmatic member/agent/publisher lookup
 * - Evaluation tools: Agent testing (probe, compliance, RFP, IO execution)
 * - Agent context tools: Save/list/remove agent credentials
 * - Validation tools: Schema validation and adagents.json checking
 *
 * Knowledge and billing tools are NOT exposed - use chat_with_addie instead.
 */
export function getAllTools() {
  const chatTool = convertToMCPTool(CHAT_TOOL);
  const directoryTools = TOOL_DEFINITIONS;
  const exposedTools = ALL_EXPOSED_TOOL_DEFINITIONS;

  return {
    directory: directoryTools,
    exposed: exposedTools,
    chat: chatTool,
    all: [chatTool, ...directoryTools, ...exposedTools],
  };
}

/**
 * Create all tool handlers
 *
 * Creates handlers for publicly exposed tools:
 * - chat_with_addie
 * - Directory tools (list_members, list_agents, etc.)
 * - Evaluation tools (probe, compliance, RFP, IO execution)
 * - Agent context tools (save_agent, list_saved_agents, remove_saved_agent)
 * - Validation tools (validate_json, get_schema, validate_adagents)
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
    handlers.set(name, async (args, auth) => {
      const result = await handler(args, auth);
      return { content: [{ type: 'text', text: result }] };
    });
  }

  // Member tools (eval + agent context) — need per-request auth bridging
  const memberToolDefs = [...EVAL_TOOL_DEFINITIONS, ...AGENT_CONTEXT_TOOL_DEFINITIONS];
  for (const tool of memberToolDefs) {
    handlers.set(tool.name, createMemberToolHandler(tool.name));
  }

  // Stateless tools (schema + property validation) — created once
  const statelessHandlers = createStatelessToolHandlers();
  for (const [name, handler] of statelessHandlers) {
    handlers.set(name, async (args) => handler(args));
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
 * - Evaluation tools: Agent testing and compliance checking
 * - Agent context tools: Credential management for agent testing
 * - Validation tools: Schema and adagents.json validation
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
  const strictToolArguments = buildStrictToolArguments(tools.all);

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

    const normalizedArgs = args ?? {};
    const strictArguments = strictToolArguments.get(name);
    if (strictArguments) {
      let unsupportedArgumentCount = 0;
      const unsupportedArguments: string[] = [];
      for (const argumentName in normalizedArgs) {
        if (!Object.prototype.hasOwnProperty.call(normalizedArgs, argumentName)) continue;
        if (strictArguments.allowed.has(argumentName)) continue;

        unsupportedArgumentCount++;
        retainUnsupportedArgument(unsupportedArguments, argumentName);
      }

      if (unsupportedArgumentCount > 0) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'Unsupported tool arguments',
              tool: name,
              unsupported_argument_count: unsupportedArgumentCount,
              unsupported_arguments: unsupportedArguments.map(sanitizeArgumentName),
              supported_arguments: strictArguments.supported,
            }),
          }],
          isError: true,
        };
      }
    }

    try {
      const result = await handler(normalizedArgs, authContext);
      return result as {
        content: Array<{ type: string; text?: string; resource?: { uri: string; mimeType: string; text: string } }>;
        isError?: boolean;
      };
    } catch (error) {
      if (error instanceof ToolError) {
        logger.warn({ error: error.message, tool: name }, 'MCP: Tool returned expected error');
      } else {
        logger.error({ error, tool: name }, 'MCP: Tool execution error');
      }
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
