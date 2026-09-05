import { createHash } from 'node:crypto';
import type { ToolHandler } from './model-providers/tool-orchestration.js';
import {
  selectBoundedRoutedToolSets,
  type ActiveCertificationKind,
  type SlackToolSource,
  type SponsoredIntelligenceContextKind,
  type SystemChannelRole,
} from './slack-tool-selection.js';
import type { AddieTool } from './types.js';

/**
 * The authenticated facts that make a direct-generation request replayable.
 *
 * These are deliberately request/thread facts, rather than a router result or
 * an evaluator expectation. Values are opaque stable identifiers: fixed
 * traces must use synthetic identifiers and must never copy production IDs or
 * conversation text into this object.
 */
export interface AddieRequestThreadFactInput {
  surface: SlackToolSource;
  authenticatedPrincipalId: string;
  /** Account authorization that shaped the request-local handler inventory. */
  accountAccess: 'authenticated' | 'member' | 'api_access_member';
  isAAOAdmin: boolean;
  threadId: string;
  isThread: boolean;
  channelPrivacy: 'public' | 'private' | 'unknown';
  systemRole?: SystemChannelRole | null;
  activeCertificationKind?: ActiveCertificationKind | null;
  sponsoredIntelligenceContextKind?: SponsoredIntelligenceContextKind | null;
  /** The authenticated confirmation state at this request boundary. */
  confirmation: 'not_required' | 'pending' | 'confirmed';
  /** Exact mutation tools covered by the authenticated confirmation. */
  confirmedMutationToolNames: readonly string[];
  /** Exact call keys covered by that confirmation; never infer approval broadly. */
  confirmedMutationIdempotencyKeys: readonly string[];
  /** Opaque idempotency scope, never a natural-language request or tool input. */
  idempotencyScope: string;
  /** Completed opaque call keys prevent a replay from re-executing a mutation. */
  completedToolCallKeys: readonly string[];
  replayClassification: 'initial' | 'retry_same_request' | 'replay';
}

export interface AddieRequestThreadFacts extends Readonly<AddieRequestThreadFactInput> {
  readonly schemaVersion: 'addie-request-thread-facts-v1';
  readonly completedToolCallKeys: readonly string[];
}

export interface AuthorizedToolBinding {
  definition: AddieTool;
  handler: ToolHandler;
  /** Stable deployment-owned identity for the handler contract, not source code. */
  handlerIdentity: string;
}

export interface CapturedDirectTool {
  readonly definition: AddieTool;
  readonly definitionSha256: string;
  readonly handlerIdentity: string;
  readonly handlerIdentitySha256: string;
}

/**
 * A bounded direct tool universe selected without a language-model router.
 * `toolNames` preserves the exact shared-policy order used to construct the
 * provider request. The handler functions never leave the capture boundary.
 */
export interface CapturedDirectToolUniverse {
  readonly source: 'authenticated_request_definition_handler_intersection';
  readonly policy: 'shared_deterministic_surface_policy';
  readonly requestThreadFactsSha256: string;
  readonly selectedToolSets: readonly string[];
  readonly toolNames: readonly string[];
  readonly toolNamesSha256: string;
  readonly definitionHandlerSha256: string;
  readonly tools: readonly CapturedDirectTool[];
}

export interface SyntheticDirectToolReceipt {
  readonly kind: 'synthetic_direct_tool_receipt';
  readonly toolName: string;
  readonly definitionSha256: string;
  readonly handlerIdentitySha256: string;
  readonly definitionHandlerSha256: string;
}

export type DirectToolExecutionAdmissionReason =
  | 'mutation_not_confirmed_for_tool'
  | 'mutation_confirmation_required'
  | 'duplicate_idempotency_key'
  | 'replay_mutation_blocked';

/** A request-fact-only mutation/replay gate for future direct execution. */
export function admitDirectToolExecution(
  facts: AddieRequestThreadFacts,
  input: { toolName: string; isMutation: boolean; idempotencyKey: string },
): { allowed: true } | { allowed: false; reason: DirectToolExecutionAdmissionReason } {
  requireOpaqueFact('toolName', input.toolName);
  requireOpaqueFact('idempotencyKey', input.idempotencyKey);
  if (!input.isMutation) return { allowed: true };
  if (facts.replayClassification === 'replay') {
    return { allowed: false, reason: 'replay_mutation_blocked' };
  }
  if (facts.confirmation !== 'confirmed') {
    return { allowed: false, reason: 'mutation_confirmation_required' };
  }
  if (
    !facts.confirmedMutationToolNames.includes(input.toolName)
    || !facts.confirmedMutationIdempotencyKeys.includes(input.idempotencyKey)
  ) {
    return { allowed: false, reason: 'mutation_not_confirmed_for_tool' };
  }
  if (facts.completedToolCallKeys.includes(input.idempotencyKey)) {
    return { allowed: false, reason: 'duplicate_idempotency_key' };
  }
  return { allowed: true };
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

function requireOpaqueFact(name: string, value: string): void {
  if (!value.trim()) throw new Error(`Request/thread fact ${name} is required`);
}

/** Capture and deeply freeze the facts required by authorization and replay. */
export function captureAddieRequestThreadFacts(input: AddieRequestThreadFactInput): AddieRequestThreadFacts {
  requireOpaqueFact('authenticatedPrincipalId', input.authenticatedPrincipalId);
  requireOpaqueFact('threadId', input.threadId);
  requireOpaqueFact('idempotencyScope', input.idempotencyScope);
  if (new Set(input.completedToolCallKeys).size !== input.completedToolCallKeys.length) {
    throw new Error('Request/thread completed tool call keys must be unique');
  }
  if (new Set(input.confirmedMutationToolNames).size !== input.confirmedMutationToolNames.length) {
    throw new Error('Request/thread confirmed mutation tool names must be unique');
  }
  if (new Set(input.confirmedMutationIdempotencyKeys).size !== input.confirmedMutationIdempotencyKeys.length) {
    throw new Error('Request/thread confirmed mutation idempotency keys must be unique');
  }
  for (const key of input.completedToolCallKeys) requireOpaqueFact('completedToolCallKey', key);
  for (const name of input.confirmedMutationToolNames) requireOpaqueFact('confirmedMutationToolName', name);
  for (const key of input.confirmedMutationIdempotencyKeys) requireOpaqueFact('confirmedMutationIdempotencyKey', key);
  if (input.confirmation !== 'confirmed' && (
    input.confirmedMutationToolNames.length > 0 || input.confirmedMutationIdempotencyKeys.length > 0
  )) throw new Error('Only a confirmed request may carry confirmed mutation facts');
  return deepFreeze({
    schemaVersion: 'addie-request-thread-facts-v1' as const,
    ...input,
    confirmedMutationToolNames: [...input.confirmedMutationToolNames],
    confirmedMutationIdempotencyKeys: [...input.confirmedMutationIdempotencyKeys],
    completedToolCallKeys: [...input.completedToolCallKeys],
  });
}

function channelIsPublic(facts: AddieRequestThreadFacts): boolean | undefined {
  if (facts.channelPrivacy === 'public') return true;
  if (facts.channelPrivacy === 'private') return false;
  return undefined;
}

function definitionSha256(definition: AddieTool): string {
  return sha256({
    name: definition.name,
    description: definition.description,
    inputSchema: definition.input_schema,
  });
}

/**
 * Capture the production-shaped custom-tool intersection for direct
 * generation. Selection intentionally invokes the existing deterministic
 * router-outage policy: no LLM capability router, trace fixture, rubric, or
 * expected route participates in this decision.
 */
export function captureAuthorizedDirectToolUniverse(
  facts: AddieRequestThreadFacts,
  bindings: readonly AuthorizedToolBinding[],
): CapturedDirectToolUniverse {
  const byName = new Map<string, AuthorizedToolBinding>();
  for (const binding of bindings) {
    if (!binding.definition.name.trim()) throw new Error('Tool definition name is required');
    if (typeof binding.handler !== 'function') throw new Error(`Tool handler is required: ${binding.definition.name}`);
    if (!binding.handlerIdentity.trim()) throw new Error(`Tool handler identity is required: ${binding.definition.name}`);
    if (byName.has(binding.definition.name)) throw new Error(`Duplicate tool binding: ${binding.definition.name}`);
    byName.set(binding.definition.name, binding);
  }

  const selection = selectBoundedRoutedToolSets({
    plan: null,
    routerAvailable: false,
    source: facts.surface,
    isAdmin: facts.isAAOAdmin,
    isPublicChannel: channelIsPublic(facts),
    activeCertificationKind: facts.activeCertificationKind,
    sponsoredIntelligenceContextKind: facts.sponsoredIntelligenceContextKind,
    // This is the exact definition/handler intersection. Provider-managed
    // tools are intentionally absent from the direct custom-tool universe.
    isToolAvailable: (name) => byName.has(name),
  });
  const tools = selection.allowedToolNames.flatMap((name) => {
    const binding = byName.get(name);
    if (!binding) return [];
    const definition = deepFreeze(structuredClone(binding.definition));
    const definitionHash = definitionSha256(definition);
    return [deepFreeze({
      definition,
      definitionSha256: definitionHash,
      handlerIdentity: binding.handlerIdentity,
      handlerIdentitySha256: sha256(binding.handlerIdentity),
    })];
  });
  const toolNames = tools.map((tool) => tool.definition.name);
  const factsHash = sha256(facts);
  return deepFreeze({
    source: 'authenticated_request_definition_handler_intersection' as const,
    policy: 'shared_deterministic_surface_policy' as const,
    requestThreadFactsSha256: factsHash,
    selectedToolSets: [...selection.selectedToolSets],
    toolNames,
    toolNamesSha256: sha256(toolNames),
    definitionHandlerSha256: sha256(tools.map((tool) => ({
      name: tool.definition.name,
      definitionSha256: tool.definitionSha256,
      handlerIdentitySha256: tool.handlerIdentitySha256,
    }))),
    tools,
  });
}

/**
 * Create inert evaluator handlers for an already captured universe. Each
 * receipt binds the visible definition to the same handler-identity contract
 * captured from production; it never invokes a production handler or records
 * model-provided arguments.
 */
export function createSyntheticDirectToolReceiptHandlers(
  universe: CapturedDirectToolUniverse,
): Map<string, ToolHandler> {
  return new Map(universe.tools.map((tool) => [tool.definition.name, async () => JSON.stringify({
    kind: 'synthetic_direct_tool_receipt',
    toolName: tool.definition.name,
    definitionSha256: tool.definitionSha256,
    handlerIdentitySha256: tool.handlerIdentitySha256,
    definitionHandlerSha256: universe.definitionHandlerSha256,
  } satisfies SyntheticDirectToolReceipt)]));
}
