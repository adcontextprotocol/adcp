import { describe, expect, it, vi } from 'vitest';
import type { AddieTool } from '../../../src/addie/types.js';
import {
  selectRoutedWebTools,
} from '../../../src/routes/addie-chat.js';
import { getToolsForSets } from '../../../src/addie/tool-sets.js';

const tools: AddieTool[] = [
  { name: 'search_docs', description: 'Search docs', input_schema: { type: 'object', properties: {} } },
  { name: 'create_payment_link', description: 'Create payment link', input_schema: { type: 'object', properties: {} } },
  { name: 'add_prospect', description: 'Add prospect', input_schema: { type: 'object', properties: {} } },
  { name: 'orphaned_definition', description: 'Must not reach the model', input_schema: { type: 'object', properties: {} } },
];
const handlers = new Map(tools
  .filter((tool) => tool.name !== 'orphaned_definition')
  .map((tool) => [tool.name, async () => '{}']));
handlers.set('orphaned_handler', async () => '{}');

// The selector also receives baseline definitions registered by the client.
// Keep this fixture narrow while modeling those paired globals, deliberately
// excluding the request-local tool each routing assertion is about.
const pairedGlobalToolNames = [...new Set([
  ...getToolsForSets(['knowledge'], false, false)
    .filter((name) => name !== 'search_docs'),
  ...getToolsForSets(['member_billing'], false, false)
    .filter((name) => name !== 'create_payment_link'),
  ...getToolsForSets(['admin_prospects'], true, false)
    .filter((name) => name !== 'add_prospect'),
])];

function routerFor(toolSets: string[]) {
  return {
    quickMatch: vi.fn().mockReturnValue(null),
    route: vi.fn().mockResolvedValue({
      action: 'respond' as const,
      tool_sets: toolSets,
      confidence: 'high' as const,
      reason: 'test',
      decision_method: 'llm' as const,
    }),
  };
}

async function select(
  router: Parameters<typeof selectRoutedWebTools>[0]['router'],
  isAAOAdmin = false,
  requestTools = { tools, handlers },
  globalToolNames: string[] = pairedGlobalToolNames,
) {
  return selectRoutedWebTools({
    message: 'Test message',
    memberContext: null,
    threadId: 'thread-1',
    isAAOAdmin,
    requestTools,
    router,
    globalToolNames,
    threadMessages: ['User: Earlier request'],
  });
}

describe('authenticated web Addie tool routing', () => {
  it('selects bounded member tools without an implicit knowledge overlay', async () => {
    const router = routerFor(['member_billing']);
    const selected = await select(router);

    expect(selected.selectedToolSets).toEqual(['member_billing']);
    expect(selected.allowedToolNames).toContain('create_payment_link');
    expect(selected.requestTools.tools.map((tool) => tool.name)).toEqual(['create_payment_link']);
    expect([...selected.requestTools.handlers.keys()]).toEqual(['create_payment_link']);
    expect(router.route).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'dm',
        isThread: true,
        isAAOAdmin: false,
        threadMessages: ['User: Earlier request'],
      }),
      { failureMode: 'throw' },
    );
  });

  it('preserves an explicit knowledge plus member-domain web plan', async () => {
    const selected = await select(routerFor(['knowledge', 'member_billing']));

    expect(selected.selectedToolSets).toEqual(['knowledge', 'member_billing']);
    expect(selected.requestTools.tools.map((tool) => tool.name)).toEqual([
      'search_docs',
      'create_payment_link',
    ]);
    expect([...selected.requestTools.handlers.keys()]).toEqual([
      'search_docs',
      'create_payment_link',
    ]);
  });

  it('allows an authorized admin domain but rejects it for a member', async () => {
    const adminSelected = await select(routerFor(['admin_prospects']), true);
    expect(adminSelected.selectedToolSets).toContain('admin_prospects');
    expect(adminSelected.requestTools.tools.map((tool) => tool.name)).toContain('add_prospect');

    const memberSelected = await select(routerFor(['admin_prospects']));
    expect(memberSelected.selectedToolSets).toEqual([
      'knowledge',
      'community_research',
      'schema_reference',
    ]);
    expect(memberSelected.requestTools.tools.map((tool) => tool.name)).not.toContain('add_prospect');
  });

  it('fails closed to the safe read-only fallback for invalid router output', async () => {
    const selected = await select(routerFor(['obsolete_router_alias']));

    expect(selected.selectedToolSets).toEqual([
      'knowledge',
      'community_research',
      'schema_reference',
    ]);
    expect(selected.requestTools.tools.map((tool) => tool.name)).toEqual(['search_docs']);
    expect(selected.allowedToolNames).not.toContain('create_payment_link');
    expect(selected.allowedToolNames).not.toContain('add_prospect');
  });

  it('uses the complete read-only fallback when a routed web domain has an incomplete registration', async () => {
    const incompleteHandlers = new Map(handlers);
    incompleteHandlers.delete('create_payment_link');
    const selected = await select(
      routerFor(['member_billing']),
      false,
      { tools, handlers: incompleteHandlers },
    );

    expect(selected.selectedToolSets).toEqual([
      'knowledge',
      'community_research',
      'schema_reference',
    ]);
    expect(selected.allowedToolNames).not.toContain('create_payment_link');
    expect(selected.requestTools.tools.map((tool) => tool.name)).toEqual(['search_docs']);
  });

  it('fails closed when a router plan exceeds the two-domain direct-chat bound', async () => {
    const selected = await select(routerFor(['member_billing', 'partner_directory', 'events']));

    expect(selected.selectedToolSets).toEqual([
      'knowledge',
      'community_research',
      'schema_reference',
    ]);
    expect(selected.allowedToolNames).not.toContain('create_payment_link');
    expect(selected.allowedToolNames).not.toContain('capture_learning');
  });

  it('does not add sponsored-intelligence prompt scope to a safe fallback', async () => {
    const selected = await selectRoutedWebTools({
      message: 'Continue SI work',
      memberContext: null,
      threadId: 'thread-1',
      isAAOAdmin: false,
      requestTools: { tools, handlers },
      router: null,
      hasSponsoredIntelligenceContext: true,
    });

    expect(selected.selectedToolSets).not.toContain('sponsored_intelligence');
    expect(selected.allowedToolNames).not.toContain('send_to_si_agent');
  });

  it('fails closed to the safe read-only fallback when the router fails', async () => {
    const router = {
      quickMatch: vi.fn().mockReturnValue(null),
      route: vi.fn().mockRejectedValue(new Error('router unavailable')),
    };
    const selected = await select(router);

    expect(selected.selectedToolSets).toEqual([
      'knowledge',
      'community_research',
      'schema_reference',
    ]);
    expect(selected.requestTools.tools.map((tool) => tool.name)).toEqual(['search_docs']);
    for (const mutation of [
      'capture_learning',
      'set_outreach_preference',
      'escalate_to_admin',
      'resolve_escalation',
      'create_payment_link',
      'add_prospect',
    ]) {
      expect(selected.allowedToolNames).not.toContain(mutation);
    }
  });

  it('forces router outages into the safe fallback instead of accepting a returned fallback plan', async () => {
    const router = {
      quickMatch: vi.fn().mockReturnValue(null),
      route: vi.fn().mockImplementation(async (_context, options) => {
        // This is deliberately a single, otherwise-authorized admin domain:
        // without failureMode: throw it would evade a set-count guard.
        if (options?.failureMode !== 'throw') {
          return {
            action: 'respond' as const,
            tool_sets: ['admin_prospects'],
            confidence: 'high' as const,
            reason: 'internal router fallback',
            decision_method: 'llm' as const,
          };
        }
        throw new Error('provider outage');
      }),
    };

    const selected = await select(router, true);

    expect(router.route).toHaveBeenCalledWith(expect.any(Object), { failureMode: 'throw' });
    expect(selected.selectedToolSets).toEqual([
      'knowledge',
      'community_research',
      'schema_reference',
    ]);
    expect(selected.allowedToolNames).not.toContain('add_prospect');
  });

  it('never returns a definition or handler without its counterpart', async () => {
    const selected = await select(routerFor(['member_billing']));
    const definitionNames = selected.requestTools.tools.map((tool) => tool.name).sort();
    const handlerNames = [...selected.requestTools.handlers.keys()].sort();

    expect(definitionNames).toEqual(handlerNames);
    expect(definitionNames).not.toContain('orphaned_definition');
    expect(handlerNames).not.toContain('orphaned_handler');
  });

  it('retains authenticated handlers that override a paired global definition', async () => {
    const localTools = tools.filter((tool) => tool.name === 'create_payment_link');
    const authenticatedPaymentLinkHandler = async () => '{}';
    const localHandlers = new Map([
      ['search_docs', async () => '{"scope":"authenticated"}'],
      ['create_payment_link', authenticatedPaymentLinkHandler],
    ]);
    const selected = await select(
      routerFor(['member_billing']),
      false,
      { tools: localTools, handlers: localHandlers },
      [...pairedGlobalToolNames, 'search_docs'],
    );

    // The request-local definition and handler remain paired on the selected
    // bounded member-billing route.
    expect(selected.requestTools.tools.map((tool) => tool.name)).toEqual(['create_payment_link']);
    expect([...selected.requestTools.handlers.keys()]).toEqual(['create_payment_link']);
    expect(selected.requestTools.handlers.get('create_payment_link')).toBe(authenticatedPaymentLinkHandler);
  });
});
