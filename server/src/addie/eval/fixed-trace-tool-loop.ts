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
  /** Identity-only record for each dispatched model turn; never prompt data. */
  providerExposures: ReadonlyArray<{
    attempt: number;
    preparedProvider: PreparedModelInvocation['provider'];
    preparedModel: string;
    returnedProvider: ModelResponse['provider'];
    returnedModel: string;
  }>;
}

export interface FixedTraceToolLoopOptions {
  signal?: AbortSignal;
  maxIterations?: number;
  /** Deterministic adapter request validation before every model turn. */
  beforePrepare?: (request: ModelRequest) => void;
  beforeDispatch?: ModelRespondOptions['beforeDispatch'];
  /**
   * Evaluator-owned tool surface. This bypasses trace fixtures while retaining
   * the shared normalized model/tool continuation loop.
   */
  evaluatorToolEnvironment?: FixedTraceEvaluatorToolEnvironment;
}

export interface FixedTraceEvaluatorTool {
  definition: AddieTool;
  handler: ToolHandler;
  effect: FixedTraceToolFixture['effect'];
  resultStatus: FixedTraceToolFixture['resultStatus'];
}

export interface FixedTraceEvaluatorToolEnvironment {
  tools: readonly FixedTraceEvaluatorTool[];
  authorize: (input: {
    toolName: string;
    toolCallId: string;
    isMutation: boolean;
  }) => { allowed: boolean };
}

interface RegisteredTool {
  definition: AddieTool;
  validate: ValidateFunction;
  handler: ToolHandler;
  effect: FixedTraceToolFixture['effect'];
  resultStatus: FixedTraceToolFixture['resultStatus'];
  fixtureResult: string | null;
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

function registerTools(
  trace: FixedTraceCase,
  definitions: readonly AddieTool[],
  environment?: FixedTraceEvaluatorToolEnvironment,
): Map<string, RegisteredTool> {
  const ajv = new Ajv({ allErrors: false, strict: false });
  if (environment) {
    const evaluatorTools = new Map(environment.tools.map((tool) => [tool.definition.name, tool]));
    if (evaluatorTools.size !== environment.tools.length) {
      throw new FixedTraceToolLoopBoundaryError('duplicate_tool_definition');
    }
    const registered = new Map<string, RegisteredTool>();
    for (const sourceDefinition of definitions) {
      if (registered.has(sourceDefinition.name)) {
        throw new FixedTraceToolLoopBoundaryError('duplicate_tool_definition');
      }
      const tool = evaluatorTools.get(sourceDefinition.name);
      if (!tool || typeof tool.handler !== 'function') {
        throw new FixedTraceToolLoopBoundaryError('fixture_definition_mismatch');
      }
      const definition = deepFreeze(structuredClone(sourceDefinition));
      let validate: ValidateFunction;
      try {
        validate = ajv.compile(definition.input_schema);
      } catch {
        throw new FixedTraceToolLoopBoundaryError('tool_schema_invalid');
      }
      registered.set(definition.name, {
        definition,
        validate,
        handler: tool.handler,
        effect: tool.effect,
        resultStatus: tool.resultStatus,
        fixtureResult: null,
      });
    }
    if (registered.size !== evaluatorTools.size) {
      throw new FixedTraceToolLoopBoundaryError('fixture_definition_mismatch');
    }
    return registered;
  }
  const fixtures = new Map(trace.toolFixtures.map((fixture) => [fixture.name, fixture]));
  if (fixtures.size !== trace.toolFixtures.length) {
    throw new FixedTraceToolLoopBoundaryError('fixture_definition_mismatch');
  }
  const registered = new Map<string, RegisteredTool>();
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
    registered.set(definition.name, {
      definition,
      validate,
      handler: async () => ({
        status: fixture.resultStatus,
        model_context: fixture.result,
        user_summary: fixture.result,
      }),
      effect: fixture.effect,
      resultStatus: fixture.resultStatus,
      fixtureResult: fixture.result,
    });
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
  void registerTools(trace, definitions);
}

/** The same preflight for an evaluator-owned, non-fixture tool environment. */
export function validateFixedTraceToolLoopEnvironment(
  definitions: readonly AddieTool[],
  environment: FixedTraceEvaluatorToolEnvironment,
): void {
  // Registration does not read trace fields while an evaluator environment is
  // supplied. This empty placeholder prevents fixture facts from entering
  // direct admission.
  void registerTools({ toolFixtures: [] } as unknown as FixedTraceCase, definitions, environment);
}

function safeIterationLimit(toolCount: number, requested?: number): number {
  const limit = requested ?? Math.max(1, toolCount + 1);
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
  const registered = registerTools(trace, definitions, options.evaluatorToolEnvironment);
  const iterationLimit = safeIterationLimit(registered.size, options.maxIterations);
  const handlers = new Map<string, ToolHandler>();
  for (const [name, entry] of registered) handlers.set(name, entry.handler);
  const executeTool = createAddieToolExecutor(
    [...registered.values()].map((entry) => entry.definition),
    handlers,
    {
      executionMode: 'evaluation',
      policy: ({ toolName, toolCallId }) => {
        const tool = registered.get(toolName);
        return {
          allowed: tool !== undefined && (options.evaluatorToolEnvironment
            ? options.evaluatorToolEnvironment.authorize({
              toolName,
              toolCallId,
              isMutation: tool.effect === 'mutation',
            }).allowed
            : tool.effect !== 'mutation' || trace.expectation.mutationAuthorization === 'confirmed'),
        };
      },
    },
  );

  let messages = [...request.messages];
  const executions: FixedTraceToolExecution[] = [];
  const completedExecutions: ToolExecution[] = [];
  const invocations: PreparedModelInvocation[] = [];
  const providerExposures: FixedTraceToolLoopResult['providerExposures'][number][] = [];
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
    const prepared = invocations.at(-1);
    if (!prepared) throw new Error('fixed-trace model response was not preceded by a prepared invocation');
    providerExposures.push(Object.freeze({
      attempt: invocations.length,
      preparedProvider: prepared.provider,
      preparedModel: prepared.model,
      returnedProvider: response.provider,
      returnedModel: response.model,
    }));
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
        providerExposures: Object.freeze([...providerExposures]),
      };
    }

    if (executions.length + turn.toolCalls.length > registered.size) {
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
          effect: entry.effect,
          policyDisposition: blocked ? 'blocked' : 'allowed',
          resultStatus: entry.resultStatus,
          simulated: true,
        } as const;
        executions.push(Object.freeze({
          ...receipt,
          transcriptSha256: fixedTraceToolTranscriptSha256(
            receipt,
            entry.fixtureResult ?? event.executed.execution.result,
          ),
        }));
        results.push(event.executed.result);
      }
    }
    appendModelTurnContinuation(messages, response, results);
  }

  throw boundary('iteration_limit_exceeded');
}
