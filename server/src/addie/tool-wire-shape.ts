import type { AddieTool } from './types.js';

export interface AddieWireTool {
  name: string;
  description: string;
  input_schema: AddieTool['input_schema'];
  cache_control?: { type: 'ephemeral' };
}

export interface AddieProviderWebSearchTool {
  type: 'web_search_20250305';
  name: 'web_search';
}

/** Resolve the ordered custom-tool definitions used for a request. */
export function mergeAddieToolDefinitions(
  globalTools: readonly AddieTool[],
  requestTools: readonly AddieTool[] = [],
  allowedToolNames?: readonly string[],
): AddieTool[] {
  const allowed = allowedToolNames ? new Set(allowedToolNames) : null;
  return [...new Map(
    [...globalTools, ...requestTools].map((tool) => [tool.name, tool]),
  ).values()].filter((tool) => !allowed || allowed.has(tool.name));
}

/** Project definitions to the exact Anthropic custom-tool wire shape. */
export function buildAddieWireTools(tools: readonly AddieTool[]): AddieWireTool[] {
  const wireTools: AddieWireTool[] = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema,
  }));
  if (wireTools.length > 0) {
    wireTools[wireTools.length - 1] = {
      ...wireTools[wireTools.length - 1],
      cache_control: { type: 'ephemeral' },
    };
  }
  return wireTools;
}

/** Project request-local provider tools through the same production seam. */
export function buildAddieProviderTools(
  webSearchEnabled: boolean,
): AddieProviderWebSearchTool[] {
  return webSearchEnabled
    ? [{ type: 'web_search_20250305', name: 'web_search' }]
    : [];
}
