import type { RequestTools } from './claude-client.js';
import type { ToolExecutionPolicy } from './model-providers/tool-orchestration.js';
import { ALWAYS_AVAILABLE_ADMIN_TOOLS, getToolsForSets, getValidToolSetNames, TOOL_SETS } from './tool-sets.js';
import { selectRoutedToolSets, type ActiveCertificationKind, type SponsoredIntelligenceContextKind } from './slack-tool-selection.js';
import { ADMIN_ANALYTICS_TOOL_NAME } from './mcp/admin-analytics.js';

export interface DirectToolSession {
  visibleToolNames(): ReadonlySet<string>;
  selectedToolSetNames(): string[];
}

export interface DirectToolContext {
  activeCertificationKind?: ActiveCertificationKind | null;
  sponsoredIntelligenceContextKind?: SponsoredIntelligenceContextKind | null;
}

/** Discover the same custom-tool domains as routed chat, using existing request authority. */
export function createGeminiDirectTools(
  requestTools: RequestTools, globalToolNames: readonly string[], isAdmin = false, context: DirectToolContext = {},
) {
  const globals = new Set(globalToolNames);
  const registered = new Set(requestTools.tools
    .filter(tool => requestTools.handlers.has(tool.name))
    .map(tool => tool.name));
  const available = (name: string, adminOnly = false) => adminOnly
    ? isAdmin && registered.has(name)
    : registered.has(name) || globals.has(name);
  const requiredGroups = selectRoutedToolSets({
    source: 'dm', isAdmin, routerAvailable: true, routerSelectedSets: ['knowledge', 'schema_reference'], ...context,
  });
  // Active teaching uses the same trusted workflow restriction as Sonnet.
  const groupNames = context.activeCertificationKind
    ? new Set(requiredGroups)
    : getValidToolSetNames(isAdmin);
  const groups = [...groupNames].map(name => ({
    ...TOOL_SETS[name],
    tools: TOOL_SETS[name].tools.filter(tool => available(tool, TOOL_SETS[name].adminOnly)),
  })).filter(group => group.tools.length > 0);
  const persistentGroups = new Set(requiredGroups);
  const baseline = getToolsForSets([], isAdmin).filter(name => available(name,
    (ALWAYS_AVAILABLE_ADMIN_TOOLS as readonly string[]).includes(name)));
  const allowed = new Set([...baseline, ...groups.flatMap(group => group.tools)]);
  const persistent = new Set([...baseline, ...groups.filter(group => persistentGroups.has(group.name)).flatMap(group => group.tools)]);
  if (allowed.has(ADMIN_ANALYTICS_TOOL_NAME)) persistent.add(ADMIN_ANALYTICS_TOOL_NAME);
  const visible = new Set(persistent);
  const loadName = 'load_tool_group';
  allowed.add(loadName);
  persistent.add(loadName);
  visible.add(loadName);
  const handlers = new Map([...requestTools.handlers].filter(([name]) => allowed.has(name)));
  handlers.set(loadName, async ({ group }) => {
    const selected = groups.find(candidate => candidate.name === group);
    if (!selected) return 'Error: Tool group is unavailable.';
    // Replace the optional domain; docs, baseline tools and trusted active
    // workflows remain available. Loading a group never grants permissions.
    for (const name of visible) if (!persistent.has(name)) visible.delete(name);
    for (const name of selected.tools) visible.add(name);
    return JSON.stringify({ available_tools: [...visible] });
  });
  const tools: RequestTools = {
    tools: [
      ...requestTools.tools.filter(tool => allowed.has(tool.name)),
      {
        name: loadName,
        description: `Load an authorized tool group for your next step. Account, action-confirmation and audit checks still apply. ${groups
          .map(group => `${group.name}: ${group.description}`).join('; ')}`,
        input_schema: {
          type: 'object', properties: { group: { type: 'string', enum: groups.map(group => group.name) } },
          required: ['group'], additionalProperties: false,
        },
      },
    ],
    handlers,
  };
  const session: DirectToolSession = {
    visibleToolNames: () => new Set(visible),
    selectedToolSetNames: () => groups.filter(group => group.tools.some(name => visible.has(name))).map(group => group.name),
  };
  const policy: ToolExecutionPolicy = ({ toolName }) => ({ allowed: allowed.has(toolName) && visible.has(toolName) });
  return { tools, session, policy, allowedToolNames: [...allowed], selectedToolSets: session.selectedToolSetNames() };
}
