import { describe, expect, it } from 'vitest';
import {
  ADMIN_CHANNEL_WG_SLUG,
  classifyActiveCertificationProgress,
  hasActiveCertificationProgress,
  resolveRequiredSlackChannelContext,
  resolveSlackChannelPrivacy,
  selectBoundedRoutedToolSets,
  selectSlackToolSets,
  SYSTEM_CHANNEL_TOOL_SETS,
  type SystemChannelRole,
} from '../../../src/addie/slack-tool-selection.js';
import { getToolsForSets } from '../../../src/addie/tool-sets.js';

const safeKnowledgeFallback = ['knowledge', 'community_research', 'schema_reference'];

describe('Slack tool-set selection policy', () => {
  it('distinguishes an active module from the no-module certification warning', () => {
    expect(hasActiveCertificationProgress([])).toBe(false);
    expect(hasActiveCertificationProgress([{ status: 'completed' }])).toBe(false);
    expect(hasActiveCertificationProgress([{ status: 'in_progress' }])).toBe(true);
    expect(classifyActiveCertificationProgress([
      { status: 'in_progress', module_id: 'B2' },
    ])).toBe('learning');
    expect(classifyActiveCertificationProgress([
      { status: 'in_progress', module_id: 's3' },
    ])).toBe('assessment');
    expect(classifyActiveCertificationProgress([
      { status: 'in_progress', module_id: 'A1' },
      { status: 'in_progress', module_id: 'S2' },
    ])).toBe('mixed');
  });

  it.each([
    ['member DM', { source: 'dm', isAdmin: false }, ['knowledge']],
    ['admin DM', { source: 'dm', isAdmin: true }, ['knowledge']],
    ['private admin channel', { source: 'channel', isAdmin: true }, ['knowledge']],
    ['public admin channel', { source: 'channel', isAdmin: true }, ['knowledge']],
    [
      'admin working group',
      { source: 'channel', isAdmin: true, workingGroupSlug: ADMIN_CHANNEL_WG_SLUG },
      ['knowledge'],
    ],
  ] as const)('applies the normal %s policy', (_label, input, expected) => {
    expect(selectSlackToolSets({
      routerSelectedSets: ['knowledge'],
      routerAvailable: true,
      ...input,
    })).toEqual(expected);
  });

  it.each([
    ['learning', ['certification_learning', ...safeKnowledgeFallback, 'illustrations']],
    ['assessment', ['certification_assessment', ...safeKnowledgeFallback, 'illustrations']],
    ['mixed', ['certification_learning', 'certification_assessment', ...safeKnowledgeFallback, 'illustrations']],
  ] as const)('overrides router and admin sets for an active %s certification DM', (activeCertificationKind, expected) => {
    expect(selectSlackToolSets({
      routerSelectedSets: ['billing', 'admin_workflows'],
      routerAvailable: true,
      source: 'dm',
      isAdmin: true,
      activeCertificationKind,
    })).toEqual(expected);
  });

  it('keeps legacy boolean callers on the mixed certification workflow when the router is unavailable', () => {
    expect(selectSlackToolSets({
      routerAvailable: false,
      source: 'dm',
      isAdmin: true,
      hasActiveCertification: true,
    })).toEqual(['certification_learning', 'certification_assessment', ...safeKnowledgeFallback, 'illustrations']);
  });

  it('preserves safe read-only knowledge domains when the router is unavailable', () => {
    expect(selectSlackToolSets({
      routerAvailable: false,
      source: 'dm',
      isAdmin: false,
    })).toEqual(safeKnowledgeFallback);
  });

  it.each(['dm', 'mention'] as const)(
    'keeps authoritative knowledge available in a direct %s when the router selects no tools',
    (source) => {
      const selectedSets = selectSlackToolSets({
        routerSelectedSets: [],
        routerAvailable: true,
        source,
        isAdmin: false,
      });

      expect(selectedSets).toEqual(['knowledge']);
      expect(getToolsForSets(selectedSets, false, source === 'mention')).toEqual(
        expect.arrayContaining(['search_docs', 'get_doc', 'search_repos']),
      );
    },
  );

  it('adds authoritative knowledge to a narrow direct route without changing channel routes', () => {
    expect(selectSlackToolSets({
      routerSelectedSets: ['directory'],
      routerAvailable: true,
      source: 'dm',
      isAdmin: false,
    })).toEqual(['directory', 'knowledge']);

    expect(selectSlackToolSets({
      routerSelectedSets: ['directory'],
      routerAvailable: true,
      source: 'channel',
      isAdmin: false,
    })).toEqual(['directory']);
  });

  it('does not treat a non-DM certification context as a routing override', () => {
    expect(selectSlackToolSets({
      routerSelectedSets: ['knowledge'],
      routerAvailable: true,
      source: 'channel',
      isAdmin: true,
      workingGroupSlug: ADMIN_CHANNEL_WG_SLUG,
      activeCertificationKind: 'learning',
    })).toEqual(['knowledge']);
  });

  it.each(Object.entries(SYSTEM_CHANNEL_TOOL_SETS) as Array<[SystemChannelRole, readonly string[]]>) (
    'adds the exact %s system-channel sets for admins',
    (systemRole, requiredSets) => {
      expect(selectSlackToolSets({
        routerSelectedSets: ['knowledge'],
        routerAvailable: true,
        source: 'channel',
        isAdmin: true,
        systemRole,
      })).toEqual(['knowledge', ...requiredSets]);
    },
  );

  it('never grants server-owned admin sets to a non-admin', () => {
    expect(selectSlackToolSets({
      routerSelectedSets: ['knowledge'],
      routerAvailable: true,
      source: 'channel',
      isAdmin: false,
      workingGroupSlug: ADMIN_CHANNEL_WG_SLUG,
      systemRole: 'billing',
    })).toEqual(['knowledge']);
  });

  it('deduplicates router and server-owned sets without reordering them', () => {
    expect(selectSlackToolSets({
      routerSelectedSets: ['billing'],
      routerAvailable: true,
      source: 'channel',
      isAdmin: true,
      systemRole: 'billing',
    })).toEqual(['billing']);
  });

  it('adds Sponsored Intelligence tools for a relevant retrieval or active session', () => {
    expect(selectSlackToolSets({
      routerSelectedSets: ['directory'],
      routerAvailable: true,
      source: 'channel',
      isAdmin: false,
      hasSponsoredIntelligenceContext: true,
    })).toEqual(['directory', 'sponsored_intelligence']);

    expect(selectSlackToolSets({
      routerSelectedSets: ['sponsored_intelligence'],
      routerAvailable: true,
      source: 'channel',
      isAdmin: false,
      hasSponsoredIntelligenceContext: true,
    })).toEqual(['sponsored_intelligence']);

    expect(selectSlackToolSets({
      routerAvailable: false,
      source: 'dm',
      isAdmin: false,
      hasSponsoredIntelligenceContext: true,
    })).toEqual([...safeKnowledgeFallback, 'sponsored_intelligence']);
  });

  it('rejects obsolete router-plan aliases before they reach prompt or tool selection', () => {
    expect(selectSlackToolSets({
      routerSelectedSets: ['admin'],
      routerAvailable: true,
      source: 'channel',
      isAdmin: true,
    })).toEqual([]);
  });

  it('bounds reaction response plans by member/admin and public/private policy', () => {
    const member = selectBoundedRoutedToolSets({
      plan: { action: 'respond', tool_sets: ['member_billing'], confidence: 'high', reason: 'test', decision_method: 'quick_match' },
      routerAvailable: true,
      source: 'channel',
      isAdmin: false,
      isPublicChannel: false,
    });
    expect(member.useSafeFallback).toBe(false);
    expect(member.selectedToolSets).toEqual(['member_billing']);
    expect(member.allowedToolNames).toContain('create_payment_link');

    const publicMember = selectBoundedRoutedToolSets({
      plan: { action: 'respond', tool_sets: ['member_billing'], confidence: 'high', reason: 'test', decision_method: 'quick_match' },
      routerAvailable: true,
      source: 'channel',
      isAdmin: false,
      isPublicChannel: true,
    });
    expect(publicMember.allowedToolNames).not.toContain('create_payment_link');
    expect(publicMember.allowedToolNames).not.toContain('get_account_link');

    const admin = selectBoundedRoutedToolSets({
      plan: { action: 'respond', tool_sets: ['admin_prospects'], confidence: 'high', reason: 'test', decision_method: 'quick_match' },
      routerAvailable: true,
      source: 'channel',
      isAdmin: true,
      isPublicChannel: false,
    });
    expect(admin.useSafeFallback).toBe(false);
    expect(admin.allowedToolNames).toContain('add_prospect');
  });

  it.each([
    ['non-response action', { action: 'react', emoji: 'wave', reason: 'test', decision_method: 'quick_match' }],
    ['stale alias', { action: 'respond', tool_sets: ['admin'], confidence: 'high', reason: 'test', decision_method: 'quick_match' }],
    ['unauthorized admin domain', { action: 'respond', tool_sets: ['admin_prospects'], confidence: 'high', reason: 'test', decision_method: 'quick_match' }],
    ['over-broad domains', { action: 'respond', tool_sets: ['knowledge', 'directory', 'events'], confidence: 'high', reason: 'test', decision_method: 'quick_match' }],
  ] as const)('uses the mutation-free fallback for reaction %s', (_label, plan) => {
    const selection = selectBoundedRoutedToolSets({
      plan,
      routerAvailable: true,
      source: 'channel',
      isAdmin: false,
      isPublicChannel: false,
      activeCertificationKind: 'mixed',
      hasSponsoredIntelligenceContext: true,
      systemRole: 'billing',
    });
    expect(selection.useSafeFallback).toBe(true);
    expect(selection.selectedToolSets).toEqual(safeKnowledgeFallback);
    expect(selection.selectedToolSets).not.toContain('sponsored_intelligence');
    expect(selection.allowedToolNames).not.toEqual(expect.arrayContaining([
      'capture_learning', 'set_outreach_preference', 'create_payment_link',
      'add_prospect', 'send_to_si_agent', 'start_certification_module',
    ]));
  });

  it('uses the mutation-free fallback when the reaction router is unavailable', () => {
    const selection = selectBoundedRoutedToolSets({
      plan: null,
      routerAvailable: false,
      source: 'channel',
      isAdmin: true,
      isPublicChannel: false,
      activeCertificationKind: 'learning',
      hasSponsoredIntelligenceContext: true,
    });
    expect(selection.useSafeFallback).toBe(true);
    expect(selection.selectedToolSets).toEqual(safeKnowledgeFallback);
    expect(selection.allowedToolNames).not.toContain('resolve_escalation');
    expect(selection.allowedToolNames).not.toContain('start_certification_module');
    expect(selection.allowedToolNames).not.toContain('send_to_si_agent');
  });

  it('does not expose a routed domain when one of its tools lacks a paired handler', () => {
    const selection = selectBoundedRoutedToolSets({
      plan: { action: 'respond', tool_sets: ['member_billing'], confidence: 'high', reason: 'test', decision_method: 'quick_match' },
      routerAvailable: true,
      source: 'channel',
      isAdmin: false,
      isToolAvailable: (name) => name !== 'create_payment_link',
    });
    expect(selection.useSafeFallback).toBe(true);
    expect(selection.selectedToolSets).toEqual(safeKnowledgeFallback);
    expect(selection.allowedToolNames).not.toContain('create_payment_link');
  });

  it('withholds escalation records from public admin reactions', () => {
    const selection = selectBoundedRoutedToolSets({
      plan: { action: 'respond', tool_sets: ['knowledge'], confidence: 'high', reason: 'test', decision_method: 'quick_match' },
      routerAvailable: true,
      source: 'channel',
      isAdmin: true,
      isPublicChannel: true,
    });
    expect(selection.allowedToolNames).not.toContain('resolve_escalation');
    expect(selection.allowedToolNames).not.toContain('list_escalations');
  });

  it('returns verified channel context from the required resolver', async () => {
    const context = { viewing_channel_is_private: false };
    await expect(resolveRequiredSlackChannelContext(
      'C123',
      async () => context,
    )).resolves.toBe(context);
    await expect(resolveRequiredSlackChannelContext(
      'C456',
      async () => ({ viewing_channel_is_private: true }),
    )).resolves.toEqual({ viewing_channel_is_private: true });
  });

  it.each([
    ['DM', { is_im: true }, true],
    ['multi-person DM', { is_mpim: true }, true],
    ['public channel', { is_private: false }, false],
    ['private channel', { is_private: true }, true],
    ['unclassified partial response', { name: 'unknown' }, null],
  ] as const)('normalizes %s privacy', (_label, channel, expected) => {
    expect(resolveSlackChannelPrivacy(channel)).toBe(expected);
  });

  it('fails closed when channel privacy is absent from partial context', async () => {
    await expect(resolveRequiredSlackChannelContext(
      'C123',
      async () => ({ viewing_channel_name: 'general' }),
    )).resolves.toBeNull();
  });

  it('fails closed when required channel context cannot be resolved', async () => {
    await expect(resolveRequiredSlackChannelContext(
      'C123',
      async () => { throw new Error('private resolver detail'); },
    )).resolves.toBeNull();
  });
});
