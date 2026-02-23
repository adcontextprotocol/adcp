/**
 * Tests for buildMessageTurns function
 *
 * This function converts conversation history into proper Claude API message turns
 * instead of flattening everything into a single user message string.
 */

import { describe, it, expect } from '@jest/globals';
import { buildMessageTurns, buildMessageTurnsWithMetadata, type ThreadContextEntry, type MessageTurn } from '../../server/src/addie/prompts.js';

describe('buildMessageTurns', () => {
  it('should return single user message when no thread context', () => {
    const result = buildMessageTurns('Hello!');

    expect(result).toEqual([{ role: 'user', content: 'Hello!' }]);
  });

  it('should return single user message when empty thread context', () => {
    const result = buildMessageTurns('Hello!', []);

    expect(result).toEqual([{ role: 'user', content: 'Hello!' }]);
  });

  it('should convert thread context to proper message turns', () => {
    const threadContext: ThreadContextEntry[] = [
      { user: 'User', text: 'Can you help me with AdMesh?' },
      { user: 'Addie', text: 'AdMesh looks like a strong prospect!' },
    ];

    const result = buildMessageTurns('an outreach message would be great!', threadContext);

    expect(result).toEqual([
      { role: 'user', content: 'Can you help me with AdMesh?' },
      { role: 'assistant', content: 'AdMesh looks like a strong prospect!' },
      { role: 'user', content: 'an outreach message would be great!' },
    ]);
  });

  it('should merge consecutive same-role messages', () => {
    const threadContext: ThreadContextEntry[] = [
      { user: 'User', text: 'First message' },
      { user: 'User', text: 'Second message' },
      { user: 'Addie', text: 'Response' },
    ];

    const result = buildMessageTurns('Current message', threadContext);

    expect(result).toEqual([
      { role: 'user', content: 'First message\n\nSecond message' },
      { role: 'assistant', content: 'Response' },
      { role: 'user', content: 'Current message' },
    ]);
  });

  it('should prepend placeholder if history starts with assistant', () => {
    const threadContext: ThreadContextEntry[] = [
      { user: 'Addie', text: 'Welcome! How can I help?' },
    ];

    const result = buildMessageTurns('I need help', threadContext);

    expect(result).toEqual([
      { role: 'user', content: '[conversation continued]' },
      { role: 'assistant', content: 'Welcome! How can I help?' },
      { role: 'user', content: 'I need help' },
    ]);
  });

  it('should merge current message with last user message in history', () => {
    const threadContext: ThreadContextEntry[] = [
      { user: 'Addie', text: 'Here is the analysis' },
      { user: 'User', text: 'Thanks!' },
    ];

    const result = buildMessageTurns('One more thing...', threadContext);

    expect(result).toEqual([
      { role: 'user', content: '[conversation continued]' },
      { role: 'assistant', content: 'Here is the analysis' },
      { role: 'user', content: 'Thanks!\n\nOne more thing...' },
    ]);
  });

  it('should handle longer conversation history', () => {
    const threadContext: ThreadContextEntry[] = [
      { user: 'User', text: 'Question 1' },
      { user: 'Addie', text: 'Answer 1' },
      { user: 'User', text: 'Question 2' },
      { user: 'Addie', text: 'Answer 2' },
      { user: 'User', text: 'Question 3' },
      { user: 'Addie', text: 'Answer 3' },
    ];

    const result = buildMessageTurns('Question 4', threadContext);

    expect(result).toHaveLength(7);
    expect(result[0]).toEqual({ role: 'user', content: 'Question 1' });
    expect(result[5]).toEqual({ role: 'assistant', content: 'Answer 3' });
    expect(result[6]).toEqual({ role: 'user', content: 'Question 4' });
  });

  it('should limit to last 20 messages from thread context', () => {
    // Create 25 messages
    const threadContext: ThreadContextEntry[] = [];
    for (let i = 1; i <= 25; i++) {
      threadContext.push({ user: i % 2 === 1 ? 'User' : 'Addie', text: `Message ${i}` });
    }

    const result = buildMessageTurns('Current', threadContext);

    // Should only include messages 6-25 (last 20) plus current
    // Message 6 is from Addie (even index in 1-based), so placeholder is added
    const firstHistoryMessage = result.find(m => m.content.includes('Message'));
    expect(firstHistoryMessage?.content).toContain('Message 6');
  });

  it('should skip empty messages in thread context', () => {
    const threadContext: ThreadContextEntry[] = [
      { user: 'User', text: 'Hello' },
      { user: 'Addie', text: '' }, // Empty message
      { user: 'Addie', text: '   ' }, // Whitespace-only message
      { user: 'User', text: 'Follow up' },
    ];

    const result = buildMessageTurns('Current', threadContext);

    // Should skip empty messages, resulting in: user, user (merged), user (current merged)
    expect(result).toEqual([
      { role: 'user', content: 'Hello\n\nFollow up\n\nCurrent' },
    ]);
  });
});

describe('buildMessageTurnsWithMetadata', () => {
  it('should return metadata about message building', () => {
    const threadContext: ThreadContextEntry[] = [
      { user: 'User', text: 'Hello' },
      { user: 'Addie', text: 'Hi!' },
    ];

    const result = buildMessageTurnsWithMetadata('Current', threadContext);

    expect(result.messages).toHaveLength(3);
    expect(result.estimatedTokens).toBeGreaterThan(0);
    expect(result.messagesRemoved).toBe(0);
    expect(result.wasTrimmed).toBe(false);
  });

  it('should respect maxMessages option', () => {
    const threadContext: ThreadContextEntry[] = [];
    for (let i = 1; i <= 20; i++) {
      threadContext.push({ user: i % 2 === 1 ? 'User' : 'Addie', text: `Message ${i}` });
    }

    const result = buildMessageTurnsWithMetadata('Current', threadContext, { maxMessages: 5 });

    // Should only include last 5 messages from history plus current
    // Last 5 messages are: 16, 17, 18, 19, 20
    // After merging and adding placeholder if needed, count may vary slightly
    // But the first history message should be from the limited set (16+)
    const firstHistoryMsg = result.messages.find(m => m.content.includes('Message'));
    expect(firstHistoryMsg?.content).toContain('Message 16');
    // Ensure older messages are not included
    expect(result.messages.some(m => m.content.includes('Message 1\n') || m.content === 'Message 1')).toBe(false);
    expect(result.messages.some(m => m.content.includes('Message 15'))).toBe(false);
  });

  it('should trim messages when tokenLimit is exceeded', () => {
    // Create messages that exceed a small token limit
    const threadContext: ThreadContextEntry[] = [
      { user: 'User', text: 'A'.repeat(1000) },
      { user: 'Addie', text: 'B'.repeat(1000) },
      { user: 'User', text: 'C'.repeat(100) },
    ];

    // Very small limit - should trim older messages
    const result = buildMessageTurnsWithMetadata('D', threadContext, { tokenLimit: 100 });

    expect(result.wasTrimmed).toBe(true);
    expect(result.messagesRemoved).toBeGreaterThan(0);
    // Most recent messages should be preserved
    expect(result.messages.length).toBeLessThan(4);
  });

  it('should disable message count limit when maxMessages is 0', () => {
    const threadContext: ThreadContextEntry[] = [];
    for (let i = 1; i <= 15; i++) {
      threadContext.push({ user: i % 2 === 1 ? 'User' : 'Addie', text: `Message ${i}` });
    }

    // Use a very large token limit and no message limit
    const result = buildMessageTurnsWithMetadata('Current', threadContext, {
      maxMessages: 0,
      tokenLimit: 1000000,
    });

    // Should include all 15 messages (merged as needed) plus current
    const messageContents = result.messages.map(m => m.content).join(' ');
    expect(messageContents).toContain('Message 1');
    expect(messageContents).toContain('Message 15');
  });
});
