import Ajv, { type ValidateFunction } from 'ajv';
import type { AddieTool } from '../types.js';
import { buildModelToolDefinitions } from '../tool-wire-shape.js';
import {
  appendModelTurnContinuation,
  ModelTurnLoopState,
} from '../model-providers/model-turn.js';
import type {
  ModelProvider,
  ModelRequest,
  ModelRespondOptions,
  ModelResponse,
  ModelUsage,
  PreparedModelInvocation,
} from '../model-providers/model-provider.js';
import {
  createAddieToolExecutor,
  executeAddieToolCalls,
  type ToolExecution,
  type ToolHandler,
} from '../model-providers/tool-orchestration.js';
import { enforceFailedLookupEvidenceBoundary } from '../failed-lookup-evidence.js';
import { fixedTraceToolTranscriptSha256 } from './fixed-trace-suite.js';
import type {
  FixedTraceBoundaryReason,
  FixedTraceCase,
  FixedTraceRejectedToolCall,
  FixedTraceToolFixture,
  FixedTraceToolObservation,
} from './fixed-trace-suite.js';

// The bounded full-meeting compatibility route can legitimately use its exact
// 11-tool union, followed by one final model turn. This applies only to the
// synthetic replay harness, never to production request routing.
export const MAX_FIXED_TRACE_TOOL_LOOP_ITERATIONS = 12;

export type FixedTraceToolLoopReason = FixedTraceBoundaryReason;

export interface FixedTraceToolLoopCheckpoint {
  usage: ModelUsage;
  tools: ReadonlyArray<FixedTraceToolExecution>;
  rejectedToolCalls: ReadonlyArray<FixedTraceRejectedToolCall>;
}

export class FixedTraceToolLoopBoundaryError extends Error {
  constructor(
    readonly reason: FixedTraceToolLoopReason,
    readonly checkpoint?: FixedTraceToolLoopCheckpoint,
  ) {
    super(reason);
    this.name = 'FixedTraceToolLoopBoundaryError';
  }
}

export interface FixedTraceToolExecution extends FixedTraceToolObservation {
  sequence: number;
}

export interface FixedTraceToolLoopResult {
  response: ModelResponse;
  text: string;
  localReplacementReason: string | null;
  iterations: number;
  usage: ModelUsage;
  tools: ReadonlyArray<FixedTraceToolExecution>;
  invocations: ReadonlyArray<PreparedModelInvocation>;
}

export interface FixedTraceToolLoopOptions {
  signal?: AbortSignal;
  maxIterations?: number;
  /** Deterministic adapter request validation before every model turn. */
  beforePrepare?: (request: ModelRequest) => void;
  beforeDispatch?: ModelRespondOptions['beforeDispatch'];
}

interface RegisteredFixture {
  fixture: FixedTraceToolFixture;
  definition: AddieTool;
  validate: ValidateFunction;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function snapshotRequest(request: ModelRequest): ModelRequest {
  return deepFreeze(structuredClone(request));
}

function validateInitialRequest(request: ModelRequest): void {
  if (request.tools.length > 0) {
    throw new FixedTraceToolLoopBoundaryError('duplicate_tool_definition');
  }
  if ((request.providerTools?.length ?? 0) > 0) {
    throw new FixedTraceToolLoopBoundaryError('provider_tool_not_allowed');
  }
  if (request.messages.some((message) => message.content.some(
    (content) => content.type !== 'text' && content.type !== 'image' && content.type !== 'document',
  ))) {
    throw new FixedTraceToolLoopBoundaryError('preexisting_tool_state');
  }
}

function registerFixtures(
  trace: FixedTraceCase,
  definitions: readonly AddieTool[],
): Map<string, RegisteredFixture> {
  const ajv = new Ajv({ allErrors: false, strict: false });
  const fixtures = new Map(trace.toolFixtures.map((fixture) => [fixture.name, fixture]));
  if (fixtures.size !== trace.toolFixtures.length) {
    throw new FixedTraceToolLoopBoundaryError('fixture_definition_mismatch');
  }
  const registered = new Map<string, RegisteredFixture>();
  for (const sourceDefinition of definitions) {
    if (registered.has(sourceDefinition.name)) {
      throw new FixedTraceToolLoopBoundaryError('duplicate_tool_definition');
    }
    const fixture = fixtures.get(sourceDefinition.name);
    if (!fixture) throw new FixedTraceToolLoopBoundaryError('fixture_definition_mismatch');
    const definition = deepFreeze(structuredClone(sourceDefinition));
    let validate: ValidateFunction;
    try {
      validate = ajv.compile(definition.input_schema);
    } catch {
      throw new FixedTraceToolLoopBoundaryError('tool_schema_invalid');
    }
    registered.set(definition.name, { fixture, definition, validate });
  }
  if (registered.size !== fixtures.size) {
    throw new FixedTraceToolLoopBoundaryError('fixture_definition_mismatch');
  }
  return registered;
}

/**
 * Validate the exact fixture/definition registration contract without making
 * a model request. The runner invokes this before routing so deterministic
 * schema and fixture errors cannot spend a router call; execution uses the
 * same registration primitive again against its frozen request snapshot.
 */
export function validateFixedTraceToolLoopFixtures(
  trace: FixedTraceCase,
  definitions: readonly AddieTool[],
): void {
  void registerFixtures(trace, definitions);
}

function safeIterationLimit(trace: FixedTraceCase, requested?: number): number {
  const limit = requested ?? Math.max(1, trace.toolFixtures.length + 1);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_FIXED_TRACE_TOOL_LOOP_ITERATIONS) {
    throw new RangeError(`Fixed trace iteration limit must be between 1 and ${MAX_FIXED_TRACE_TOOL_LOOP_ITERATIONS}`);
  }
  return limit;
}

function rejectedToolCalls(
  reason: FixedTraceToolLoopReason,
  calls: ReadonlyArray<{ name: string }>,
): ReadonlyArray<FixedTraceRejectedToolCall> {
  return Object.freeze(calls.map((call) => Object.freeze({ name: call.name, reason })));
}

/**
 * Execute one synthetic trace through the normalized provider boundary.
 *
 * Only static fixture handlers are registered. Production handlers are never
 * accepted by this API, and a fixture classified as a mutation is authorized
 * only when the trace contains an explicit confirmation. Even then the result
 * is a simulation string from the immutable corpus, not a real side effect.
 */
export async function executeFixedTraceToolLoop(
  provider: ModelProvider,
  initialRequest: ModelRequest,
  trace: FixedTraceCase,
  definitions: readonly AddieTool[],
  options: FixedTraceToolLoopOptions = {},
): Promise<FixedTraceToolLoopResult> {
  const request = snapshotRequest(initialRequest);
  validateInitialRequest(request);
  const { toolChoice: initialToolChoice, ...requestWithoutToolChoice } = request;
  const registered = registerFixtures(trace, definitions);
  const iterationLimit = safeIterationLimit(trace, options.maxIterations);
  const handlers = new Map<string, ToolHandler>();
  for (const [name, entry] of registered) {
    handlers.set(name, async () => ({
      status: entry.fixture.resultStatus,
      model_context: entry.fixture.result,
      user_summary: entry.fixture.result,
    }));
  }
  const executeTool = createAddieToolExecutor(
    [...registered.values()].map((entry) => entry.definition),
    handlers,
    {
      executionMode: 'evaluation',
      policy: ({ toolName }) => {
        const fixture = registered.get(toolName)?.fixture;
        return {
          allowed: fixture !== undefined && (
            fixture.effect !== 'mutation'
            || trace.expectation.mutationAuthorization === 'confirmed'
          ),
        };
      },
    },
  );

  let messages = [...request.messages];
  const executions: FixedTraceToolExecution[] = [];
  const completedExecutions: ToolExecution[] = [];
  const invocations: PreparedModelInvocation[] = [];
  const seenCallIds = new Set<string>();
  const seenToolNames = new Set<string>();
  const modelLoop = new ModelTurnLoopState(iterationLimit);
  const boundary = (
    reason: FixedTraceToolLoopReason,
    calls: ReadonlyArray<{ name: string }> = [],
  ): FixedTraceToolLoopBoundaryError => (
    new FixedTraceToolLoopBoundaryError(reason, {
      usage: modelLoop.usage,
      tools: Object.freeze([...executions]),
      rejectedToolCalls: rejectedToolCalls(reason, calls),
    })
  );

  while (modelLoop.hasRemaining) {
    const activeTurn = modelLoop.beginNext();
    const iteration = activeTurn.iteration;
    const modelRequest: ModelRequest = {
      ...requestWithoutToolChoice,
      messages,
      tools: buildModelToolDefinitions(
        [...registered.values()].map((entry) => entry.definition),
      ),
      providerTools: [],
      // Production's official-docs profile forces search_docs only on the
      // first turn. Requiring it again after the fixture result would create
      // a duplicate call and make replay diverge from the live loop.
      ...(iteration === 1 && initialToolChoice ? { toolChoice: initialToolChoice } : {}),
    };
    options.beforePrepare?.(modelRequest);
    const response = await activeTurn.invoke(provider, modelRequest, {
      signal: options.signal,
      beforeDispatch: async (prepared) => {
        invocations.push(prepared);
        await options.beforeDispatch?.(prepared);
      },
    });
    const turn = activeTurn.acceptResponse(response);

    if (turn.providerToolCalls.length > 0 || turn.providerToolResults.length > 0) {
      throw boundary('provider_continuation_not_allowed');
    }
    if (turn.action === 'continue') {
      appendModelTurnContinuation(messages, response);
      continue;
    }
    if (turn.action !== 'execute_tools') {
      const evidenceBoundary = enforceFailedLookupEvidenceBoundary(
        turn.textBlocks.map((content) => content.text).join(''),
        completedExecutions,
      );
      return {
        response,
        text: evidenceBoundary.text,
        localReplacementReason: evidenceBoundary.reason,
        iterations: iteration,
        usage: modelLoop.usage,
        tools: Object.freeze([...executions]),
        invocations: Object.freeze([...invocations]),
      };
    }

    if (executions.length + turn.toolCalls.length > trace.toolFixtures.length) {
      throw boundary('tool_call_limit_exceeded', turn.toolCalls);
    }
    const calls = turn.toolCalls.map((call) => deepFreeze(structuredClone(call)));
    const batchCallIds = new Set<string>();
    const batchToolNames = new Set<string>();
    for (const call of calls) {
      if (
        seenCallIds.has(call.id)
        || seenToolNames.has(call.name)
        || batchCallIds.has(call.id)
        || batchToolNames.has(call.name)
      ) {
        throw boundary('duplicate_tool_call', calls);
      }
      const entry = registered.get(call.name);
      if (!entry) throw boundary('unknown_tool_call', calls);
      if (!entry.validate(call.input)) {
        throw boundary('tool_input_invalid', calls);
      }
      batchCallIds.add(call.id);
      batchToolNames.add(call.name);
    }

    const results = [];
    for await (const event of executeAddieToolCalls(calls, executeTool, executions.length)) {
      if (event.type === 'start') {
        seenCallIds.add(event.call.id);
        seenToolNames.add(event.call.name);
      } else {
        const entry = registered.get(event.call.name)!;
        const blocked = event.executed.execution.blocked_by_policy === true;
        completedExecutions.push(event.executed.execution);
        const receipt = {
          sequence: event.sequence,
          callId: event.executed.result.toolCallId,
          name: event.call.name,
          description: entry.definition.description,
          input: deepFreeze(structuredClone(event.call.input)),
          effect: entry.fixture.effect,
          policyDisposition: blocked ? 'blocked' : 'allowed',
          resultStatus: entry.fixture.resultStatus,
          simulated: true,
        } as const;
        executions.push(Object.freeze({
          ...receipt,
          transcriptSha256: fixedTraceToolTranscriptSha256(receipt, entry.fixture.result),
        }));
        results.push(event.executed.result);
      }
    }
    appendModelTurnContinuation(messages, response, results);
  }

  throw boundary('iteration_limit_exceeded');
}
