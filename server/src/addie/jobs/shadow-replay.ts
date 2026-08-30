import { createHmac } from 'node:crypto';
import type { AddieResponse, InvocationPreparedSnapshot, RequestTools } from '../claude-client.js';
import type { MemberContext } from '../member-context.js';
import type { SIRetrievalResult } from '../services/si-retriever.js';
import type { ThreadContext } from '../thread-service.js';
import type { AddieTool } from '../types.js';
import type { ModelProviderId } from '../model-providers/model-provider.js';
import { getCurrentConfigVersionId } from '../config-version.js';
import {
  buildChannelResponseInvocation,
  getChannelClaudeClient,
  type ChannelRespondPlan,
  type ChannelResponseInvocation,
} from '../bolt-app.js';
import {
  KNOWLEDGE_TOOLS,
  createKnowledgeToolHandlers,
} from '../mcp/knowledge-search.js';
import { getDocsCorpusFingerprint } from '../mcp/docs-indexer.js';
import { guardBareJsonEnvelope, validateOutput } from '../security.js';
import {
  SHADOW_REPLAY_POLICY_VERSION,
  type ShadowReplayEvidence,
} from './shadow-eval-metadata.js';
import {
  OFFICIAL_DOCS_ALLOWED_TOOLS,
} from './shadow-replay-cohort.js';
import {
  verifyShadowReplayFirstInvocation,
  type ResolvedShadowReplayTrace,
  type ShadowReplayGenerationCompletion,
  type ShadowReplayInvocationEvidence,
  type ShadowReplayToolEvidence,
} from './shadow-replay-trace.js';
import type { ShadowReplayJudgeEvidence } from './shadow-replay-judge.js';

type ReplayDisposition = ShadowReplayEvidence['executions'][number]['disposition'];

interface MutableExecution {
  sequence: number;
  name: string;
  schema_sha256: string | null;
  input_sha256: string;
  result_sha256: string;
  disposition: ReplayDisposition;
}

export interface ShadowReplayResult {
  response: AddieResponse;
  model: string;
  configVersionId: number | null;
  traceId: string;
  evidence: ShadowReplayEvidence;
}

export interface ShadowReplayInput {
  question: string;
  userId: string;
  threadId: string;
  sourceQuestionMessageId: string;
  sourceConfigVersionId?: number | null;
  memberContext: MemberContext | null;
  channelContext?: ThreadContext;
  plan: ChannelRespondPlan;
  siRetrievalResult?: SIRetrievalResult | null;
  modelOverride?: string;
  hashKey?: string;
  hashKeyVersion?: string;
}

export interface ShadowReplayDependencies {
  buildInvocation?: typeof buildChannelResponseInvocation;
  client?: NonNullable<ReturnType<typeof getChannelClaudeClient>>;
  getConfigVersionId?: typeof getCurrentConfigVersionId;
  verifyTrace?: (input: ShadowReplayInput) => boolean | Promise<boolean>;
}

// Keep the generation ledger and the per-value evidence domain on the same
// reviewed policy version. The trace claim persists this shared version before
// any paid generation begins.
export const OFFICIAL_DOCS_REPLAY_EXECUTION_POLICY_VERSION = SHADOW_REPLAY_POLICY_VERSION;
export const MAX_OFFICIAL_DOCS_REPLAY_TOOL_CALLS = 8;
export const MAX_OFFICIAL_DOCS_REPLAY_INVOCATIONS = 4;

export interface VerifiedOfficialDocsReplayInput {
  trace: ResolvedShadowReplayTrace;
  invocation: ChannelResponseInvocation;
  /** Fingerprint already checked by the signed hydrated-context parity gate. */
  docsCorpusFingerprint: string;
  /**
   * Optional alternate-provider target prepared from this same verified
   * invocation. Only the default-off shadow target admission may supply it.
   */
  target?: VerifiedOfficialDocsReplayTarget;
}

export interface VerifiedOfficialDocsReplayTarget {
  provider: ModelProviderId;
  model: string;
  firstInvocation: InvocationPreparedSnapshot;
}

export interface VerifiedOfficialDocsReplayResult extends ShadowReplayGenerationCompletion {
  traceId: string;
  provider: ModelProviderId;
  model: string;
  returnedProvider: ModelProviderId | null;
  returnedModel: string | null;
  executionPolicyVersion: typeof OFFICIAL_DOCS_REPLAY_EXECUTION_POLICY_VERSION;
  completeFidelity: boolean;
  judgment?: ShadowReplayJudgeEvidence;
}

/** Raw output exists only for the duration of a trusted in-memory consumer. */
export interface TrustedOfficialDocsReplayOutput {
  readonly text: string;
  readonly outputHmac: string;
  readonly outputBytes: number;
  readonly generatorModel: string;
}

export interface VerifiedOfficialDocsReplayDependencies {
  client?: NonNullable<ReturnType<typeof getChannelClaudeClient>>;
  getDocsFingerprint?: typeof getDocsCorpusFingerprint;
  createKnowledgeHandlers?: typeof createKnowledgeToolHandlers;
  renewLease?: () => Promise<boolean>;
  monotonicNow?: () => number;
  outputConsumer?: (
    output: TrustedOfficialDocsReplayOutput,
  ) => Promise<ShadowReplayJudgeEvidence>;
}

export class OfficialDocsReplayBoundaryError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'OfficialDocsReplayBoundaryError';
  }
}

export class OfficialDocsReplayExecutionError extends Error {
  constructor(readonly completion: VerifiedOfficialDocsReplayResult) {
    super(completion.reason);
    this.name = 'OfficialDocsReplayExecutionError';
  }
}

export class OfficialDocsReplayOutputConsumerError extends Error {
  constructor(readonly completion: VerifiedOfficialDocsReplayResult) {
    super('replay_output_consumer_failed');
    this.name = 'OfficialDocsReplayOutputConsumerError';
  }
}

/** Prepare the exact alternate-provider request that will later be dispatched. */
export function prepareVerifiedOfficialDocsReplayTarget(
  input: Omit<VerifiedOfficialDocsReplayInput, 'target'>,
  target: Pick<VerifiedOfficialDocsReplayTarget, 'provider' | 'model'>,
  client: NonNullable<ReturnType<typeof getChannelClaudeClient>>,
): VerifiedOfficialDocsReplayTarget {
  assertOfficialDocsReplayPreflight(input);
  const prepared = {
    ...target,
    firstInvocation: client.prepareMessageInvocation(
      input.trace.question,
      undefined,
      input.invocation.requestTools,
      undefined,
      {
        ...input.invocation.processOptions,
        executionMode: 'replay',
        disableServerTools: true,
        allowedToolNames: OFFICIAL_DOCS_ALLOWED_TOOLS,
        maxIterations: 4,
        invocationHashKey: input.trace.identity.hashKey,
        invocationHashDomain: input.trace.identity.hashDomain,
        uncapped: true,
        modelOverride: target.model,
      },
    ),
  };
  assertTargetFirstInvocation(prepared);
  return prepared;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(',')}}`;
}

export function hashReplayValue(value: unknown, key: string): string {
  return createHmac('sha256', key).update(canonicalJson(value), 'utf8').digest('hex');
}

function resolveHashKey(explicit?: string): string | null {
  return explicit?.trim()
    || process.env.SHADOW_EVAL_HASH_KEY?.trim()
    || null;
}

function replaySafetyByName(tools: AddieTool[]): Map<string, AddieTool['replaySafety']> {
  return new Map(tools.map((tool) => [tool.name, tool.replaySafety]));
}

function withReplayKnowledgeHandlers(
  requestTools: RequestTools,
  wrap: (
    name: string,
    handler: (input: Record<string, unknown>) => Promise<string>,
  ) => (input: Record<string, unknown>) => Promise<string>,
): RequestTools {
  const pureLocalTools = KNOWLEDGE_TOOLS.filter((tool) => tool.replaySafety === 'pure_local');
  const handlers = createKnowledgeToolHandlers({ disableSearchTelemetry: true });
  const replayHandlers = new Map(requestTools.handlers);
  for (const tool of pureLocalTools) {
    const handler = handlers.get(tool.name);
    if (handler) replayHandlers.set(tool.name, wrap(tool.name, handler));
  }
  return {
    tools: [...requestTools.tools, ...pureLocalTools],
    handlers: replayHandlers,
  };
}

/** Execute Addie's real channel orchestration under a request-local fail-closed policy. */
export async function executeShadowReplay(
  input: ShadowReplayInput,
  dependencies: ShadowReplayDependencies = {},
): Promise<ShadowReplayResult> {
  const client = dependencies.client ?? getChannelClaudeClient();
  if (!client) throw new Error('channel_client_not_initialized');
  const buildInvocation = dependencies.buildInvocation ?? buildChannelResponseInvocation;
  const invocation: ChannelResponseInvocation = await buildInvocation({
    userId: input.userId,
    threadId: input.threadId,
    memberContext: input.memberContext,
    channelContext: input.channelContext,
    plan: input.plan,
    siRetrievalResult: input.siRetrievalResult,
  });
  const model = input.modelOverride ?? invocation.effectiveModel;
  // Resolve the configuration that this replay actually uses. The queued
  // value identifies the original production opportunity and must never be
  // relabelled as the replay configuration after a deployment.
  const resolveConfigVersionId = dependencies.getConfigVersionId ?? getCurrentConfigVersionId;
  const configVersionId = await resolveConfigVersionId();
  const key = resolveHashKey(input.hashKey);
  const hashKeyVersion = input.hashKeyVersion?.trim()
    || process.env.SHADOW_EVAL_HASH_KEY_VERSION?.trim()
    || null;
  const blockedCapabilities = new Set<string>();
  if (!key) blockedCapabilities.add('missing_hash_key');
  if (!hashKeyVersion) blockedCapabilities.add('missing_hash_key_version');
  if (input.sourceConfigVersionId == null) {
    blockedCapabilities.add('missing_source_config_version');
  }
  if (configVersionId == null) {
    blockedCapabilities.add('missing_replay_config_version');
  } else if (
    input.sourceConfigVersionId != null
    && configVersionId !== input.sourceConfigVersionId
  ) {
    blockedCapabilities.add(
      `config_version_drift:${input.sourceConfigVersionId}->${configVersionId}`,
    );
  }
  const serverToolStateKnown = typeof client.isWebSearchEnabled === 'function';
  if (!serverToolStateKnown) {
    blockedCapabilities.add('server_tool_state_unknown');
  } else if (client.isWebSearchEnabled()) {
    blockedCapabilities.add('disabled_server_tool:web_search');
  }
  const traceVerified = dependencies.verifyTrace
    ? await dependencies.verifyTrace(input)
    : false;
  if (!traceVerified) blockedCapabilities.add('unverified_replay_trace');
  if (input.modelOverride && input.modelOverride !== invocation.effectiveModel) {
    blockedCapabilities.add(`model_override:${input.modelOverride}`);
  }

  const preparedSnapshots: InvocationPreparedSnapshot[] = [];
  const schemaHashes = new Map<string, string>();
  const executions: MutableExecution[] = [];
  const pendingAllowed = new Map<string, MutableExecution[]>();
  const safety = replaySafetyByName([
    ...KNOWLEDGE_TOOLS,
    ...invocation.requestTools.tools,
  ]);
  const hash = (value: unknown): string => key ? hashReplayValue(value, key) : 'unavailable';

  // Do not spend production-model tokens on output that cannot enter an eval.
  // Every preflight capability, including a restricted trace verifier, is
  // deliberately required before generation. Incomplete replays record the
  // missing capability and exit without calling the model.
  if (blockedCapabilities.size > 0) {
    blockedCapabilities.add('generation_skipped_incomplete_replay');
    return {
      response: {
        text: '',
        tools_used: [],
        tool_executions: [],
        flagged: false,
        model_execution: {
          source: 'local',
          requested_provider: 'anthropic',
          requested_model: model,
          reason: 'no_provider_response',
        },
      },
      model,
      configVersionId,
      traceId: input.threadId,
      evidence: {
        complete_fidelity: false,
        hash_key_version: hashKeyVersion,
        trace_verified: traceVerified,
        system_block_hashes: [],
        schemas: [],
        executions: [],
        blocked_capabilities: [...blockedCapabilities].sort(),
      },
    };
  }

  const requestTools = withReplayKnowledgeHandlers(
    invocation.requestTools,
    (name, handler) => async (toolInput) => {
      const pending = pendingAllowed.get(name)?.shift();
      try {
        const result = await handler(toolInput);
        if (pending) {
          pending.result_sha256 = hash(result);
          pending.disposition = 'live_read';
        }
        return result;
      } catch (error) {
        if (pending) {
          pending.result_sha256 = hash('tool_execution_failed');
          pending.disposition = 'error';
        }
        blockedCapabilities.add(`tool_error:${name}`);
        throw error;
      }
    },
  );

  const response = await client.processMessage(
    input.question,
    undefined,
    requestTools,
    undefined,
    {
      ...invocation.processOptions,
      executionMode: 'replay',
      disableServerTools: true,
      invocationHashKey: key ?? undefined,
      invocationHashDomain: `addie-shadow-replay-evidence:${SHADOW_REPLAY_POLICY_VERSION}`,
      uncapped: true,
      modelOverride: model,
      onInvocationPrepared: (snapshot) => {
        if (preparedSnapshots.length === 0 && snapshot.iteration === 1 && snapshot.attempt === 1) {
          preparedSnapshots.push(snapshot);
          for (const schema of snapshot.tool_schemas) {
            schemaHashes.set(schema.name, schema.sha256);
          }
        }
      },
      toolExecutionPolicy: ({ toolName, input: toolInput, tool }) => {
        const classification = tool?.replaySafety ?? safety.get(toolName);
        const allowed = classification === 'pure_local';
        const disposition: ReplayDisposition = allowed
          ? 'live_read'
          : classification === 'mutation'
            ? 'blocked_mutation'
            : 'blocked_unknown';
        const execution: MutableExecution = {
          sequence: executions.length + 1,
          name: toolName,
          schema_sha256: schemaHashes.get(toolName) ?? null,
          input_sha256: hash(toolInput),
          result_sha256: allowed ? 'pending' : hash('tool_execution_blocked'),
          disposition,
        };
        executions.push(execution);
        if (allowed) {
          const pending = pendingAllowed.get(toolName) ?? [];
          pending.push(execution);
          pendingAllowed.set(toolName, pending);
        } else {
          blockedCapabilities.add(`${classification ?? 'unclassified'}:${toolName}`);
        }
        return { allowed };
      },
    },
  );

  const prepared = preparedSnapshots[0];
  const recordedCounts = new Map<string, number>();
  for (const execution of executions) {
    recordedCounts.set(execution.name, (recordedCounts.get(execution.name) ?? 0) + 1);
  }
  for (const toolExecution of response.tool_executions) {
    const remaining = recordedCounts.get(toolExecution.tool_name) ?? 0;
    if (remaining > 0) {
      recordedCounts.set(toolExecution.tool_name, remaining - 1);
      continue;
    }
    executions.push({
      sequence: toolExecution.sequence,
      name: toolExecution.tool_name,
      schema_sha256: schemaHashes.get(toolExecution.tool_name) ?? null,
      input_sha256: hash('unavailable_unknown_tool_input'),
      result_sha256: hash('unknown_tool_blocked'),
      disposition: 'blocked_unknown',
    });
    blockedCapabilities.add(`unclassified:${toolExecution.tool_name}`);
  }
  for (const execution of executions) {
    if (execution.result_sha256 === 'pending') {
      execution.result_sha256 = hash('tool_execution_missing_result');
      execution.disposition = 'error';
      blockedCapabilities.add(`missing_result:${execution.name}`);
    }
  }
  if (!prepared) blockedCapabilities.add('missing_invocation_snapshot');
  if (response.flagged) blockedCapabilities.add(`flagged_response:${response.flag_reason ?? 'unknown'}`);

  const schemas = prepared?.tool_schemas.map((schema) => ({
    name: schema.name,
    sha256: schema.sha256,
    replay_safety: safety.get(schema.name) ?? null,
  })) ?? [];
  const blocked = [...blockedCapabilities].sort();
  return {
    response,
    model,
    configVersionId,
    traceId: input.threadId,
    evidence: {
      complete_fidelity: blocked.length === 0
        && executions.every((execution) => execution.disposition === 'live_read'),
      hash_key_version: hashKeyVersion,
      trace_verified: traceVerified,
      system_block_hashes: prepared?.system_blocks.map((block) => block.sha256) ?? [],
      schemas,
      executions,
      blocked_capabilities: blocked,
    },
  };
}

function sameOrderedSnapshotItems(
  expected: Array<{ index: number; name?: string; sha256: string }>,
  actual: Array<{ index: number; name?: string; sha256: string }>,
): boolean {
  return expected.length === actual.length && expected.every((item, index) => {
    const candidate = actual[index];
    return candidate?.index === item.index
      && candidate?.name === item.name
      && candidate?.sha256 === item.sha256;
  });
}

function sourceReplayTarget(trace: ResolvedShadowReplayTrace): VerifiedOfficialDocsReplayTarget {
  return {
    provider: 'anthropic',
    model: trace.expected.effective_model,
    firstInvocation: {
      execution_mode: 'replay',
      model: trace.expected.effective_model,
      iteration: 1,
      attempt: 1,
      system_blocks: trace.expected.system_block_hmacs,
      tool_schemas: trace.expected.tool_schema_hmacs,
      message_payloads: trace.expected.message_payload_hmacs,
      message_count: trace.expected.message_count,
      provider_request_sha256: trace.expected.provider_request_hmac ?? '',
    },
  };
}

function assertTargetFirstInvocation(target: VerifiedOfficialDocsReplayTarget): void {
  const snapshot = target.firstInvocation;
  if (!target.model.trim() || target.model.length > 160) {
    throw new OfficialDocsReplayBoundaryError('target_model_invalid');
  }
  if (snapshot.execution_mode !== 'replay'
    || snapshot.model !== target.model
    || snapshot.iteration !== 1
    || snapshot.attempt !== 1
    || !/^[0-9a-f]{64}$/.test(snapshot.provider_request_sha256)) {
    throw new OfficialDocsReplayBoundaryError('target_invocation_invalid');
  }
}

function sameFirstInvocation(
  expected: InvocationPreparedSnapshot,
  actual: InvocationPreparedSnapshot,
): boolean {
  return expected.execution_mode === actual.execution_mode
    && expected.model === actual.model
    && expected.iteration === actual.iteration
    && expected.attempt === actual.attempt
    && expected.message_count === actual.message_count
    && expected.provider_request_sha256 === actual.provider_request_sha256
    && sameOrderedSnapshotItems(expected.system_blocks, actual.system_blocks)
    && sameOrderedSnapshotItems(expected.tool_schemas, actual.tool_schemas)
    && sameOrderedSnapshotItems(expected.message_payloads, actual.message_payloads);
}

function evidenceHmac(
  trace: ResolvedShadowReplayTrace,
  purpose: string,
  value: unknown,
): string {
  return createHmac('sha256', trace.identity.hashKey)
    .update(`${trace.identity.hashDomain}\0${OFFICIAL_DOCS_REPLAY_EXECUTION_POLICY_VERSION}\0`, 'utf8')
    .update(`${purpose}\0`, 'utf8')
    .update(canonicalJson(value), 'utf8')
    .digest('hex');
}

function exactAllowedNames(names: readonly string[] | undefined): boolean {
  return names?.length === OFFICIAL_DOCS_ALLOWED_TOOLS.length
    && OFFICIAL_DOCS_ALLOWED_TOOLS.every((name, index) => names[index] === name);
}

function assertOfficialDocsReplayPreflight(input: VerifiedOfficialDocsReplayInput): void {
  const { invocation, trace } = input;
  if (invocation.effectiveModel !== trace.expected.effective_model) {
    throw new OfficialDocsReplayBoundaryError('model_drift');
  }
  if (invocation.isAdmin
    || invocation.selectedToolSets.length !== 1
    || invocation.selectedToolSets[0] !== 'knowledge') {
    throw new OfficialDocsReplayBoundaryError('capability_policy_drift');
  }
  if (invocation.processOptions.disableServerTools !== true) {
    throw new OfficialDocsReplayBoundaryError('provider_tool_state_drift');
  }
  if (!exactAllowedNames(invocation.processOptions.allowedToolNames)
    || !exactAllowedNames(trace.expected.approved_tool_names)) {
    throw new OfficialDocsReplayBoundaryError('capability_policy_drift');
  }
  // The profiled production invocation deliberately uses only canonical global
  // schemas. Replay may replace handlers below, but must never add or override
  // a schema by name.
  if (invocation.requestTools.tools.length !== 0 || invocation.requestTools.handlers.size !== 0) {
    throw new OfficialDocsReplayBoundaryError('request_tool_override_present');
  }
}

function assertLaterInvocationBoundary(
  target: VerifiedOfficialDocsReplayTarget,
  snapshot: InvocationPreparedSnapshot,
): void {
  if (snapshot.execution_mode !== 'replay') {
    throw new OfficialDocsReplayBoundaryError('execution_mode_drift');
  }
  if (snapshot.model !== target.model) {
    throw new OfficialDocsReplayBoundaryError('model_drift');
  }
  if (!sameOrderedSnapshotItems(target.firstInvocation.system_blocks, snapshot.system_blocks)) {
    throw new OfficialDocsReplayBoundaryError('system_blocks_drift');
  }
  if (!sameOrderedSnapshotItems(target.firstInvocation.tool_schemas, snapshot.tool_schemas)
    || !exactAllowedNames(snapshot.tool_schemas.map(({ name }) => name))) {
    throw new OfficialDocsReplayBoundaryError('tool_schemas_drift');
  }
  if (!/^[0-9a-f]{64}$/.test(snapshot.provider_request_sha256)) {
    throw new OfficialDocsReplayBoundaryError('provider_request_hmac_unavailable');
  }
}

function assertInvocationPosition(
  previous: ShadowReplayInvocationEvidence | undefined,
  snapshot: InvocationPreparedSnapshot,
): void {
  if (!Number.isInteger(snapshot.iteration)
    || snapshot.iteration < 1
    || snapshot.iteration > 4
    || !Number.isInteger(snapshot.attempt)
    || snapshot.attempt < 1
    || snapshot.attempt > 4) {
    throw new OfficialDocsReplayBoundaryError('invocation_position_invalid');
  }
  if (!previous) {
    if (snapshot.iteration !== 1 || snapshot.attempt !== 1) {
      throw new OfficialDocsReplayBoundaryError('first_invocation_position_drift');
    }
    return;
  }
  const isNextRetry = snapshot.iteration === previous.iteration
    && snapshot.attempt === previous.attempt + 1;
  const isNextIteration = snapshot.iteration === previous.iteration + 1
    && snapshot.attempt === 1;
  if (!isNextRetry && !isNextIteration) {
    throw new OfficialDocsReplayBoundaryError('invocation_position_drift');
  }
}

function boundedUsage(value: number | undefined): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

function hasCompleteUsage(
  usage: AddieResponse['usage'],
): usage is NonNullable<AddieResponse['usage']> {
  if (!usage) return false;
  const values = [
    usage.input_tokens,
    usage.output_tokens,
    usage.cache_read_input_tokens ?? 0,
    usage.cache_creation_input_tokens ?? 0,
  ];
  return values.every((value) => Number.isSafeInteger(value) && value >= 0);
}

function generationLatencyMs(startedAt: number, completedAt: number): number | null {
  const duration = completedAt - startedAt;
  return Number.isFinite(duration) && duration >= 0 && duration <= 900_000
    ? Math.ceil(duration)
    : null;
}

/**
 * Generate one non-user-visible answer from an already authorized and parity-
 * checked official-docs invocation. Raw questions, tool payloads/results, and
 * output stay in memory; the returned completion is safe for the hash-only
 * generation ledger.
 */
export async function executeVerifiedOfficialDocsReplay(
  input: VerifiedOfficialDocsReplayInput,
  dependencies: VerifiedOfficialDocsReplayDependencies = {},
): Promise<VerifiedOfficialDocsReplayResult> {
  assertOfficialDocsReplayPreflight(input);
  const target = input.target ?? sourceReplayTarget(input.trace);
  assertTargetFirstInvocation(target);
  const client = dependencies.client ?? getChannelClaudeClient();
  if (!client) throw new OfficialDocsReplayBoundaryError('channel_client_not_initialized');
  if (!dependencies.renewLease) {
    throw new OfficialDocsReplayBoundaryError('lease_verifier_unavailable');
  }
  const getFingerprint = dependencies.getDocsFingerprint ?? getDocsCorpusFingerprint;
  if (getFingerprint() !== input.docsCorpusFingerprint) {
    throw new OfficialDocsReplayBoundaryError('docs_corpus_drift');
  }

  const canonicalTools = new Map(
    KNOWLEDGE_TOOLS
      .filter((tool) => OFFICIAL_DOCS_ALLOWED_TOOLS.includes(
        tool.name as (typeof OFFICIAL_DOCS_ALLOWED_TOOLS)[number],
      ))
      .map((tool) => [tool.name, tool]),
  );
  for (const name of OFFICIAL_DOCS_ALLOWED_TOOLS) {
    if (canonicalTools.get(name)?.replaySafety !== 'pure_local') {
      throw new OfficialDocsReplayBoundaryError('unsafe_tool_classification');
    }
  }

  const createHandlers = dependencies.createKnowledgeHandlers ?? createKnowledgeToolHandlers;
  const telemetryFreeHandlers = createHandlers({ disableSearchTelemetry: true });
  for (const name of OFFICIAL_DOCS_ALLOWED_TOOLS) {
    if (!telemetryFreeHandlers.has(name)) {
      throw new OfficialDocsReplayBoundaryError('replay_handler_unavailable');
    }
  }

  const invocations: ShadowReplayInvocationEvidence[] = [];
  const providerRequestHmacByIteration = new Map<number, string>();
  const toolExecutions: ShadowReplayToolEvidence[] = [];
  const blockedCapabilities = new Set<string>();
  const pendingAllowed = new Map<string, ShadowReplayToolEvidence[]>();
  const schemaHmacs = new Map(
    input.trace.expected.tool_schema_hmacs.map(({ name, sha256 }) => [name, sha256]),
  );

  const replayHandlers: RequestTools['handlers'] = new Map();
  for (const name of OFFICIAL_DOCS_ALLOWED_TOOLS) {
    const handler = telemetryFreeHandlers.get(name)!;
    replayHandlers.set(name, async (toolInput) => {
      const pending = pendingAllowed.get(name)?.shift();
      if (!pending) {
        blockedCapabilities.add('missing_policy_receipt');
        throw new OfficialDocsReplayBoundaryError('missing_policy_receipt');
      }
      try {
        const result = await handler(toolInput);
        pending.result_hmac = evidenceHmac(
          input.trace,
          `tool-result:${pending.sequence}:${name}`,
          result,
        );
        pending.disposition = 'live_read';
        return result;
      } catch (error) {
        pending.result_hmac = evidenceHmac(
          input.trace,
          `tool-result:${pending.sequence}:${name}`,
          'tool_execution_failed',
        );
        pending.disposition = 'error';
        blockedCapabilities.add('tool_execution_error');
        throw error;
      }
    });
  }

  const monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
  const generationStartedAt = monotonicNow();
  let response: AddieResponse;
  try {
    response = await client.processMessage(
      input.trace.question,
      undefined,
      // Handler-only override: provider schemas remain the exact canonical global
      // definitions signed at capture time.
      { tools: [], handlers: replayHandlers },
      undefined,
      {
        ...input.invocation.processOptions,
        executionMode: 'replay',
        disableServerTools: true,
        allowedToolNames: OFFICIAL_DOCS_ALLOWED_TOOLS,
        maxIterations: 4,
        invocationHashKey: input.trace.identity.hashKey,
        invocationHashDomain: input.trace.identity.hashDomain,
        uncapped: true,
        modelOverride: target.model,
        onInvocationPrepared: async (snapshot) => {
          if (invocations.length >= MAX_OFFICIAL_DOCS_REPLAY_INVOCATIONS) {
            throw new OfficialDocsReplayBoundaryError('invocation_limit_exceeded');
          }
          assertInvocationPosition(invocations.at(-1), snapshot);
          if (snapshot.attempt !== 1) {
            throw new OfficialDocsReplayBoundaryError('provider_retry_not_allowed');
          }
          if (snapshot.iteration === 1) {
            if (input.target) {
              if (!sameFirstInvocation(target.firstInvocation, snapshot)) {
                throw new OfficialDocsReplayBoundaryError('target_invocation_drift');
              }
            } else {
              const first = verifyShadowReplayFirstInvocation(input.trace, snapshot);
              if (!first.verified) {
                throw new OfficialDocsReplayBoundaryError(
                  first.reasons[0] ?? 'first_invocation_drift',
                );
              }
            }
          } else {
            assertLaterInvocationBoundary(target, snapshot);
          }
          const previousRequestHmac = providerRequestHmacByIteration.get(snapshot.iteration);
          if (previousRequestHmac && previousRequestHmac !== snapshot.provider_request_sha256) {
            throw new OfficialDocsReplayBoundaryError('provider_request_retry_drift');
          }
          if (!await dependencies.renewLease!()) {
            throw new OfficialDocsReplayBoundaryError('generation_lease_lost');
          }
          providerRequestHmacByIteration.set(snapshot.iteration, snapshot.provider_request_sha256);
          invocations.push({
            iteration: snapshot.iteration,
            attempt: snapshot.attempt,
            provider_request_hmac: snapshot.provider_request_sha256,
          });
        },
        toolExecutionPolicy: ({ toolName, input: toolInput, tool }) => {
          const sequence = toolExecutions.length + 1;
          if (sequence > MAX_OFFICIAL_DOCS_REPLAY_TOOL_CALLS) {
            blockedCapabilities.add('tool_call_limit_exceeded');
            return { allowed: false };
          }
          const approved = OFFICIAL_DOCS_ALLOWED_TOOLS.includes(
            toolName as (typeof OFFICIAL_DOCS_ALLOWED_TOOLS)[number],
          );
          const classifiedPureLocal = approved && tool?.replaySafety === 'pure_local';
          const allowed = classifiedPureLocal;
          const evidenceName = approved
            ? toolName as ShadowReplayToolEvidence['name']
            : 'unapproved_tool';
          const execution: ShadowReplayToolEvidence = {
            sequence,
            name: evidenceName,
            schema_hmac: approved ? schemaHmacs.get(toolName) ?? null : null,
            input_hmac: evidenceHmac(
              input.trace,
              `tool-input:${sequence}:${evidenceName}`,
              toolInput,
            ),
            result_hmac: allowed
              ? evidenceHmac(input.trace, `tool-result:${sequence}:${evidenceName}`, 'pending')
              : evidenceHmac(
                input.trace,
                `tool-result:${sequence}:${evidenceName}`,
                'tool_execution_blocked',
              ),
            disposition: allowed
              ? 'live_read'
              : approved
                ? 'blocked_policy'
                : 'blocked_unknown',
          };
          toolExecutions.push(execution);
          if (allowed) {
            const pending = pendingAllowed.get(toolName) ?? [];
            pending.push(execution);
            pendingAllowed.set(toolName, pending);
          } else if (!approved) {
            blockedCapabilities.add('unapproved_tool');
          } else {
            blockedCapabilities.add('unsafe_tool_classification');
          }
          return { allowed };
        },
      },
    );
  } catch (error) {
    const latencyMs = generationLatencyMs(generationStartedAt, monotonicNow());
    const reason = error instanceof OfficialDocsReplayBoundaryError
      ? error.reason
      : 'provider_execution_failed';
    for (const pending of pendingAllowed.values()) {
      for (const execution of pending) {
        execution.result_hmac = evidenceHmac(
          input.trace,
          `tool-result:${execution.sequence}:${execution.name}`,
          'tool_execution_interrupted',
        );
        execution.disposition = 'error';
      }
    }
    throw new OfficialDocsReplayExecutionError({
      traceId: input.trace.traceId,
      provider: target.provider,
      model: target.model,
      returnedProvider: null,
      returnedModel: null,
      executionPolicyVersion: OFFICIAL_DOCS_REPLAY_EXECUTION_POLICY_VERSION,
      completeFidelity: false,
      status: error instanceof OfficialDocsReplayBoundaryError ? 'blocked' : 'error',
      reason,
      outputHmac: null,
      outputBytes: 0,
      invocations,
      toolExecutions,
      blockedCapabilities: error instanceof OfficialDocsReplayBoundaryError
        ? [reason]
        : ['provider_execution_failed', 'usage_unavailable'],
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      usageAvailable: false,
      latencyMs,
    });
  }

  // Any execution not observed by the dispatch policy was unknown to the
  // handler map or provider-managed. Persist only a categorical placeholder.
  const recordedByPolicy = new Map<string, number>();
  for (const execution of toolExecutions) {
    if (execution.name === 'unapproved_tool') continue;
    recordedByPolicy.set(
      execution.name,
      (recordedByPolicy.get(execution.name) ?? 0) + 1,
    );
  }
  for (const execution of response.tool_executions) {
    const remaining = recordedByPolicy.get(execution.tool_name) ?? 0;
    if (remaining > 0) {
      recordedByPolicy.set(execution.tool_name, remaining - 1);
      continue;
    }
    if (toolExecutions.length >= MAX_OFFICIAL_DOCS_REPLAY_TOOL_CALLS) {
      blockedCapabilities.add('tool_call_limit_exceeded');
      break;
    }
    const sequence = toolExecutions.length + 1;
    toolExecutions.push({
      sequence,
      name: 'unapproved_tool',
      schema_hmac: null,
      input_hmac: evidenceHmac(input.trace, `tool-input:${sequence}:unapproved_tool`, 'unavailable'),
      result_hmac: evidenceHmac(input.trace, `tool-result:${sequence}:unapproved_tool`, 'blocked'),
      disposition: 'blocked_unknown',
    });
    blockedCapabilities.add('unexpected_tool_execution');
  }
  for (const pending of pendingAllowed.values()) {
    for (const execution of pending) {
      execution.result_hmac = evidenceHmac(
        input.trace,
        `tool-result:${execution.sequence}:${execution.name}`,
        'tool_execution_missing_result',
      );
      execution.disposition = 'error';
      blockedCapabilities.add('missing_tool_result');
    }
  }
  if (invocations.length === 0) blockedCapabilities.add('missing_invocation_snapshot');
  if (response.flagged) blockedCapabilities.add('flagged_response');
  const execution = response.model_execution;
  if (execution.source !== 'provider'
    || execution.requested_provider !== target.provider
    || execution.requested_model !== target.model) {
    blockedCapabilities.add('provider_identity_drift');
  }

  const guarded = guardBareJsonEnvelope(response.text, { pathTag: 'verified-docs-replay' });
  const validated = validateOutput(guarded.text);
  if (validated.flagged) blockedCapabilities.add('output_rejected');
  if (validated.sanitized.trim().length === 0) blockedCapabilities.add('empty_output');
  if (getFingerprint() !== input.docsCorpusFingerprint) {
    blockedCapabilities.add('docs_corpus_drift');
  }
  const latencyMs = generationLatencyMs(generationStartedAt, monotonicNow());
  const usageAvailable = hasCompleteUsage(response.usage);
  if (!usageAvailable) blockedCapabilities.add('usage_unavailable');
  if (latencyMs === null) blockedCapabilities.add('latency_unavailable');

  // The model output is never returned or persisted. Only evidence over the
  // exact bytes produced by the client leaves this scope.
  const outputBytes = Buffer.byteLength(validated.sanitized, 'utf8');
  const outputHmac = evidenceHmac(input.trace, 'output', validated.sanitized);
  const blocked = [...blockedCapabilities].sort();
  const completeFidelity = blocked.length === 0
    && invocations.length > 0
    && toolExecutions.every(({ disposition }) => disposition === 'live_read');
  const usage = usageAvailable ? response.usage : undefined;

  const completion: VerifiedOfficialDocsReplayResult = {
    traceId: input.trace.traceId,
    provider: target.provider,
    model: target.model,
    returnedProvider: execution.source === 'provider' ? execution.provider : null,
    returnedModel: execution.source === 'provider' ? execution.model : null,
    executionPolicyVersion: OFFICIAL_DOCS_REPLAY_EXECUTION_POLICY_VERSION,
    completeFidelity,
    status: completeFidelity ? 'succeeded' : 'blocked',
    reason: completeFidelity ? 'generation_succeeded' : blocked[0] ?? 'generation_blocked',
    outputHmac,
    outputBytes,
    invocations,
    toolExecutions,
    blockedCapabilities: blocked,
    inputTokens: boundedUsage(usage?.input_tokens),
    outputTokens: boundedUsage(usage?.output_tokens),
    cacheReadTokens: boundedUsage(usage?.cache_read_input_tokens),
    cacheWriteTokens: boundedUsage(usage?.cache_creation_input_tokens),
    usageAvailable,
    latencyMs,
  };
  if (!completeFidelity || !dependencies.outputConsumer) return completion;

  try {
    const judgment = await dependencies.outputConsumer(Object.freeze({
      text: validated.sanitized,
      outputHmac,
      outputBytes,
      generatorModel: target.model,
    }));
    return { ...completion, judgment };
  } catch {
    // Never allow a consumer exception (which may contain raw evidence) to
    // cross the replay boundary. The safe generation completion remains
    // available to the caller for atomic terminal persistence.
    throw new OfficialDocsReplayOutputConsumerError(completion);
  }
}
