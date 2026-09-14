import { describe, expect, it, vi } from 'vitest';
import type { AddieTool } from '../../../src/addie/types.js';
import {
  handleActiveThreadReply,
  handleAppMention,
  selectRoutedDirectSlackTools,
  selectRoutedToolsForSlackResponse,
} from '../../../src/addie/bolt-app.js';
import { AAOAdminLookupUnavailableError } from '../../../src/addie/admin-status-lookup.js';
import {
  PLATFORM_ADMIN_TOOL_PERMISSION_DENIED_MESSAGE,
  PlatformAdminToolPermissionDeniedError,
} from '../../../src/addie/admin-tool-boundary.js';
import {
  PUBLIC_MENTION_READ_ONLY_TOOL_NAMES,
} from '../../../src/addie/slack-tool-selection.js';

const tools: AddieTool[] = [
  { name: 'search_docs', description: 'Search docs', input_schema: { type: 'object', properties: {} } },
  { name: 'create_payment_link', description: 'Create payment link', input_schema: { type: 'object', properties: {} } },
  { name: 'confirm_send_invoice', description: 'Confirm invoice', input_schema: { type: 'object', properties: {} } },
  { name: 'resolve_escalation', description: 'Resolve escalation', input_schema: { type: 'object', properties: {} } },
  { name: 'capture_learning', description: 'Capture learning', input_schema: { type: 'object', properties: {} } },
  { name: 'set_outreach_preference', description: 'Set outreach preference', input_schema: { type: 'object', properties: {} } },
  { name: 'get_account_link', description: 'Get account link', input_schema: { type: 'object', properties: {} } },
  { name: 'list_escalations', description: 'List escalations', input_schema: { type: 'object', properties: {} } },
  { name: 'orphaned_definition', description: 'Must not reach the model', input_schema: { type: 'object', properties: {} } },
];
const handlers = new Map(tools
  .filter((tool) => tool.name !== 'orphaned_definition')
  .map((tool) => [tool.name, async () => '{}']));
handlers.set('orphaned_handler', async () => '{}');

function routerFor(toolSets: string[]) {
  return {
    quickMatch: vi.fn().mockReturnValue(null),
    route: vi.fn().mockResolvedValue({
      action: 'respond' as const,
      tool_sets: toolSets,
      confidence: 'medium' as const,
      reason: 'test',
      decision_method: 'llm' as const,
      requires_precision: true,
      requires_depth: true,
    }),
  };
}

async function select(input: {
  toolSets?: string[];
  source?: 'dm' | 'mention';
  isAAOAdmin?: boolean;
  isPublicChannel?: boolean;
  router?: ReturnType<typeof routerFor> | null;
  requestTools?: { tools: AddieTool[]; handlers: Map<string, () => Promise<string>> };
  hasRegisteredTools?: (names: string[]) => boolean;
  activeCertificationKind?: 'learning' | 'assessment' | 'mixed';
  message?: string;
}) {
  const router = input.router === undefined ? routerFor(input.toolSets ?? ['member_billing']) : input.router;
  return selectRoutedDirectSlackTools({
    message: input.message ?? 'Test direct Slack request',
    source: input.source ?? 'dm',
    memberContext: null,
    threadId: 'thread-1',
    isThread: true,
    isAAOAdmin: input.isAAOAdmin ?? false,
    requestTools: input.requestTools ?? { tools, handlers },
    router,
    // This models only a trusted client-global definition/handler pair. The
    // request-local tools above still need their own exact pair.
    hasRegisteredTools: input.hasRegisteredTools ?? (() => true),
    activeCertificationKind: input.activeCertificationKind,
    isPublicChannel: input.isPublicChannel,
  });
}

describe('direct Slack Addie response tool routing', () => {
  it.each(['list_escalations', 'resolve_escalation'])(
    'rejects an explicit non-admin private Slack %s request before routing',
    async (toolName) => {
      const router = routerFor(['admin_escalations']);

      await expect(select({ router, message: toolName }))
        .rejects.toMatchObject({ code: 'platform_admin_permission_denied', statusCode: 403 });
      expect(router.quickMatch).not.toHaveBeenCalled();
      expect(router.route).not.toHaveBeenCalled();
    },
  );

  it('keeps explicit reserved admin names withheld on public Slack', async () => {
    const router = routerFor(['admin_escalations']);
    const selected = await select({
      router,
      source: 'mention',
      isPublicChannel: true,
      message: 'list_escalations',
    });

    expect(router.route).toHaveBeenCalledOnce();
    expect(selected.allowedToolNames).not.toEqual(expect.arrayContaining([
      'list_escalations', 'resolve_escalation',
    ]));
  });

  it.each(['dm', 'mention'] as const)('uses the bounded selector at the %s response seam', async (source) => {
    const router = routerFor(['member_billing']);
    const selected = await select({
      source,
      router,
      ...(source === 'mention' ? { isPublicChannel: false } : {}),
    });

    expect(selected.selectedToolSets).toEqual(['member_billing']);
    expect(selected.allowedToolNames).toContain('create_payment_link');
    expect(selected.allowedToolNames).not.toContain('search_docs');
    expect(selected.tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['create_payment_link']));
    expect([...selected.tools.handlers.keys()]).toEqual(expect.arrayContaining(['create_payment_link']));
    expect(selected.requiresPrecision).toBe(true);
    expect(selected.requiresDepth).toBe(true);
    expect(selected.confidence).toBe('medium');
    expect(router.route).toHaveBeenCalledWith(expect.objectContaining({ source, isThread: true }));
  });

  it('retains explicit knowledge and valid two-domain direct routes', async () => {
    const knowledge = await select({ toolSets: ['knowledge'] });
    expect(knowledge.selectedToolSets).toEqual(['knowledge']);
    expect(knowledge.tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['search_docs']));

    const twoDomains = await select({ toolSets: ['knowledge', 'member_billing'] });
    expect(twoDomains.selectedToolSets).toEqual(['knowledge', 'member_billing']);
    expect(twoDomains.tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'search_docs', 'create_payment_link',
    ]));
  });

  it.each([
    ['empty', routerFor([])],
    ['stale', routerFor(['obsolete_router_alias'])],
    ['unauthenticated', routerFor(['admin_prospect_pipeline'])],
    ['over-two-domain', routerFor(['knowledge', 'partner_directory', 'events'])],
    ['non-response', {
      quickMatch: vi.fn().mockReturnValue({ action: 'react', emoji: 'wave', reason: 'test', decision_method: 'quick_match' }),
      route: vi.fn(),
    }],
  ] as const)('keeps direct %s interactions answerable through the safe fallback', async (label, router) => {
    const selected = await select({ router });

    expect(selected.selectedToolSets).toEqual(['knowledge', 'community_research', 'schema_reference']);
    expect(selected.tools.tools.map((tool) => tool.name)).toEqual(['search_docs']);
    expect(selected.allowedToolNames).not.toEqual(expect.arrayContaining([
      'create_payment_link', 'confirm_send_invoice', 'resolve_escalation',
    ]));
    expect(selected.requiresPrecision).toBe(false);
    expect(selected.requiresDepth).toBe(false);
  });

  it('propagates a direct router failure', async () => {
    const router = {
      quickMatch: vi.fn().mockReturnValue(null),
      route: vi.fn().mockRejectedValue(new Error('router unavailable')),
    };

    await expect(select({ router })).rejects.toThrow('router unavailable');
  });

  it('falls back when a selected request definition lacks its exact handler pair', async () => {
    const incompleteHandlers = new Map(handlers);
    incompleteHandlers.delete('create_payment_link');
    const selected = await select({
      requestTools: { tools, handlers: incompleteHandlers },
      hasRegisteredTools: (names) => names[0] !== 'create_payment_link',
    });

    expect(selected.selectedToolSets).toEqual(['knowledge', 'community_research', 'schema_reference']);
    expect(selected.tools.tools.map((tool) => tool.name)).toEqual(['search_docs']);
    expect([...selected.tools.handlers.keys()]).toEqual(['search_docs']);
  });

  it('keeps public fallback recovery inside the audited read-only surface', async () => {
    const selected = await select({
      source: 'mention',
      isPublicChannel: true,
      toolSets: ['knowledge'],
      // The routed knowledge domain is valid, but get_doc and search_repos
      // have no exact definition/handler pair. Private fallback retrievals
      // are globally registered and must still not reach a public reply.
      hasRegisteredTools: ([name]) => [
        'search_slack',
        'read_slack_file',
        'get_channel_activity',
        'fetch_url',
        'search_resources',
        'get_recent_news',
      ].includes(name),
    });

    expect(selected.useSafeFallback).toBe(true);
    expect(selected.selectedToolSets).toEqual(['knowledge', 'community_research', 'schema_reference']);
    expect(selected.allowedToolNames).toContain('search_docs');
    expect(selected.allowedToolNames.every((name) =>
      (PUBLIC_MENTION_READ_ONLY_TOOL_NAMES as readonly string[]).includes(name),
    )).toBe(true);
    expect(selected.allowedToolNames).not.toEqual(expect.arrayContaining([
      'search_slack', 'read_slack_file', 'get_channel_activity',
      'fetch_url', 'search_resources', 'get_recent_news',
    ]));
  });

  it('suppresses the registered app-mention handler when channel privacy lookup fails', async () => {
    const modelDispatch = vi.fn();
    const responseDelivery = vi.fn();
    const getThreadService = vi.fn();
    const selectRoutedTools = vi.fn();
    const buildCurrentChannelCostOptions = vi.fn();
    const logInteraction = vi.fn();

    await handleAppMention({
      event: { channel: 'C_UNVERIFIED', ts: '1', user: 'U_TEST', text: '<@B_ADDIE> help' },
      context: { botUserId: 'B_ADDIE' },
      say: responseDelivery,
    } as never, {
      claudeClient: { processMessage: modelDispatch } as never,
      resolveChannelContext: vi.fn().mockResolvedValue(null),
      getThreadService,
      selectRoutedTools,
      buildCurrentChannelCostOptions,
      logInteraction,
    });

    expect(getThreadService).not.toHaveBeenCalled();
    expect(selectRoutedTools).not.toHaveBeenCalled();
    expect(buildCurrentChannelCostOptions).not.toHaveBeenCalled();
    expect(logInteraction).not.toHaveBeenCalled();
    expect(modelDispatch).not.toHaveBeenCalled();
    expect(responseDelivery).not.toHaveBeenCalled();
  });

  it('reports an app-mention routing error without dispatching the model', async () => {
    const modelDispatch = vi.fn();
    const responseDelivery = vi.fn();
    const selectRoutedTools = vi.fn().mockRejectedValue(new Error('router unavailable'));
    const buildCurrentChannelCostOptions = vi.fn();
    const logInteraction = vi.fn();
    const threadService = {
      getOrCreateThread: vi.fn().mockResolvedValue({ thread_id: 'thread-1' }),
      getThreadMessages: vi.fn().mockResolvedValue([]),
      addMessage: vi.fn().mockResolvedValue(undefined),
    };

    await handleAppMention({
      event: { channel: 'C_PRIVATE', ts: '1', user: 'U_TEST', text: '<@B_ADDIE> help' },
      context: { botUserId: 'B_ADDIE' },
      say: responseDelivery,
    } as never, {
      claudeClient: { processMessage: modelDispatch } as never,
      resolveChannelContext: vi.fn().mockResolvedValue({
        viewing_channel_name: 'private-test',
        viewing_channel_is_private: true,
      }),
      getChannelHistory: vi.fn().mockResolvedValue({ messages: [], has_more: false }),
      getMemberContext: vi.fn().mockResolvedValue(null),
      buildRequestContext: vi.fn().mockResolvedValue({
        requestContext: 'test request context',
        memberContext: null,
        activeCertificationKind: undefined,
      }),
      getThreadService: vi.fn(() => threadService as never),
      selectRoutedTools,
      buildCurrentChannelCostOptions,
      logInteraction,
    });

    expect(selectRoutedTools).toHaveBeenCalledOnce();
    expect(modelDispatch).not.toHaveBeenCalled();
    expect(buildCurrentChannelCostOptions).not.toHaveBeenCalled();
    expect(logInteraction).not.toHaveBeenCalled();
    expect(responseDelivery).toHaveBeenCalledWith({
      text: "I'm sorry, I can't process that request right now. Please try again.",
      thread_ts: '1',
    });
  });

  it('reports an admin-status outage with retry guidance and no model dispatch', async () => {
    const modelDispatch = vi.fn();
    const responseDelivery = vi.fn();
    const selectRoutedTools = vi.fn().mockRejectedValue(new AAOAdminLookupUnavailableError());
    const buildCurrentChannelCostOptions = vi.fn();
    const logInteraction = vi.fn();
    const threadService = {
      getOrCreateThread: vi.fn().mockResolvedValue({ thread_id: 'thread-1' }),
      getThreadMessages: vi.fn().mockResolvedValue([]),
      addMessage: vi.fn().mockResolvedValue(undefined),
    };

    await handleAppMention({
      event: { channel: 'C_PRIVATE', ts: '1', user: 'U_TEST', text: '<@B_ADDIE> help' },
      context: { botUserId: 'B_ADDIE' },
      say: responseDelivery,
    } as never, {
      claudeClient: { processMessage: modelDispatch } as never,
      resolveChannelContext: vi.fn().mockResolvedValue({
        viewing_channel_name: 'private-test',
        viewing_channel_is_private: true,
      }),
      getChannelHistory: vi.fn().mockResolvedValue({ messages: [], has_more: false }),
      getMemberContext: vi.fn().mockResolvedValue(null),
      buildRequestContext: vi.fn().mockResolvedValue({
        requestContext: 'test request context',
        memberContext: null,
        activeCertificationKind: undefined,
      }),
      getThreadService: vi.fn(() => threadService as never),
      selectRoutedTools,
      buildCurrentChannelCostOptions,
      logInteraction,
    });

    expect(selectRoutedTools).toHaveBeenCalledOnce();
    expect(modelDispatch).not.toHaveBeenCalled();
    expect(buildCurrentChannelCostOptions).not.toHaveBeenCalled();
    expect(logInteraction).not.toHaveBeenCalled();
    expect(responseDelivery).toHaveBeenCalledWith({
      text: 'Administrator authorization is temporarily unavailable. Please try again.',
      thread_ts: '1',
    });
  });

  it('returns deterministic permission denial for a private explicit admin-tool mention without model or cost dispatch', async () => {
    const modelDispatch = vi.fn();
    const responseDelivery = vi.fn();
    const selectRoutedTools = vi.fn().mockRejectedValue(new PlatformAdminToolPermissionDeniedError());
    const buildCurrentChannelCostOptions = vi.fn();
    const logInteraction = vi.fn();
    const threadService = {
      getOrCreateThread: vi.fn().mockResolvedValue({ thread_id: 'thread-1' }),
      getThreadMessages: vi.fn().mockResolvedValue([]),
      addMessage: vi.fn().mockResolvedValue(undefined),
    };

    await handleAppMention({
      event: { channel: 'C_PRIVATE', ts: '1', user: 'U_TEST', text: '<@B_ADDIE> list_escalations' },
      context: { botUserId: 'B_ADDIE' },
      say: responseDelivery,
    } as never, {
      claudeClient: { processMessage: modelDispatch } as never,
      resolveChannelContext: vi.fn().mockResolvedValue({
        viewing_channel_name: 'private-test',
        viewing_channel_is_private: true,
      }),
      getChannelHistory: vi.fn().mockResolvedValue({ messages: [], has_more: false }),
      getMemberContext: vi.fn().mockResolvedValue(null),
      buildRequestContext: vi.fn().mockResolvedValue({
        requestContext: 'test request context',
        memberContext: null,
        activeCertificationKind: undefined,
      }),
      getThreadService: vi.fn(() => threadService as never),
      selectRoutedTools,
      buildCurrentChannelCostOptions,
      logInteraction,
    });

    expect(modelDispatch).not.toHaveBeenCalled();
    expect(buildCurrentChannelCostOptions).not.toHaveBeenCalled();
    expect(logInteraction).not.toHaveBeenCalled();
    expect(responseDelivery).toHaveBeenCalledWith({
      text: PLATFORM_ADMIN_TOOL_PERMISSION_DENIED_MESSAGE,
      thread_ts: '1',
    });
  });

  it.each([
    ['forbidden', false, PLATFORM_ADMIN_TOOL_PERMISSION_DENIED_MESSAGE],
    ['unavailable', 'unavailable', 'Administrator authorization is temporarily unavailable. Please try again.'],
  ] as const)(
    'stops an active private-channel list request as %s before router, model, handler, or cost dispatch',
    async (_label, adminDecision, expectedMessage) => {
      const router = routerFor(['admin_escalations']);
      const modelDispatch = vi.fn();
      const listHandler = vi.fn().mockResolvedValue('{}');
      const buildCostOptions = vi.fn();
      const responseDelivery = vi.fn().mockResolvedValue(undefined);
      const createUserScopedTools = adminDecision === 'unavailable'
        ? vi.fn().mockRejectedValue(new AAOAdminLookupUnavailableError())
        : vi.fn().mockResolvedValue({
          tools: {
            tools: [tools.find((tool) => tool.name === 'list_escalations')!],
            handlers: new Map([['list_escalations', listHandler]]),
          },
          isAAOAdmin: false,
        });
      const selectWithBoundary: typeof selectRoutedToolsForSlackResponse = (
        message,
        source,
        memberContext,
        slackUserId,
        threadId,
        threadContext,
        options,
      ) => selectRoutedToolsForSlackResponse(
        message,
        source,
        memberContext,
        slackUserId,
        threadId,
        threadContext,
        options,
        { createUserScopedTools: createUserScopedTools as never, router },
      );
      const threadService = {
        getOrCreateThread: vi.fn().mockResolvedValue({ thread_id: 'active-thread-1' }),
        getThreadMessages: vi.fn().mockResolvedValue([]),
        addMessage: vi.fn().mockResolvedValue(undefined),
      };

      await handleActiveThreadReply({
        event: { channel: 'C_PRIVATE', ts: '2', user: 'U_TEST', text: 'list_escalations', thread_ts: '1' },
        context: { botUserId: 'B_ADDIE' },
        channelId: 'C_PRIVATE',
        userId: 'U_TEST',
        messageText: 'list_escalations',
        threadTs: '1',
        startTime: Date.now(),
        threadService: threadService as never,
        slackThreadMessages: [],
      }, {
        claudeClient: { processMessage: modelDispatch } as never,
        postMessage: responseDelivery,
        buildChannelContext: vi.fn().mockResolvedValue({
          viewing_channel_name: 'private-test',
          viewing_channel_is_private: true,
        }),
        getMemberContext: vi.fn().mockResolvedValue(null),
        buildRequestContext: vi.fn().mockResolvedValue({
          requestContext: 'test request context',
          memberContext: null,
          activeCertificationKind: null,
        }),
        selectRoutedTools: selectWithBoundary,
        buildCurrentChannelCostOptions: buildCostOptions,
      });

      expect(router.quickMatch).not.toHaveBeenCalled();
      expect(router.route).not.toHaveBeenCalled();
      expect(modelDispatch).not.toHaveBeenCalled();
      expect(listHandler).not.toHaveBeenCalled();
      expect(buildCostOptions).not.toHaveBeenCalled();
      expect(responseDelivery).toHaveBeenCalledWith({
        channel: 'C_PRIVATE',
        text: expectedMessage,
        thread_ts: '1',
      });
    },
  );

  it.each([
    ['private', true, true],
    ['public', false, false],
  ] as const)(
    'keeps the active %s-channel admin list surface correctly scoped',
    async (_label, isPrivate, expectListTool) => {
      const router = routerFor(['admin_escalations']);
      const listTool = tools.find((tool) => tool.name === 'list_escalations')!;
      const listHandler = vi.fn().mockResolvedValue('{}');

      const selected = await selectRoutedToolsForSlackResponse(
        'list_escalations',
        'channel',
        null,
        'U_ADMIN',
        'active-thread-admin',
        {
          viewing_channel_name: `${_label}-test`,
          viewing_channel_is_private: isPrivate,
        },
        { isThread: true },
        {
          createUserScopedTools: vi.fn().mockResolvedValue({
            tools: {
              tools: [listTool],
              handlers: new Map([['list_escalations', listHandler]]),
            },
            isAAOAdmin: true,
          }),
          router,
        },
      );

      expect(router.route).toHaveBeenCalledOnce();
      expect(selected.tools.tools.some((tool) => tool.name === 'list_escalations'))
        .toBe(expectListTool);
      expect(selected.tools.handlers.has('list_escalations')).toBe(expectListTool);
      expect(listHandler).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['admin', true, 'undefined', undefined],
    ['non-admin', false, 'undefined', undefined],
    ['admin', true, 'null', null],
    ['non-admin', false, 'null', null],
    ['admin', true, 'lookup error', 'error'],
    ['non-admin', false, 'lookup error', 'error'],
  ] as const)(
    'uses the public-safe active channel surface for %s when privacy is %s',
    async (_role, isAdmin, _privacyLabel, privacy) => {
      const router = routerFor(['admin_escalations']);
      const listTool = tools.find((tool) => tool.name === 'list_escalations')!;
      const resolveTool = tools.find((tool) => tool.name === 'resolve_escalation')!;
      const listHandler = vi.fn().mockResolvedValue('{}');
      const resolveHandler = vi.fn().mockResolvedValue('{}');
      const createUserScopedTools = vi.fn().mockResolvedValue({
        tools: {
          tools: [listTool, resolveTool],
          handlers: new Map([
            ['list_escalations', listHandler],
            ['resolve_escalation', resolveHandler],
          ]),
        },
        isAAOAdmin: isAdmin,
      });
      const selectWithBoundary: typeof selectRoutedToolsForSlackResponse = (
        message,
        source,
        memberContext,
        slackUserId,
        threadId,
        threadContext,
        options,
      ) => selectRoutedToolsForSlackResponse(
        message,
        source,
        memberContext,
        slackUserId,
        threadId,
        threadContext,
        options,
        { createUserScopedTools: createUserScopedTools as never, router },
      );
      let selectedTools: { tools: AddieTool[]; handlers: Map<string, unknown> } | undefined;
      let selectedRequestContext = '';
      const modelDispatch = vi.fn().mockImplementation(async (
        _message,
        _history,
        requestTools,
        _rules,
        processOptions,
      ) => {
        selectedTools = requestTools;
        selectedRequestContext = processOptions.requestContext;
        return {
          text: 'Please ask me in a direct message for administrative escalation details.',
          tools_used: [],
          tool_executions: [],
          model_execution: {
            source: 'local', requested_provider: 'anthropic', requested_model: 'test', reason: 'empty_response',
          },
        };
      });
      const responseDelivery = vi.fn().mockResolvedValue(undefined);
      const buildChannelContext = privacy === 'error'
        ? vi.fn().mockRejectedValue(new Error('privacy lookup failed'))
        : vi.fn().mockResolvedValue({
            viewing_channel_name: 'unverified-channel',
            viewing_channel_is_private: privacy,
          });
      const buildRequestContext = vi.fn().mockImplementation(async (_userId, context) => {
        expect(context.viewing_channel_is_private).toBe(false);
        return {
          requestContext: 'PUBLIC-SAFE: do not disclose sensitive data; direct the requester to a DM.',
          memberContext: null,
          activeCertificationKind: null,
        };
      });
      const threadService = {
        getOrCreateThread: vi.fn().mockResolvedValue({ thread_id: 'active-unverified' }),
        getThreadMessages: vi.fn().mockResolvedValue([]),
        addMessage: vi.fn().mockResolvedValue(undefined),
      };

      await handleActiveThreadReply({
        event: { channel: 'C_UNVERIFIED', ts: '2', user: 'U_TEST', text: 'list_escalations', thread_ts: '1' },
        context: { botUserId: 'B_ADDIE' },
        channelId: 'C_UNVERIFIED',
        userId: 'U_TEST',
        messageText: 'list_escalations',
        threadTs: '1',
        startTime: Date.now(),
        threadService: threadService as never,
        slackThreadMessages: [],
      }, {
        claudeClient: { processMessage: modelDispatch } as never,
        postMessage: responseDelivery,
        buildChannelContext: buildChannelContext as never,
        getMemberContext: vi.fn().mockResolvedValue(null),
        buildRequestContext,
        selectRoutedTools: selectWithBoundary,
        buildCurrentChannelCostOptions: vi.fn().mockResolvedValue({}),
      });

      expect(router.route).toHaveBeenCalledOnce();
      expect(selectedTools?.tools.map((tool) => tool.name)).not.toEqual(expect.arrayContaining([
        'list_escalations', 'resolve_escalation',
      ]));
      expect([...(selectedTools?.handlers.keys() ?? [])]).not.toEqual(expect.arrayContaining([
        'list_escalations', 'resolve_escalation',
      ]));
      expect(selectedRequestContext).toContain('PUBLIC-SAFE');
      expect(listHandler).not.toHaveBeenCalled();
      expect(resolveHandler).not.toHaveBeenCalled();
      expect(responseDelivery).toHaveBeenCalledWith({
        channel: 'C_UNVERIFIED',
        text: 'Please ask me in a direct message for administrative escalation details.',
        thread_ts: '1',
      });
    },
  );

  it('fails closed to the audited public surface when mention privacy is unknown', async () => {
    const selected = await select({
      source: 'mention',
      toolSets: ['community_discussions'],
    });

    expect(selected.allowedToolNames.every((name) =>
      (PUBLIC_MENTION_READ_ONLY_TOOL_NAMES as readonly string[]).includes(name),
    )).toBe(true);
    expect(selected.allowedToolNames).not.toEqual(expect.arrayContaining([
      'search_slack', 'read_slack_file', 'get_channel_activity',
      'fetch_url', 'search_resources', 'get_recent_news',
    ]));
  });

  it('exposes a confirmation tool only when its domain is explicitly routed and paired', async () => {
    const selected = await select({ toolSets: ['member_billing'] });
    expect(selected.selectedToolSets).toEqual(['member_billing']);
    expect(selected.tools.tools.map((tool) => tool.name)).toContain('confirm_send_invoice');
    expect([...selected.tools.handlers.keys()]).toContain('confirm_send_invoice');

    const unavailable = await select({
      toolSets: ['member_billing'],
      requestTools: { tools, handlers: new Map([...handlers].filter(([name]) => name !== 'confirm_send_invoice')) },
      hasRegisteredTools: (names) => names[0] !== 'confirm_send_invoice',
    });
    expect(unavailable.selectedToolSets).toEqual(['knowledge', 'community_research', 'schema_reference']);
    expect(unavailable.allowedToolNames).not.toContain('confirm_send_invoice');
  });

  it('preserves the trusted DM certification workflow with a valid or unavailable router', async () => {
    const valid = await select({ activeCertificationKind: 'learning' });
    const unavailable = await select({ activeCertificationKind: 'learning', router: null });
    const expected = ['certification_learning', 'knowledge', 'community_research', 'schema_reference', 'illustrations'];

    expect(valid.selectedToolSets).toEqual(expected);
    expect(unavailable.selectedToolSets).toEqual(expected);
    expect(unavailable.allowedToolNames).toContain('start_certification_module');
  });

  it('does not let a mention inherit certification and excludes mutations from a public mention', async () => {
    const certificationMention = await select({
      source: 'mention',
      toolSets: ['partner_directory'],
      activeCertificationKind: 'learning',
      isPublicChannel: false,
    });
    expect(certificationMention.selectedToolSets).toEqual(['partner_directory']);
    expect(certificationMention.allowedToolNames).not.toContain('start_certification_module');

    const publicAdminMention = await select({
      source: 'mention',
      toolSets: ['billing', 'admin_workflows'],
      isAAOAdmin: true,
      isPublicChannel: true,
    });
    expect(publicAdminMention.allowedToolNames).not.toEqual(expect.arrayContaining([
      'create_payment_link', 'confirm_send_invoice', 'resolve_escalation',
      'escalate_to_admin', 'get_escalation_status', 'capture_learning',
      'set_outreach_preference', 'save_agent', 'start_certification_module',
    ]));
  });

  it('removes legacy always-available and admin escalation tools from public mentions', async () => {
    const selected = await select({
      source: 'mention',
      toolSets: ['knowledge'],
      isAAOAdmin: true,
      isPublicChannel: true,
    });
    const definitionNames = selected.tools.tools.map((tool) => tool.name).sort();
    const handlerNames = [...selected.tools.handlers.keys()].sort();
    const disallowedNames = [
      'capture_learning', 'set_outreach_preference', 'get_account_link',
      'set_my_name', 'save_agent',
      'create_payment_link', 'confirm_send_invoice',
      'resolve_escalation', 'list_escalations', 'escalate_to_admin',
      'start_certification_module',
    ];

    expect(definitionNames).toEqual(['search_docs']);
    expect(handlerNames).toEqual(definitionNames);
    expect(definitionNames).toContain('search_docs');
    for (const names of [definitionNames, handlerNames, selected.allowedToolNames]) {
      expect(names).not.toEqual(expect.arrayContaining(disallowedNames));
    }
  });

  it('keeps selected definitions, handlers, and allowed names in agreement', async () => {
    const selected = await select({ toolSets: ['knowledge', 'member_billing'] });
    const definitionNames = selected.tools.tools.map((tool) => tool.name).sort();
    const handlerNames = [...selected.tools.handlers.keys()].sort();

    expect(definitionNames).toEqual(handlerNames);
    expect(definitionNames.every((name) => selected.allowedToolNames.includes(name))).toBe(true);
    expect(definitionNames).not.toContain('orphaned_definition');
    expect(handlerNames).not.toContain('orphaned_handler');
  });
});
