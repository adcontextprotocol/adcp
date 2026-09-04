import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const memberContextMocks = vi.hoisted(() => ({
  getWebMemberContext: vi.fn(),
  formatMemberContextForPrompt: vi.fn(),
}));

const siMocks = vi.hoisted(() => ({
  retrieve: vi.fn(),
  formatContext: vi.fn(),
}));

const siHostMocks = vi.hoisted(() => ({
  hasCachedSiSession: vi.fn(),
  toolNames: [
    'get_si_availability',
    'list_si_agents',
    'connect_to_si_agent',
    'send_to_si_agent',
    'end_si_session',
    'get_si_session_status',
  ],
}));

const directoryMocks = vi.hoisted(() => ({
  createHandlers: vi.fn(),
  toolNames: [
    'list_members',
    'get_member',
    'list_agents',
    'get_agent',
    'validate_agent',
    'lookup_domain',
    'list_publishers',
  ],
}));

const threadMocks = vi.hoisted(() => ({
  getThreadByExternalId: vi.fn(),
  getOrCreateThread: vi.fn(),
  getThreadMessages: vi.fn(),
  getRecoverableClientTurn: vi.fn(),
  addMessage: vi.fn(),
  addMessageFeedback: vi.fn(),
}));

vi.mock('../../src/addie/member-context.js', () => ({
  getWebMemberContext: memberContextMocks.getWebMemberContext,
  formatMemberContextForPrompt: memberContextMocks.formatMemberContextForPrompt,
}));

vi.mock('../../src/addie/services/si-retriever.js', () => ({
  siRetriever: {
    retrieve: siMocks.retrieve,
    formatContext: siMocks.formatContext,
  },
}));

vi.mock('../../src/addie/mcp/directory-tools.js', () => ({
  DIRECTORY_TOOLS: directoryMocks.toolNames.map((name) => ({
    name,
    description: `Test ${name}`,
    input_schema: { type: 'object', properties: {} },
  })),
  createDirectoryToolHandlers: (context: unknown) => {
    directoryMocks.createHandlers(context);
    return new Map(directoryMocks.toolNames.map((name) => [
      name,
      async () => JSON.stringify({ scoped: true }),
    ]));
  },
}));

vi.mock('../../src/addie/mcp/si-host-tools.js', () => ({
  SI_HOST_TOOLS: siHostMocks.toolNames.map((name) => ({
    name,
    description: `Test ${name}`,
    input_schema: { type: 'object', properties: {} },
  })),
  createSiHostToolHandlers: () => new Map(
    siHostMocks.toolNames.map((name) => [name, async () => '{}']),
  ),
  hasCachedSiSession: siHostMocks.hasCachedSiSession,
}));

vi.mock('../../src/db/certification-db.js', () => ({
  getProgress: vi.fn(),
}));

vi.mock('../../src/addie/admin-status-lookup.js', () => ({
  isWebUserAAOAdmin: vi.fn().mockResolvedValue(false),
}));

vi.mock('../../src/db/working-group-db.js', () => ({
  WorkingGroupDatabase: class {
    getCommitteesLedByUser = vi.fn().mockResolvedValue([]);
  },
}));

vi.mock('../../src/middleware/auth.js', () => ({
  optionalAuth: (req: any, _res: any, next: any) => {
    const id = req.get('x-test-user-id');
    if (id) req.user = { id, email: `${id}@example.com` };
    next();
  },
}));

vi.mock('../../src/addie/thread-service.js', () => ({
  getThreadService: () => threadMocks,
}));

import {
  canAccessWebThread,
  createAddieChatRouter,
  prepareRequestWithMemberTools,
} from '../../src/routes/addie-chat.js';
import { MAX_INPUT_LENGTH } from '../../src/addie/security.js';
import { DIRECTORY_TOOLS } from '../../src/addie/mcp/directory-tools.js';
import { ANONYMOUS_SAFE_KNOWLEDGE_TOOLS } from '../../src/mcp/chat-tool.js';
import { issueAnonymousSessionCapability } from '../../src/routes/helpers/anonymous-session-capability.js';

describe('prepareRequestWithMemberTools organization selection', () => {
  beforeEach(() => {
    memberContextMocks.getWebMemberContext.mockReset();
    memberContextMocks.getWebMemberContext.mockResolvedValue({
      is_mapped: false,
      is_member: false,
      slack_linked: false,
    });
    memberContextMocks.formatMemberContextForPrompt.mockReset();
    memberContextMocks.formatMemberContextForPrompt.mockReturnValue(null);
    siMocks.retrieve.mockReset();
    siMocks.retrieve.mockResolvedValue({ agents: [], retrieval_time_ms: 0 });
    siMocks.formatContext.mockReset();
    siHostMocks.hasCachedSiSession.mockReset();
    siHostMocks.hasCachedSiSession.mockReturnValue(false);
    directoryMocks.createHandlers.mockClear();
  });

  it('passes the selected organization id into web member context resolution', async () => {
    const prepared = await prepareRequestWithMemberTools(
      'Save this agent',
      'user_123',
      'thread_external_123',
      false,
      undefined,
      'org_selected_123',
    );

    expect(memberContextMocks.getWebMemberContext).toHaveBeenCalledWith('user_123', 'org_selected_123');
    expect(prepared.requestContext).toContain('## Authoritative time context');
    expect(prepared.requestContext).toMatch(/- utc_instant: \d{4}-\d{2}-\d{2}T/);
  });

  it('overrides the anonymous directory handler with the authenticated member context', async () => {
    const paidContext = {
      is_mapped: true,
      is_member: true,
      organization: {
        workos_organization_id: 'org_paid',
        name: 'Paid Org',
        subscription_status: 'active',
        is_personal: false,
        membership_tier: 'company_standard',
      },
    };
    memberContextMocks.getWebMemberContext.mockResolvedValue(paidContext);

    const prepared = await prepareRequestWithMemberTools(
      'List registered agents',
      'user_123',
      'thread_external_123',
      true,
    );

    expect(directoryMocks.createHandlers).toHaveBeenCalledWith(paidContext);
    expect(prepared.requestTools.tools.map((tool) => tool.name)).toContain('list_agents');
    expect(await prepared.requestTools.handlers.get('list_agents')?.({})).toBe('{"scoped":true}');
  });
});

describe('mounted Addie web-thread ownership', () => {
  const chatClient = {
    // Production globally registers public directory, search-member, and
    // anonymous-safe knowledge tools. SI host tools remain request-scoped
    // because their handlers bind the external conversation id.
    getRegisteredTools: vi.fn(() => [
      ...DIRECTORY_TOOLS.map((tool) => tool.name),
      'search_members',
      ...ANONYMOUS_SAFE_KNOWLEDGE_TOOLS,
    ]),
    processMessage: vi.fn().mockResolvedValue({
      text: 'Hello',
      tools_used: [],
      tool_executions: [],
    }),
    processMessageStream: vi.fn(() => (async function* () {
      yield { type: 'text', text: 'Hello' };
      yield {
        type: 'done',
        response: { text: 'Hello', tools_used: [], tool_executions: [] },
      };
    })()),
  } as any;

  function app(router?: any) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      const ownerCookie = req.get('cookie')
        ?.split(';')
        .map(value => value.trim())
        .find(value => value.startsWith('addie-anonymous-owner='));
      req.cookies = ownerCookie
        ? { 'addie-anonymous-owner': ownerCookie.slice('addie-anonymous-owner='.length) }
        : {};
      next();
    });
    instance.use('/api/addie/chat', createAddieChatRouter({ chatClient, router }).apiRouter);
    return instance;
  }

  beforeEach(() => {
    threadMocks.getThreadByExternalId.mockReset();
    threadMocks.getOrCreateThread.mockReset().mockResolvedValue({
      thread_id: 'thread-anonymous-created',
      user_type: 'anonymous',
      user_id: 'anonymous-owner-created',
      message_count: 0,
    });
    threadMocks.getThreadMessages.mockReset().mockResolvedValue([]);
    threadMocks.getRecoverableClientTurn.mockReset().mockResolvedValue(null);
    threadMocks.addMessage.mockReset().mockResolvedValue({
      message_id: '33333333-3333-4333-8333-333333333333',
    });
    threadMocks.addMessageFeedback.mockReset().mockResolvedValue(true);
  });

  it('hides another user\'s thread on the mounted GET route', async () => {
    threadMocks.getThreadByExternalId.mockResolvedValue({
      thread_id: 'thread-1', user_type: 'workos', user_id: 'owner', message_count: 0,
    });
    await request(app())
      .get('/api/addie/chat/11111111-1111-4111-8111-111111111111')
      .set('x-test-user-id', 'attacker')
      .expect(404);
    expect(threadMocks.getThreadMessages).not.toHaveBeenCalled();
  });

  it.each([
    ['JSON', '/api/addie/chat'],
    ['streaming', '/api/addie/chat/stream'],
  ])('hides another user\'s thread before writes on the mounted %s POST route', async (_label, path) => {
    threadMocks.getThreadByExternalId.mockResolvedValue({
      thread_id: 'thread-1', user_type: 'workos', user_id: 'owner', message_count: 0,
    });

    await request(app())
      .post(path)
      .set('x-test-user-id', 'attacker')
      .send({
        message: 'hello',
        conversation_id: '11111111-1111-4111-8111-111111111111',
      })
      .expect(404);

    expect(threadMocks.getThreadMessages).not.toHaveBeenCalled();
    expect(threadMocks.addMessage).not.toHaveBeenCalled();
  });

  it.each(['/api/addie/chat', '/api/addie/chat/stream'])('rejects oversized messages before thread access on %s', async (path) => {
    await request(app()).post(path).send({ message: 'x'.repeat(MAX_INPUT_LENGTH + 1) }).expect(413);
    expect(threadMocks.getThreadByExternalId).not.toHaveBeenCalled();
    expect(threadMocks.getOrCreateThread).not.toHaveBeenCalled();
    expect(threadMocks.addMessage).not.toHaveBeenCalled();
  });

  it.each([
    ['JSON', '/api/addie/chat', chatClient.processMessage],
    ['streaming', '/api/addie/chat/stream', chatClient.processMessageStream],
  ])(
    'accepts the incident-sized message unchanged on the %s route',
    async (_label, path, processMessage) => {
      const message = 'D'.repeat(10_329);
      processMessage.mockClear();

      await request(app()).post(path).send({ message }).expect(200);

      expect(processMessage.mock.calls[0]?.[0]).toBe(message);
    },
  );

  it('uses identical routed tools and prompt modules for authenticated JSON and streaming requests', async () => {
    const router = {
      quickMatch: vi.fn().mockReturnValue(null),
      route: vi.fn().mockResolvedValue({
        action: 'respond',
        tool_sets: ['agent_publisher_directory'],
        confidence: 'high',
        reason: 'directory lookup',
        decision_method: 'llm',
      }),
    };
    chatClient.processMessage.mockClear();
    chatClient.processMessageStream.mockClear();

    await request(app(router))
      .post('/api/addie/chat')
      .set('x-test-user-id', 'user_123')
      .send({ message: 'Find an agent' })
      .expect(200);
    await request(app(router))
      .post('/api/addie/chat/stream')
      .set('x-test-user-id', 'user_123')
      .send({ message: 'Find an agent' })
      .expect(200);

    const jsonTools = chatClient.processMessage.mock.calls[0]?.[2]?.tools.map((tool: { name: string }) => tool.name);
    const jsonOptions = chatClient.processMessage.mock.calls[0]?.[4];
    const streamTools = chatClient.processMessageStream.mock.calls[0]?.[2]?.tools.map((tool: { name: string }) => tool.name);
    const streamOptions = chatClient.processMessageStream.mock.calls[0]?.[3];

    expect(jsonTools).toEqual(streamTools);
    expect(jsonOptions.selectedToolSetNames).toEqual(['agent_publisher_directory']);
    expect(streamOptions.selectedToolSetNames).toEqual(jsonOptions.selectedToolSetNames);
    expect(streamOptions.allowedToolNames).toEqual(jsonOptions.allowedToolNames);
  });

  it.each([
    ['JSON', '/api/addie/chat', chatClient.processMessage, 4],
    ['streaming', '/api/addie/chat/stream', chatClient.processMessageStream, 3],
  ])('keeps sponsored-intelligence routing scoped to the external thread id on %s', async (
    _label,
    path,
    processMessage,
    optionsArgument,
  ) => {
    const conversationId = '11111111-1111-4111-8111-111111111111';
    const router = {
      quickMatch: vi.fn().mockReturnValue(null),
      route: vi.fn().mockResolvedValue({
        action: 'respond', tool_sets: ['partner_directory'], confidence: 'high', reason: 'test', decision_method: 'llm',
      }),
    };
    siHostMocks.hasCachedSiSession.mockReturnValue(true);
    threadMocks.getThreadByExternalId.mockResolvedValue({
      thread_id: 'thread-internal-id', user_type: 'workos', user_id: 'user_123', message_count: 1,
    });
    processMessage.mockClear();

    await request(app(router))
      .post(path)
      .set('x-test-user-id', 'user_123')
      .send({ message: 'Continue SI work', conversation_id: conversationId })
      .expect(200);

    expect(siHostMocks.hasCachedSiSession).toHaveBeenCalledWith(conversationId);
    expect(processMessage.mock.calls[0]?.[optionsArgument]?.selectedToolSetNames)
      .toEqual(['partner_directory', 'sponsored_intelligence_session']);
  });

  it('issues an HttpOnly owner capability cookie when an anonymous POST creates a thread', async () => {
    const response = await request(app())
      .post('/api/addie/chat')
      .send({ message: 'hello' })
      .expect(200);

    expect(response.headers['set-cookie']?.join(';')).toContain('addie-anonymous-owner=');
    expect(response.headers['set-cookie']?.join(';')).toContain('HttpOnly');
    expect(threadMocks.getOrCreateThread).toHaveBeenCalledWith(expect.objectContaining({
      user_type: 'anonymous',
      user_id: expect.any(String),
    }));
  });

  it('issues an HttpOnly owner capability cookie when an anonymous streaming POST creates a thread', async () => {
    const response = await request(app())
      .post('/api/addie/chat/stream')
      .send({ message: 'hello' })
      .expect(200);

    expect(response.headers['set-cookie']?.join(';')).toContain('addie-anonymous-owner=');
    expect(response.headers['set-cookie']?.join(';')).toContain('HttpOnly');
    expect(threadMocks.getOrCreateThread).toHaveBeenCalledWith(expect.objectContaining({
      user_type: 'anonymous',
      user_id: expect.any(String),
    }));
  });

  it('passes clamped GET pagination to the thread query', async () => {
    threadMocks.getThreadByExternalId.mockResolvedValue({
      thread_id: 'thread-1', user_type: 'workos', user_id: 'owner', message_count: 50_000,
    });

    const response = await request(app())
      .get('/api/addie/chat/11111111-1111-4111-8111-111111111111?limit=999&offset=99999')
      .set('x-test-user-id', 'owner')
      .expect(200);

    expect(threadMocks.getThreadMessages).toHaveBeenCalledWith('thread-1', {
      limit: 200,
      offset: 10_000,
    });
    expect(response.body).toMatchObject({ limit: 200, offset: 10_000 });
  });

  it('requires thread ownership and message-to-thread scoping for feedback', async () => {
    threadMocks.getThreadByExternalId.mockResolvedValue({
      thread_id: 'thread-1', user_type: 'workos', user_id: 'owner',
    });
    const path = '/api/addie/chat/11111111-1111-4111-8111-111111111111/feedback';
    const body = { message_id: '22222222-2222-4222-8222-222222222222', rating: 5 };

    await request(app()).post(path).set('x-test-user-id', 'attacker').send(body).expect(404);
    expect(threadMocks.addMessageFeedback).not.toHaveBeenCalled();

    threadMocks.addMessageFeedback.mockResolvedValueOnce(false);
    await request(app()).post(path).set('x-test-user-id', 'owner').send(body).expect(404);

    await request(app()).post(path).set('x-test-user-id', 'owner').send(body).expect(200);
    expect(threadMocks.addMessageFeedback).toHaveBeenCalledWith(
      'thread-1',
      body.message_id,
      expect.objectContaining({ rating: 5 }),
    );
  });

  it('rejects oversized and mistyped feedback before thread access', async () => {
    await request(app())
      .post('/api/addie/chat/11111111-1111-4111-8111-111111111111/feedback')
      .send({
        message_id: '22222222-2222-4222-8222-222222222222',
        rating: 5,
        feedback_text: 'x'.repeat(2_001),
      })
      .expect(400);
    expect(threadMocks.getThreadByExternalId).not.toHaveBeenCalled();
    expect(threadMocks.addMessageFeedback).not.toHaveBeenCalled();
  });

  it('allows only the signed anonymous owner cookie on the mounted GET route', async () => {
    const ownerId = 'anonymous-owner';
    threadMocks.getThreadByExternalId.mockResolvedValue({
      thread_id: 'thread-anon', user_type: 'anonymous', user_id: ownerId, message_count: 0,
    });
    const capability = issueAnonymousSessionCapability('addie-web-thread-owner', ownerId);
    const path = '/api/addie/chat/11111111-1111-4111-8111-111111111111';

    await request(app()).get(path).expect(404);
    await request(app()).get(path).set('Cookie', `addie-anonymous-owner=${capability}`).expect(200);
  });
});

describe('Addie existing web-thread ownership', () => {
  it('allows only the authenticated owner of a WorkOS thread', () => {
    const thread = { user_type: 'workos' as const, user_id: 'user_owner' };

    expect(canAccessWebThread({ user: { id: 'user_owner' }, cookies: {} } as any, thread)).toBe(true);
    expect(canAccessWebThread({ user: { id: 'user_other' }, cookies: {} } as any, thread)).toBe(false);
    expect(canAccessWebThread({ cookies: {} } as any, thread)).toBe(false);
  });

  it('requires a valid signed owner capability for an anonymous thread', () => {
    const ownerId = 'anon-owner-123';
    const capability = issueAnonymousSessionCapability('addie-web-thread-owner', ownerId);
    const thread = { user_type: 'anonymous' as const, user_id: ownerId };

    expect(canAccessWebThread({ cookies: { 'addie-anonymous-owner': capability } } as any, thread)).toBe(true);
    expect(canAccessWebThread({ cookies: {} } as any, thread)).toBe(false);
    expect(canAccessWebThread({ cookies: { 'addie-anonymous-owner': `${capability}tampered` } } as any, thread)).toBe(false);
  });

  it('fails closed for legacy anonymous threads without an owner binding', () => {
    expect(canAccessWebThread(
      { cookies: {} } as any,
      { user_type: 'anonymous', user_id: null },
    )).toBe(false);
  });
});
