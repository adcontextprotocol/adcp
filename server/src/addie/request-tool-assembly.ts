import type { ToolHandler } from './model-providers/tool-orchestration.js';
import { mergeAddieToolDefinitions } from './tool-wire-shape.js';
import type { AddieTool } from './types.js';

/** Neutral request-local custom-tool inputs assembled by a caller. */
export interface AddieRequestTools {
  tools: readonly AddieTool[];
  handlers: ReadonlyMap<string, ToolHandler>;
}

/**
 * Combine globally registered and request-local custom-tool data for one
 * model request. This is data assembly only: it neither invokes handlers nor
 * establishes that a caller or its inputs are trusted.
 */
export function assembleAddieRequestTools(
  globalTools: readonly AddieTool[],
  globalHandlers: ReadonlyMap<string, ToolHandler>,
  requestTools?: AddieRequestTools,
  allowedToolNames?: readonly string[],
): { tools: AddieTool[]; handlers: Map<string, ToolHandler> } {
  const allowed = allowedToolNames ? new Set(allowedToolNames) : null;
  return {
    tools: mergeAddieToolDefinitions(
      globalTools,
      requestTools?.tools,
      allowedToolNames,
    ),
    handlers: new Map(
      [...globalHandlers, ...(requestTools?.handlers || [])]
        .filter(([name]) => !allowed || allowed.has(name)),
    ),
  };
}
