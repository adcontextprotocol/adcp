import { createHash } from 'node:crypto';
import { KNOWLEDGE_TOOLS } from './mcp/knowledge-search.js';
import { SCHEMA_TOOLS } from './mcp/schema-tools.js';
import { URL_TOOLS } from './mcp/url-tools.js';
import type { ToolHandler } from './model-providers/tool-orchestration.js';
import { getSafeReadOnlyFallbackTools, SAFE_KNOWLEDGE_FALLBACK_TOOL_SETS } from './tool-sets.js';
import type { AddieTool } from './types.js';

/**
 * This module deliberately has no production registration or authentication
 * authority. It exports only evaluator-simulated descriptors for inspectable
 * fixed traces. A production direct executor must be introduced behind an
 * actual trusted request/registration boundary; hashes, freezes, and shapes
 * created here are diagnostic data and cannot establish that authority.
 */
export interface CapturedDirectTool {
  readonly definition: AddieTool;
  readonly definitionSha256: string;
  readonly handlerIdentity: string;
  readonly handlerIdentitySha256: string;
  readonly handlerProvenance: 'evaluator_simulated_receipt';
}

/**
 * A bounded direct tool universe selected without a language-model router.
 * `toolNames` preserves the exact shared-policy order used to construct the
 * provider request. The handler functions never leave the capture boundary.
 */
export interface CapturedDirectToolUniverse {
  readonly source: 'evaluator_owned_production_definitions_simulated_receipts';
  readonly policy: 'shared_deterministic_surface_policy';
  /**
   * An evaluator marker, never a request/thread-facts digest. It makes the
   * absence of authentication explicit instead of inviting comparison with a
   * caller-provided digest.
   */
  readonly requestThreadFactsProvenance: 'unavailable_in_evaluator';
  readonly selectedToolSets: readonly string[];
  readonly toolNames: readonly string[];
  readonly toolNamesSha256: string;
  readonly toolSchemaSha256: string;
  readonly definitionHandlerSha256: string;
  /** This evaluator cannot capture an authenticated production contract. */
  readonly authenticatedBindingContract: 'unavailable_in_evaluator';
  readonly tools: readonly CapturedDirectTool[];
}

export interface SyntheticDirectToolReceipt {
  readonly kind: 'synthetic_direct_tool_receipt';
  readonly toolName: string;
  readonly definitionSha256: string;
  readonly handlerProvenance: 'evaluator_simulated_receipt';
  readonly receiptHandlerIdentitySha256: string;
  readonly definitionHandlerSha256: string;
}

/**
 * A frozen evaluator-only receipt handler bound to one captured definition.
 * A caller receives a fresh set for each environment, so it cannot alter a
 * handler selected by another evaluation run.
 */
export interface SyntheticDirectToolReceiptHandler {
  readonly definition: AddieTool;
  readonly definitionSha256: string;
  readonly handlerIdentitySha256: string;
  readonly handlerProvenance: 'evaluator_simulated_receipt';
  readonly handler: ToolHandler;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Cannot canonicalize a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  throw new Error('Cannot canonicalize a non-JSON value');
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function definitionSha256(definition: AddieTool): string {
  return sha256({
    name: definition.name,
    description: definition.description,
    inputSchema: definition.input_schema,
  });
}

/** The fixed fallback's 13 custom definitions are taken only from production registries. */
function fixedTraceProductionDefinitions(): AddieTool[] {
  const byName = new Map<string, AddieTool>();
  for (const definition of [...KNOWLEDGE_TOOLS, ...SCHEMA_TOOLS, ...URL_TOOLS]) {
    if (byName.has(definition.name)) throw new Error(`Duplicate production direct tool definition: ${definition.name}`);
    byName.set(definition.name, definition);
  }
  return getSafeReadOnlyFallbackTools().flatMap((name) => {
    if (name === 'web_search') return [];
    const definition = byName.get(name);
    if (!definition) throw new Error(`Missing production direct tool definition: ${name}`);
    return [definition];
  });
}

/**
 * Create inert evaluator handlers for an already captured universe. Each
 * receipt has evaluator-owned provenance. It never invokes a production
 * handler, and must not be represented as a production handler identity.
 */
export function createSyntheticDirectToolReceiptHandlers(
  universe: CapturedDirectToolUniverse,
): readonly SyntheticDirectToolReceiptHandler[] {
  return Object.freeze(universe.tools.map((tool) => Object.freeze({
    definition: tool.definition,
    definitionSha256: tool.definitionSha256,
    handlerIdentitySha256: tool.handlerIdentitySha256,
    handlerProvenance: tool.handlerProvenance,
    handler: async () => JSON.stringify({
      kind: 'synthetic_direct_tool_receipt',
      toolName: tool.definition.name,
      definitionSha256: tool.definitionSha256,
      handlerProvenance: 'evaluator_simulated_receipt',
      // The receipt must repeat the exact handler identity included in the
      // universe binding, not a parallel descriptive hash.
      receiptHandlerIdentitySha256: tool.handlerIdentitySha256,
      definitionHandlerSha256: universe.definitionHandlerSha256,
    } satisfies SyntheticDirectToolReceipt),
  })));
}

/**
 * Fixed traces deliberately use the production direct-chat safe fallback,
 * before intent routing. This is evaluator-owned rather than a per-case
 * selection: a trace cannot add, remove, or relabel the candidate universe.
 */
function captureFixedTraceEvaluatorToolUniverse(): CapturedDirectToolUniverse {
  const tools = fixedTraceProductionDefinitions().map((originalDefinition) => {
    const definition = deepFreeze(structuredClone(originalDefinition));
    const definitionHash = definitionSha256(definition);
    const handlerIdentity = `evaluator-simulated-receipt/${definition.name}/${definitionHash}`;
    return deepFreeze({
      definition,
      definitionSha256: definitionHash,
      handlerIdentity,
      handlerIdentitySha256: sha256(handlerIdentity),
      handlerProvenance: 'evaluator_simulated_receipt' as const,
    });
  });
  const toolNames = tools.map((tool) => tool.definition.name);
  return deepFreeze({
    source: 'evaluator_owned_production_definitions_simulated_receipts' as const,
    policy: 'shared_deterministic_surface_policy' as const,
    requestThreadFactsProvenance: 'unavailable_in_evaluator' as const,
    selectedToolSets: [...SAFE_KNOWLEDGE_FALLBACK_TOOL_SETS],
    toolNames,
    toolNamesSha256: sha256(toolNames),
    toolSchemaSha256: sha256(tools.map((tool) => ({ name: tool.definition.name, definitionSha256: tool.definitionSha256 }))),
    definitionHandlerSha256: sha256(tools.map((tool) => ({
      name: tool.definition.name,
      definitionSha256: tool.definitionSha256,
      handlerIdentitySha256: tool.handlerIdentitySha256,
      handlerProvenance: tool.handlerProvenance,
    }))),
    authenticatedBindingContract: 'unavailable_in_evaluator' as const,
    tools,
  });
}

/**
 * The only direct custom-tool universe available to fixed-trace evaluation.
 * It is immutable, complete for the shared fallback policy, and paired only
 * with inert evaluator receipt handlers.
 */
export const FIXED_TRACE_DIRECT_TOOL_UNIVERSE = captureFixedTraceEvaluatorToolUniverse();
