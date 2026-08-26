import { isDeepStrictEqual } from 'node:util';
import type { JsonObject, ModelToolDefinition } from '../model-providers/model-provider.js';
import type {
  ReadOnlyModelTool,
  ReadOnlyToolAuthorizationInput,
} from '../model-providers/read-only-tool-loop.js';
import {
  KNOWLEDGE_TOOLS,
  createKnowledgeToolHandlers,
} from '../mcp/knowledge-search.js';
import { OFFICIAL_DOCS_ALLOWED_TOOLS } from './shadow-replay-cohort.js';

type KnowledgeHandlerFactory = typeof createKnowledgeToolHandlers;

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

/**
 * Resolve the exact canonical official-doc definitions and telemetry-free local
 * handlers used by provider compatibility runs. Missing or reclassified tools
 * fail closed before a provider request is prepared.
 */
export function createOfficialDocsReadOnlyToolBoundary(
  createHandlers: KnowledgeHandlerFactory = createKnowledgeToolHandlers,
): Readonly<{
  tools: ReadonlyArray<ReadOnlyModelTool>;
  authorizeToolExecution(input: Readonly<ReadOnlyToolAuthorizationInput>): { allowed: true } | { allowed: false };
}> {
  const definitions = new Map(KNOWLEDGE_TOOLS.map((tool) => [tool.name, tool]));
  const handlers = createHandlers({ disableSearchTelemetry: true });
  const tools = Object.freeze(OFFICIAL_DOCS_ALLOWED_TOOLS.map((name) => {
    const tool = definitions.get(name);
    const handler = handlers.get(name);
    if (!tool || tool.replaySafety !== 'pure_local' || !handler) {
      throw new Error('official_docs_read_only_tool_boundary_unavailable');
    }
    const definition: ModelToolDefinition = deepFreeze({
      name: tool.name,
      description: tool.description,
      inputSchema: structuredClone(tool.input_schema) as JsonObject,
    });
    return Object.freeze({
      definition,
      replaySafety: tool.replaySafety,
      handler,
    });
  }));
  const exactByName = new Map(tools.map((tool) => [tool.definition.name, tool]));
  return Object.freeze({
    tools,
    authorizeToolExecution(input: Readonly<ReadOnlyToolAuthorizationInput>) {
      const expected = exactByName.get(input.toolName);
      return expected
        && input.replaySafety === 'pure_local'
        && input.handler === expected.handler
        && isDeepStrictEqual(input.definition, expected.definition)
        ? { allowed: true }
        : { allowed: false };
    },
  });
}
