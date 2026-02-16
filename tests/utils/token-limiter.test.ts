/**
 * Tests for token-limiter utilities
 *
 * These tests verify the token estimation and conversation trimming logic
 * that prevents context limit errors when calling the Anthropic API.
 */

import { describe, it, expect } from '@jest/globals';
import {
  estimateTokens,
  estimateToolTokens,
  trimConversationHistory,
  getConversationTokenLimit,
  checkContextLimit,
  formatTokenCount,
  MODEL_CONTEXT_LIMITS,
  RESERVED_TOKENS,
  TOKEN_BUFFERS,
  type MessageTurn,
} from '../../server/src/utils/token-limiter.js';

describe('estimateTokens', () => {
  it('should return 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('should return 0 for undefined/null', () => {
    // @ts-expect-error - testing edge case
    expect(estimateTokens(undefined)).toBe(0);
    // @ts-expect-error - testing edge case
    expect(estimateTokens(null)).toBe(0);
  });

  it('should estimate tokens for short text', () => {
    // "Hello world" = 11 chars, ~3 tokens at 3.5 chars/token
    const result = estimateTokens('Hello world');
    expect(result).toBe(Math.ceil(11 / 3.5)); // 4
  });

  it('should estimate tokens for longer text', () => {
    const text = 'This is a longer piece of text that should have more tokens.';
    const result = estimateTokens(text);
    expect(result).toBe(Math.ceil(text.length / 3.5));
  });

  it('should round up token estimates', () => {
    // 10 chars / 3.5 = 2.857... should round up to 3
    expect(estimateTokens('1234567890')).toBe(3);
  });
});

describe('estimateToolTokens', () => {
  it('should estimate 300 tokens per tool', () => {
    expect(estimateToolTokens(1)).toBe(300);
    expect(estimateToolTokens(10)).toBe(3000);
    expect(estimateToolTokens(100)).toBe(30000);
  });

  it('should return 0 for zero tools', () => {
    expect(estimateToolTokens(0)).toBe(0);
  });
});

describe('trimConversationHistory', () => {
  it('should return empty result for empty messages', () => {
    const result = trimConversationHistory([], 10000);
    expect(result.messages).toEqual([]);
    expect(result.estimatedTokens).toBe(0);
    expect(result.messagesRemoved).toBe(0);
    expect(result.wasTrimmed).toBe(false);
  });

  it('should keep all messages when within limit', () => {
    const messages: MessageTurn[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
      { role: 'user', content: 'How are you?' },
    ];

    const result = trimConversationHistory(messages, 100000);

    expect(result.messages).toHaveLength(3);
    expect(result.messagesRemoved).toBe(0);
    expect(result.wasTrimmed).toBe(false);
  });

  it('should remove oldest messages when over limit', () => {
    const messages: MessageTurn[] = [
      { role: 'user', content: 'A'.repeat(1000) }, // ~286 tokens
      { role: 'assistant', content: 'B'.repeat(1000) }, // ~286 tokens
      { role: 'user', content: 'C'.repeat(100) }, // ~29 tokens
    ];

    // Set limit to only fit the last message
    const result = trimConversationHistory(messages, 50);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].content).toContain('C');
    expect(result.messagesRemoved).toBe(2);
    expect(result.wasTrimmed).toBe(true);
  });

  it('should always try to include the most recent message', () => {
    const messages: MessageTurn[] = [
      { role: 'user', content: 'First message that is very long ' + 'x'.repeat(500) },
      { role: 'assistant', content: 'Second message' },
      { role: 'user', content: 'Most recent message' },
    ];

    // Very small limit - should prioritize most recent messages
    const result = trimConversationHistory(messages, 10);

    // Should include at least the most recent message
    expect(result.messages.length).toBeGreaterThanOrEqual(1);
    // Most recent message should be preserved
    expect(result.messages[result.messages.length - 1].content).toBe('Most recent message');
    // First long message should be trimmed
    expect(result.wasTrimmed).toBe(true);
  });

  it('should handle zero or very small token limit gracefully', () => {
    const messages: MessageTurn[] = [
      { role: 'user', content: 'Hello world' },
    ];

    const result = trimConversationHistory(messages, 0);

    // Should still return a message (truncated)
    expect(result.messages).toHaveLength(1);
    // Content should include truncation notice (message content was truncated)
    expect(result.messages[0].content).toContain('[Message truncated due to length]');
    // No messages were removed, but content was truncated
    expect(result.messagesRemoved).toBe(0);
  });

  it('should truncate single message if it exceeds limit', () => {
    const messages: MessageTurn[] = [
      { role: 'user', content: 'A'.repeat(10000) }, // Very long message
    ];

    // Very small limit
    const result = trimConversationHistory(messages, 50);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].content).toContain('[Message truncated due to length]');
    expect(result.messages[0].content.length).toBeLessThan(10000);
  });

  it('should preserve message order', () => {
    const messages: MessageTurn[] = [
      { role: 'user', content: 'First' },
      { role: 'assistant', content: 'Second' },
      { role: 'user', content: 'Third' },
      { role: 'assistant', content: 'Fourth' },
    ];

    const result = trimConversationHistory(messages, 100000);

    expect(result.messages[0].content).toBe('First');
    expect(result.messages[1].content).toBe('Second');
    expect(result.messages[2].content).toBe('Third');
    expect(result.messages[3].content).toBe('Fourth');
  });

  it('should track estimated tokens correctly', () => {
    const messages: MessageTurn[] = [
      { role: 'user', content: 'Hello' }, // 5 chars ~2 tokens
      { role: 'assistant', content: 'World' }, // 5 chars ~2 tokens
    ];

    const result = trimConversationHistory(messages, 100000);

    expect(result.estimatedTokens).toBeGreaterThan(0);
    expect(result.estimatedTokens).toBe(
      estimateTokens('Hello') + estimateTokens('World')
    );
  });
});

describe('getConversationTokenLimit', () => {
  it('should return default limit minus reserved tokens', () => {
    const limit = getConversationTokenLimit();
    expect(limit).toBe(MODEL_CONTEXT_LIMITS.default - RESERVED_TOKENS);
  });

  it('should return model-specific limit minus reserved tokens', () => {
    const limit = getConversationTokenLimit('claude-sonnet-4-20250514');
    expect(limit).toBe(MODEL_CONTEXT_LIMITS['claude-sonnet-4-20250514'] - RESERVED_TOKENS);
  });

  it('should use default for unknown models', () => {
    const limit = getConversationTokenLimit('unknown-model');
    expect(limit).toBe(MODEL_CONTEXT_LIMITS.default - RESERVED_TOKENS);
  });

  it('should use dynamic calculation when toolCount is provided', () => {
    const toolCount = 50;
    const limit = getConversationTokenLimit('claude-sonnet-4-20250514', toolCount);

    // Expected: model limit - (system prompt + tool tokens + prepended context + response buffer + safety margin)
    const expectedToolTokens = estimateToolTokens(toolCount);
    const expectedReserved = TOKEN_BUFFERS.systemPrompt + expectedToolTokens +
      TOKEN_BUFFERS.prependedContext + TOKEN_BUFFERS.responseBuffer + TOKEN_BUFFERS.safetyMargin;
    const expectedLimit = MODEL_CONTEXT_LIMITS['claude-sonnet-4-20250514'] - expectedReserved;

    expect(limit).toBe(expectedLimit);
  });

  it('should give more conversation budget with fewer tools', () => {
    const limitWithFewTools = getConversationTokenLimit('claude-sonnet-4-20250514', 10);
    const limitWithManyTools = getConversationTokenLimit('claude-sonnet-4-20250514', 100);

    // Fewer tools = more room for conversation
    expect(limitWithFewTools).toBeGreaterThan(limitWithManyTools);
  });

  it('should differ from static buffer when toolCount provided', () => {
    const staticLimit = getConversationTokenLimit('claude-sonnet-4-20250514');
    const dynamicLimit = getConversationTokenLimit('claude-sonnet-4-20250514', 50);

    // Dynamic calculation should differ from static RESERVED_TOKENS buffer
    expect(dynamicLimit).not.toBe(staticLimit);
  });
});

describe('checkContextLimit', () => {
  it('should return within limit for small request', () => {
    const result = checkContextLimit(5000, 10000, 5000);

    expect(result.withinLimit).toBe(true);
    expect(result.headroom).toBeGreaterThan(0);
  });

  it('should return not within limit for large request', () => {
    // System + messages + tools close to limit
    const result = checkContextLimit(100000, 80000, 20000);

    expect(result.withinLimit).toBe(false);
  });

  it('should calculate correct totals', () => {
    const result = checkContextLimit(10000, 20000, 5000);

    // Total should include prepended context buffer and response buffer
    expect(result.estimatedTotal).toBe(10000 + 20000 + 5000 + TOKEN_BUFFERS.prependedContext + TOKEN_BUFFERS.responseBuffer);
    expect(result.modelLimit).toBe(MODEL_CONTEXT_LIMITS.default);
  });
});

describe('formatTokenCount', () => {
  it('should format small numbers as-is', () => {
    expect(formatTokenCount(500)).toBe('500');
    expect(formatTokenCount(999)).toBe('999');
  });

  it('should format thousands with K suffix', () => {
    expect(formatTokenCount(1000)).toBe('1K');
    expect(formatTokenCount(5000)).toBe('5K');
    expect(formatTokenCount(10000)).toBe('10K');
  });

  it('should round to nearest K', () => {
    expect(formatTokenCount(1500)).toBe('2K');
    expect(formatTokenCount(1499)).toBe('1K');
    expect(formatTokenCount(150000)).toBe('150K');
  });
});
