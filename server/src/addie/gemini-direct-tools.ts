import type { RequestTools } from './claude-client.js';
import type { ToolExecutionPolicy } from './model-providers/tool-orchestration.js';
import { TOOL_SETS } from './tool-sets.js';
import { isSideEffectTool } from './side-effect-claims.js';
import { ADMIN_ANALYTICS_TOOL_NAME } from './mcp/admin-analytics.js';

/** Pilot capability boundary. Domain membership alone never grants access. */
export const GEMINI_DIRECT_GROUPS = [
  'knowledge', 'schema_reference', 'industry_research',
  'community_discussions', 'community_group_discovery', 'agent_publisher_directory',
] as const;

export interface DirectToolSession {
  visibleToolNames(): ReadonlySet<string>;
  selectedToolSetNames(): string[];
  handoffRequested(): boolean;
}

export function createGeminiDirectTools(requestTools: RequestTools, globalToolNames: readonly string[], isAdmin = false) {
  const globals = new Set(globalToolNames);
  const registered = new Set(requestTools.tools
    .filter(tool => requestTools.handlers.has(tool.name))
    .map(tool => tool.name));
  const groups = GEMINI_DIRECT_GROUPS.map(name => ({
    ...TOOL_SETS[name],
    tools: TOOL_SETS[name].tools.filter(tool => !isSideEffectTool(tool)
      && (registered.has(tool) || globals.has(tool))),
  })).filter(group => group.tools.length > 0);
  // Admin access requires both the trusted role and this request's definition
  // and handler. Global registration must never grant administrative access.
  if (isAdmin && registered.has(ADMIN_ANALYTICS_TOOL_NAME)) {
    groups.push({
      ...TOOL_SETS.admin_conversation_review,
      description: 'Read-only administrative analytics: live membership and platform totals, search performance, and engagement rankings.',
      tools: [ADMIN_ANALYTICS_TOOL_NAME],
    });
  }
  const persistentGroups = new Set(['knowledge', 'schema_reference', 'admin_conversation_review']);
  const allowed = new Set(groups.flatMap(group => group.tools));
  const visible = new Set(groups.filter(group => persistentGroups.has(group.name))
    .flatMap(group => group.tools));
  let handoff = false;
  const loadName = 'load_tool_group';
  const handoffName = 'handoff_to_addie';
  for (const name of [loadName, handoffName]) {
    allowed.add(name);
    visible.add(name);
  }
  const handlers = new Map(requestTools.handlers);
  handlers.set(loadName, async ({ group }) => {
    const selected = groups.find(candidate => candidate.name === group);
    if (!selected) return 'Error: Tool group is unavailable.';
    // Replace the optional domain to keep the active catalog bounded. Core
    // documentation/schema and authorized analytics stay available throughout.
    for (const candidate of groups) {
      if (!persistentGroups.has(candidate.name)) {
        for (const name of candidate.tools) visible.delete(name);
      }
    }
    for (const name of selected.tools) visible.add(name);
    return JSON.stringify({ available_tools: [...visible] });
  });
  handlers.set(handoffName, async () => {
    handoff = true;
    return 'The application will continue this request with the full Addie workflow.';
  });
  const tools: RequestTools = {
    tools: [
      ...requestTools.tools.filter(tool => allowed.has(tool.name)),
      {
        name: loadName,
        description: `Load another authorized read-only tool group for your next step. ${groups
          .map(group => `${group.name}: ${group.description}`).join('; ')}`,
        input_schema: {
          type: 'object', properties: { group: { type: 'string', enum: groups.map(group => group.name) } },
          required: ['group'], additionalProperties: false,
        },
      },
      {
        name: handoffName,
        description: 'Continue through the full Addie workflow when the request needs account changes, payments, messages, certification, administrative actions, or any capability outside the available read-only groups. Call this instead of claiming an action was done or asking the user to repeat their request.',
        input_schema: { type: 'object', properties: {}, additionalProperties: false },
      },
    ],
    handlers,
  };
  const session: DirectToolSession = {
    visibleToolNames: () => new Set(visible),
    selectedToolSetNames: () => groups.filter(group => group.tools.some(name => visible.has(name))).map(group => group.name),
    handoffRequested: () => handoff,
  };
  const policy: ToolExecutionPolicy = ({ toolName }) => ({
    allowed: allowed.has(toolName) && visible.has(toolName) && !isSideEffectTool(toolName),
  });
  return { tools, session, policy, allowedToolNames: [...allowed], selectedToolSets: groups.map(group => group.name) };
}
