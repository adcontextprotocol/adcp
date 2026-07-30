import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const originalApiKey = process.env.ADDIE_ANTHROPIC_API_KEY;
process.env.ADDIE_ANTHROPIC_API_KEY = 'test-addie-object-authorization-key';

const mocks = vi.hoisted(() => ({
  authenticated: true,
  getThreadByExternalId: vi.fn(),
  getThreadMessages: vi.fn(),
  addMessage: vi.fn(),
  addMessageFeedback: vi.fn(),
  processMessage: vi.fn(),
  processMessageStream: vi.fn(),
  initializeKnowledgeSearch: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('express-rate-limit', () => ({
  default: () => (_req: any, _res: any, next: any) => next(),
  ipKeyGenerator: (ip: string) => ip,
}));

vi.mock('../../src/middleware/auth.js', () => ({
  optionalAuth: (req: any, _res: any, next: any) => {
    if (mocks.authenticated) {
      req.user = {
        id: 'user_attacker',
        email: 'attacker@example.test',
        firstName: 'Attacker',
      };
    }
    next();
  },
}));

vi.mock('../../src/addie/claude-client.js', () => ({
  AddieClaudeClient: class {
    registerTool() {}
    getRegisteredTools() { return []; }
    processMessage(...args: unknown[]) { return mocks.processMessage(...args); }
    processMessageStream(...args: unknown[]) { return mocks.processMessageStream(...args); }
  },
}));

vi.mock('../../src/addie/thread-service.js', () => ({
  getThreadService: () => ({
    getThreadByExternalId: mocks.getThreadByExternalId,
    getThreadMessages: mocks.getThreadMessages,
    addMessage: mocks.addMessage,
    addMessageFeedback: mocks.addMessageFeedback,
    getOrCreateThread: vi.fn(),
  }),
}));

vi.mock('../../src/addie/mcp/knowledge-search.js', () => ({
  isKnowledgeReady: () => true,
  initializeKnowledgeSearch: mocks.initializeKnowledgeSearch,
  KNOWLEDGE_TOOLS: [],
  createKnowledgeToolHandlers: () => new Map(),
}));

vi.mock('../../src/mcp/chat-tool.js', () => ({
  ANONYMOUS_SAFE_KNOWLEDGE_TOOLS: new Set(),
}));

vi.mock('../../src/addie/mcp/member-tools.js', () => ({
  MEMBER_TOOLS: [],
  createMemberToolHandlers: () => new Map(),
}));

vi.mock('../../src/addie/mcp/directory-tools.js', () => ({
  DIRECTORY_TOOLS: [],
  createDirectoryToolHandlers: () => new Map(),
}));

vi.mock('../../src/addie/mcp/billing-tools.js', () => ({
  BILLING_TOOLS: [],
  createBillingToolHandlers: () => new Map(),
}));

vi.mock('../../src/addie/mcp/schema-tools.js', () => ({
  SCHEMA_TOOLS: [],
  createSchemaToolHandlers: () => new Map(),
}));

vi.mock('../../src/addie/mcp/brand-tools.js', () => ({
  BRAND_TOOLS: [],
  createBrandToolHandlers: () => new Map(),
}));

vi.mock('../../src/addie/mcp/property-tools.js', () => ({
  PROPERTY_TOOLS: [],
  createPropertyToolHandlers: () => new Map(),
}));

vi.mock('../../src/addie/mcp/si-host-tools.js', () => ({
  SI_HOST_TOOLS: [],
  createSiHostToolHandlers: () => new Map(),
}));

vi.mock('../../src/addie/mcp/adcp-tools.js', () => ({
  ADCP_TOOLS: [],
  createAdcpToolHandlers: () => new Map(),
}));

vi.mock('../../src/addie/mcp/escalation-tools.js', () => ({
  ESCALATION_TOOLS: [],
  createEscalationToolHandlers: () => new Map(),
}));

vi.mock('../../src/addie/mcp/admin-tools.js', () => ({
  ADMIN_TOOLS: [],
  createAdminToolHandlers: () => new Map(),
  isWebUserAAOAdmin: vi.fn().mockResolvedValue(false),
}));

vi.mock('../../src/addie/mcp/event-tools.js', () => ({
  EVENT_READONLY_TOOLS: [],
  EVENT_ADMIN_TOOLS: [],
  EVENT_CREATOR_COMMITTEE_TYPES: new Set(),
  createEventToolHandlers: () => new Map(),
}));

vi.mock('../../src/addie/mcp/meeting-tools.js', () => ({
  MEETING_TOOLS: [],
  createMeetingToolHandlers: () => new Map(),
}));

vi.mock('../../src/addie/mcp/collaboration-tools.js', () => ({
  COLLABORATION_TOOLS: [],
  createCollaborationToolHandlers: () => new Map(),
}));

vi.mock('../../src/addie/mcp/committee-leader-tools.js', () => ({
  COMMITTEE_LEADER_TOOLS: [],
  createCommitteeLeaderToolHandlers: () => new Map(),
}));

vi.mock('../../src/addie/mcp/moltbook-tools.js', () => ({
  MOLTBOOK_TOOLS: [],
  createMoltbookToolHandlers: () => ({}),
}));

vi.mock('../../src/addie/mcp/certification-tools.js', () => ({
  CERTIFICATION_TOOLS: [],
  createCertificationToolHandlers: () => new Map(),
  buildCertificationContext: vi.fn(),
}));

vi.mock('../../src/addie/mcp/image-tools.js', () => ({
  IMAGE_TOOLS: [],
  createImageToolHandlers: () => new Map(),
}));

vi.mock('../../src/addie/mcp/auth-grader-tools.js', () => ({
  AUTH_GRADER_TOOLS: [],
  createAuthGraderToolHandlers: () => new Map(),
}));

vi.mock('../../src/utils/anthropic-retry.js', () => ({
  isRetriesExhaustedError: () => false,
}));

vi.mock('../../src/addie/member-context.js', () => ({
  getWebMemberContext: vi.fn().mockResolvedValue({
    is_mapped: false,
    is_member: false,
    slack_linked: false,
  }),
  formatMemberContextForPrompt: vi.fn().mockReturnValue(null),
}));

vi.mock('../../src/addie/services/si-retriever.js', () => ({
  siRetriever: {
    retrieve: vi.fn().mockResolvedValue({ agents: [], retrieval_time_ms: 0 }),
    formatContext: vi.fn().mockReturnValue(''),
  },
}));

vi.mock('../../src/db/certification-db.js', () => ({
  getProgress: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../src/db/working-group-db.js', () => ({
  WorkingGroupDatabase: class {
    getCommitteesLedByUser = vi.fn().mockResolvedValue([]);
  },
}));

vi.mock('../../src/addie/claude-cost-tracker.js', () => ({
  resolveUserTierFromDb: vi.fn().mockResolvedValue('member_free'),
}));

vi.mock('../../src/db/relationship-db.js', () => ({
  resolvePersonId: vi.fn().mockResolvedValue('person_attacker'),
  recordPersonMessage: vi.fn().mockResolvedValue(undefined),
  deriveSentiment: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/db/person-events-db.js', () => ({
  recordEvent: vi.fn().mockResolvedValue(undefined),
  buildMessageReceivedData: vi.fn().mockReturnValue({}),
}));

import {
  createAddieChatRouter,
  getChatClaudeClient,
} from '../../src/routes/addie-chat.js';

afterAll(() => {
  if (originalApiKey === undefined) {
    delete process.env.ADDIE_ANTHROPIC_API_KEY;
  } else {
    process.env.ADDIE_ANTHROPIC_API_KEY = originalApiKey;
  }
});

beforeAll(async () => {
  await getChatClaudeClient();
});

function successfulModelResponse(text = 'Allowed response') {
  return {
    text,
    tools_used: [],
    tool_executions: [],
    flagged: false,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function mountChatRouter() {
  const timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((() => 0) as typeof setTimeout);
  const { apiRouter } = createAddieChatRouter();
  timeoutSpy.mockRestore();

  const app = express();
  app.use(express.json());
  // Supertest completes the incoming request body before consuming the SSE
  // response, which emits IncomingMessage's `close` event immediately. A real
  // browser keeps the stream open. Suppress only the route's disconnect hook
  // so this harness can observe the emitted SSE events.
  app.use((req, _res, next) => {
    const originalOn = req.on.bind(req);
    req.on = ((event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'close') return req;
      return originalOn(event, listener);
    }) as typeof req.on;
    next();
  });
  app.use(apiRouter);
  return app;
}

describe('Addie chat conversation object authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticated = true;
    mocks.getThreadByExternalId.mockResolvedValue({
      thread_id: 'thread_victim',
      channel: 'web',
      external_id: '9f3e25b7-fc57-4ad9-bb32-0d5ecdb41489',
      user_type: 'workos',
      user_id: 'user_victim',
    });
    mocks.getThreadMessages.mockResolvedValue([
      { role: 'user', content: 'Earlier question', user_display_name: 'Attacker' },
      { role: 'assistant', content: 'Earlier answer' },
    ]);
    mocks.addMessage.mockImplementation(async (message: { role: string }) => ({
      ...message,
      message_id: message.role === 'assistant' ? 'message_assistant' : 'message_user',
    }));
    mocks.processMessage.mockResolvedValue(successfulModelResponse());
    mocks.addMessageFeedback.mockResolvedValue(true);
    mocks.processMessageStream.mockImplementation(async function* () {
      yield { type: 'text', text: 'Allowed response' };
      yield { type: 'done', response: successfulModelResponse() };
    });
  });

  it('denies a cross-user conversation UUID before reading history, writing, or invoking the model', async () => {
    const response = await request(mountChatRouter())
      .post('/')
      .send({
        message: 'Summarize the private history',
        conversation_id: '9f3e25b7-fc57-4ad9-bb32-0d5ecdb41489',
      });

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('Access denied');
    expect(mocks.getThreadByExternalId).toHaveBeenCalledWith(
      'web',
      '9f3e25b7-fc57-4ad9-bb32-0d5ecdb41489',
    );
    expect(mocks.getThreadMessages).not.toHaveBeenCalled();
    expect(mocks.addMessage).not.toHaveBeenCalled();
    expect(mocks.processMessage).not.toHaveBeenCalled();
  });

  it('allows an anonymous caller to continue an anonymous bearer-capability thread', async () => {
    mocks.authenticated = false;
    mocks.getThreadByExternalId.mockResolvedValue({
      thread_id: 'thread_anonymous',
      channel: 'web',
      external_id: '9f3e25b7-fc57-4ad9-bb32-0d5ecdb41489',
      user_type: 'anonymous',
      user_id: null,
    });

    const response = await request(mountChatRouter())
      .post('/')
      .send({
        message: 'Continue this anonymous conversation',
        conversation_id: '9f3e25b7-fc57-4ad9-bb32-0d5ecdb41489',
      });

    expect(response.status).toBe(200);
    expect(response.body.response).toBe('Allowed response');
    expect(mocks.getThreadMessages).toHaveBeenCalledWith('thread_anonymous');
    expect(mocks.addMessage).toHaveBeenCalledTimes(2);
    expect(mocks.processMessage).toHaveBeenCalledOnce();
  });

  it('denies an authenticated caller access to an anonymous thread before effects', async () => {
    mocks.getThreadByExternalId.mockResolvedValue({
      thread_id: 'thread_anonymous',
      channel: 'web',
      external_id: '9f3e25b7-fc57-4ad9-bb32-0d5ecdb41489',
      user_type: 'anonymous',
      user_id: null,
    });

    const response = await request(mountChatRouter())
      .post('/')
      .send({
        message: 'Try to absorb an anonymous conversation',
        conversation_id: '9f3e25b7-fc57-4ad9-bb32-0d5ecdb41489',
      });

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('Access denied');
    expect(mocks.getThreadMessages).not.toHaveBeenCalled();
    expect(mocks.addMessage).not.toHaveBeenCalled();
    expect(mocks.processMessage).not.toHaveBeenCalled();
  });

  it('allows the owner to continue a conversation through the normal response path', async () => {
    mocks.getThreadByExternalId.mockResolvedValue({
      thread_id: 'thread_attacker',
      channel: 'web',
      external_id: '9f3e25b7-fc57-4ad9-bb32-0d5ecdb41489',
      user_type: 'workos',
      user_id: 'user_attacker',
    });

    const response = await request(mountChatRouter())
      .post('/')
      .send({
        message: 'Continue my conversation',
        conversation_id: '9f3e25b7-fc57-4ad9-bb32-0d5ecdb41489',
      });

    expect(response.status).toBe(200);
    expect(response.body.response).toBe('Allowed response');
    expect(mocks.getThreadMessages).toHaveBeenCalledWith('thread_attacker');
    expect(mocks.addMessage).toHaveBeenCalledTimes(2);
    expect(mocks.processMessage).toHaveBeenCalledOnce();
  });

  it('denies a cross-user conversation UUID through the streaming path before side effects', async () => {
    const response = await request(mountChatRouter())
      .post('/stream')
      .send({
        message: 'Stream the private history',
        conversation_id: '9f3e25b7-fc57-4ad9-bb32-0d5ecdb41489',
      });

    expect(response.status).toBe(200);
    expect(response.text).toContain('event: error');
    expect(response.text).toContain('Access denied');
    expect(mocks.getThreadByExternalId).toHaveBeenCalledWith(
      'web',
      '9f3e25b7-fc57-4ad9-bb32-0d5ecdb41489',
    );
    expect(mocks.getThreadMessages).not.toHaveBeenCalled();
    expect(mocks.addMessage).not.toHaveBeenCalled();
    expect(mocks.processMessage).not.toHaveBeenCalled();
    expect(mocks.processMessageStream).not.toHaveBeenCalled();
  });

  it('allows the owner to continue a conversation through the streaming path', async () => {
    mocks.getThreadByExternalId.mockResolvedValue({
      thread_id: 'thread_attacker',
      channel: 'web',
      external_id: '9f3e25b7-fc57-4ad9-bb32-0d5ecdb41489',
      user_type: 'workos',
      user_id: 'user_attacker',
    });

    const response = await request(mountChatRouter())
      .post('/stream')
      .send({
        message: 'Stream my conversation',
        conversation_id: '9f3e25b7-fc57-4ad9-bb32-0d5ecdb41489',
      });

    expect(response.status).toBe(200);
    expect(response.text).toContain('event: text');
    expect(response.text).toContain('Allowed response');
    expect(response.text).toContain('event: done');
    expect(mocks.getThreadMessages).toHaveBeenCalledWith('thread_attacker');
    expect(mocks.addMessage).toHaveBeenCalledTimes(2);
    expect(mocks.processMessage).not.toHaveBeenCalled();
    expect(mocks.processMessageStream).toHaveBeenCalledOnce();
  });

  it('denies cross-user feedback before attempting a message update', async () => {
    const response = await request(mountChatRouter())
      .post('/9f3e25b7-fc57-4ad9-bb32-0d5ecdb41489/feedback')
      .send({
        message_id: '86b7df04-4c25-4627-bcee-c7c69c671ec3',
        rating: 1,
      });

    expect(response.status).toBe(404);
    expect(response.body.error).toBe('Feedback target not found');
    expect(mocks.addMessageFeedback).not.toHaveBeenCalled();
  });

  it('allows the owner to submit validated feedback for a message in the same thread', async () => {
    mocks.getThreadByExternalId.mockResolvedValue({
      thread_id: 'thread_attacker',
      channel: 'web',
      external_id: '9f3e25b7-fc57-4ad9-bb32-0d5ecdb41489',
      user_type: 'workos',
      user_id: 'user_attacker',
    });

    const response = await request(mountChatRouter())
      .post('/9f3e25b7-fc57-4ad9-bb32-0d5ecdb41489/feedback')
      .send({
        message_id: '86b7df04-4c25-4627-bcee-c7c69c671ec3',
        rating: 4,
        rating_category: ' helpfulness ',
        feedback_text: ' Clear, but missing one example. ',
        feedback_tags: ['missing_info', 'too_short', 'missing_info'],
        improvement_suggestion: ' Add a concrete example. ',
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, message: 'Feedback submitted' });
    expect(mocks.addMessageFeedback).toHaveBeenCalledOnce();
    expect(mocks.addMessageFeedback).toHaveBeenCalledWith(
      'thread_attacker',
      '86b7df04-4c25-4627-bcee-c7c69c671ec3',
      {
        rating: 4,
        rating_category: 'helpfulness',
        rating_notes: 'Clear, but missing one example.',
        feedback_tags: ['missing_info', 'too_short'],
        improvement_suggestion: 'Add a concrete example.',
        rated_by: 'user_attacker',
        rating_source: 'user',
      },
    );
  });

  it('scopes feedback updates to the authorized thread and hides cross-thread misses', async () => {
    mocks.getThreadByExternalId.mockResolvedValue({
      thread_id: 'thread_attacker',
      channel: 'web',
      external_id: '9f3e25b7-fc57-4ad9-bb32-0d5ecdb41489',
      user_type: 'workos',
      user_id: 'user_attacker',
    });
    mocks.addMessageFeedback.mockResolvedValue(false);

    const response = await request(mountChatRouter())
      .post('/9f3e25b7-fc57-4ad9-bb32-0d5ecdb41489/feedback')
      .send({
        message_id: '86b7df04-4c25-4627-bcee-c7c69c671ec3',
        rating: 1,
        feedback_text: 'Overwrite another thread',
      });

    expect(response.status).toBe(404);
    expect(response.body.error).toBe('Feedback target not found');
    expect(mocks.addMessageFeedback).toHaveBeenCalledWith(
      'thread_attacker',
      '86b7df04-4c25-4627-bcee-c7c69c671ec3',
      expect.objectContaining({ rating: 1, rating_notes: 'Overwrite another thread' }),
    );
  });

  it('rejects oversized or unsupported feedback fields before lookup or write', async () => {
    const response = await request(mountChatRouter())
      .post('/9f3e25b7-fc57-4ad9-bb32-0d5ecdb41489/feedback')
      .send({
        message_id: '86b7df04-4c25-4627-bcee-c7c69c671ec3',
        rating: 5,
        feedback_text: 'x'.repeat(2_001),
        feedback_tags: ['<img src=x onerror=alert(1)>'],
      });

    expect(response.status).toBe(400);
    expect(mocks.getThreadByExternalId).not.toHaveBeenCalled();
    expect(mocks.addMessageFeedback).not.toHaveBeenCalled();
  });
});
