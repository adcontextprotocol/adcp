import type {
  ModelMessage,
  ModelProvider,
  ModelProviderToolCallContent,
  ModelProviderToolResultContent,
  ModelRequest,
  ModelResponse,
  ModelRespondOptions,
  ModelTextContent,
  ModelToolCallContent,
  ModelToolResultContent,
  ModelUsage,
} from './model-provider.js';
import { collectModelResponse } from './events.js';

export type ModelTurnAction =
  | 'complete'
  | 'truncated'
  | 'execute_tools'
  | 'continue'
  | 'continue_provider_tools';

export interface InspectedModelTurn {
  action: ModelTurnAction;
  textBlocks: ReadonlyArray<ModelTextContent>;
  toolCalls: ReadonlyArray<ModelToolCallContent>;
  providerToolCalls: ReadonlyArray<ModelProviderToolCallContent>;
  providerToolResults: ReadonlyArray<ModelProviderToolResultContent>;
}

export interface AcceptedModelTurn extends InspectedModelTurn {
  response: ModelResponse;
  discardedRecoveryToolCalls: boolean;
}

/** Append one canonical assistant continuation and any custom-tool results. */
export function appendModelTurnContinuation(
  messages: ModelMessage[],
  response: ModelResponse,
  toolResults?: ModelToolResultContent[],
): void {
  messages.push({ role: 'assistant', content: response.content });
  if (toolResults) messages.push({ role: 'user', content: toolResults });
}

export type EmptyResponseRecoveryKind = 'initial' | 'post_tool';

export interface EmptyResponseRecoveryInvocation {
  /** Whether this invocation is the optional recovery sample. */
  isRecovery: boolean;
  /** Recovery after tool use is permanently text-only. */
  toolsAllowed: boolean;
  /** Recovery must never be transparently submitted more than once. */
  requiresExactlyOnce: boolean;
}

export interface EmptyResponseRecoveryEligibility {
  /** Evaluation/replay preserve the first empty terminal exactly. */
  allowInitial: boolean;
  /** Delivery-owned evidence that the first turn has not exposed work. */
  initialEligible: boolean;
  /** Delivery-owned evidence that a completed tool turn may be resampled. */
  postToolEligible: boolean;
}

/**
 * A successful canonical stop is safe to resample only when it has no visible
 * answer and every normalized block is side-effect-free. Provider-specific
 * finish diagnostics must not control orchestration.
 */
export function isSideEffectFreeEmptyModelResponse(
  response: ModelResponse,
  deliverableText: string,
): boolean {
  if (response.finishReason !== 'stop' || deliverableText.trim().length > 0) return false;
  return response.content.every((content) => (
    content.type === 'text'
    || (content.type === 'provider_state'
      && (content.kind === 'thinking' || content.kind === 'redacted_thinking'))
  ));
}

/**
 * State shared by delivery modes while resampling a side-effect-free empty
 * terminal. The original response remains authoritative if the optional
 * recovery call fails. Post-tool recovery is permanently text-only so a
 * malformed retry cannot repeat a mutation.
 */
export class EmptyResponseRecoveryState {
  private attemptedInitial = false;
  private attemptedPostTool = false;
  private fallbackResponse: ModelResponse | null = null;

  get pending(): boolean {
    return this.fallbackResponse !== null;
  }

  get toolsAllowed(): boolean {
    return !this.attemptedPostTool;
  }

  get postToolAttempted(): boolean {
    return this.attemptedPostTool;
  }

  hasAttempted(kind: EmptyResponseRecoveryKind): boolean {
    return kind === 'initial' ? this.attemptedInitial : this.attemptedPostTool;
  }

  /** Snapshot the recovery policy for one provider invocation. */
  prepareInvocation(): Readonly<EmptyResponseRecoveryInvocation> {
    return Object.freeze({
      isRecovery: this.pending,
      toolsAllowed: this.toolsAllowed,
      requiresExactlyOnce: this.pending,
    });
  }

  schedule(kind: EmptyResponseRecoveryKind, response: ModelResponse): boolean {
    if (this.pending || this.hasAttempted(kind)) return false;
    if (kind === 'initial') {
      this.attemptedInitial = true;
    } else {
      this.attemptedPostTool = true;
    }
    this.fallbackResponse = response;
    return true;
  }

  completeInvocation(invocation: EmptyResponseRecoveryInvocation): void {
    if (invocation.isRecovery) this.fallbackResponse = null;
  }

  fallbackAfterInvocationFailure(
    invocation: EmptyResponseRecoveryInvocation,
  ): ModelResponse | null {
    if (!invocation.isRecovery) return null;
    const response = this.fallbackResponse;
    this.fallbackResponse = null;
    return response;
  }
}

/** One monotonic iteration wall shared by provider-neutral model loops. */
export class ModelLoopBudget {
  private startedIterations = 0;

  constructor(readonly limit: number) {}

  get iteration(): number {
    return this.startedIterations;
  }

  get hasRemaining(): boolean {
    return this.startedIterations < this.limit;
  }

  startNext(): number {
    if (!this.hasRemaining) {
      throw new Error('Model loop iteration budget exhausted');
    }
    this.startedIterations++;
    return this.startedIterations;
  }
}

/**
 * Canonical state boundary for a provider-neutral model loop. It owns the
 * logical turn wall, normalized usage, one-response-per-turn discipline, and
 * optional empty-terminal recovery state. Delivery adapters still own
 * transport retries and user-facing events.
 */
export class ModelTurnLoopState {
  readonly emptyResponseRecovery = new EmptyResponseRecoveryState();
  private readonly budget: ModelLoopBudget;
  private accumulatedUsage: ModelUsage = { inputTokens: 0, outputTokens: 0 };
  private awaitingResponse = false;

  constructor(limit: number) {
    this.budget = new ModelLoopBudget(limit);
  }

  get limit(): number {
    return this.budget.limit;
  }

  get iteration(): number {
    return this.budget.iteration;
  }

  get hasRemaining(): boolean {
    return this.budget.hasRemaining;
  }

  get usage(): ModelUsage {
    return { ...this.accumulatedUsage };
  }

  startNext(): number {
    if (this.awaitingResponse) {
      throw new Error('Previous model loop iteration has no response');
    }
    const iteration = this.budget.startNext();
    this.awaitingResponse = true;
    return iteration;
  }

  /** Begin one logical turn whose transport attempts share this state slot. */
  beginNext(): ActiveModelTurn {
    return new ActiveModelTurn(this, this.startNext());
  }

  acceptResponse(
    response: ModelResponse,
    options: { countUsage?: boolean } = {},
  ): AcceptedModelTurn {
    if (!this.awaitingResponse) {
      throw new Error('Model loop response has no active iteration');
    }
    // Post-tool recovery is permanently text-only. A malformed provider
    // response must not be able to request the same mutation a second time.
    const discardedRecoveryToolCalls = this.emptyResponseRecovery.postToolAttempted
      && response.finishReason === 'tool_calls';
    const acceptedResponse: ModelResponse = discardedRecoveryToolCalls
      ? {
          ...response,
          finishReason: 'stop',
          providerFinishReason: 'end_turn',
          content: [],
        }
      : response;
    const turn = inspectModelTurn(acceptedResponse);
    if (options.countUsage !== false) {
      this.accumulatedUsage = addModelUsage(this.accumulatedUsage, acceptedResponse.usage);
    }
    this.awaitingResponse = false;
    return Object.freeze({
      ...turn,
      response: acceptedResponse,
      discardedRecoveryToolCalls,
    });
  }

  /** Schedule one safe empty-terminal retry from canonical turn state. */
  scheduleEmptyResponseRecovery(
    response: ModelResponse,
    deliverableText: string,
    eligibility: EmptyResponseRecoveryEligibility,
  ): EmptyResponseRecoveryKind | null {
    if (
      !this.hasRemaining
      || !isSideEffectFreeEmptyModelResponse(response, deliverableText)
    ) return null;
    if (
      eligibility.allowInitial
      && eligibility.initialEligible
      && this.iteration === 1
      && this.emptyResponseRecovery.schedule('initial', response)
    ) return 'initial';
    if (
      eligibility.postToolEligible
      && this.emptyResponseRecovery.schedule('post_tool', response)
    ) return 'post_tool';
    return null;
  }
}

/**
 * One active logical model turn. Sequential transport attempts are allowed so
 * delivery adapters can retain their retry policy and event timing, but only
 * one normalized response can be accepted into the common loop.
 */
export class ActiveModelTurn {
  private invocationInFlight = false;
  private accepted = false;

  constructor(
    private readonly loop: ModelTurnLoopState,
    readonly iteration: number,
  ) {}

  async invoke(
    provider: ModelProvider,
    request: ModelRequest,
    options?: ModelRespondOptions,
  ): Promise<ModelResponse> {
    if (this.accepted) throw new Error('Model turn already accepted a response');
    if (this.invocationInFlight) throw new Error('Model turn provider invocation already in flight');
    this.invocationInFlight = true;
    try {
      return await collectModelResponse(
        provider.respond(request, options),
        provider.id,
      );
    } finally {
      this.invocationInFlight = false;
    }
  }

  acceptResponse(
    response: ModelResponse,
    options: { countUsage?: boolean } = {},
  ): AcceptedModelTurn {
    if (this.invocationInFlight) {
      throw new Error('Cannot accept a response while provider invocation is in flight');
    }
    if (this.accepted) throw new Error('Model turn already accepted a response');
    const turn = this.loop.acceptResponse(response, options);
    this.accepted = true;
    return turn;
  }
}

/** Accumulate normalized usage without inventing absent provider cache metrics. */
export function addModelUsage(total: ModelUsage, usage: ModelUsage): ModelUsage {
  return {
    inputTokens: total.inputTokens + usage.inputTokens,
    outputTokens: total.outputTokens + usage.outputTokens,
    ...(total.cacheWriteTokens !== undefined || usage.cacheWriteTokens !== undefined
      ? { cacheWriteTokens: (total.cacheWriteTokens ?? 0) + (usage.cacheWriteTokens ?? 0) }
      : {}),
    ...(total.cacheReadTokens !== undefined || usage.cacheReadTokens !== undefined
      ? { cacheReadTokens: (total.cacheReadTokens ?? 0) + (usage.cacheReadTokens ?? 0) }
      : {}),
  };
}

/**
 * Interpret one already-validated provider response for common orchestration.
 * Provider-specific finish values remain diagnostic only; decisions use the
 * canonical finish reason and canonical content variants exclusively.
 */
export function inspectModelTurn(response: ModelResponse): InspectedModelTurn {
  const textBlocks = Object.freeze(response.content.filter((content) => content.type === 'text'));
  const toolCalls = Object.freeze(response.content.filter((content) => content.type === 'tool_call'));
  const providerToolCalls = Object.freeze(response.content.filter(
    (content) => content.type === 'provider_tool_call',
  ));
  const providerToolResults = Object.freeze(response.content.filter(
    (content) => content.type === 'provider_tool_result',
  ));
  let action: ModelTurnAction;
  switch (response.finishReason) {
    case 'stop':
    case 'refusal':
      action = 'complete';
      break;
    case 'length':
      action = 'truncated';
      break;
    case 'tool_calls':
      // A provider-managed tool is continuation state, not an application
      // mutation. When custom and provider-managed calls coexist, the custom
      // calls must execute before the next model turn. A malformed tool-call
      // finish with no canonical calls remains terminal and side-effect free.
      action = toolCalls.length > 0
        ? 'execute_tools'
        : providerToolCalls.length > 0
          ? 'continue_provider_tools'
          : 'complete';
      break;
    case 'continue':
      action = 'continue';
      break;
    default: {
      const exhaustiveReason: never = response.finishReason;
      throw new Error(`Unhandled model finish reason: ${String(exhaustiveReason)}`);
    }
  }

  return Object.freeze({
    action,
    textBlocks,
    toolCalls,
    providerToolCalls,
    providerToolResults,
  });
}
