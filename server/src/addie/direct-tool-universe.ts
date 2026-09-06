import { createHash } from 'node:crypto';
import { KNOWLEDGE_TOOLS } from './mcp/knowledge-search.js';
import { SCHEMA_TOOLS } from './mcp/schema-tools.js';
import { URL_TOOLS } from './mcp/url-tools.js';
import type { ToolHandler } from './model-providers/tool-orchestration.js';
import { getSafeReadOnlyFallbackTools, SAFE_KNOWLEDGE_FALLBACK_TOOL_SETS } from './tool-sets.js';
import type { AddieTool } from './types.js';

/**
 * This inventory revision adds only the two descriptors required by the
 * evaluator-only Addie smoke simulator. They are not selected by production
 * fallback policy and never carry a production handler into this module.
 */
export const FIXED_TRACE_EVALUATOR_NEUTRAL_TOOL_UNIVERSE_VERSION =
  'addie-fixed-trace-evaluator-neutral-tools-v2';

const EVALUATOR_ONLY_SMOKE_TOOL_NAMES = Object.freeze([
  'list_paying_members',
  'confirm_send_invoice',
] as const);

/**
 * Reviewed production wire-schema snapshots for the two smoke-only entries.
 * Importing the production admin or billing modules would instantiate their
 * database, Slack, and billing dependencies, so these inert descriptors are
 * intentionally maintained here instead. The generic custom-tool result wire
 * shape is text; the simulator owns deterministic synthetic result strings.
 */
const EVALUATOR_ONLY_SMOKE_TOOL_DEFINITIONS: readonly AddieTool[] = [
  {
    name: 'list_paying_members',
    replaySafety: 'principal_read',
    description: 'List all paying members grouped by subscription level ($50K ICL, $10K corporate, $2.5K SMB, individual). Includes individual members by default. Pass include_individual: false for corporate-only. Each entry includes the primary contact name and email.',
    usage_hints: 'Use when asked about paying members, subscription breakdown, who pays what, membership revenue by tier, listing members for events/outreach, getting member contact lists, or checking for payment issues.',
    input_schema: {
      type: 'object' as const,
      properties: {
        include_individual: { type: 'boolean', description: 'Include individual (personal) memberships (default: true)' },
        include_payment_issues: { type: 'boolean', description: 'Also include members with past_due or unpaid subscriptions, flagged in output (default: false)' },
        limit: { type: 'number', description: 'Maximum results (default: 200, max: 500)' },
      },
    },
  },
  {
    name: 'confirm_send_invoice',
    replaySafety: 'mutation',
    description: 'Send an invoice for the authenticated member\'s own organization after they have\nconfirmed the details shown by send_invoice. The contact email, company, and billing address come\nfrom the signed-in session — they cannot be overridden. The org must already have a billing address\non file (set via the dashboard or invite-acceptance flow).',
    input_schema: {
      type: 'object' as const,
      properties: {
        lookup_key: { type: 'string', description: 'The product lookup key from find_membership_products' },
        coupon_id: { type: 'string', description: 'Explicit Stripe coupon ID to apply (optional)' },
        payment_terms: { type: 'number', enum: [30, 45, 60, 90], description: 'Payment terms in days (net-30, net-45, net-60, net-90). Defaults to 30.' },
      },
      required: ['lookup_key'],
    },
  },
];

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
  readonly version: typeof FIXED_TRACE_EVALUATOR_NEUTRAL_TOOL_UNIVERSE_VERSION;
  readonly source: 'evaluator_owned_production_definitions_simulated_receipts';
  readonly policy: 'shared_deterministic_surface_policy';
  /**
   * An evaluator marker, never a request/thread-facts digest. It makes the
   * absence of authentication explicit instead of inviting comparison with a
   * caller-provided digest.
   */
  readonly requestThreadFactsProvenance: 'unavailable_in_evaluator';
  readonly selectedToolSets: readonly string[];
  /** Explicit evaluator-only extension; this is not a production tool-set registration. */
  readonly evaluatorOnlyToolNames: readonly (typeof EVALUATOR_ONLY_SMOKE_TOOL_NAMES)[number][];
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
    usageHints: definition.usage_hints ?? null,
    replaySafety: definition.replaySafety ?? null,
    inputSchema: definition.input_schema,
  });
}

/**
 * The shared safe fallback definitions come from their existing registries.
 * The smoke descriptors use reviewed plain-data production wire-schema
 * snapshots because importing their registry modules would load production
 * dependencies. No production handler is ever imported or registered.
 */
function fixedTraceProductionDefinitions(): AddieTool[] {
  const byName = new Map<string, AddieTool>();
  for (const definition of [
    ...KNOWLEDGE_TOOLS,
    ...SCHEMA_TOOLS,
    ...URL_TOOLS,
    ...EVALUATOR_ONLY_SMOKE_TOOL_DEFINITIONS,
  ]) {
    if (byName.has(definition.name)) throw new Error(`Duplicate production direct tool definition: ${definition.name}`);
    byName.set(definition.name, definition);
  }
  const fallback = getSafeReadOnlyFallbackTools().flatMap((name) => {
    if (name === 'web_search') return [];
    const definition = byName.get(name);
    if (!definition) throw new Error(`Missing production direct tool definition: ${name}`);
    return [definition];
  });
  const smokeDefinitions = EVALUATOR_ONLY_SMOKE_TOOL_NAMES.map((name) => {
    const definition = byName.get(name);
    if (!definition) throw new Error(`Missing evaluator smoke tool definition: ${name}`);
    return definition;
  });
  return [...fallback, ...smokeDefinitions];
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
    version: FIXED_TRACE_EVALUATOR_NEUTRAL_TOOL_UNIVERSE_VERSION,
    source: 'evaluator_owned_production_definitions_simulated_receipts' as const,
    policy: 'shared_deterministic_surface_policy' as const,
    requestThreadFactsProvenance: 'unavailable_in_evaluator' as const,
    selectedToolSets: [...SAFE_KNOWLEDGE_FALLBACK_TOOL_SETS],
    evaluatorOnlyToolNames: [...EVALUATOR_ONLY_SMOKE_TOOL_NAMES],
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
