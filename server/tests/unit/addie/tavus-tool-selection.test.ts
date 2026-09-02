import { describe, expect, it, vi } from 'vitest';
import type { AddieTool } from '../../../src/addie/types.js';
import { selectRoutedTavusVoiceTools } from '../../../src/routes/tavus.js';
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

const pairedGlobalToolNames = [...new Set([
  ...getToolsForSets(['knowledge'], false, false).filter((name) => name !== 'search_docs'),
  ...getToolsForSets(['member_billing'], false, false).filter((name) => name !== 'create_payment_link'),
  ...getToolsForSets(['admin_prospects'], true, false).filter((name) => name !== 'add_prospect'),
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
  router: Parameters<typeof selectRoutedTavusVoiceTools>[0]['router'],
  isAAOAdmin = false,
  requestTools = { tools, handlers },
  globalToolNames: string[] = pairedGlobalToolNames,
) {
  return selectRoutedTavusVoiceTools({
    message: 'Test spoken request',
    memberContext: null,
    threadId: 'thread-1',
    isAAOAdmin,
    requestTools,
    router,
    globalToolNames,
    threadMessages: ['User: Earlier spoken request'],
  });
}

describe('authenticated Tavus voice Addie tool routing', () => {
  it('selects a bounded member domain without an implicit knowledge overlay', async () => {
    const router = routerFor(['member_billing']);
    const selected = await select(router);

    expect(selected.selectedToolSets).toEqual(['member_billing']);
    expect(selected.allowedToolNames).toContain('create_payment_link');
    expect(selected.requestTools.tools.map((tool) => tool.name)).toEqual(['create_payment_link']);
    expect([...selected.requestTools.handlers.keys()]).toEqual(['create_payment_link']);
    expect(router.route).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Test spoken request',
        source: 'dm',
        isThread: true,
        isAAOAdmin: false,
        threadMessages: ['User: Earlier spoken request'],
      }),
      { failureMode: 'throw' },
    );
  });

  it('preserves an explicit knowledge plus member-domain Tavus plan', async () => {
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

  it('permits an admin domain only for an authenticated admin voice caller', async () => {
    const admin = await select(routerFor(['admin_prospects']), true);
    expect(admin.selectedToolSets).toContain('admin_prospects');
    expect(admin.requestTools.tools.map((tool) => tool.name)).toContain('add_prospect');

    const member = await select(routerFor(['admin_prospects']));
    expect(member.selectedToolSets).toEqual(['knowledge', 'community_research', 'schema_reference']);
    expect(member.requestTools.tools.map((tool) => tool.name)).not.toContain('add_prospect');
  });

  it.each([
    ['unavailable router', null],
    ['failed router', {
      quickMatch: vi.fn().mockReturnValue(null),
      route: vi.fn().mockRejectedValue(new Error('router unavailable')),
    }],
    ['invalid plan', routerFor(['obsolete_router_alias'])],
    ['non-response plan', {
      quickMatch: vi.fn().mockReturnValue({ action: 'react', emoji: 'wave', reason: 'test', decision_method: 'quick_match' }),
      route: vi.fn(),
    }],
    ['over-broad plan', routerFor(['member_billing', 'directory', 'events'])],
  ] as const)('uses the safe read-only fallback for a %s', async (_label, router) => {
    const selected = await select(router);
    expect(selected.selectedToolSets).toEqual(['knowledge', 'community_research', 'schema_reference']);
    expect(selected.allowedToolNames).not.toEqual(expect.arrayContaining([
      'capture_learning', 'set_outreach_preference', 'create_payment_link', 'add_prospect',
    ]));
    expect(selected.requestTools.tools.map((tool) => tool.name)).toEqual(['search_docs']);
  });

  it('falls back when a selected voice domain has an incomplete registration', async () => {
    const incompleteHandlers = new Map(handlers);
    incompleteHandlers.delete('create_payment_link');
    const selected = await select(
      routerFor(['member_billing']),
      false,
      { tools, handlers: incompleteHandlers },
    );

    expect(selected.selectedToolSets).toEqual(['knowledge', 'community_research', 'schema_reference']);
    expect(selected.allowedToolNames).not.toContain('create_payment_link');
    expect(selected.requestTools.tools.map((tool) => tool.name)).toEqual(['search_docs']);
  });

  it('never returns a definition or handler without its counterpart', async () => {
    const selected = await select(routerFor(['member_billing']));
    expect(selected.requestTools.tools.map((tool) => tool.name).sort()).toEqual(
      [...selected.requestTools.handlers.keys()].sort(),
    );
    expect(selected.requestTools.tools.map((tool) => tool.name)).not.toContain('orphaned_definition');
    expect([...selected.requestTools.handlers.keys()]).not.toContain('orphaned_handler');
  });
});
