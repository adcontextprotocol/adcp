import { describe, expect, it, vi } from 'vitest';
import type { AddieTool } from '../../../src/addie/types.js';
import { selectRoutedDirectSlackTools } from '../../../src/addie/bolt-app.js';
import {
  PUBLIC_MENTION_READ_ONLY_TOOL_NAMES,
  resolveRequiredSlackChannelContext,
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
}) {
  const router = input.router === undefined ? routerFor(input.toolSets ?? ['member_billing']) : input.router;
  return selectRoutedDirectSlackTools({
    message: 'Test direct Slack request',
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
    expect(router.route).toHaveBeenCalledWith(expect.objectContaining({ source, isThread: true }), { failureMode: 'throw' });
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
    ['unauthenticated', routerFor(['admin_prospects'])],
    ['over-two-domain', routerFor(['knowledge', 'directory', 'events'])],
    ['non-response', {
      quickMatch: vi.fn().mockReturnValue({ action: 'react', emoji: 'wave', reason: 'test', decision_method: 'quick_match' }),
      route: vi.fn(),
    }],
    ['router throw', {
      quickMatch: vi.fn().mockReturnValue(null),
      route: vi.fn().mockRejectedValue(new Error('router unavailable')),
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

  it('suppresses direct app-mention dispatch when channel privacy lookup fails', async () => {
    const router = routerFor(['community_research']);
    const modelDispatch = vi.fn();
    const responseDelivery = vi.fn();
    const channelContext = await resolveRequiredSlackChannelContext(
      'C_UNVERIFIED',
      async () => { throw new Error('channel lookup failed'); },
    );

    // This is the same required-context gate used by handleAppMention before
    // it constructs tools, invokes the router/model, or calls Slack `say`.
    if (channelContext) {
      const selected = await select({
        source: 'mention',
        isPublicChannel: channelContext.viewing_channel_is_private === false,
        router,
      });
      modelDispatch(selected);
      responseDelivery();
    }

    expect(channelContext).toBeNull();
    expect(router.quickMatch).not.toHaveBeenCalled();
    expect(router.route).not.toHaveBeenCalled();
    expect(modelDispatch).not.toHaveBeenCalled();
    expect(responseDelivery).not.toHaveBeenCalled();
  });

  it('fails closed to the audited public surface when mention privacy is unknown', async () => {
    const selected = await select({
      source: 'mention',
      toolSets: ['community_research'],
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
      toolSets: ['directory'],
      activeCertificationKind: 'learning',
      isPublicChannel: false,
    });
    expect(certificationMention.selectedToolSets).toEqual(['directory']);
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
