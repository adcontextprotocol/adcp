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
import type {
  FixedTraceBoundaryReason,
  FixedTraceCase,
  FixedTraceToolFixture,
  FixedTraceToolObservation,
} from './fixed-trace-suite.js';

const MAX_ITERATIONS = 8;

export type FixedTraceToolLoopReason = FixedTraceBoundaryReason;

export class FixedTraceToolLoopBoundaryError extends Error {
  constructor(readonly reason: FixedTraceToolLoopReason) {
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

function safeIterationLimit(trace: FixedTraceCase, requested?: number): number {
  const limit = requested ?? Math.max(1, trace.toolFixtures.length + 1);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ITERATIONS) {
    throw new RangeError(`Fixed trace iteration limit must be between 1 and ${MAX_ITERATIONS}`);
  }
  return limit;
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

  while (modelLoop.hasRemaining) {
    const activeTurn = modelLoop.beginNext();
    const iteration = activeTurn.iteration;
    const response = await activeTurn.invoke(provider, {
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
    }, {
      signal: options.signal,
      beforeDispatch: async (prepared) => {
        invocations.push(prepared);
        await options.beforeDispatch?.(prepared);
      },
    });
    const turn = activeTurn.acceptResponse(response);

    if (turn.providerToolCalls.length > 0 || turn.providerToolResults.length > 0) {
      throw new FixedTraceToolLoopBoundaryError('provider_continuation_not_allowed');
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
      throw new FixedTraceToolLoopBoundaryError('tool_call_limit_exceeded');
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
        throw new FixedTraceToolLoopBoundaryError('duplicate_tool_call');
      }
      const entry = registered.get(call.name);
      if (!entry) throw new FixedTraceToolLoopBoundaryError('unknown_tool_call');
      if (!entry.validate(call.input)) {
        throw new FixedTraceToolLoopBoundaryError('tool_input_invalid');
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
        executions.push(Object.freeze({
          sequence: event.sequence,
          name: event.call.name,
          description: entry.definition.description,
          input: deepFreeze(structuredClone(event.call.input)),
          effect: entry.fixture.effect,
          policyDisposition: blocked ? 'blocked' : 'allowed',
          resultStatus: entry.fixture.resultStatus,
          simulated: true,
        }));
        results.push(event.executed.result);
      }
    }
    appendModelTurnContinuation(messages, response, results);
  }

  throw new FixedTraceToolLoopBoundaryError('iteration_limit_exceeded');
}
