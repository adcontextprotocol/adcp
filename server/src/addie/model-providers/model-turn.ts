import type {
  ModelProviderToolCallContent,
  ModelProviderToolResultContent,
  ModelResponse,
  ModelTextContent,
  ModelToolCallContent,
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
