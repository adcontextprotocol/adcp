/**
 * Email Conversation Flow Tests
 *
 * Tests the end-to-end email conversation handler logic:
 * - Thread resolution (In-Reply-To → recent sender → new thread)
 * - CC vs TO behavior
 * - Message storage and reply sending
 * - Multi-turn threading
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { Thread, ThreadMessage, CreateMessageInput } from '../../server/src/addie/thread-service.js';

// --- Track calls for assertions ---
const state = vi.hoisted(() => ({
  addedMessages: [] as CreateMessageInput[],
  sentEmails: [] as Array<{ to: string[]; subject: string; textContent: string }>,
  threadMessages: [] as ThreadMessage[],
  foundThread: null as Thread | null,
  createdThread: null as Thread | null,
}));

// --- Mock thread service ---
const mockThreadService = vi.hoisted(() => ({
  findThreadByEmailMessageId: vi.fn<any>().mockImplementation(async () => state.foundThread),
  findRecentEmailThread: vi.fn<any>().mockImplementation(async () => state.foundThread),
  countRecentEmailMessages: vi.fn<any>().mockResolvedValue(0),
  getOrCreateThread: vi.fn<any>().mockImplementation(async (input: any) => {
    const thread = makeThread({ external_id: input.external_id, channel: 'email', context: input.context, title: input.title });
    state.createdThread = thread;
    return thread;
  }),
  addMessage: vi.fn<any>().mockImplementation(async (input: CreateMessageInput) => {
    state.addedMessages.push(input);
    return makeMessage({ thread_id: input.thread_id, role: input.role, content: input.content });
  }),
  getThreadMessages: vi.fn<any>().mockImplementation(async () => state.threadMessages),
}));

const mockClaudeClient = vi.hoisted(() => ({
  processMessage: vi.fn<any>().mockResolvedValue({
    text: 'Thanks for reaching out! Here is what I found.',
    tools_used: ['search_docs'],
    tool_executions: [{ tool_name: 'search_docs', parameters: { query: 'test' }, result: 'found', is_error: false, duration_ms: 100, sequence: 1 }],
    flagged: false,
    active_rule_ids: [1],
    config_version_id: 1,
    timing: { system_prompt_ms: 10, total_llm_ms: 500, total_tool_execution_ms: 100, iterations: 1 },
    usage: { input_tokens: 100, output_tokens: 50 },
  }),
}));

vi.mock('../../server/src/addie/thread-service.js', () => ({
  getThreadService: vi.fn().mockReturnValue(mockThreadService),
}));

vi.mock('../../server/src/routes/addie-chat.js', () => ({
  getChatClaudeClient: vi.fn<any>().mockResolvedValue(mockClaudeClient),
  prepareRequestWithMemberTools: vi.fn<any>().mockResolvedValue({
    messageToProcess: 'test message',
    requestContext: 'member context here',
    memberContext: null,
    requestTools: { tools: [], handlers: new Map() },
    siRetrievalTimeMs: null,
    siAgents: [],
    hasCertificationContext: false,
    threadExternalId: 'test-ext-id',
  }),
  buildTieredAccess: vi.fn<any>().mockReturnValue({
    requestTools: { tools: [], handlers: new Map() },
    processOptions: {},
    effectiveModel: 'claude-sonnet-4-20250514',
  }),
}));

// --- Mock email sending ---
vi.mock('../../server/src/notifications/email.js', () => ({
  sendEmailReply: vi.fn<any>().mockImplementation(async (data: any) => {
    state.sentEmails.push({
      to: [data.threadContext.from],
      subject: data.threadContext.subject,
      textContent: data.textContent,
    });
    return { success: true, messageId: `resend_${Date.now()}` };
  }),
}));

vi.mock('../../server/src/addie/security.js', () => ({
  sanitizeInput: vi.fn().mockImplementation((input: string) => ({ sanitized: input, flagged: false })),
  validateOutput: vi.fn().mockImplementation((input: string) => ({ sanitized: input, flagged: false })),
}));

vi.mock('../../server/src/utils/markdown.js', () => ({
  markdownToEmailHtml: vi.fn().mockImplementation((md: string) => `<p>${md}</p>`),
}));

vi.mock('../../server/src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

import { handleEmailConversation, type EmailConversationInput } from '../../server/src/addie/email-conversation-handler.js';

// --- Helpers ---

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    thread_id: 'thread_001',
    channel: 'email',
    external_id: 'email:test-msg-id',
    user_type: 'anonymous',
    user_id: 'prospect@acme.com',
    user_display_name: 'Prospect',
    context: {},
    title: null,
    message_count: 0,
    reviewed: false,
    reviewed_by: null,
    reviewed_at: null,
    review_notes: null,
    flagged: false,
    flag_reason: null,
    experiment_id: null,
    experiment_group: null,
    active_rules_snapshot: null,
    impersonator_user_id: null,
    impersonation_reason: null,
    started_at: new Date(),
    last_message_at: new Date(),
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function makeMessage(overrides: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    message_id: `msg_${Math.random().toString(36).slice(2)}`,
    thread_id: 'thread_001',
    role: 'user',
    content: '',
    content_sanitized: null,
    tools_used: null,
    tool_calls: null,
    knowledge_ids: null,
    model: null,
    latency_ms: null,
    tokens_input: null,
    tokens_output: null,
    flagged: false,
    flag_reason: null,
    rating: null,
    rating_category: null,
    rating_notes: null,
    feedback_tags: [],
    improvement_suggestion: null,
    rated_by: null,
    rating_source: null,
    rated_at: null,
    outcome: null,
    user_sentiment: null,
    intent_category: null,
    sequence_number: 1,
    created_at: new Date(),
    timing_system_prompt_ms: null,
    timing_total_llm_ms: null,
    timing_total_tool_ms: null,
    processing_iterations: null,
    tokens_cache_creation: null,
    tokens_cache_read: null,
    active_rule_ids: null,
    router_decision: null,
    config_version_id: null,
    email_message_id: null,
    ...overrides,
  };
}

function baseInput(overrides: Partial<EmailConversationInput> = {}): EmailConversationInput {
  return {
    emailId: 'email_001',
    messageId: '<msg-001@gmail.com>',
    from: '"Prospect Jones" <prospect@acme.com>',
    to: ['addie@agenticadvertising.org'],
    subject: 'Question about AdCP',
    textContent: 'Hi, I have a question about the protocol specification.',
    addieAddress: 'addie@agenticadvertising.org',
    addiePosition: 'to',
    senderEmail: 'prospect@acme.com',
    senderDisplayName: 'Prospect Jones',
    ...overrides,
  };
}

// --- Tests ---

describe('email conversation flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.addedMessages = [];
    state.sentEmails = [];
    state.threadMessages = [];
    state.foundThread = null;
    state.createdThread = null;
  });

  describe('thread resolution', () => {
    test('creates new thread when no In-Reply-To and no recent thread', async () => {
      const result = await handleEmailConversation(baseInput());

      expect(result.responded).toBe(true);
      expect(mockThreadService.getOrCreateThread).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'email',
          user_id: 'prospect@acme.com',
          user_display_name: 'Prospect Jones',
          title: 'Question about AdCP',
        })
      );
    });

    test('finds existing thread via In-Reply-To header', async () => {
      const existingThread = makeThread({ thread_id: 'existing_thread_001' });
      state.foundThread = existingThread;

      const result = await handleEmailConversation(baseInput({
        inReplyTo: '<prev-msg@resend.dev>',
      }));

      expect(result.responded).toBe(true);
      expect(result.threadId).toBe('existing_thread_001');
      expect(mockThreadService.findThreadByEmailMessageId).toHaveBeenCalledWith('<prev-msg@resend.dev>');
      expect(mockThreadService.getOrCreateThread).not.toHaveBeenCalled();
    });

    test('falls back to recent sender thread when In-Reply-To not found', async () => {
      // First call (findThreadByEmailMessageId) returns null, second (findRecentEmailThread) returns thread
      mockThreadService.findThreadByEmailMessageId.mockResolvedValueOnce(null);
      const recentThread = makeThread({ thread_id: 'recent_thread_001' });
      mockThreadService.findRecentEmailThread.mockResolvedValueOnce(recentThread);

      const result = await handleEmailConversation(baseInput({
        inReplyTo: '<unknown-msg@gmail.com>',
      }));

      expect(result.responded).toBe(true);
      expect(result.threadId).toBe('recent_thread_001');
      expect(mockThreadService.findRecentEmailThread).toHaveBeenCalledWith('prospect@acme.com', 'Question about AdCP');
    });
  });

  describe('message storage', () => {
    test('stores user message with email_message_id', async () => {
      await handleEmailConversation(baseInput());

      const userMsg = state.addedMessages.find(m => m.role === 'user');
      expect(userMsg).toBeDefined();
      expect(userMsg!.email_message_id).toBe('<msg-001@gmail.com>');
      expect(userMsg!.content).toBe('Hi, I have a question about the protocol specification.');
    });

    test('stores assistant message with sent email ID', async () => {
      await handleEmailConversation(baseInput());

      const assistantMsg = state.addedMessages.find(m => m.role === 'assistant');
      expect(assistantMsg).toBeDefined();
      expect(assistantMsg!.email_message_id).toMatch(/^resend_/);
      expect(assistantMsg!.tools_used).toEqual(['search_docs']);
      expect(assistantMsg!.model).toBe('claude-sonnet-4-20250514');
    });

    test('strips quoted content from user message', async () => {
      await handleEmailConversation(baseInput({
        textContent: `Yes, I'd like to know more.

On Mon, Apr 1, 2026 at 3:00 PM Addie wrote:
> Thanks for reaching out! Here is what I found.`,
      }));

      const userMsg = state.addedMessages.find(m => m.role === 'user');
      expect(userMsg!.content).toBe("Yes, I'd like to know more.");
    });
  });

  describe('email reply', () => {
    test('sends email reply with correct threading context', async () => {
      await handleEmailConversation(baseInput({
        inReplyTo: '<prev-msg@gmail.com>',
        references: ['<original@gmail.com>', '<prev-msg@gmail.com>'],
      }));

      expect(state.sentEmails).toHaveLength(1);
      expect(state.sentEmails[0].subject).toBe('Question about AdCP');
    });

    test('does not respond to empty content after stripping quotes', async () => {
      const result = await handleEmailConversation(baseInput({
        textContent: `On Mon, Apr 1, 2026 at 3:00 PM Someone wrote:
> Just the quoted text, nothing new`,
      }));

      expect(result.responded).toBe(false);
      expect(state.sentEmails).toHaveLength(0);
    });
  });

  describe('CC vs TO behavior', () => {
    test('always responds when Addie is in TO', async () => {
      const result = await handleEmailConversation(baseInput({
        addiePosition: 'to',
        textContent: 'Just a simple question about membership.',
      }));

      expect(result.responded).toBe(true);
    });

    test('does not respond when CC\'d without invocation', async () => {
      const result = await handleEmailConversation(baseInput({
        addiePosition: 'cc',
        textContent: 'Hey team, can we discuss the pricing for next quarter?',
      }));

      expect(result.responded).toBe(false);
      expect(state.sentEmails).toHaveLength(0);
    });

    test('responds when CC\'d with explicit Addie invocation', async () => {
      const result = await handleEmailConversation(baseInput({
        addiePosition: 'cc',
        textContent: 'Addie, can you send the latest pricing details?',
      }));

      expect(result.responded).toBe(true);
      expect(state.sentEmails).toHaveLength(1);
    });

    test('responds when CC\'d with "ask Addie" pattern', async () => {
      const result = await handleEmailConversation(baseInput({
        addiePosition: 'cc',
        textContent: 'Can someone ask Addie to look up the member directory?',
      }));

      expect(result.responded).toBe(true);
    });

    test('does not respond when CC\'d with casual Addie mention (no action)', async () => {
      const result = await handleEmailConversation(baseInput({
        addiePosition: 'cc',
        textContent: 'I talked to Addie about this yesterday and she was helpful.',
      }));

      expect(result.responded).toBe(false);
    });
  });

  describe('multi-turn conversation', () => {
    test('passes conversation history to Claude', async () => {
      // Simulate existing conversation history
      state.threadMessages = [
        makeMessage({ role: 'user', content: 'What is AdCP?' }),
        makeMessage({ role: 'assistant', content: 'AdCP is the Ad Context Protocol.' }),
      ];
      state.foundThread = makeThread({ thread_id: 'existing_thread' });

      await handleEmailConversation(baseInput({
        inReplyTo: '<prev-msg@resend.dev>',
        textContent: 'How do I get started with it?',
      }));

      // Claude should receive conversation history
      expect(mockClaudeClient.processMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining([
          expect.objectContaining({ user: 'User', text: 'What is AdCP?' }),
          expect.objectContaining({ user: 'Addie', text: 'AdCP is the Ad Context Protocol.' }),
        ]),
        expect.any(Object),
        undefined,
        expect.any(Object),
      );
    });
  });

  describe('error handling', () => {
    test('returns error when email send fails', async () => {
      const { sendEmailReply } = await import('../../server/src/notifications/email.js');
      (sendEmailReply as any).mockResolvedValueOnce({ success: false, error: 'Resend API error' });

      const result = await handleEmailConversation(baseInput());

      expect(result.responded).toBe(false);
      expect(result.error).toBe('Resend API error');
      // User message was stored but assistant message was not
      expect(state.addedMessages.filter(m => m.role === 'assistant')).toHaveLength(0);
      expect(state.addedMessages.filter(m => m.role === 'user')).toHaveLength(1);
    });

    test('returns error when Claude throws', async () => {
      mockClaudeClient.processMessage.mockRejectedValueOnce(new Error('Claude API timeout'));

      const result = await handleEmailConversation(baseInput());

      expect(result.responded).toBe(false);
      expect(result.error).toBe('Claude API timeout');
    });

    test('returns error when thread creation fails', async () => {
      mockThreadService.getOrCreateThread.mockRejectedValueOnce(new Error('Database connection lost'));

      const result = await handleEmailConversation(baseInput());

      expect(result.responded).toBe(false);
      expect(result.error).toBe('Database connection lost');
    });

    test('rejects when rate limit exceeded', async () => {
      mockThreadService.countRecentEmailMessages.mockResolvedValueOnce(10);

      const result = await handleEmailConversation(baseInput());

      expect(result.responded).toBe(false);
      expect(result.error).toBe('Rate limit exceeded');
      expect(state.sentEmails).toHaveLength(0);
    });
  });

  describe('security', () => {
    test('thread hijacking prevented — mismatched sender ignored', async () => {
      // Someone else's thread found via In-Reply-To
      const otherThread = makeThread({ thread_id: 'other_thread', user_id: 'other@example.com' });
      mockThreadService.findThreadByEmailMessageId.mockResolvedValueOnce(otherThread);

      const result = await handleEmailConversation(baseInput({
        inReplyTo: '<stolen-msg-id@resend.dev>',
      }));

      // Should NOT use the other person's thread — should create a new one
      expect(result.responded).toBe(true);
      expect(result.threadId).not.toBe('other_thread');
    });
  });
});
