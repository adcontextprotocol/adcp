import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const originalApiKey = process.env.ADDIE_ANTHROPIC_API_KEY;
process.env.ADDIE_ANTHROPIC_API_KEY = 'test-addie-object-authorization-key';

const mocks = vi.hoisted(() => ({
  authenticated: true,
  getThreadByExternalId: vi.fn(),
  getThreadMessages: vi.fn(),
  getMessagesByClientRequestId: vi.fn(),
  claimClientTurn: vi.fn(),
  renewClientTurnLease: vi.fn(),
  setClientTurnStatus: vi.fn(),
  getRecoverableClientTurn: vi.fn(),
  claimAnonymousThread: vi.fn(),
  addMessage: vi.fn(),
  addMessageFeedback: vi.fn(),
  processMessage: vi.fn(),
  processMessageStream: vi.fn(),
  initializeKnowledgeSearch: vi.fn().mockResolvedValue(undefined),
  getProgress: vi.fn(),
  getAttemptForUser: vi.fn(),
  memberContext: {
    is_mapped: false,
    is_member: false,
    slack_linked: false,
  } as Record<string, unknown>,
  createSlackKnowledgeRequestTools: vi.fn(() => ({ tools: [], handlers: new Map() })),
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
    getMessagesByClientRequestId: mocks.getMessagesByClientRequestId,
    claimClientTurn: mocks.claimClientTurn,
    renewClientTurnLease: mocks.renewClientTurnLease,
    setClientTurnStatus: mocks.setClientTurnStatus,
    getRecoverableClientTurn: mocks.getRecoverableClientTurn,
    claimAnonymousThread: mocks.claimAnonymousThread,
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
  createSlackKnowledgeRequestTools: mocks.createSlackKnowledgeRequestTools,
  isSlackKnowledgeTool: () => false,
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
  getWebMemberContext: vi.fn(() => Promise.resolve(mocks.memberContext)),
  formatMemberContextForPrompt: vi.fn().mockReturnValue(null),
}));

vi.mock('../../src/addie/services/si-retriever.js', () => ({
  siRetriever: {
    retrieve: vi.fn().mockResolvedValue({ agents: [], retrieval_time_ms: 0 }),
    formatContext: vi.fn().mockReturnValue(''),
  },
}));

vi.mock('../../src/db/certification-db.js', () => ({
  getProgress: mocks.getProgress,
  getAttemptForUser: mocks.getAttemptForUser,
}));

vi.mock('../../src/services/certification-experience.js', () => ({
  getCertificationExperienceForClientRequest: vi.fn().mockResolvedValue(null),
  getCertificationModuleExperience: vi.fn().mockResolvedValue(null),
  recordCertificationExperienceEvent: vi.fn().mockResolvedValue(undefined),
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
  resolveCompletionModuleId,
  resolveThreadCertificationProgress,
  prepareRequestWithMemberTools,
} from '../../src/routes/addie-chat.js';
import { issueAnonymousSessionCapability } from '../../src/routes/helpers/anonymous-session-capability.js';

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
  app.use((req, _res, next) => {
    const ownerCookie = req.get('cookie')
      ?.split(';')
      .map(value => value.trim())
      .find(value => value.startsWith('addie-anonymous-owner='));
    req.cookies = ownerCookie
      ? { 'addie-anonymous-owner': ownerCookie.slice('addie-anonymous-owner='.length) }
      : {};
    next();
  });
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
    mocks.memberContext = {
      is_mapped: false,
      is_member: false,
      slack_linked: false,
    };
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
    mocks.getMessagesByClientRequestId.mockResolvedValue([]);
    mocks.claimClientTurn.mockResolvedValue({ state: 'claimed', leaseId: 'lease-1' });
    mocks.renewClientTurnLease.mockResolvedValue(true);
    mocks.setClientTurnStatus.mockResolvedValue(undefined);
    mocks.getRecoverableClientTurn.mockResolvedValue(null);
    mocks.claimAnonymousThread.mockImplementation(async (
      _threadId: string,
      _ownerId: string,
      workosUserId: string,
      userDisplayName?: string,
    ) => ({
      thread_id: 'thread_anonymous',
      channel: 'web',
      external_id: '9f3e25b7-fc57-4ad9-bb32-0d5ecdb41489',
      user_type: 'workos',
      user_id: workosUserId,
      user_display_name: userDisplayName,
    }));
    mocks.addMessage.mockImplementation(async (message: { role: string }) => ({
      ...message,
      message_id: message.role === 'assistant' ? 'message_assistant' : 'message_user',
    }));
    mocks.processMessage.mockResolvedValue(successfulModelResponse());
    mocks.getProgress.mockResolvedValue([]);
    mocks.getAttemptForUser.mockResolvedValue(null);
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

    expect(response.status).toBe(404);
    expect(response.body.error).toBe('Conversation not found');
    expect(mocks.getThreadByExternalId).toHaveBeenCalledWith(
      'web',
      '9f3e25b7-fc57-4ad9-bb32-0d5ecdb41489',
    );
    expect(mocks.getThreadMessages).not.toHaveBeenCalled();
    expect(mocks.addMessage).not.toHaveBeenCalled();
    expect(mocks.processMessage).not.toHaveBeenCalled();
  });

  it('resolves an ordinary learner-progress module from its bound conversation', () => {
    const resolved = resolveThreadCertificationProgress([
      { module_id: 'S6', status: 'in_progress', addie_thread_id: 'other-thread', completed_at: null },
      { module_id: 'A1', status: 'completed', addie_thread_id: 'conversation-a1', completed_at: new Date().toISOString() },
      { module_id: 'A2', status: 'in_progress', addie_thread_id: 'conversation-a1', completed_at: null },
    ], 'conversation-a1', 'internal-thread-a1');

    expect(resolved?.module_id).toBe('A2');
  });

  it('attributes capstone completion to the attempt module instead of stale thread context', async () => {
    const attemptId = '36ad6e65-7a1c-45bb-ab7f-86b05ae3b718';
    mocks.getAttemptForUser.mockResolvedValue({
      id: attemptId,
      workos_user_id: 'user_attacker',
      module_id: 'S6',
    });

    const resolved = await resolveCompletionModuleId({
      tool_name: 'complete_certification_exam',
      parameters: { attempt_id: attemptId },
    }, 'user_attacker', 'A2');

    expect(resolved).toBe('S6');
    expect(mocks.getAttemptForUser).toHaveBeenCalledWith(attemptId, 'user_attacker');
  });

  it('builds authenticated unlinked web Slack tools with an explicit public-only scope', async () => {
    await prepareRequestWithMemberTools('hello', 'user_attacker', 'thread-web', true);

    expect(mocks.createSlackKnowledgeRequestTools).toHaveBeenCalledWith({ kind: 'public-only' });
  });

  it('builds linked web Slack tools with the member Slack identity', async () => {
    mocks.memberContext = {
      is_mapped: true,
      is_member: true,
      slack_linked: true,
      slack_user: { slack_user_id: 'U_LINKED' },
    };

    await prepareRequestWithMemberTools('hello', 'user_attacker', 'thread-web', true);

    expect(mocks.createSlackKnowledgeRequestTools).toHaveBeenCalledWith({
      kind: 'slack-user',
      slackUserId: 'U_LINKED',
    });
  });

  it('allows an anonymous caller to continue a thread with its signed owner capability', async () => {
    mocks.authenticated = false;
    const ownerId = 'anonymous-owner';
    mocks.getThreadByExternalId.mockResolvedValue({
      thread_id: 'thread_anonymous',
      channel: 'web',
      external_id: '9f3e25b7-fc57-4ad9-bb32-0d5ecdb41489',
      user_type: 'anonymous',
      user_id: ownerId,
    });
    const capability = issueAnonymousSessionCapability('addie-web-thread-owner', ownerId);

    const response = await request(mountChatRouter())
      .post('/')
      .set('Cookie', `addie-anonymous-owner=${capability}`)
      .send({
        message: 'Continue this anonymous conversation',
        conversation_id: '9f3e25b7-fc57-4ad9-bb32-0d5ecdb41489',
      });

    expect(response.status).toBe(200);
    expect(response.body.response).toBe('Allowed response');
    expect(mocks.getThreadMessages).toHaveBeenCalledWith('thread_anonymous', { limit: 100 });
    expect(mocks.addMessage).toHaveBeenCalledTimes(2);
    expect(mocks.processMessage).toHaveBeenCalledOnce();
  });

  it('claims a browser-owned anonymous thread when that learner signs in', async () => {
    const ownerId = 'anonymous-owner';
    mocks.getThreadByExternalId.mockResolvedValue({
      thread_id: 'thread_anonymous',
      channel: 'web',
      external_id: '9f3e25b7-fc57-4ad9-bb32-0d5ecdb41489',
      user_type: 'anonymous',
      user_id: ownerId,
    });
    const capability = issueAnonymousSessionCapability('addie-web-thread-owner', ownerId);

    const response = await request(mountChatRouter())
      .post('/')
      .set('Cookie', `addie-anonymous-owner=${capability}`)
      .send({
        message: 'Continue after signing in',
        conversation_id: '9f3e25b7-fc57-4ad9-bb32-0d5ecdb41489',
      });

    expect(response.status).toBe(200);
    expect(mocks.claimAnonymousThread).toHaveBeenCalledWith(
      'thread_anonymous', ownerId, 'user_attacker', 'Attacker',
    );
    expect(mocks.getThreadMessages).toHaveBeenCalledWith('thread_anonymous', { limit: 100 });
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

    expect(response.status).toBe(404);
    expect(response.body.error).toBe('Conversation not found');
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
    expect(mocks.getThreadMessages).toHaveBeenCalledWith('thread_attacker', { limit: 100 });
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

    expect(response.status).toBe(404);
    expect(response.body.error).toBe('Conversation not found');
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
    expect(mocks.getThreadMessages).toHaveBeenCalledWith('thread_attacker', { limit: 100 });
    expect(mocks.addMessage).toHaveBeenCalledTimes(2);
    expect(mocks.processMessage).not.toHaveBeenCalled();
    expect(mocks.processMessageStream).toHaveBeenCalledOnce();
  });

  it('replays a completed client request without duplicating messages, tools, or model work', async () => {
    mocks.getThreadByExternalId.mockResolvedValue({
      thread_id: 'thread_attacker',
      channel: 'web',
      external_id: '9f3e25b7-fc57-4ad9-bb32-0d5ecdb41489',
      user_type: 'workos',
      user_id: 'user_attacker',
    });
    mocks.getMessagesByClientRequestId.mockResolvedValue([
      {
        message_id: 'message_user',
        role: 'user',
        content: 'Complete my module',
        delivery_status: 'completed',
      },
      {
        message_id: 'message_assistant',
        role: 'assistant',
        content: 'Module complete and saved.',
        delivery_status: 'completed',
      },
    ]);

    const response = await request(mountChatRouter())
      .post('/stream')
      .send({
        message: 'Complete my module',
        conversation_id: '9f3e25b7-fc57-4ad9-bb32-0d5ecdb41489',
        client_request_id: 'e6c3ffbe-bbf4-4ae5-a32f-713e05af4b68',
        retry: true,
      });

    expect(response.status).toBe(200);
    expect(response.text).toContain('Module complete and saved.');
    expect(response.text).toContain('"replayed":true');
    expect(mocks.getThreadMessages).not.toHaveBeenCalled();
    expect(mocks.addMessage).not.toHaveBeenCalled();
    expect(mocks.processMessageStream).not.toHaveBeenCalled();
  });

  it('rejects a duplicate request while the original turn owns the execution lease', async () => {
    mocks.getThreadByExternalId.mockResolvedValue({
      thread_id: 'thread_attacker',
      channel: 'web',
      external_id: '9f3e25b7-fc57-4ad9-bb32-0d5ecdb41489',
      user_type: 'workos',
      user_id: 'user_attacker',
    });
    mocks.getMessagesByClientRequestId.mockResolvedValue([{
      message_id: 'message_user',
      role: 'user',
      content: 'Complete my module',
      delivery_status: 'completed',
    }]);
    mocks.claimClientTurn.mockResolvedValue({ state: 'processing' });

    const response = await request(mountChatRouter())
      .post('/stream')
      .send({
        message: 'Complete my module',
        conversation_id: '9f3e25b7-fc57-4ad9-bb32-0d5ecdb41489',
        client_request_id: 'e6c3ffbe-bbf4-4ae5-a32f-713e05af4b68',
        retry: true,
      });

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('turn_in_progress');
    expect(mocks.addMessage).not.toHaveBeenCalled();
    expect(mocks.processMessageStream).not.toHaveBeenCalled();
  });

  it('marks a stream that ends without done as interrupted and recoverable', async () => {
    mocks.getThreadByExternalId.mockResolvedValue({
      thread_id: 'thread_attacker',
      channel: 'web',
      external_id: '9f3e25b7-fc57-4ad9-bb32-0d5ecdb41489',
      user_type: 'workos',
      user_id: 'user_attacker',
    });
    mocks.processMessageStream.mockImplementation(async function* () {
      yield { type: 'text', text: 'Partial response' };
    });

    const response = await request(mountChatRouter())
      .post('/stream')
      .send({
        message: 'Continue assessment',
        conversation_id: '9f3e25b7-fc57-4ad9-bb32-0d5ecdb41489',
        client_request_id: 'e6c3ffbe-bbf4-4ae5-a32f-713e05af4b68',
      });

    expect(response.status).toBe(200);
    expect(response.text).toContain('Reply ended before completion');
    expect(response.text).toContain('"recoverable":true');
    expect(mocks.addMessage).toHaveBeenCalledWith(expect.objectContaining({
      role: 'assistant',
      delivery_status: 'interrupted',
      client_turn_lease_id: 'lease-1',
      finalize_client_turn_status: 'interrupted',
    }));
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
