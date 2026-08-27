import type {
  ModelMessage,
  ModelProviderToolCallContent,
  ModelProviderToolResultContent,
  ModelResponse,
  ModelTextContent,
  ModelToolCallContent,
  ModelToolResultContent,
  ModelUsage,
} from './model-provider.js';

export type ModelTurnAction = 'complete' | 'truncated' | 'tool_use' | 'continue';

export interface InspectedModelTurn {
  action: ModelTurnAction;
  textBlocks: ReadonlyArray<ModelTextContent>;
  toolCalls: ReadonlyArray<ModelToolCallContent>;
  providerToolCalls: ReadonlyArray<ModelProviderToolCallContent>;
  providerToolResults: ReadonlyArray<ModelProviderToolResultContent>;
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

  resolve(): void {
    this.fallbackResponse = null;
  }

  takeFallback(): ModelResponse | null {
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

  acceptResponse(
    response: ModelResponse,
    options: { countUsage?: boolean } = {},
  ): InspectedModelTurn {
    if (!this.awaitingResponse) {
      throw new Error('Model loop response has no active iteration');
    }
    const turn = inspectModelTurn(response);
    if (options.countUsage !== false) {
      this.accumulatedUsage = addModelUsage(this.accumulatedUsage, response.usage);
    }
    this.awaitingResponse = false;
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
      action = 'tool_use';
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
    textBlocks: Object.freeze(response.content.filter((content) => content.type === 'text')),
    toolCalls: Object.freeze(response.content.filter((content) => content.type === 'tool_call')),
    providerToolCalls: Object.freeze(response.content.filter(
      (content) => content.type === 'provider_tool_call',
    )),
    providerToolResults: Object.freeze(response.content.filter(
      (content) => content.type === 'provider_tool_result',
    )),
  });
}
