import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import type { ToolHandler } from './model-providers/tool-orchestration.js';
import {
  assembleAddieRequestTools,
  type AddieRequestToolDefinitionOptions,
  type AddieRequestTools,
} from './request-tool-assembly.js';
import type { AddieTool } from './types.js';

/** Version of the assembly semantics sealed into a replay binding. */
export const ADDIE_REQUEST_TOOL_REPLAY_ASSEMBLY_POLICY_VERSION =
  'request-tool-intersection:v1';

/** A bounded lifetime makes an unconsumed request-local binding unusable. */
export const ADDIE_REQUEST_TOOL_REPLAY_BINDING_TTL_MS = 60_000;

/**
 * Privacy-safe request facts supplied only through the repository-owned
 * production capture boundary. This deliberately contains no caller-
 * controlled `verified` marker: a fact claim is never trusted.
 */
export interface AddieRequestToolReplayFacts {
  readonly surface: 'slack_dm' | 'slack_channel' | 'web_chat' | 'email' | 'voice' | 'mcp';
  readonly requestIdSha256: string;
  readonly messageIdSha256: string;
  readonly threadIdSha256: string;
  readonly threadContextSha256: string;
  readonly principalSha256: string;
  readonly adminStatus: 'admin' | 'not_admin';
  readonly adminProvenance: 'slack_member_context' | 'web_session' | 'email_recipient' | 'voice_session' | 'mcp_session';
  readonly isThread: boolean;
  readonly privacy: 'private' | 'public' | 'unknown';
  readonly privacyProvenance: 'slack_dm' | 'slack_channel_context' | 'web_session' | 'email_recipient' | 'voice_session' | 'mcp_session';
  readonly requestTimeMs: number;
  /** Unknown is mandatory unless the live transport supplies a verified checkpoint. */
  readonly confirmationState: 'unknown' | 'not_required' | 'pending' | 'confirmed' | 'rejected';
  /** Unknown is mandatory unless the transport's dedupe outcome is bound. */
  readonly idempotencyState: 'unknown' | 'first_attempt' | 'retry';
  /** Unknown is mandatory unless mutation replay policy is bound to this request. */
  readonly mutationReplayState: 'unknown' | 'not_applicable' | 'replay_blocked';
}

/** Safe, handler-free descriptor for later evaluator-owned substitution. */
export interface SealedReplayToolDescriptor {
  readonly index: number;
  readonly name: string;
  readonly definitionSha256: string;
  readonly handlerSlotSha256: string;
  readonly definitionWinner: 'global' | 'request_local';
  readonly handlerWinner: 'global' | 'request_local';
}

/**
 * This is only a projection. Its identity is looked up in a module-private
 * WeakMap; copying, serializing, branding, hashing, or changing a prototype
 * therefore cannot recreate the module-private integrity state behind it.
 */
export interface SealedRequestToolReplayBinding {
  readonly policyVersion: typeof ADDIE_REQUEST_TOOL_REPLAY_ASSEMBLY_POLICY_VERSION;
  readonly factsSha256: string;
  readonly tools: readonly SealedReplayToolDescriptor[];
  readonly intersectionSha256: string;
}

export interface CaptureSealedRequestToolReplayBindingInput {
  readonly facts: AddieRequestToolReplayFacts;
  readonly globalTools: readonly AddieTool[];
  readonly globalHandlers: ReadonlyMap<string, ToolHandler>;
  readonly requestTools?: AddieRequestTools;
  readonly definitionOptions?: AddieRequestToolDefinitionOptions;
  readonly handlerAllowedToolNames?: ReadonlySet<string> | null;
}

export type SealedReplayBindingValidation =
  | { readonly valid: true; readonly tools: readonly SealedReplayToolDescriptor[] }
  | {
    readonly valid: false;
    readonly reason:
      | 'binding_unknown_or_forged'
      | 'binding_already_consumed'
      | 'binding_expired'
      | 'binding_clock_invalid'
      | 'binding_aborted'
      | 'binding_evaluator_custody_unavailable'
      | 'request_facts_drift'
      | 'assembly_drift';
  };

interface BoundState {
  readonly facts: AddieRequestToolReplayFacts;
  readonly factsSha256: string;
  readonly createdAtMonotonicMs: number;
  /** Detached, deeply frozen inputs used by all assembly and descriptor work. */
  readonly globalTools: readonly AddieTool[];
  readonly globalHandlers: ReadonlyMap<string, ToolHandler>;
  readonly requestDefinitions: readonly AddieTool[] | undefined;
  readonly requestHandlers: ReadonlyMap<string, ToolHandler> | undefined;
  readonly definitionOptions: AddieRequestToolDefinitionOptions | undefined;
  readonly handlerAllowedToolNames: ReadonlySet<string> | null | undefined;
  /** Plain-data sources are revalidated without invoking accessors or traps. */
  readonly sourceGlobalTools: readonly AddieTool[];
  readonly sourceGlobalHandlers: ReadonlyMap<string, ToolHandler>;
  readonly originalRequestTools: AddieRequestTools | undefined;
  readonly originalRequestDefinitions: readonly AddieTool[] | undefined;
  readonly originalRequestHandlers: ReadonlyMap<string, ToolHandler> | undefined;
  readonly sourceDefinitionOptions: AddieRequestToolDefinitionOptions | undefined;
  readonly sourceHandlerAllowedToolNames: ReadonlySet<string> | null | undefined;
  readonly globalToolEvidence: string;
  readonly requestToolEvidence: string;
  readonly globalHandlerEvidence: string;
  readonly requestHandlerEvidence: string;
  readonly definitionOptionsEvidence: string;
  readonly handlerAllowedToolNamesEvidence: string;
  readonly assembledTools: readonly AddieTool[];
  readonly assembledHandlers: ReadonlyMap<string, ToolHandler>;
  readonly assembledDefinitionEvidence: string;
  readonly descriptors: readonly SealedReplayToolDescriptor[];
  consumed: boolean;
}

const boundStates = new WeakMap<object, BoundState>();
/** Terminal identities retain no handlers or source maps after a claim attempt. */
const consumedBindings = new WeakSet<object>();
const handlerIdentities = new WeakMap<Function, string>();
let nextHandlerIdentity = 1;

/**
 * Wall time is deliberately module-private and is used only to reject a
 * future-dated request fact at capture. It never measures TTL elapsed time.
 */
function readWallClockMs(): number {
  const nowMs = Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error('Replay binding clock is invalid');
  }
  return nowMs;
}

/**
 * Module-private monotonic elapsed clock. DOMHighResTimeStamp values may be
 * fractional, so this accepts finite, nonnegative, safe-range milliseconds
 * and compares them with a strict TTL boundary.
 */
function readMonotonicClockMs(): number {
  const nowMs = performance.now();
  if (!Number.isFinite(nowMs) || nowMs < 0 || nowMs > Number.MAX_SAFE_INTEGER) {
    throw new Error('Replay binding monotonic clock is invalid');
  }
  return nowMs;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Replay binding cannot canonicalize a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  throw new Error('Replay binding cannot canonicalize a non-JSON value');
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function rejectProxy(value: unknown, owner: string): void {
  if ((typeof value === 'object' && value !== null) || typeof value === 'function') {
    if (isProxy(value)) throw new Error(`Replay binding ${owner} must not be a Proxy`);
  }
}

function plainDataRecord(source: unknown, owner: string): Record<string, unknown> {
  rejectProxy(source, owner);
  if (typeof source !== 'object' || source === null || Object.getPrototypeOf(source) !== Object.prototype) {
    throw new Error(`Replay binding ${owner} must be a plain object`);
  }
  if (Object.getOwnPropertySymbols(source).length > 0) {
    throw new Error(`Replay binding ${owner} must not contain symbol properties`);
  }
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(source)) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      throw new Error(`Replay binding ${owner}.${key} must be an enumerable own data property`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function exactFields(record: Record<string, unknown>, expected: readonly string[], owner: string): void {
  const actual = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length || actual.some((name, index) => name !== sortedExpected[index])) {
    throw new Error(`Replay binding ${owner} has unsupported fields`);
  }
}

function allowedWrapperFields(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  owner: string,
): void {
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(record).some((name) => !allowed.has(name)) || required.some((name) => !(name in record))) {
    throw new Error(`Replay binding ${owner} has missing or unsupported fields`);
  }
}

function plainDataArray(source: unknown, owner: string): readonly unknown[] {
  rejectProxy(source, owner);
  if (!Array.isArray(source) || Object.getPrototypeOf(source) !== Array.prototype) {
    throw new Error(`Replay binding ${owner} must be a plain array`);
  }
  if (Object.getOwnPropertySymbols(source).length > 0) {
    throw new Error(`Replay binding ${owner} must not contain symbol properties`);
  }
  const names = Object.getOwnPropertyNames(source);
  if (names.length !== source.length + 1 || !names.includes('length')) {
    throw new Error(`Replay binding ${owner} must not contain extra or sparse properties`);
  }
  const values: unknown[] = [];
  for (let index = 0; index < source.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(source, String(index));
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      throw new Error(`Replay binding ${owner}[${index}] must be an enumerable own data property`);
    }
    values.push(descriptor.value);
  }
  return values;
}

type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

function snapshotJson(value: unknown, owner: string): JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Replay binding ${owner} must contain finite JSON numbers`);
    return value;
  }
  if (Array.isArray(value)) {
    return Object.freeze(plainDataArray(value, owner).map((entry, index) => snapshotJson(entry, `${owner}[${index}]`)));
  }
  const source = plainDataRecord(value, owner);
  const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const [key, entry] of Object.entries(source)) {
    Object.defineProperty(result, key, {
      enumerable: true,
      value: snapshotJson(entry, `${owner}.${key}`),
    });
  }
  return Object.freeze(result);
}

function snapshotFacts(input: AddieRequestToolReplayFacts): AddieRequestToolReplayFacts {
  const expected = [
    'surface', 'requestIdSha256', 'messageIdSha256', 'threadIdSha256', 'threadContextSha256', 'principalSha256',
    'adminStatus', 'adminProvenance', 'isThread', 'privacy', 'privacyProvenance', 'requestTimeMs',
    'confirmationState', 'idempotencyState', 'mutationReplayState',
  ];
  const inputRecord = plainDataRecord(input, 'facts');
  exactFields(inputRecord, expected, 'facts');
  const facts = {
    surface: inputRecord.surface,
    requestIdSha256: inputRecord.requestIdSha256,
    messageIdSha256: inputRecord.messageIdSha256,
    threadIdSha256: inputRecord.threadIdSha256,
    threadContextSha256: inputRecord.threadContextSha256,
    principalSha256: inputRecord.principalSha256,
    adminStatus: inputRecord.adminStatus,
    adminProvenance: inputRecord.adminProvenance,
    isThread: inputRecord.isThread,
    privacy: inputRecord.privacy,
    privacyProvenance: inputRecord.privacyProvenance,
    requestTimeMs: inputRecord.requestTimeMs,
    confirmationState: inputRecord.confirmationState,
    idempotencyState: inputRecord.idempotencyState,
    mutationReplayState: inputRecord.mutationReplayState,
  };
  const snapshot = facts as AddieRequestToolReplayFacts;
  if (
    !['slack_dm', 'slack_channel', 'web_chat', 'email', 'voice', 'mcp'].includes(snapshot.surface)
    || ![snapshot.requestIdSha256, snapshot.messageIdSha256, snapshot.threadIdSha256, snapshot.threadContextSha256, snapshot.principalSha256]
      .every((value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))
    || (snapshot.adminStatus !== 'admin' && snapshot.adminStatus !== 'not_admin')
    || !['slack_member_context', 'web_session', 'email_recipient', 'voice_session', 'mcp_session'].includes(snapshot.adminProvenance)
    || typeof snapshot.isThread !== 'boolean'
    || (snapshot.privacy !== 'private' && snapshot.privacy !== 'public' && snapshot.privacy !== 'unknown')
    || !['slack_dm', 'slack_channel_context', 'web_session', 'email_recipient', 'voice_session', 'mcp_session'].includes(snapshot.privacyProvenance)
    || !Number.isSafeInteger(snapshot.requestTimeMs) || snapshot.requestTimeMs < 0
    || !['unknown', 'not_required', 'pending', 'confirmed', 'rejected'].includes(snapshot.confirmationState)
    || !['unknown', 'first_attempt', 'retry'].includes(snapshot.idempotencyState)
    || !['unknown', 'not_applicable', 'replay_blocked'].includes(snapshot.mutationReplayState)
  ) throw new Error('Replay binding facts are invalid');
  return Object.freeze(snapshot);
}

function definitionEvidence(tools: readonly AddieTool[]): string {
  return sha256(tools);
}

function privateHandlerIdentity(handler: ToolHandler): string {
  let identity = handlerIdentities.get(handler);
  if (!identity) {
    identity = `handler-${nextHandlerIdentity++}`;
    handlerIdentities.set(handler, identity);
  }
  return identity;
}

function handlerEvidence(handlers: ReadonlyMap<string, ToolHandler>): string {
  // Function identity remains module-private. This binds every source slot,
  // including off-intersection slots, without making any handler reachable.
  return sha256([...handlers.entries()].map(([name, handler], index) => ({
    name,
    index,
    handlerIdentity: privateHandlerIdentity(handler),
  })));
}

interface RequestToolsSnapshot {
  readonly original: AddieRequestTools;
  readonly originalDefinitions: readonly AddieTool[];
  readonly originalHandlers: ReadonlyMap<string, ToolHandler>;
  readonly assemblyTools: AddieRequestTools;
}

function snapshotTool(tool: unknown, owner: string): AddieTool {
  const source = plainDataRecord(tool, owner);
  const required = ['name', 'description', 'input_schema'];
  const allowed = ['name', 'description', 'input_schema', 'usage_hints', 'replaySafety'];
  for (const name of required) {
    if (!(name in source)) throw new Error(`Replay binding ${owner}.${name} is required`);
  }
  if (Object.keys(source).some((name) => !allowed.includes(name))) {
    throw new Error(`Replay binding ${owner} has unsupported fields`);
  }
  if (typeof source.name !== 'string' || typeof source.description !== 'string') {
    throw new Error(`Replay binding ${owner} has invalid required fields`);
  }
  if ('usage_hints' in source && typeof source.usage_hints !== 'string') {
    throw new Error(`Replay binding ${owner}.usage_hints must be a string when present`);
  }
  if ('replaySafety' in source && !['pure_local', 'public_read', 'principal_read', 'external_read', 'mutation'].includes(source.replaySafety as string)) {
    throw new Error(`Replay binding ${owner}.replaySafety is invalid`);
  }
  const inputSchema = snapshotJson(source.input_schema, `${owner}.input_schema`);
  if (typeof inputSchema !== 'object' || inputSchema === null || Array.isArray(inputSchema)) {
    throw new Error(`Replay binding ${owner}.input_schema must be a JSON object`);
  }
  const snapshot: AddieTool = {
    name: source.name,
    description: source.description,
    input_schema: inputSchema as AddieTool['input_schema'],
  };
  if ('usage_hints' in source) snapshot.usage_hints = source.usage_hints as string;
  if ('replaySafety' in source) snapshot.replaySafety = source.replaySafety as AddieTool['replaySafety'];
  return Object.freeze(snapshot);
}

function snapshotToolDefinitions(source: unknown, owner: string): readonly AddieTool[] {
  return Object.freeze(plainDataArray(source, owner).map((tool, index) => snapshotTool(tool, `${owner}[${index}]`)));
}

function assertNativeCollection(source: unknown, owner: string, prototype: object): void {
  rejectProxy(source, owner);
  if (typeof source !== 'object' || source === null || Object.getPrototypeOf(source) !== prototype
    || Object.getOwnPropertyNames(source).length > 0 || Object.getOwnPropertySymbols(source).length > 0) {
    throw new Error(`Replay binding ${owner} must be an unextended native collection`);
  }
}

function snapshotHandlers(source: unknown, owner: string): ReadonlyMap<string, ToolHandler> {
  assertNativeCollection(source, owner, Map.prototype);
  const handlers = new Map<string, ToolHandler>();
  for (const [name, handler] of Map.prototype.entries.call(source as Map<unknown, unknown>)) {
    if (typeof name !== 'string' || typeof handler !== 'function') {
      throw new Error(`Replay binding ${owner} must map string names to functions`);
    }
    rejectProxy(handler, `${owner}.${name}`);
    handlers.set(name, handler as ToolHandler);
  }
  return handlers;
}

function snapshotDefinitionOptions(source: AddieRequestToolDefinitionOptions | undefined): AddieRequestToolDefinitionOptions | undefined {
  if (source === undefined) return undefined;
  const record = plainDataRecord(source, 'definitionOptions');
  if (Object.keys(record).some((name) => name !== 'allowedToolNames')) {
    throw new Error('Replay binding definitionOptions has unsupported fields');
  }
  if (!('allowedToolNames' in record)) return Object.freeze({});
  const names = plainDataArray(record.allowedToolNames, 'definitionOptions.allowedToolNames');
  if (names.some((name) => typeof name !== 'string')) {
    throw new Error('Replay binding definitionOptions.allowedToolNames must contain strings');
  }
  return Object.freeze({ allowedToolNames: Object.freeze([...names] as string[]) });
}

function snapshotAllowedToolNames(source: ReadonlySet<string> | null | undefined): ReadonlySet<string> | null | undefined {
  if (source === undefined || source === null) return source;
  assertNativeCollection(source, 'handlerAllowedToolNames', Set.prototype);
  const names = new Set<string>();
  for (const name of Set.prototype.values.call(source as Set<unknown>)) {
    if (typeof name !== 'string') throw new Error('Replay binding handlerAllowedToolNames must contain strings');
    names.add(name);
  }
  return names;
}

interface CaptureInputSnapshot {
  readonly facts: AddieRequestToolReplayFacts;
  readonly globalTools: readonly AddieTool[];
  readonly globalHandlers: ReadonlyMap<string, ToolHandler>;
  readonly requestTools: AddieRequestTools | undefined;
  readonly definitionOptions: AddieRequestToolDefinitionOptions | undefined;
  readonly handlerAllowedToolNames: ReadonlySet<string> | null | undefined;
}

function snapshotCaptureInput(input: CaptureSealedRequestToolReplayBindingInput): CaptureInputSnapshot {
  const record = plainDataRecord(input, 'capture input');
  allowedWrapperFields(
    record,
    ['facts', 'globalTools', 'globalHandlers'],
    ['requestTools', 'definitionOptions', 'handlerAllowedToolNames'],
    'capture input',
  );
  return Object.freeze({
    facts: record.facts as AddieRequestToolReplayFacts,
    globalTools: record.globalTools as readonly AddieTool[],
    globalHandlers: record.globalHandlers as ReadonlyMap<string, ToolHandler>,
    requestTools: record.requestTools as AddieRequestTools | undefined,
    definitionOptions: record.definitionOptions as AddieRequestToolDefinitionOptions | undefined,
    handlerAllowedToolNames: record.handlerAllowedToolNames as ReadonlySet<string> | null | undefined,
  });
}

function snapshotAbortState(signal: unknown): boolean {
  if (signal === undefined) return false;
  rejectProxy(signal, 'claim signal');
  if (typeof signal !== 'object' || signal === null) {
    throw new Error('Replay binding claim signal must be an AbortSignal');
  }
  const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get;
  if (typeof abortedGetter !== 'function') {
    throw new Error('Replay binding AbortSignal support is unavailable');
  }
  const aborted = abortedGetter.call(signal);
  if (typeof aborted !== 'boolean') {
    throw new Error('Replay binding claim signal is invalid');
  }
  return aborted;
}

interface ClaimInputSnapshot {
  readonly binding: SealedRequestToolReplayBinding;
  readonly facts: AddieRequestToolReplayFacts;
  /** Kept opaque until the authentic binding has been terminally consumed. */
  readonly signal: unknown;
}

function snapshotClaimInput(input: {
  readonly binding: SealedRequestToolReplayBinding;
  readonly facts: AddieRequestToolReplayFacts;
  readonly signal?: AbortSignal;
}): ClaimInputSnapshot {
  const record = plainDataRecord(input, 'claim input');
  allowedWrapperFields(record, ['binding', 'facts'], ['signal'], 'claim input');
  const binding = record.binding as SealedRequestToolReplayBinding;
  rejectProxy(binding, 'claim binding');
  return Object.freeze({
    binding,
    facts: record.facts as AddieRequestToolReplayFacts,
    signal: record.signal,
  });
}

/**
 * Read request-local plain data fields once, then give the shared assembly
 * helper an ordinary detached container. This rejects accessors rather than
 * allowing a getter to change values observed by validation versus assembly.
 */
function snapshotRequestTools(requestTools: AddieRequestTools | undefined): RequestToolsSnapshot | undefined {
  if (!requestTools) return undefined;
  const requestToolsRecord = plainDataRecord(requestTools, 'requestTools');
  exactFields(requestToolsRecord, ['tools', 'handlers'], 'requestTools');
  const definitions = requestToolsRecord.tools;
  const handlers = requestToolsRecord.handlers;
  const toolSnapshot = snapshotToolDefinitions(definitions, 'requestTools.tools');
  const handlerSnapshot = snapshotHandlers(handlers, 'requestTools.handlers');
  return Object.freeze({
    original: requestTools,
    originalDefinitions: definitions as readonly AddieTool[],
    originalHandlers: handlers as ReadonlyMap<string, ToolHandler>,
    assemblyTools: Object.freeze({
      tools: toolSnapshot,
      handlers: handlerSnapshot,
    }),
  });
}

function definitionWinner(
  name: string,
  requestDefinitions: readonly AddieTool[] | undefined,
): 'global' | 'request_local' {
  return requestDefinitions?.some((tool) => tool.name === name) ? 'request_local' : 'global';
}

function handlerWinner(
  name: string,
  requestHandlers: ReadonlyMap<string, ToolHandler> | undefined,
): 'global' | 'request_local' {
  return requestHandlers?.has(name) ? 'request_local' : 'global';
}

function sameFacts(left: AddieRequestToolReplayFacts, right: AddieRequestToolReplayFacts): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function sourceDefinitionEvidence(source: unknown, owner: string): string {
  return definitionEvidence(snapshotToolDefinitions(source, owner));
}

function sourceHandlerEvidence(source: unknown, owner: string): string {
  return handlerEvidence(snapshotHandlers(source, owner));
}

function sourceDefinitionOptionsEvidence(source: AddieRequestToolDefinitionOptions | undefined): string {
  return sha256(snapshotDefinitionOptions(source) ?? null);
}

function sourceAllowedToolNamesEvidence(source: ReadonlySet<string> | null | undefined): string {
  const snapshot = snapshotAllowedToolNames(source);
  return sha256(snapshot === undefined ? { absent: true } : snapshot === null ? null : [...snapshot]);
}

function assemblyStillMatches(state: BoundState): boolean {
  try {
    if (state.originalRequestTools !== undefined) {
      const currentRequestTools = plainDataRecord(state.originalRequestTools, 'requestTools');
      exactFields(currentRequestTools, ['tools', 'handlers'], 'requestTools');
      if (
        currentRequestTools.tools !== state.originalRequestDefinitions
        || currentRequestTools.handlers !== state.originalRequestHandlers
      ) return false;
    }
    if (
      sourceDefinitionEvidence(state.sourceGlobalTools, 'globalTools') !== state.globalToolEvidence
      || sourceDefinitionEvidence(state.originalRequestDefinitions ?? [], 'requestTools.tools') !== state.requestToolEvidence
      || sourceHandlerEvidence(state.sourceGlobalHandlers, 'globalHandlers') !== state.globalHandlerEvidence
      || sourceHandlerEvidence(state.originalRequestHandlers ?? new Map(), 'requestTools.handlers') !== state.requestHandlerEvidence
      || sourceDefinitionOptionsEvidence(state.sourceDefinitionOptions) !== state.definitionOptionsEvidence
      || sourceAllowedToolNamesEvidence(state.sourceHandlerAllowedToolNames) !== state.handlerAllowedToolNamesEvidence
      || definitionEvidence(state.assembledTools) !== state.assembledDefinitionEvidence
    ) return false;
    const names = new Set<string>();
    let intersectionCount = 0;
    for (const [index, definition] of state.assembledTools.entries()) {
      if (names.has(definition.name)) return false;
      names.add(definition.name);
      const descriptor = state.descriptors.find((candidate) => candidate.index === index);
      const handler = state.assembledHandlers.get(definition.name);
      if (!handler) {
        if (descriptor) return false;
        continue;
      }
      intersectionCount++;
      if (!descriptor || descriptor.name !== definition.name) return false;
      if (descriptor.definitionSha256 !== sha256(definition)) return false;
      const expectedDefinition = definitionWinner(definition.name, state.requestDefinitions);
      const expectedHandler = handlerWinner(definition.name, state.requestHandlers);
      if (descriptor.definitionWinner !== expectedDefinition || descriptor.handlerWinner !== expectedHandler) return false;
      const sourceHandler = expectedHandler === 'request_local'
        ? state.requestHandlers?.get(definition.name)
        : state.globalHandlers.get(definition.name);
      if (handler !== sourceHandler) return false;
    }
    return state.descriptors.length === intersectionCount;
  } catch {
    return false;
  }
}

/**
 * Seal a fresh result of #7299's production request-local assembly helper.
 * This does not dispatch anything, return handlers, or validate a replay. Until
 * repository-validated production facts are wired here, it remains a sealed,
 * non-dispatching prerequisite rather than a fixed-trace admission path.
 */
export function captureSealedRequestToolReplayBinding(
  input: CaptureSealedRequestToolReplayBindingInput,
): SealedRequestToolReplayBinding {
  const captureInput = snapshotCaptureInput(input);
  const facts = snapshotFacts(captureInput.facts);
  const createdAtMs = readWallClockMs();
  if (createdAtMs < facts.requestTimeMs) {
    throw new Error('Replay binding request time is in the future');
  }
  const createdAtMonotonicMs = readMonotonicClockMs();
  const globalTools = snapshotToolDefinitions(captureInput.globalTools, 'globalTools');
  const globalHandlers = snapshotHandlers(captureInput.globalHandlers, 'globalHandlers');
  const requestSnapshot = snapshotRequestTools(captureInput.requestTools);
  const definitionOptions = snapshotDefinitionOptions(captureInput.definitionOptions);
  const handlerAllowedToolNames = snapshotAllowedToolNames(captureInput.handlerAllowedToolNames);
  const requestDefinitions = requestSnapshot?.assemblyTools.tools;
  const requestHandlers = requestSnapshot?.assemblyTools.handlers;
  const assembled = assembleAddieRequestTools(
    globalTools,
    globalHandlers,
    requestSnapshot?.assemblyTools,
    definitionOptions,
    handlerAllowedToolNames,
  );
  const assembledTools = Object.freeze([...assembled.tools]);
  const descriptors = assembledTools.flatMap((definition, index) => {
    const handler = assembled.handlers.get(definition.name);
    if (!handler) return [];
    const definitionWinnerValue = definitionWinner(definition.name, requestDefinitions);
    const handlerWinnerValue = handlerWinner(definition.name, requestHandlers);
    const sourceHandler = handlerWinnerValue === 'request_local'
      ? requestHandlers?.get(definition.name)
      : globalHandlers.get(definition.name);
    if (handler !== sourceHandler) {
      throw new Error(`Replay binding handler winner drifted: ${definition.name}`);
    }
    const definitionSha256 = sha256(definition);
    return [Object.freeze({
      index,
      name: definition.name,
      definitionSha256,
      handlerSlotSha256: sha256({ name: definition.name, index, definitionWinner: definitionWinnerValue, handlerWinner: handlerWinnerValue }),
      definitionWinner: definitionWinnerValue,
      handlerWinner: handlerWinnerValue,
    } satisfies SealedReplayToolDescriptor)];
  });
  const frozenDescriptors = Object.freeze(descriptors);
  const factsSha256 = sha256(facts);
  const projection = Object.freeze({
    policyVersion: ADDIE_REQUEST_TOOL_REPLAY_ASSEMBLY_POLICY_VERSION,
    factsSha256,
    tools: frozenDescriptors,
    intersectionSha256: sha256(frozenDescriptors),
  } satisfies SealedRequestToolReplayBinding);
  boundStates.set(projection, {
    facts,
    factsSha256,
    createdAtMonotonicMs,
    globalTools,
    globalHandlers,
    requestDefinitions,
    requestHandlers,
    definitionOptions,
    handlerAllowedToolNames,
    sourceGlobalTools: captureInput.globalTools,
    sourceGlobalHandlers: captureInput.globalHandlers,
    originalRequestTools: requestSnapshot?.original,
    originalRequestDefinitions: requestSnapshot?.originalDefinitions,
    originalRequestHandlers: requestSnapshot?.originalHandlers,
    sourceDefinitionOptions: captureInput.definitionOptions,
    sourceHandlerAllowedToolNames: captureInput.handlerAllowedToolNames,
    globalToolEvidence: definitionEvidence(globalTools),
    requestToolEvidence: definitionEvidence(requestDefinitions ?? []),
    globalHandlerEvidence: handlerEvidence(globalHandlers),
    requestHandlerEvidence: handlerEvidence(requestHandlers ?? new Map()),
    definitionOptionsEvidence: sha256(definitionOptions ?? null),
    handlerAllowedToolNamesEvidence: sha256(
      handlerAllowedToolNames === undefined ? { absent: true } : handlerAllowedToolNames === null ? null : [...handlerAllowedToolNames],
    ),
    assembledTools,
    assembledHandlers: assembled.handlers,
    assembledDefinitionEvidence: definitionEvidence(assembledTools),
    descriptors: frozenDescriptors,
    consumed: false,
  });
  return projection;
}

/**
 * Consume a binding for evaluator-owned simulator substitution. Production
 * handlers never cross this boundary; callers receive frozen descriptors only.
 */
export function claimSealedRequestToolReplayBinding(input: {
  readonly binding: SealedRequestToolReplayBinding;
  readonly facts: AddieRequestToolReplayFacts;
  readonly signal?: AbortSignal;
}): SealedReplayBindingValidation {
  let claimInput: ClaimInputSnapshot;
  try {
    claimInput = snapshotClaimInput(input);
  } catch {
    return { valid: false, reason: 'binding_unknown_or_forged' };
  }
  if (consumedBindings.has(claimInput.binding)) return { valid: false, reason: 'binding_already_consumed' };
  const state = boundStates.get(claimInput.binding);
  if (!state) return { valid: false, reason: 'binding_unknown_or_forged' };
  // Any attempted validation is terminal, so mutable facts cannot be repaired
  // after learning why an integrity check failed.
  state.consumed = true;
  consumedBindings.add(claimInput.binding);
  // Release all production definitions and handlers before any validation
  // result leaves this module. A replay projection never retains authority
  // after a terminal claim, including failure, expiry, or abort.
  boundStates.delete(claimInput.binding);
  let signalAborted: boolean;
  try {
    signalAborted = snapshotAbortState(claimInput.signal);
  } catch {
    return { valid: false, reason: 'binding_unknown_or_forged' };
  }
  if (signalAborted) return { valid: false, reason: 'binding_aborted' };
  let nowMs: number;
  try {
    nowMs = readMonotonicClockMs();
  } catch {
    return { valid: false, reason: 'binding_clock_invalid' };
  }
  const elapsedMs = nowMs - state.createdAtMonotonicMs;
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    return { valid: false, reason: 'binding_clock_invalid' };
  }
  if (elapsedMs > ADDIE_REQUEST_TOOL_REPLAY_BINDING_TTL_MS) {
    return { valid: false, reason: 'binding_expired' };
  }
  let facts: AddieRequestToolReplayFacts;
  try {
    facts = snapshotFacts(claimInput.facts);
  } catch {
    return { valid: false, reason: 'request_facts_drift' };
  }
  if (!sameFacts(state.facts, facts) || state.factsSha256 !== claimInput.binding.factsSha256) {
    return { valid: false, reason: 'request_facts_drift' };
  }
  if (!assemblyStillMatches(state)) return { valid: false, reason: 'assembly_drift' };
  // #7308 deliberately has no evaluator-owned custody or simulator handler
  // substitution yet. A locally sealed projection is therefore never an
  // authorization grant and cannot be claimed as a runnable binding.
  return { valid: false, reason: 'binding_evaluator_custody_unavailable' };
}
