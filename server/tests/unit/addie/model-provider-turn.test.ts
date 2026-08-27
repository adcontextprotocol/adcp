import { describe, expect, it } from 'vitest';
import type {
  ModelFinishReason,
  ModelMessageContent,
  ModelResponse,
} from '../../../src/addie/model-providers/model-provider.js';
import {
  addModelUsage,
  EmptyResponseRecoveryState,
  inspectModelTurn,
  ModelLoopBudget,
  ModelTurnLoopState,
} from '../../../src/addie/model-providers/model-turn.js';

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

describe('addModelUsage', () => {
  it('accumulates token and cache metrics', () => {
    expect(addModelUsage(
      { inputTokens: 10, outputTokens: 4, cacheWriteTokens: 3 },
      { inputTokens: 6, outputTokens: 2, cacheReadTokens: 5 },
    )).toEqual({
      inputTokens: 16,
      outputTokens: 6,
      cacheWriteTokens: 3,
      cacheReadTokens: 5,
    });
  });

  it('does not invent cache metrics when providers omit them', () => {
    expect(addModelUsage(
      { inputTokens: 1, outputTokens: 2 },
      { inputTokens: 3, outputTokens: 4 },
    )).toEqual({ inputTokens: 4, outputTokens: 6 });
  });
});

describe('EmptyResponseRecoveryState', () => {
  it('retains the authoritative response until recovery succeeds', () => {
    const state = new EmptyResponseRecoveryState();
    const original = response('stop', []);

    expect(state.schedule('initial', original)).toBe(true);
    expect(state.pending).toBe(true);
    expect(state.toolsAllowed).toBe(true);
    expect(state.schedule('post_tool', original)).toBe(false);

    state.resolve();
    expect(state.pending).toBe(false);
    expect(state.hasAttempted('initial')).toBe(true);
    expect(state.schedule('initial', original)).toBe(false);
  });

  it('returns the original response when recovery fails', () => {
    const state = new EmptyResponseRecoveryState();
    const original = response('stop', []);

    state.schedule('initial', original);
    expect(state.takeFallback()).toBe(original);
    expect(state.pending).toBe(false);
  });

  it('makes post-tool recovery permanently text-only', () => {
    const state = new EmptyResponseRecoveryState();
    const original = response('stop', []);

    expect(state.schedule('post_tool', original)).toBe(true);
    expect(state.toolsAllowed).toBe(false);
    expect(state.postToolAttempted).toBe(true);

    state.resolve();
    expect(state.toolsAllowed).toBe(false);
    expect(state.schedule('post_tool', original)).toBe(false);
  });
});

describe('ModelLoopBudget', () => {
  it('issues monotonic iterations up to the configured wall', () => {
    const budget = new ModelLoopBudget(2);

    expect(budget.iteration).toBe(0);
    expect(budget.hasRemaining).toBe(true);
    expect(budget.startNext()).toBe(1);
    expect(budget.startNext()).toBe(2);
    expect(budget.iteration).toBe(2);
    expect(budget.hasRemaining).toBe(false);
    expect(() => budget.startNext()).toThrow('Model loop iteration budget exhausted');
  });

  it('starts exhausted when the configured wall is zero', () => {
    const budget = new ModelLoopBudget(0);

    expect(budget.hasRemaining).toBe(false);
    expect(budget.iteration).toBe(0);
  });
});

describe('ModelTurnLoopState', () => {
  it('accepts one canonical response per iteration and accumulates usage', () => {
    const loop = new ModelTurnLoopState(2);
    const first = response('stop', [{ type: 'text', text: 'done' }]);
    first.usage = { inputTokens: 5, outputTokens: 2, cacheReadTokens: 3 };

    expect(loop.startNext()).toBe(1);
    expect(loop.acceptResponse(first).action).toBe('complete');
    expect(loop.usage).toEqual({
      inputTokens: 5,
      outputTokens: 2,
      cacheReadTokens: 3,
    });
    expect(loop.iteration).toBe(1);
    expect(loop.hasRemaining).toBe(true);
  });

  it('does not count a retained fallback response twice', () => {
    const loop = new ModelTurnLoopState(1);
    const original = response('stop', []);
    original.usage = { inputTokens: 7, outputTokens: 1 };

    loop.startNext();
    loop.acceptResponse(original, { countUsage: false });
    expect(loop.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('enforces one response per started iteration', () => {
    const loop = new ModelTurnLoopState(2);
    const terminal = response('stop', []);

    expect(() => loop.acceptResponse(terminal)).toThrow('no active iteration');
    loop.startNext();
    expect(() => loop.startNext()).toThrow('has no response');
    loop.acceptResponse(terminal);
    expect(() => loop.acceptResponse(terminal)).toThrow('no active iteration');
  });
});
