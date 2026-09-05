import type { ToolHandler } from './model-providers/tool-orchestration.js';
import { mergeAddieToolDefinitions } from './tool-wire-shape.js';
import type { AddieTool } from './types.js';

/** Neutral request-local custom-tool inputs assembled by a caller. */
export interface AddieRequestTools {
  tools: readonly AddieTool[];
  handlers: ReadonlyMap<string, ToolHandler>;
}

/** Structural source for the definition allowlist; its value is intentionally read during assembly. */
export interface AddieRequestToolDefinitionOptions {
  readonly allowedToolNames?: readonly string[];
}

/**
 * Combine globally registered and request-local custom-tool data for one
 * model request. This is data assembly only: it neither invokes handlers nor
 * establishes that a caller or its inputs are trusted.
 *
 * Definition inputs are read before the definition allowlist, followed by
 * request-local handlers. This preserves the client boundary's observable
 * access order without accepting an executable callback.
 */
export function assembleAddieRequestTools(
  globalTools: readonly AddieTool[],
  globalHandlers: ReadonlyMap<string, ToolHandler>,
  requestTools?: AddieRequestTools,
  definitionOptions?: AddieRequestToolDefinitionOptions,
  handlerAllowedToolNames?: ReadonlySet<string> | null,
): { tools: AddieTool[]; handlers: Map<string, ToolHandler> } {
  const requestToolDefinitions = requestTools?.tools;
  return {
    tools: mergeAddieToolDefinitions(
      globalTools,
      requestToolDefinitions,
      definitionOptions?.allowedToolNames,
    ),
    handlers: new Map(
      [...globalHandlers, ...(requestTools?.handlers || [])]
        .filter(([name]) => !handlerAllowedToolNames || handlerAllowedToolNames.has(name)),
    ),
  };
}
