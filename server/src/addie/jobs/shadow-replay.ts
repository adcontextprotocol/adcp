import { createHmac } from 'node:crypto';
import type { AddieResponse, InvocationPreparedSnapshot, RequestTools } from '../claude-client.js';
import type { MemberContext } from '../member-context.js';
import type { SIRetrievalResult } from '../services/si-retriever.js';
import type { ThreadContext } from '../thread-service.js';
import type { AddieTool } from '../types.js';
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
import {
  SHADOW_REPLAY_POLICY_VERSION,
  type ShadowReplayEvidence,
} from './shadow-eval-metadata.js';

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
