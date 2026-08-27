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
