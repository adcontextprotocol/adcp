/**
 * Exposed MCP Tools
 *
 * Internal Addie tools promoted to first-class MCP tools on the /mcp endpoint,
 * callable directly by external MCP clients (Claude Code, Claude Desktop, etc.).
 *
 * Three categories:
 * 1. Evaluation — agent testing and compliance (requires auth)
 * 2. Agent context — save/list/remove agent credentials (requires auth)
 * 3. Validation — schema and adagents.json validation (stateless, no auth)
 */

import { createLogger } from '../logger.js';
import { MEMBER_TOOLS, createMemberToolHandlers } from '../addie/mcp/member-tools.js';
import { SCHEMA_TOOLS, createSchemaToolHandlers } from '../addie/mcp/schema-tools.js';
import { PROPERTY_TOOLS, createPropertyToolHandlers } from '../addie/mcp/property-tools.js';
import type { MemberContext } from '../addie/member-context.js';
import type { MCPAuthContext } from './auth.js';

const logger = createLogger('mcp-exposed-tools');

// ── Tool name sets ──────────────────────────────────────────────────

/** Agent evaluation tools (require auth for saved-agent credential lookup). */
const EVAL_TOOL_NAMES = [
  'get_agent_status',
  'evaluate_agent_quality',
  'test_rfp_response',
  'test_io_execution',
] as const;

/** Agent context management tools (require auth). */
const AGENT_CONTEXT_TOOL_NAMES = [
  'save_agent',
  'list_saved_agents',
  'remove_saved_agent',
] as const;

/** Schema validation tools (stateless, no auth required). */
const SCHEMA_TOOL_NAMES = [
  'validate_json',
  'get_schema',
] as const;

/** Property validation tools (stateless, no auth required). */
const PROPERTY_TOOL_NAMES = [
  'validate_adagents',
] as const;

// ── Startup validation ──────────────────────────────────────────────
// Fail at import time if any exposed tool name was renamed or removed upstream.

const memberToolNames = new Set(MEMBER_TOOLS.map((t) => t.name));
for (const name of [...EVAL_TOOL_NAMES, ...AGENT_CONTEXT_TOOL_NAMES]) {
  if (!memberToolNames.has(name)) {
    throw new Error(`Exposed tool "${name}" not found in MEMBER_TOOLS — was it renamed or removed?`);
  }
}

const schemaToolNames = new Set(SCHEMA_TOOLS.map((t) => t.name));
for (const name of SCHEMA_TOOL_NAMES) {
  if (!schemaToolNames.has(name)) {
    throw new Error(`Exposed tool "${name}" not found in SCHEMA_TOOLS — was it renamed or removed?`);
  }
}

const propertyToolNames = new Set(PROPERTY_TOOLS.map((t) => t.name));
for (const name of PROPERTY_TOOL_NAMES) {
  if (!propertyToolNames.has(name)) {
    throw new Error(`Exposed tool "${name}" not found in PROPERTY_TOOLS — was it renamed or removed?`);
  }
}

// ── Tool definitions (MCP format) ───────────────────────────────────

// usage_hints are intentionally excluded — they're for Addie's internal router,
// not for external MCP clients.
function toMCPFormat(tool: { name: string; description: string; input_schema: object }) {
  return { name: tool.name, description: tool.description, inputSchema: tool.input_schema };
}

/** Evaluation tool definitions in MCP format. */
export const EVAL_TOOL_DEFINITIONS = MEMBER_TOOLS
  .filter((t) => (EVAL_TOOL_NAMES as readonly string[]).includes(t.name))
  .map(toMCPFormat);

/** Agent context tool definitions in MCP format. */
export const AGENT_CONTEXT_TOOL_DEFINITIONS = MEMBER_TOOLS
  .filter((t) => (AGENT_CONTEXT_TOOL_NAMES as readonly string[]).includes(t.name))
  .map(toMCPFormat);

/** Schema validation tool definitions in MCP format. */
export const SCHEMA_TOOL_DEFINITIONS = SCHEMA_TOOLS
  .filter((t) => (SCHEMA_TOOL_NAMES as readonly string[]).includes(t.name))
  .map(toMCPFormat);

/** Property validation tool definitions in MCP format. */
export const PROPERTY_TOOL_DEFINITIONS = PROPERTY_TOOLS
  .filter((t) => (PROPERTY_TOOL_NAMES as readonly string[]).includes(t.name))
  .map(toMCPFormat);

/** All exposed tool definitions combined. */
export const ALL_EXPOSED_TOOL_DEFINITIONS = [
  ...EVAL_TOOL_DEFINITIONS,
  ...AGENT_CONTEXT_TOOL_DEFINITIONS,
  ...SCHEMA_TOOL_DEFINITIONS,
  ...PROPERTY_TOOL_DEFINITIONS,
];

// ── Auth bridging ───────────────────────────────────────────────────

/**
 * Build a minimal MemberContext from MCP auth claims.
 *
 * Identity is verified via OAuth JWT, but membership/subscription status
 * is not resolved from the database. Tools gate on orgId presence for
 * credential lookup rather than membership status.
 */
function mcpAuthToMemberContext(auth: MCPAuthContext): MemberContext {
  return {
    is_mapped: true,
    is_member: false,
    workos_user: {
      workos_user_id: auth.sub,
      email: auth.email || '',
    },
    organization: auth.orgId
      ? {
          workos_organization_id: auth.orgId,
          name: '',
          subscription_status: null,
          is_personal: false,
        }
      : undefined,
  } as MemberContext;
}

// ── Handler factories ───────────────────────────────────────────────

/**
 * Create a handler for a member tool (eval or agent context) that bridges
 * MCPAuthContext to MemberContext. Requires authentication — anonymous
 * callers receive an error with isError: true.
 */
export function createMemberToolHandler(toolName: string) {
  return async (
    args: Record<string, unknown>,
    authContext?: MCPAuthContext,
  ): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> => {
    if (!authContext || authContext.sub === 'anonymous') {
      return {
        content: [{ type: 'text', text: 'Authentication required. Connect with OAuth to use this tool.' }],
        isError: true,
      };
    }

    const memberContext = mcpAuthToMemberContext(authContext);
    const handlers = createMemberToolHandlers(memberContext);
    const handler = handlers.get(toolName);

    if (!handler) {
      logger.error({ toolName }, 'Member tool handler not found');
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${toolName}` }) }],
        isError: true,
      };
    }

    const result = await handler(args);
    return { content: [{ type: 'text', text: result }] };
  };
}

/**
 * Create handlers for stateless tools (schema and property validation).
 * These are created once at startup since they don't need per-request auth.
 */
export function createStatelessToolHandlers(): Map<
  string,
  (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>
> {
  const result = new Map<
    string,
    (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>
  >();

  const schemaHandlers = createSchemaToolHandlers();
  for (const name of SCHEMA_TOOL_NAMES) {
    const handler = schemaHandlers.get(name);
    if (handler) {
      result.set(name, async (args) => {
        const text = await handler(args);
        return { content: [{ type: 'text', text }] };
      });
    }
  }

  const propertyHandlers = createPropertyToolHandlers();
  for (const name of PROPERTY_TOOL_NAMES) {
    const handler = propertyHandlers.get(name);
    if (handler) {
      result.set(name, async (args) => {
        const text = await handler(args);
        return { content: [{ type: 'text', text }] };
      });
    }
  }

  return result;
}
