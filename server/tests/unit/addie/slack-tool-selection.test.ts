import { describe, expect, it } from 'vitest';
import {
  ADMIN_CHANNEL_WG_SLUG,
  classifyActiveCertificationProgress,
  hasActiveCertificationProgress,
  PUBLIC_MENTION_READ_ONLY_TOOL_NAMES,
  resolveRequiredSlackChannelContext,
  resolveSlackChannelPrivacy,
  selectBoundedRoutedToolSets,
  selectSlackToolSets,
  SYSTEM_CHANNEL_TOOL_SETS,
  type SystemChannelRole,
} from '../../../src/addie/slack-tool-selection.js';
import {
  AGENT_END_TO_END_TOOLS,
  ADMIN_BRANDS_TOOLS,
  ADMIN_ORGANIZATIONS_TOOLS,
  BRAND_REGISTRY_TOOLS,
  COMMUNITY_GROUP_FULL_PARTICIPATION_TOOLS,
  COMMUNITY_GROUP_TOOLS,
  getToolsForSets,
  MEETING_FULL_ADMINISTRATION_TOOLS,
  MAX_DIRECT_ROUTED_TOOL_SET_COUNT,
} from '../../../src/addie/tool-sets.js';

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

  it('leaves bounded channel selection unchanged', () => {
    const selection = selectBoundedRoutedToolSets({
      plan: { action: 'respond', tool_sets: ['directory'], confidence: 'high', reason: 'directory request', decision_method: 'quick_match' },
      routerAvailable: true,
      source: 'channel',
      isAdmin: false,
      isPublicChannel: true,
      isToolAvailable: () => true,
    });

    expect(selection.useSafeFallback).toBe(false);
    expect(selection.selectedToolSets).toEqual(['directory']);
  });

  it('keeps the trusted active-certification direct overlay unchanged', () => {
    const selection = selectBoundedRoutedToolSets({
      plan: { action: 'respond', tool_sets: ['directory'], confidence: 'high', reason: 'continue course', decision_method: 'quick_match' },
      routerAvailable: true,
      source: 'dm',
      isAdmin: false,
      activeCertificationKind: 'learning',
      isToolAvailable: () => true,
    });

    expect(selection.useSafeFallback).toBe(false);
    expect(selection.selectedToolSets).toEqual([
      'certification_learning',
      ...safeKnowledgeFallback,
      'illustrations',
    ]);
    expect(selection.allowedToolNames).toContain('search_docs');
  });

  it('uses the explicit audited read-only surface for public app mentions', () => {
    const publicMention = selectBoundedRoutedToolSets({
      plan: { action: 'respond', tool_sets: ['brand_registry_records'], confidence: 'high', reason: 'public brand lookup', decision_method: 'quick_match' },
      routerAvailable: true,
      source: 'mention',
      isAdmin: true,
      isPublicChannel: true,
      isToolAvailable: () => true,
    });

    expect(publicMention.useSafeFallback).toBe(false);
    expect(publicMention.allowedToolNames).toEqual(['web_search', 'resolve_brand', 'list_brands']);
    expect(publicMention.allowedToolNames.every((name) =>
      (PUBLIC_MENTION_READ_ONLY_TOOL_NAMES as readonly string[]).includes(name),
    )).toBe(true);
    expect(publicMention.allowedToolNames).not.toEqual(expect.arrayContaining([
      'research_brand', 'save_brand', 'capture_learning', 'set_outreach_preference',
      'escalate_to_admin', 'resolve_escalation', 'get_account_link',
      'create_payment_link', 'start_certification_module', 'set_my_name',
    ]));
  });

  it('filters every identity-domain tool from a public brand-verification mention', () => {
    const publicMention = selectBoundedRoutedToolSets({
      plan: { action: 'respond', tool_sets: ['brand_registry_identity'], confidence: 'high', reason: 'public canonical check', decision_method: 'quick_match' },
      routerAvailable: true,
      source: 'mention',
      isAdmin: false,
      isPublicChannel: true,
      isToolAvailable: () => true,
    });

    expect(publicMention.useSafeFallback).toBe(false);
    expect(publicMention.allowedToolNames.filter((name) =>
      (BRAND_REGISTRY_TOOLS as readonly string[]).includes(name),
    )).toEqual([]);
  });

  it.each(['mention', 'channel'] as const)(
    'keeps a %s with accidental certification context on its ordinary bounded route',
    (source) => {
      const selection = selectBoundedRoutedToolSets({
        plan: { action: 'respond', tool_sets: ['directory'], confidence: 'high', reason: 'directory request', decision_method: 'quick_match' },
        routerAvailable: true,
        source,
        isAdmin: false,
        isPublicChannel: source === 'mention' ? false : undefined,
        activeCertificationKind: 'learning',
        isToolAvailable: () => true,
      });

      expect(selection.useSafeFallback).toBe(false);
      expect(selection.selectedToolSets).toEqual(['directory']);
      expect(selection.allowedToolNames).toContain('search_members');
      expect(selection.allowedToolNames).not.toContain('search_docs');
    },
  );

  it.each(['mention', 'channel'] as const)(
    'falls back when a required %s route tool is unavailable despite accidental certification context',
    (source) => {
      const selection = selectBoundedRoutedToolSets({
        plan: { action: 'respond', tool_sets: ['directory'], confidence: 'high', reason: 'directory request', decision_method: 'quick_match' },
        routerAvailable: true,
        source,
        isAdmin: false,
        isPublicChannel: source === 'mention' ? false : undefined,
        activeCertificationKind: 'learning',
        isToolAvailable: (name) => name !== 'search_members',
      });

      expect(selection.useSafeFallback).toBe(true);
      expect(selection.selectedToolSets).toEqual(safeKnowledgeFallback);
      expect(selection.allowedToolNames).not.toContain('search_members');
    },
  );

  it('keeps trusted active-certification knowledge when optional Slack retrieval is unavailable', () => {
    const selection = selectBoundedRoutedToolSets({
      plan: { action: 'respond', tool_sets: ['directory'], confidence: 'high', reason: 'continue course', decision_method: 'quick_match' },
      routerAvailable: true,
      source: 'dm',
      isAdmin: false,
      activeCertificationKind: 'learning',
      isToolAvailable: (name) => !['fetch_url', 'read_slack_file'].includes(name),
    });

    expect(selection.useSafeFallback).toBe(false);
    expect(selection.selectedToolSets).toEqual([
      'certification_learning',
      ...safeKnowledgeFallback,
      'illustrations',
    ]);
    expect(selection.allowedToolNames).toContain('search_docs');
    expect(selection.allowedToolNames).not.toContain('fetch_url');
    expect(selection.allowedToolNames).not.toContain('read_slack_file');
  });

  it('keeps the non-bounded legacy direct route unchanged', () => {
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
    ['agent_registry', ['validate_adagents', 'resolve_brand', 'get_agent_status', 'check_publisher_authorization', 'validate_agent']],
    ['agent_quality', ['evaluate_agent_quality', 'test_rfp_response', 'test_io_execution']],
    ['agent_authentication', ['grade_agent_signing', 'diagnose_agent_auth']],
    ['agent_end_to_end', ['validate_adagents', 'check_publisher_authorization', 'evaluate_agent_quality', 'test_rfp_response', 'test_io_execution', 'grade_agent_signing', 'diagnose_agent_auth']],
  ] as const)('keeps the %s reaction surface paired and alias-free', (toolSet, expectedTools) => {
    const selection = selectBoundedRoutedToolSets({
      plan: { action: 'respond', tool_sets: [toolSet], confidence: 'high', reason: 'test', decision_method: 'quick_match' },
      routerAvailable: true,
      source: 'channel',
      isAdmin: false,
      isPublicChannel: false,
      isToolAvailable: () => true,
    });
    expect(selection.useSafeFallback).toBe(false);
    expect(selection.selectedToolSets).toEqual([toolSet]);
    expect(selection.allowedToolNames).toEqual(expect.arrayContaining(expectedTools));
    expect(selection.allowedToolNames).not.toContain('test_adcp_agent');
    expect(selection.allowedToolNames).not.toContain('compare_media_kit');
  });

  it('retains a long end-to-end agent request as one domain under the direct cap', () => {
    const selection = selectBoundedRoutedToolSets({
      plan: { action: 'respond', tool_sets: ['agent_end_to_end'], confidence: 'high', reason: 'long diagnostic', decision_method: 'quick_match' },
      routerAvailable: true,
      source: 'dm',
      isAdmin: false,
      isPublicChannel: false,
      isToolAvailable: () => true,
    });
    expect(selection.useSafeFallback).toBe(false);
    expect(selection.selectedToolSets).toEqual(['agent_end_to_end']);
    expect(selection.selectedToolSets.length).toBeLessThanOrEqual(MAX_DIRECT_ROUTED_TOOL_SET_COUNT);
    const endToEndTools = selection.allowedToolNames.filter((name) =>
      (AGENT_END_TO_END_TOOLS as readonly string[]).includes(name),
    );
    expect(endToEndTools).toEqual(AGENT_END_TO_END_TOOLS);
    expect(endToEndTools).toHaveLength(10);
  });

  it.each(['dm', 'mention'] as const)(
    'does not append knowledge to a trusted narrow bounded %s response plan',
    (source) => {
      const selection = selectBoundedRoutedToolSets({
        plan: { action: 'respond', tool_sets: ['directory'], confidence: 'high', reason: 'directory request', decision_method: 'quick_match' },
        routerAvailable: true,
        source,
        isAdmin: false,
        isToolAvailable: () => true,
      });

      expect(selection.useSafeFallback).toBe(false);
      expect(selection.selectedToolSets).toEqual(['directory']);
      expect(selection.allowedToolNames).not.toContain('search_docs');
    },
  );

  it.each([
    [['knowledge']],
    [['knowledge', 'directory']],
  ] as const)(
    'preserves explicitly router-selected knowledge in bounded direct plans',
    (tool_sets) => {
      const selection = selectBoundedRoutedToolSets({
        plan: { action: 'respond', tool_sets: [...tool_sets], confidence: 'high', reason: 'documented request', decision_method: 'quick_match' },
        routerAvailable: true,
        source: 'dm',
        isAdmin: false,
        isToolAvailable: () => true,
      });

      expect(selection.useSafeFallback).toBe(false);
      expect(selection.selectedToolSets).toEqual(tool_sets);
    },
  );

  it('accepts exactly two explicitly routed direct domains without an implicit overlay', () => {
    const selection = selectBoundedRoutedToolSets({
      plan: { action: 'respond', tool_sets: ['member_billing', 'directory'], confidence: 'high', reason: 'billing directory request', decision_method: 'quick_match' },
      routerAvailable: true,
      source: 'dm',
      isAdmin: false,
      isToolAvailable: () => true,
    });

    expect(selection.useSafeFallback).toBe(false);
    expect(selection.selectedToolSets).toEqual(['member_billing', 'directory']);
    expect(selection.allowedToolNames).toContain('create_payment_link');
    expect(selection.allowedToolNames).not.toContain('search_docs');
  });

  it('allows only the explicit full meeting composite and preserves its exact legacy union', () => {
    const selection = selectBoundedRoutedToolSets({
      plan: { action: 'respond', tool_sets: ['meeting_full_administration'], confidence: 'high', reason: 'long meeting administration', decision_method: 'quick_match' },
      routerAvailable: true,
      source: 'dm',
      isAdmin: true,
      isToolAvailable: () => true,
    });

    expect(selection.useSafeFallback).toBe(false);
    expect(selection.selectedToolSets).toEqual(['meeting_full_administration']);
    expect(selection.selectedToolSets.length).toBeLessThanOrEqual(MAX_DIRECT_ROUTED_TOOL_SET_COUNT);
    expect(selection.allowedToolNames.filter((name) =>
      (MEETING_FULL_ADMINISTRATION_TOOLS as readonly string[]).includes(name),
    )).toEqual(MEETING_FULL_ADMINISTRATION_TOOLS);
  });

  it('allows only the explicit full community-group composite and preserves its exact legacy union', () => {
    const selection = selectBoundedRoutedToolSets({
      plan: { action: 'respond', tool_sets: ['community_group_full_participation'], confidence: 'high', reason: 'long group participation', decision_method: 'quick_match' },
      routerAvailable: true,
      source: 'dm',
      isAdmin: false,
      isToolAvailable: () => true,
    });

    expect(selection.useSafeFallback).toBe(false);
    expect(selection.selectedToolSets).toEqual(['community_group_full_participation']);
    expect(selection.selectedToolSets.length).toBeLessThanOrEqual(MAX_DIRECT_ROUTED_TOOL_SET_COUNT);
    expect(selection.allowedToolNames.filter((name) =>
      (COMMUNITY_GROUP_FULL_PARTICIPATION_TOOLS as readonly string[]).includes(name),
    )).toEqual(COMMUNITY_GROUP_FULL_PARTICIPATION_TOOLS);
  });

  it('retains bookmark_resource for a trusted private community contribution route', () => {
    const selection = selectBoundedRoutedToolSets({
      plan: { action: 'respond', tool_sets: ['community_group_contribution'], confidence: 'high', reason: 'bookmark request', decision_method: 'quick_match' },
      routerAvailable: true,
      source: 'dm',
      isAdmin: false,
      isToolAvailable: () => true,
    });

    expect(selection.useSafeFallback).toBe(false);
    expect(selection.allowedToolNames).toContain('bookmark_resource');
  });

  it.each([
    'community_group_discovery',
    'community_group_membership',
    'council_interest',
    'community_group_contribution',
    'community_group_full_participation',
  ])('filters the exact community-group union from a public app mention routed to %s', (toolSet) => {
    const selection = selectBoundedRoutedToolSets({
      plan: { action: 'respond', tool_sets: [toolSet], confidence: 'high', reason: 'group request', decision_method: 'quick_match' },
      routerAvailable: true,
      source: 'mention',
      isAdmin: true,
      isPublicChannel: true,
      isToolAvailable: () => true,
    });

    expect(selection.useSafeFallback).toBe(false);
    expect(selection.allowedToolNames.filter((name) =>
      (COMMUNITY_GROUP_TOOLS as readonly string[]).includes(name),
    )).toEqual([]);
  });

  it.each([
    'admin_organization_integrity',
    'admin_organization_member_records',
  ])('filters the exact organization-admin union from a public app mention routed to %s', (toolSet) => {
    const selection = selectBoundedRoutedToolSets({
      plan: { action: 'respond', tool_sets: [toolSet], confidence: 'high', reason: 'organization request', decision_method: 'quick_match' },
      routerAvailable: true,
      source: 'mention',
      isAdmin: true,
      isPublicChannel: true,
      isToolAvailable: () => true,
    });

    expect(selection.useSafeFallback).toBe(false);
    expect(selection.allowedToolNames.filter((name) =>
      (ADMIN_ORGANIZATIONS_TOOLS as readonly string[]).includes(name),
    )).toEqual([]);
  });

  it.each([
    'admin_brand_registry_integrity',
    'admin_brand_logo_review',
  ])('filters the exact brand-admin union from a public app mention routed to %s', (toolSet) => {
    const selection = selectBoundedRoutedToolSets({
      plan: { action: 'respond', tool_sets: [toolSet], confidence: 'high', reason: 'brand-admin request', decision_method: 'quick_match' },
      routerAvailable: true,
      source: 'mention',
      isAdmin: true,
      isPublicChannel: true,
      isToolAvailable: () => true,
    });

    expect(selection.useSafeFallback).toBe(false);
    expect(selection.allowedToolNames.filter((name) =>
      (ADMIN_BRANDS_TOOLS as readonly string[]).includes(name),
    )).toEqual([]);
  });

  it('does not attach admin-only tools to a public channel community-group route', () => {
    const selection = selectBoundedRoutedToolSets({
      plan: { action: 'respond', tool_sets: ['community_group_discovery'], confidence: 'high', reason: 'group lookup', decision_method: 'quick_match' },
      routerAvailable: true,
      source: 'channel',
      isAdmin: true,
      isPublicChannel: true,
      isToolAvailable: () => true,
    });

    expect(selection.useSafeFallback).toBe(false);
    expect(selection.allowedToolNames).not.toEqual(expect.arrayContaining([
      'resolve_escalation', 'list_escalations', 'get_account_link',
      'create_payment_link', 'add_prospect',
    ]));
  });

  it.each([
    ['non-response action', { action: 'react', emoji: 'wave', reason: 'test', decision_method: 'quick_match' }],
    ['stale alias', { action: 'respond', tool_sets: ['admin'], confidence: 'high', reason: 'test', decision_method: 'quick_match' }],
    ['legacy agent-validation union', { action: 'respond', tool_sets: ['agent_validation'], confidence: 'high', reason: 'test', decision_method: 'quick_match' }],
    ['legacy meetings union', { action: 'respond', tool_sets: ['meetings'], confidence: 'high', reason: 'test', decision_method: 'quick_match' }],
    ['legacy community-groups union', { action: 'respond', tool_sets: ['community_groups'], confidence: 'high', reason: 'test', decision_method: 'quick_match' }],
    ['legacy brand-registry union', { action: 'respond', tool_sets: ['brand_registry'], confidence: 'high', reason: 'test', decision_method: 'quick_match' }],
    ['legacy organization-admin union', { action: 'respond', tool_sets: ['admin_organizations'], confidence: 'high', reason: 'test', decision_method: 'quick_match' }],
    ['legacy brand-admin union', { action: 'respond', tool_sets: ['admin_brands'], confidence: 'high', reason: 'test', decision_method: 'quick_match' }],
    ['unauthorized admin domain', { action: 'respond', tool_sets: ['admin_prospects'], confidence: 'high', reason: 'test', decision_method: 'quick_match' }],
    ['unauthorized organization integrity domain', { action: 'respond', tool_sets: ['admin_organization_integrity'], confidence: 'high', reason: 'test', decision_method: 'quick_match' }],
    ['unauthorized brand logo-review domain', { action: 'respond', tool_sets: ['admin_brand_logo_review'], confidence: 'high', reason: 'test', decision_method: 'quick_match' }],
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
