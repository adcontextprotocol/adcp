import { describe, expect, it } from 'vitest';
import type {
  ModelFinishReason,
  ModelMessageContent,
  ModelResponse,
} from '../../../src/addie/model-providers/model-provider.js';
import { inspectModelTurn } from '../../../src/addie/model-providers/model-turn.js';

function response(
  finishReason: ModelFinishReason,
  content: ModelMessageContent[] = [],
): ModelResponse {
  return {
    provider: 'anthropic',
    model: 'test-model',
    id: 'test-response',
    finishReason,
    providerFinishReason: 'provider-value-must-not-drive-orchestration',
    usage: { inputTokens: 1, outputTokens: 1 },
    content,
  };
}

const partitionedContent: ModelMessageContent[] = [
  { type: 'text', text: 'before' },
  { type: 'tool_call', id: 'tool-1', name: 'search_docs', input: { query: 'test' } },
  {
    type: 'provider_tool_call',
    provider: 'anthropic',
    id: 'provider-1',
    name: 'web_search',
    inputKeys: ['query'],
  },
  {
    type: 'provider_tool_result',
    provider: 'anthropic',
    toolCallId: 'provider-1',
    name: 'web_search',
    resultCount: 1,
    isError: false,
  },
  { type: 'text', text: 'after' },
];

describe('inspectModelTurn', () => {
  it.each([
    ['stop', 'complete'],
    ['refusal', 'complete'],
    ['length', 'truncated'],
    ['tool_calls', 'tool_use'],
    ['continue', 'continue'],
  ] as const)('maps canonical %s without consulting provider diagnostics', (finishReason, action) => {
    expect(inspectModelTurn(response(finishReason)).action).toBe(action);
  });

  it('partitions canonical content while retaining text block order', () => {
    const turn = inspectModelTurn(response('tool_calls', partitionedContent));

    expect(turn.textBlocks.map((block) => block.text)).toEqual(['before', 'after']);
    expect(turn.toolCalls.map((call) => call.id)).toEqual(['tool-1']);
    expect(turn.providerToolCalls.map((call) => call.id)).toEqual(['provider-1']);
    expect(turn.providerToolResults.map((result) => result.toolCallId)).toEqual(['provider-1']);
    expect(Object.isFrozen(turn)).toBe(true);
    expect(Object.isFrozen(turn.toolCalls)).toBe(true);
  });
});
