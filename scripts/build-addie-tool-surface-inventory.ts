#!/usr/bin/env tsx
/** Build Addie's checked-in runtime tool/prompt exposure inventory. */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddieTool } from '../server/src/addie/types.js';
import {
  buildAddieProviderTools,
  buildAddieWireTools,
  mergeAddieToolDefinitions,
} from '../server/src/addie/tool-wire-shape.js';
import { assembleAddieSystemPrompt } from '../server/src/addie/prompt-assembly.js';
import { buildAddieToolReference } from '../server/src/addie/prompts.js';
import { SAFE_KNOWLEDGE_FALLBACK_TOOL_SETS } from '../server/src/addie/tool-sets.js';
import {
  ADMIN_CHANNEL_WG_SLUG,
  PUBLIC_MENTION_READ_ONLY_TOOL_NAMES,
  selectBoundedRoutedToolSets,
  selectSlackToolSets,
  SYSTEM_CHANNEL_TOOL_SETS,
  type SlackToolSource,
  type SystemChannelRole,
} from '../server/src/addie/slack-tool-selection.js';

interface BudgetFile {
  schema_version: 4;
  baseline: { id: string; metrics: Record<string, number> };
  maximums: Record<string, number>;
  surface_maximums: Record<string, SurfaceMaximum>;
  profile_ids_sha256: string;
  profile_contract_sha256: string;
}

interface SurfaceMaximum {
  custom_tool_count: number;
  wire_schema_bytes: number;
  maximum_provider_tool_count: number;
  maximum_provider_tool_wire_bytes: number;
}

interface Profile {
  id: string;
  runtime: string;
  audience: string;
  route?: string;
  selected_tool_sets?: string[];
  conditional_maximums: string[];
  custom_tool_count: number;
  maximum_provider_tool_count: number;
  maximum_provider_tool_names: string[];
  maximum_provider_tool_wire_bytes: number;
  maximum_provider_tool_wire_sha256: string;
  wire_schema_bytes: number;
  tool_reference_bytes: number;
  tool_reference_sha256: string;
  overridden_tool_count: number;
  conflicting_override_count: number;
  conflicting_override_names: string[];
  ordered_tool_names: string[];
  ordered_tool_names_sha256: string;
  wire_schema_sha256: string;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(REPO_ROOT);
const OUTPUT_FILE = path.join(
  REPO_ROOT,
  'server/src/addie/generated/tool-surface-inventory.generated.json',
);
const BUDGET_FILE = path.join(REPO_ROOT, 'scripts/addie-tool-surface-budget.json');
const REGISTRATION_SOURCES = [
  'server/src/addie/claude-client.ts',
  'server/src/addie/prompts.ts',
  'server/src/addie/tool-wire-shape.ts',
  'server/src/addie/prompt-assembly.ts',
  'server/src/addie/register-baseline-tools.ts',
  'server/src/addie/bolt-app.ts',
  'server/src/routes/addie-chat.ts',
  'server/src/routes/tavus.ts',
  'server/src/addie/email-conversation-handler.ts',
  'server/src/mcp/chat-tool.ts',
  'server/src/addie/jobs/shadow-replay-cohort.ts',
  'server/src/addie/tool-sets.ts',
];
const METRIC_NAMES = [
  'routed_unique_tools',
  'runtime_unique_tools',
  'runtime_tools_not_declared_to_router',
  'routed_tools_missing_runtime_definition',
  'maximum_conflicting_tool_overrides',
  'runtime_tools_missing_prompt_catalog',
  'prompt_catalog_tools_missing_runtime',
  'always_available_tools',
  'tool_reference_bytes',
  'system_prompt_bytes',
  'maximum_slack_member_tools',
  'maximum_slack_admin_tools',
  'maximum_slack_public_tools',
  'maximum_slack_member_schema_bytes',
  'maximum_slack_admin_schema_bytes',
  'maximum_slack_public_schema_bytes',
  'web_anonymous_tools',
  'web_authenticated_admin_tools',
] as const;

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function profile(input: {
  id: string;
  runtime: string;
  audience: string;
  globalTools: readonly AddieTool[];
  requestTools?: readonly AddieTool[];
  providerToolCount?: number;
  route?: string;
  selectedToolSets?: string[];
  allowedToolNames?: readonly string[];
  conditionalMaximums?: string[];
}): Profile {
  const allowed = input.allowedToolNames ? new Set(input.allowedToolNames) : null;
  const combined = [...input.globalTools, ...(input.requestTools ?? [])]
    .filter((tool) => !allowed || allowed.has(tool.name));
  const seen = new Map<string, string>();
  const overriddenNames = new Set<string>();
  const conflictingNames = new Set<string>();
  for (const tool of combined) {
    const rendered = JSON.stringify({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema,
    });
    const previous = seen.get(tool.name);
    if (previous !== undefined) {
      overriddenNames.add(tool.name);
      if (previous !== rendered) conflictingNames.add(tool.name);
    }
    seen.set(tool.name, rendered);
  }
  const merged = mergeAddieToolDefinitions(
    input.globalTools,
    input.requestTools,
    input.allowedToolNames,
  );
  const wire = buildAddieWireTools(merged);
  const orderedNames = merged.map((tool) => tool.name);
  const renderedWire = JSON.stringify(wire);
  const toolReference = buildAddieToolReference({
    availableToolNames: orderedNames,
    selectedToolSetNames: input.selectedToolSets,
  });
  const providerTools = buildAddieProviderTools((input.providerToolCount ?? 0) > 0);
  const renderedProviderTools = JSON.stringify(providerTools);
  return {
    id: input.id,
    runtime: input.runtime,
    audience: input.audience,
    ...(input.route ? { route: input.route } : {}),
    ...(input.selectedToolSets ? { selected_tool_sets: input.selectedToolSets } : {}),
    conditional_maximums: input.conditionalMaximums ?? [],
    custom_tool_count: merged.length,
    maximum_provider_tool_count: providerTools.length,
    maximum_provider_tool_names: providerTools.map((tool) => tool.name),
    maximum_provider_tool_wire_bytes: Buffer.byteLength(renderedProviderTools, 'utf8'),
    maximum_provider_tool_wire_sha256: sha256(renderedProviderTools),
    wire_schema_bytes: Buffer.byteLength(renderedWire, 'utf8'),
    tool_reference_bytes: Buffer.byteLength(toolReference, 'utf8'),
    tool_reference_sha256: sha256(toolReference),
    overridden_tool_count: overriddenNames.size,
    conflicting_override_count: conflictingNames.size,
    conflicting_override_names: [...conflictingNames].sort(),
    ordered_tool_names: orderedNames,
    ordered_tool_names_sha256: sha256(JSON.stringify(orderedNames)),
    wire_schema_sha256: sha256(renderedWire),
  };
}

async function loadDefinitions() {
  // Several definition modules construct SDK clients at import time but make
  // no network calls. Use inert inventory-only configuration.
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'silent';
  process.env.WORKOS_API_KEY = 'sk_inventory_only';
  process.env.WORKOS_CLIENT_ID = 'client_inventory_only';

  const [
    knowledge, billing, schema, directory, brand, brandCanonical, property,
    member, admin, events, escalation, newsletter, adcp, authGrader,
    conformance, meetings, url, googleDocs, illustration, siHost,
    brandProperty, collaboration, social, portrait, committee, certification,
    images, moltbook, toolSets, chatTool, officialDocs,
  ] = await Promise.all([
    import('../server/src/addie/mcp/knowledge-search.js'),
    import('../server/src/addie/mcp/billing-tools.js'),
    import('../server/src/addie/mcp/schema-tools.js'),
    import('../server/src/addie/mcp/directory-tools.js'),
    import('../server/src/addie/mcp/brand-tools.js'),
    import('../server/src/addie/mcp/brand-canonical-tools.js'),
    import('../server/src/addie/mcp/property-tools.js'),
    import('../server/src/addie/mcp/member-tools.js'),
    import('../server/src/addie/mcp/admin-tools.js'),
    import('../server/src/addie/mcp/event-tools.js'),
    import('../server/src/addie/mcp/escalation-tools.js'),
    import('../server/src/addie/mcp/newsletter-tools.js'),
    import('../server/src/addie/mcp/adcp-tools.js'),
    import('../server/src/addie/mcp/auth-grader-tools.js'),
    import('../server/src/addie/mcp/conformance-tools.js'),
    import('../server/src/addie/mcp/meeting-tools.js'),
    import('../server/src/addie/mcp/url-tools.js'),
    import('../server/src/addie/mcp/google-docs.js'),
    import('../server/src/addie/mcp/illustration-tools.js'),
    import('../server/src/addie/mcp/si-host-tools.js'),
    import('../server/src/addie/mcp/brand-property-tools.js'),
    import('../server/src/addie/mcp/collaboration-tools.js'),
    import('../server/src/addie/mcp/social-draft-tools.js'),
    import('../server/src/addie/mcp/portrait-tools.js'),
    import('../server/src/addie/mcp/committee-leader-tools.js'),
    import('../server/src/addie/mcp/certification-tools.js'),
    import('../server/src/addie/mcp/image-tools.js'),
    import('../server/src/addie/mcp/moltbook-tools.js'),
    import('../server/src/addie/tool-sets.js'),
    import('../server/src/mcp/chat-tool.js'),
    import('../server/src/addie/jobs/shadow-replay-cohort.js'),
  ]);

  return {
    knowledge, billing, schema, directory, brand, brandCanonical, property,
    member, admin, events, escalation, newsletter, adcp, authGrader,
    conformance, meetings, url, googleDocs, illustration, siHost,
    brandProperty, collaboration, social, portrait, committee, certification,
    images, moltbook, toolSets, chatTool, officialDocs,
  };
}

function buildSlackBoltProfiles(defs: Awaited<ReturnType<typeof loadDefinitions>>): Profile[] {
  const {
    knowledge, billing, schema, directory, brand, brandCanonical, property,
    member, admin, events, escalation, newsletter, adcp, authGrader,
    conformance, meetings, url, googleDocs, illustration, siHost,
    brandProperty, collaboration, social, portrait, committee, certification,
    images, toolSets,
  } = defs;
  const globalTools = [
    ...knowledge.KNOWLEDGE_TOOLS.filter((tool) => !knowledge.isSlackKnowledgeTool(tool)),
    ...schema.SCHEMA_TOOLS,
    ...directory.DIRECTORY_TOOLS,
    ...url.URL_TOOLS,
    ...googleDocs.GOOGLE_DOCS_TOOLS,
  ];
  const slackKnowledge = knowledge.KNOWLEDGE_TOOLS.filter(knowledge.isSlackKnowledgeTool);
  const buildRequest = (isAdmin: boolean, isPublic: boolean): AddieTool[] => [
    ...member.MEMBER_TOOLS,
    ...siHost.SI_HOST_TOOLS,
    ...directory.DIRECTORY_TOOLS,
    ...slackKnowledge,
    ...illustration.ILLUSTRATION_TOOLS,
    ...(isPublic
      ? billing.BILLING_TOOLS.filter((tool) => tool.name === 'find_membership_products')
      : billing.BILLING_TOOLS),
    ...escalation.ESCALATION_TOOLS,
    ...newsletter.NEWSLETTER_TOOLS,
    ...adcp.ADCP_TOOLS,
    ...authGrader.AUTH_GRADER_TOOLS,
    ...conformance.CONFORMANCE_TOOLS,
    ...(isAdmin ? admin.ADMIN_TOOLS : []),
    ...events.EVENT_READONLY_TOOLS,
    ...events.EVENT_ADMIN_TOOLS,
    ...meetings.MEETING_TOOLS,
    ...brand.BRAND_TOOLS,
    ...brandCanonical.BRAND_CANONICAL_TOOLS,
    ...brandProperty.BRAND_PROPERTY_TOOLS,
    ...collaboration.COLLABORATION_TOOLS,
    ...social.SOCIAL_DRAFT_TOOLS,
    ...portrait.PORTRAIT_TOOLS,
    ...images.IMAGE_TOOLS,
    ...committee.COMMITTEE_LEADER_TOOLS,
    ...property.PROPERTY_TOOLS,
    ...schema.SCHEMA_TOOLS,
    ...certification.CERTIFICATION_TOOLS,
  ].filter((tool) => !isPublic || tool.name !== 'get_account_link');
  const memberRequest = buildRequest(false, false);
  const adminRequest = buildRequest(true, false);
  const publicRequest = buildRequest(false, true);
  const surfaces: Array<{
    audience: string;
    source: SlackToolSource;
    isAdmin: boolean;
    isPublic: boolean;
    workingGroupSlug?: string;
    available: AddieTool[];
  }> = [
    { audience: 'private_channel_member', source: 'channel', isAdmin: false, isPublic: false, available: memberRequest },
    { audience: 'private_channel_admin', source: 'channel', isAdmin: true, isPublic: false, available: adminRequest },
    { audience: 'admin_working_group', source: 'channel', isAdmin: true, isPublic: false, workingGroupSlug: ADMIN_CHANNEL_WG_SLUG, available: adminRequest },
    { audience: 'public_channel_member', source: 'channel', isAdmin: false, isPublic: true, available: publicRequest },
    { audience: 'public_channel_admin', source: 'channel', isAdmin: true, isPublic: true, available: buildRequest(true, true) },
  ];
  const profiles: Profile[] = [];

  for (const surface of surfaces) {
    for (const [setName, set] of Object.entries(toolSets.TOOL_SETS)) {
      if (set.routerVisible === false) continue;
      if (!surface.isAdmin && set.adminOnly) continue;
      const selectedSets = selectSlackToolSets({
        routerSelectedSets: [setName],
        routerAvailable: true,
        source: surface.source,
        isAdmin: surface.isAdmin,
        workingGroupSlug: surface.workingGroupSlug,
      });
      const allowed = new Set(toolSets.getToolsForSets(
        selectedSets,
        surface.isAdmin,
        surface.isPublic,
      ));
      const routedRequest = surface.available.filter((tool) => allowed.has(tool.name));
      profiles.push(profile({
        id: `slack_bolt:${surface.audience}:${setName}`,
        runtime: 'slack_bolt',
        audience: surface.audience,
        route: setName,
        selectedToolSets: selectedSets,
        allowedToolNames: [...allowed],
        globalTools,
        requestTools: routedRequest,
        // Non-streaming calls additionally expose Anthropic web search. The
        // dominant Slack streaming path does not.
        providerToolCount: 1,
        conditionalMaximums: [
          'google_docs_configured',
          'conformance_socket_enabled',
          'event_and_meeting_permissions',
          'member_content_permissions',
          'nonstreaming_web_search',
        ],
      }));
    }
    const allValidSets = Object.entries(toolSets.TOOL_SETS)
      .filter(([, set]) => set.routerVisible !== false)
      .filter(([, set]) => surface.isAdmin || !set.adminOnly)
      .map(([name]) => name);
    const selectedAllValidSets = selectSlackToolSets({
      routerSelectedSets: allValidSets,
      routerAvailable: true,
      source: surface.source,
      isAdmin: surface.isAdmin,
      workingGroupSlug: surface.workingGroupSlug,
    });
    const allAllowed = new Set(toolSets.getToolsForSets(
      selectedAllValidSets,
      surface.isAdmin,
      surface.isPublic,
    ));
    profiles.push(profile({
      id: `slack_bolt:${surface.audience}:all_valid_sets_maximum`,
      runtime: 'slack_bolt',
      audience: surface.audience,
      route: 'all_valid_sets_maximum',
      selectedToolSets: selectedAllValidSets,
      allowedToolNames: [...allAllowed],
      globalTools,
      requestTools: surface.available.filter((tool) => allAllowed.has(tool.name)),
      providerToolCount: 1,
      conditionalMaximums: [
        'router_returns_all_valid_tool_sets',
        'google_docs_configured',
        'conformance_socket_enabled',
        'all_role_permissions',
        'nonstreaming_web_search',
      ],
    }));
    const fallbackSets = selectSlackToolSets({
      routerAvailable: false,
      source: surface.source,
      isAdmin: surface.isAdmin,
      workingGroupSlug: surface.workingGroupSlug,
    });
    const fallbackAllowed = new Set(toolSets.getToolsForSets(
      fallbackSets,
      surface.isAdmin,
      surface.isPublic,
    ));
    profiles.push(profile({
      id: `slack_bolt:${surface.audience}:router_unavailable`,
      runtime: 'slack_bolt',
      audience: surface.audience,
      route: 'router_unavailable',
      selectedToolSets: fallbackSets,
      allowedToolNames: [...fallbackAllowed],
      globalTools,
      requestTools: surface.available.filter((tool) => fallbackAllowed.has(tool.name)),
      providerToolCount: 1,
      conditionalMaximums: ['router_unavailable', 'google_docs_configured', 'nonstreaming_web_search'],
    }));

    if (surface.source === 'dm') {
      for (const activeCertificationKind of ['learning', 'assessment', 'mixed'] as const) {
        const certificationSets = selectSlackToolSets({
          routerSelectedSets: ['admin_workflows'],
          routerAvailable: true,
          source: surface.source,
          isAdmin: surface.isAdmin,
          activeCertificationKind,
        });
        const certificationAllowed = new Set(toolSets.getToolsForSets(
          certificationSets,
          surface.isAdmin,
          surface.isPublic,
        ));
        profiles.push(profile({
          id: `slack_bolt:${surface.audience}:certification_${activeCertificationKind}_session`,
          runtime: 'slack_bolt',
          audience: surface.audience,
          route: `certification_${activeCertificationKind}_session`,
          selectedToolSets: certificationSets,
          allowedToolNames: [...certificationAllowed],
          globalTools,
          requestTools: surface.available.filter((tool) => certificationAllowed.has(tool.name)),
          providerToolCount: 1,
          conditionalMaximums: [
            'active_certification_overrides_router_admin_and_fallback',
            'google_docs_configured',
            'nonstreaming_web_search',
          ],
        }));
      }
    }
  }

  // Direct Slack conversations use the bounded provider-neutral selector.
  // Inventory every reachable one- and two-domain response plan, including
  // SI context, instead of treating the entire request registry as visible.
  // Channel profiles above intentionally remain on the legacy selector.
  const directSurfaces: Array<{
    audience: string;
    source: 'dm' | 'mention';
    isAdmin: boolean;
    isPublic: boolean;
    available: AddieTool[];
  }> = [
    { audience: 'member_dm', source: 'dm', isAdmin: false, isPublic: false, available: memberRequest },
    { audience: 'admin_dm', source: 'dm', isAdmin: true, isPublic: false, available: adminRequest },
    { audience: 'private_mention_member', source: 'mention', isAdmin: false, isPublic: false, available: memberRequest },
    { audience: 'private_mention_admin', source: 'mention', isAdmin: true, isPublic: false, available: adminRequest },
    { audience: 'public_mention_member', source: 'mention', isAdmin: false, isPublic: true, available: publicRequest },
    { audience: 'public_mention_admin', source: 'mention', isAdmin: true, isPublic: true, available: buildRequest(true, true) },
  ];
  for (const surface of directSurfaces) {
    const availableToolNames = new Set([
      ...globalTools,
      ...surface.available,
    ].map((tool) => tool.name));
    const routerVisibleSetNames = Object.values(toolSets.TOOL_SETS)
      .filter((set) => set.routerVisible !== false && (surface.isAdmin || !set.adminOnly))
      .map((set) => set.name);
    const combinations = routerVisibleSetNames.map((setName) => [setName]);
    for (let first = 0; first < routerVisibleSetNames.length; first += 1) {
      for (let second = first + 1; second < routerVisibleSetNames.length; second += 1) {
        combinations.push([routerVisibleSetNames[first], routerVisibleSetNames[second]]);
      }
    }
    const candidates = combinations.flatMap((toolSetsForPlan) => [false, true].map((hasSponsoredIntelligenceContext) => {
      const selection = selectBoundedRoutedToolSets({
        plan: {
          action: 'respond',
          tool_sets: toolSetsForPlan,
          confidence: 'high',
          reason: 'inventory bounded direct Slack route',
          decision_method: 'quick_match',
        },
        routerAvailable: true,
        source: surface.source,
        isAdmin: surface.isAdmin,
        isPublicChannel: surface.isPublic,
        sponsoredIntelligenceContextKind: hasSponsoredIntelligenceContext ? 'session' : null,
        isToolAvailable: (name) => availableToolNames.has(name),
      });
      return profile({
        id: `slack_bolt:${surface.audience}:candidate:${toolSetsForPlan.join('+')}${hasSponsoredIntelligenceContext ? ':si_context' : ''}`,
        runtime: 'slack_bolt',
        audience: surface.audience,
        route: toolSetsForPlan.join('+'),
        selectedToolSets: selection.selectedToolSets,
        allowedToolNames: selection.allowedToolNames,
        globalTools,
        requestTools: surface.available,
        providerToolCount: 1,
        conditionalMaximums: [
          'router_selected_up_to_two_bounded_domains',
          ...(hasSponsoredIntelligenceContext ? ['active_sponsored_intelligence_session'] : []),
          'google_docs_configured',
          'conformance_socket_enabled',
          'all_role_permissions',
          'nonstreaming_web_search',
        ],
      });
    }));
    const routed = routerVisibleSetNames.map((setName) => {
      const candidate = candidates.find((entry) =>
        entry.id === `slack_bolt:${surface.audience}:candidate:${setName}`,
      )!;
      return {
        ...candidate,
        id: `slack_bolt:${surface.audience}:routed:${setName}`,
      };
    });
    const maximums = new Map<string, Profile>();
    for (const metric of ['custom_tool_count', 'wire_schema_bytes', 'tool_reference_bytes'] as const) {
      const maximum = Math.max(...candidates.map((candidate) => candidate[metric]));
      const candidate = candidates.find((entry) => entry[metric] === maximum)!;
      maximums.set(metric, {
        ...candidate,
        id: metric === 'custom_tool_count'
          ? `slack_bolt:${surface.audience}:maximum`
          : `slack_bolt:${surface.audience}:maximum_${metric}`,
      });
    }
    const fallback = selectBoundedRoutedToolSets({
      plan: null,
      routerAvailable: false,
      source: surface.source,
      isAdmin: surface.isAdmin,
      isPublicChannel: surface.isPublic,
      sponsoredIntelligenceContextKind: 'session',
      isToolAvailable: (name) => availableToolNames.has(name),
    });
    profiles.push(...routed, ...maximums.values(), profile({
      id: `slack_bolt:${surface.audience}:safe_fallback`,
      runtime: 'slack_bolt',
      audience: surface.audience,
      route: 'safe_fallback',
      selectedToolSets: fallback.selectedToolSets,
      allowedToolNames: fallback.allowedToolNames,
      globalTools,
      requestTools: surface.available,
      providerToolCount: 1,
      conditionalMaximums: ['router_unavailable', 'nonstreaming_web_search'],
    }));

    if (surface.source === 'dm') {
      for (const activeCertificationKind of ['learning', 'assessment', 'mixed'] as const) {
        const certification = selectBoundedRoutedToolSets({
          plan: null,
          routerAvailable: false,
          source: 'dm',
          isAdmin: surface.isAdmin,
          activeCertificationKind,
          isToolAvailable: (name) => availableToolNames.has(name),
        });
        profiles.push(profile({
          id: `slack_bolt:${surface.audience}:certification_${activeCertificationKind}_session`,
          runtime: 'slack_bolt',
          audience: surface.audience,
          route: `certification_${activeCertificationKind}_session`,
          selectedToolSets: certification.selectedToolSets,
          allowedToolNames: certification.allowedToolNames,
          globalTools,
          requestTools: surface.available,
          providerToolCount: 1,
          conditionalMaximums: [
            'active_certification_overrides_router_admin_and_fallback',
            'google_docs_configured',
            'nonstreaming_web_search',
          ],
        }));
      }
    }
  }

  for (const systemRole of Object.keys(SYSTEM_CHANNEL_TOOL_SETS) as SystemChannelRole[]) {
    const allValidSets = Object.entries(toolSets.TOOL_SETS)
      .filter(([, set]) => set.routerVisible !== false)
      .map(([name]) => name);
    const selectedSets = selectSlackToolSets({
      routerSelectedSets: allValidSets,
      routerAvailable: true,
      source: 'channel',
      isAdmin: true,
      systemRole,
    });
    const allowed = new Set(toolSets.getToolsForSets(selectedSets, true, false));
    profiles.push(profile({
      id: `slack_bolt:system_channel_admin:${systemRole}:all_valid_sets_maximum`,
      runtime: 'slack_bolt',
      audience: 'system_channel_admin',
      route: `system_role_${systemRole}_all_valid_sets_maximum`,
      selectedToolSets: selectedSets,
      allowedToolNames: [...allowed],
      globalTools,
      requestTools: adminRequest.filter((tool) => allowed.has(tool.name)),
      providerToolCount: 1,
      conditionalMaximums: ['server_configured_system_channel', 'router_returns_all_valid_tool_sets', 'google_docs_configured', 'nonstreaming_web_search'],
    }));
  }
  // Reaction-triggered replies use the same bounded response-plan policy as
  // other direct, user-visible routes. Record each metric's actual maximum,
  // plus the explicit router-failure surface, rather than modeling the old
  // unrestricted request registry as reachable at runtime.
  const reactionSurfaces = [
    { audience: 'member', isAdmin: false, isPublic: false, available: memberRequest },
    { audience: 'admin', isAdmin: true, isPublic: false, available: adminRequest },
    { audience: 'public_channel', isAdmin: false, isPublic: true, available: publicRequest },
    { audience: 'public_channel_admin', isAdmin: true, isPublic: true, available: buildRequest(true, true) },
  ];
  for (const surface of reactionSurfaces) {
    const availableReactionToolNames = new Set([
      ...globalTools,
      ...surface.available,
    ].map((tool) => tool.name));
    const routerVisibleSetNames = Object.values(toolSets.TOOL_SETS)
      .filter((set) => set.routerVisible !== false && (surface.isAdmin || !set.adminOnly))
      .map((set) => set.name);
    const combinations = routerVisibleSetNames.map((setName) => [setName]);
    for (let first = 0; first < routerVisibleSetNames.length; first += 1) {
      for (let second = first + 1; second < routerVisibleSetNames.length; second += 1) {
        combinations.push([routerVisibleSetNames[first], routerVisibleSetNames[second]]);
      }
    }
    const candidates = combinations.flatMap((toolSetsForPlan) => [false, true].map((hasSponsoredIntelligenceContext) => {
      const selection = selectBoundedRoutedToolSets({
        plan: {
          action: 'respond',
          tool_sets: toolSetsForPlan,
          confidence: 'high',
          reason: 'inventory bounded reaction route',
          decision_method: 'quick_match',
        },
        routerAvailable: true,
        source: 'channel',
        isAdmin: surface.isAdmin,
        isPublicChannel: surface.isPublic,
        sponsoredIntelligenceContextKind: hasSponsoredIntelligenceContext ? 'session' : null,
        isToolAvailable: (name) => availableReactionToolNames.has(name),
      });
      return profile({
        id: `slack_bolt_reaction:${surface.audience}:candidate:${toolSetsForPlan.join('+')}${hasSponsoredIntelligenceContext ? ':si_context' : ''}`,
        runtime: 'slack_bolt_reaction',
        audience: surface.audience,
        route: toolSetsForPlan.join('+'),
        selectedToolSets: selection.selectedToolSets,
        allowedToolNames: selection.allowedToolNames,
        globalTools,
        requestTools: surface.available,
        providerToolCount: 1,
        conditionalMaximums: [
          'router_selected_up_to_two_bounded_domains',
          ...(hasSponsoredIntelligenceContext ? ['active_sponsored_intelligence_session'] : []),
          'google_docs_configured',
          'nonstreaming_web_search',
        ],
      });
    }));
    const maximums = new Map<string, Profile>();
    for (const metric of ['custom_tool_count', 'wire_schema_bytes', 'tool_reference_bytes'] as const) {
      const maximum = Math.max(...candidates.map((candidate) => candidate[metric]));
      const candidate = candidates.find((entry) => entry[metric] === maximum)!;
      maximums.set(metric, {
        ...candidate,
        id: metric === 'custom_tool_count'
          ? `slack_bolt_reaction:${surface.audience}:maximum`
          : `slack_bolt_reaction:${surface.audience}:maximum_${metric}`,
      });
    }
    const fallback = selectBoundedRoutedToolSets({
      plan: null,
      routerAvailable: false,
      source: 'channel',
      isAdmin: surface.isAdmin,
      isPublicChannel: surface.isPublic,
      sponsoredIntelligenceContextKind: 'session',
      activeCertificationKind: 'mixed',
      systemRole: 'billing',
      isToolAvailable: (name) => availableReactionToolNames.has(name),
    });
    profiles.push(...maximums.values(), profile({
      id: `slack_bolt_reaction:${surface.audience}:safe_fallback`,
      runtime: 'slack_bolt_reaction',
      audience: surface.audience,
      route: 'safe_fallback',
      selectedToolSets: fallback.selectedToolSets,
      allowedToolNames: fallback.allowedToolNames,
      globalTools,
      requestTools: surface.available,
      providerToolCount: 1,
      conditionalMaximums: ['router_unavailable', 'nonstreaming_web_search'],
    }));
  }
  return profiles;
}

function buildWebProfiles(defs: Awaited<ReturnType<typeof loadDefinitions>>): Profile[] {
  const {
    knowledge, directory, member, billing, schema, brand, property, siHost,
    adcp, escalation, images, certification, authGrader, admin, events,
    meetings, collaboration, committee, moltbook, chatTool,
  } = defs;
  const anonymousKnowledge = knowledge.KNOWLEDGE_TOOLS.filter(
    (tool) => chatTool.ANONYMOUS_SAFE_KNOWLEDGE_TOOLS.has(tool.name),
  );
  const searchMembers = member.MEMBER_TOOLS.filter((tool) => tool.name === 'search_members');
  const globalTools = [
    ...directory.DIRECTORY_TOOLS,
    ...searchMembers,
    ...anonymousKnowledge,
  ];
  const authenticatedOnly = [
    ...knowledge.KNOWLEDGE_TOOLS.filter((tool) =>
      !knowledge.isSlackKnowledgeTool(tool)
      && !chatTool.ANONYMOUS_SAFE_KNOWLEDGE_TOOLS.has(tool.name)),
    ...billing.BILLING_TOOLS,
    ...schema.SCHEMA_TOOLS,
    ...brand.BRAND_TOOLS,
    ...property.PROPERTY_TOOLS,
  ];
  const buildMemberTools = (isAdmin: boolean): AddieTool[] => [
    ...member.MEMBER_TOOLS,
    ...directory.DIRECTORY_TOOLS,
    ...siHost.SI_HOST_TOOLS,
    ...adcp.ADCP_TOOLS,
    ...escalation.ESCALATION_TOOLS,
    ...billing.BILLING_TOOLS,
    ...images.IMAGE_TOOLS,
    ...knowledge.KNOWLEDGE_TOOLS.filter(knowledge.isSlackKnowledgeTool),
    ...certification.CERTIFICATION_TOOLS,
    ...authGrader.AUTH_GRADER_TOOLS,
    ...(isAdmin ? admin.ADMIN_TOOLS : []),
    ...events.EVENT_READONLY_TOOLS,
    ...events.EVENT_ADMIN_TOOLS,
    ...meetings.MEETING_TOOLS,
    ...collaboration.COLLABORATION_TOOLS,
    ...committee.COMMITTEE_LEADER_TOOLS,
    ...moltbook.MOLTBOOK_TOOLS,
  ];
  const buildAuthenticatedRequest = (isAdmin: boolean): AddieTool[] => {
    const memberTools = buildMemberTools(isAdmin);
    const memberNames = new Set(memberTools.map((tool) => tool.name));
    return [
      ...authenticatedOnly.filter((tool) => !memberNames.has(tool.name)),
      ...memberTools,
    ];
  };
  const buildRoutedAuthenticatedProfiles = (isAdmin: boolean): Profile[] => {
    const audience = isAdmin ? 'authenticated_admin' : 'authenticated_member';
    const authenticatedRequest = buildAuthenticatedRequest(isAdmin);
    const availableToolNames = new Set([...globalTools, ...authenticatedRequest].map((tool) => tool.name));
    const selectedFor = (routerSelectedSets: string[], hasSponsoredIntelligenceContext = false) => selectBoundedRoutedToolSets({
      plan: {
        action: 'respond',
        tool_sets: routerSelectedSets,
        confidence: 'high',
        reason: 'inventory bounded web route',
        decision_method: 'quick_match',
      },
      routerAvailable: true,
      source: 'dm',
      isAdmin,
      sponsoredIntelligenceContextKind: hasSponsoredIntelligenceContext ? 'session' : null,
      isToolAvailable: (name) => name === 'web_search' || availableToolNames.has(name),
    });
    const profileFor = (
      id: string,
      selection: ReturnType<typeof selectBoundedRoutedToolSets>,
      conditionalMaximums: string[],
    ) =>
      profile({
        id: `web_chat:${audience}:${id}`,
        runtime: 'web_chat',
        audience,
        globalTools,
        requestTools: authenticatedRequest,
        allowedToolNames: selection.allowedToolNames,
        selectedToolSets: selection.selectedToolSets,
        providerToolCount: 1,
        conditionalMaximums,
      });
    const routerVisibleSetNames = Object.values(defs.toolSets.TOOL_SETS)
      .filter((set) => set.routerVisible !== false && (isAdmin || !set.adminOnly))
      .map((set) => set.name);
    const routed = routerVisibleSetNames.map((setName) => profileFor(
        `routed:${setName}`,
        selectedFor([setName]),
        ['router_selected_bounded_domain', 'nonstreaming_web_search'],
      ));
    const boundedDomainCombinations = routerVisibleSetNames.map((setName) => [setName]);
    for (let first = 0; first < routerVisibleSetNames.length; first += 1) {
      for (let second = first + 1; second < routerVisibleSetNames.length; second += 1) {
        boundedDomainCombinations.push([routerVisibleSetNames[first], routerVisibleSetNames[second]]);
      }
    }
    const boundedRouteCandidates = boundedDomainCombinations.flatMap((setNames) => [
      profileFor(
        `routed_combination:${setNames.join('+')}`,
        selectedFor(setNames),
        ['router_selected_up_to_two_bounded_domains', 'nonstreaming_web_search'],
      ),
      profileFor(
        `routed_combination:${setNames.join('+')}:si_context`,
        selectedFor(setNames, true),
        ['router_selected_up_to_two_bounded_domains', 'active_sponsored_intelligence_session', 'nonstreaming_web_search'],
      ),
    ]);
    // The runtime accepts at most two routed domains and can add SI only from
    // trusted session/retrieval context. Retain the exact profiles that
    // establish each generated maximum without checking in every combination.
    const boundedRouteMaximums = new Map<string, Profile>();
    for (const metric of ['custom_tool_count', 'wire_schema_bytes', 'tool_reference_bytes'] as const) {
      const maximum = Math.max(...boundedRouteCandidates.map((candidate) => candidate[metric]));
      for (const candidate of boundedRouteCandidates) {
        if (candidate[metric] === maximum) {
          boundedRouteMaximums.set(candidate.id, candidate);
          break;
        }
      }
    }
    const fallback = profileFor(
      'safe_fallback',
      selectBoundedRoutedToolSets({
        plan: null,
        routerAvailable: false,
        source: 'dm',
        isAdmin,
        isToolAvailable: (name) => name === 'web_search' || availableToolNames.has(name),
      }),
      ['router_unavailable', 'nonstreaming_web_search'],
    );
    const activeCertification = ([
      ['active_certification_learning', 'learning'],
      ['active_certification_assessment', 'assessment'],
      ['active_certification_mixed', 'mixed'],
    ] as const).map(([id, activeCertificationKind]) => profileFor(
      id,
      selectBoundedRoutedToolSets({
        plan: {
          action: 'respond',
          tool_sets: ['knowledge'],
          confidence: 'high',
          reason: 'inventory trusted certification session',
          decision_method: 'quick_match',
        },
        routerAvailable: true,
        source: 'dm',
        isAdmin,
        activeCertificationKind,
        isToolAvailable: (name) => name === 'web_search' || availableToolNames.has(name),
      }),
      ['active_certification_session', 'nonstreaming_web_search'],
    ));
    return [...routed, ...boundedRouteMaximums.values(), fallback, ...activeCertification];
  };

  return [
    profile({
      id: 'web_chat:anonymous:maximum', runtime: 'web_chat', audience: 'anonymous',
      globalTools, providerToolCount: 1,
      conditionalMaximums: ['nonstreaming_web_search'],
    }),
    ...buildRoutedAuthenticatedProfiles(false),
    ...buildRoutedAuthenticatedProfiles(true),
  ];
}

function buildAuxiliaryProfiles(defs: Awaited<ReturnType<typeof loadDefinitions>>): Profile[] {
  const {
    knowledge, directory, member, brand, billing, schema, property, siHost,
    adcp, escalation, admin, events, meetings, collaboration, committee,
    moltbook, toolSets, chatTool,
  } = defs;
  const anonymousKnowledge = knowledge.KNOWLEDGE_TOOLS.filter(
    (tool) => chatTool.ANONYMOUS_SAFE_KNOWLEDGE_TOOLS.has(tool.name),
  );
  const searchMembers = member.MEMBER_TOOLS.filter((tool) => tool.name === 'search_members');
  const webAnonymousGlobal = [
    ...directory.DIRECTORY_TOOLS,
    ...searchMembers,
    ...anonymousKnowledge,
  ];
  const mcpGlobal = [
    ...anonymousKnowledge,
    ...directory.DIRECTORY_TOOLS,
    ...searchMembers,
  ];
  const tavusGlobal = [
    ...knowledge.KNOWLEDGE_TOOLS.filter((tool) => !knowledge.isSlackKnowledgeTool(tool)),
    ...directory.DIRECTORY_TOOLS,
    ...brand.BRAND_TOOLS,
  ];
  const tavusCommonRequest = [
    ...member.MEMBER_TOOLS,
    ...siHost.SI_HOST_TOOLS,
    ...adcp.ADCP_TOOLS,
    ...escalation.ESCALATION_TOOLS,
    ...billing.BILLING_TOOLS,
    ...knowledge.KNOWLEDGE_TOOLS.filter(knowledge.isSlackKnowledgeTool),
    ...schema.SCHEMA_TOOLS,
    ...property.PROPERTY_TOOLS,
  ];
  const tavusTailRequest = [
    ...collaboration.COLLABORATION_TOOLS,
    ...committee.COMMITTEE_LEADER_TOOLS,
    ...moltbook.MOLTBOOK_TOOLS,
  ];
  const tavusMemberRequest = [
    ...tavusCommonRequest,
    ...events.EVENT_READONLY_TOOLS,
    ...tavusTailRequest,
  ];
  const tavusLeaderRequest = [
    ...tavusCommonRequest,
    ...events.EVENT_READONLY_TOOLS,
    ...meetings.MEETING_TOOLS,
    ...tavusTailRequest,
  ];
  const tavusAdminRequest = [
    ...tavusCommonRequest,
    ...events.EVENT_READONLY_TOOLS,
    ...admin.ADMIN_TOOLS,
    ...events.EVENT_ADMIN_TOOLS,
    ...meetings.MEETING_TOOLS,
    ...tavusTailRequest,
  ];
  // Authenticated Tavus turns now use the same bounded direct-response
  // selection as web chat and Slack reactions. Record each surface's actual
  // reachable maximum (one or two routed domains) and the explicit safe
  // fallback; do not model the request registry as a prompt-visible union.
  const buildTavusRoutedProfiles = (
    audience: 'member' | 'committee_leader' | 'admin',
    isAdmin: boolean,
    requestTools: AddieTool[],
    conditionalMaximums: string[],
  ): Profile[] => {
    const availableToolNames = new Set([...tavusGlobal, ...requestTools].map((tool) => tool.name));
    const routerVisibleSetNames = Object.values(toolSets.TOOL_SETS)
      .filter((set) => set.routerVisible !== false && (isAdmin || !set.adminOnly))
      .map((set) => set.name);
    const combinations = routerVisibleSetNames.map((setName) => [setName]);
    for (let first = 0; first < routerVisibleSetNames.length; first += 1) {
      for (let second = first + 1; second < routerVisibleSetNames.length; second += 1) {
        combinations.push([routerVisibleSetNames[first], routerVisibleSetNames[second]]);
      }
    }
    const candidates = combinations.map((toolSetsForPlan) => {
      const selection = selectBoundedRoutedToolSets({
        plan: {
          action: 'respond',
          tool_sets: toolSetsForPlan,
          confidence: 'high',
          reason: 'inventory bounded Tavus voice route',
          decision_method: 'quick_match',
        },
        routerAvailable: true,
        source: 'dm',
        isAdmin,
        isToolAvailable: (name) => availableToolNames.has(name),
      });
      return profile({
        id: `tavus_voice:${audience}:candidate:${toolSetsForPlan.join('+')}`,
        runtime: 'tavus_voice',
        audience,
        route: toolSetsForPlan.join('+'),
        selectedToolSets: selection.selectedToolSets,
        allowedToolNames: selection.allowedToolNames,
        globalTools: tavusGlobal,
        requestTools,
        providerToolCount: 0,
        conditionalMaximums: [
          'router_selected_up_to_two_bounded_domains',
          ...conditionalMaximums,
        ],
      });
    });
    const maximums = new Map<string, Profile>();
    for (const metric of ['custom_tool_count', 'wire_schema_bytes', 'tool_reference_bytes'] as const) {
      const maximum = Math.max(...candidates.map((candidate) => candidate[metric]));
      const candidate = candidates.find((entry) => entry[metric] === maximum)!;
      maximums.set(metric, {
        ...candidate,
        id: metric === 'custom_tool_count'
          ? `tavus_voice:${audience}:maximum`
          : `tavus_voice:${audience}:maximum_${metric}`,
      });
    }
    const fallback = selectBoundedRoutedToolSets({
      plan: null,
      routerAvailable: false,
      source: 'dm',
      isAdmin,
      isToolAvailable: (name) => availableToolNames.has(name),
    });
    return [
      ...maximums.values(),
      profile({
        id: `tavus_voice:${audience}:router_unavailable`,
        runtime: 'tavus_voice',
        audience,
        route: 'router_unavailable',
        selectedToolSets: fallback.selectedToolSets,
        allowedToolNames: fallback.allowedToolNames,
        globalTools: tavusGlobal,
        requestTools,
        providerToolCount: 0,
        conditionalMaximums: ['router_unavailable', ...conditionalMaximums],
      }),
    ];
  };
  return [
    profile({
      id: 'mcp_chat:anonymous:exact', runtime: 'mcp_chat', audience: 'anonymous',
      globalTools: mcpGlobal, providerToolCount: 1,
      conditionalMaximums: ['nonstreaming_web_search'],
    }),
    profile({
      id: 'email_chat:anonymous:exact', runtime: 'email_chat', audience: 'anonymous',
      globalTools: webAnonymousGlobal, providerToolCount: 1,
      conditionalMaximums: ['nonstreaming_web_search'],
    }),
    profile({
      id: 'tavus_voice:baseline:exact', runtime: 'tavus_voice', audience: 'baseline',
      globalTools: tavusGlobal, providerToolCount: 0,
      conditionalMaximums: ['thread_or_identity_unavailable'],
    }),
    ...buildTavusRoutedProfiles('member', false, tavusMemberRequest, ['moltbook_configured']),
    ...buildTavusRoutedProfiles(
      'committee_leader',
      false,
      tavusLeaderRequest,
      ['committee_leader_meeting_permissions', 'moltbook_configured'],
    ),
    ...buildTavusRoutedProfiles(
      'admin',
      true,
      tavusAdminRequest,
      ['admin_event_and_meeting_permissions', 'moltbook_configured'],
    ),
  ];
}

function buildBoundedReplayProfile(
  defs: Awaited<ReturnType<typeof loadDefinitions>>,
): Profile {
  const allowed = new Set<string>(defs.officialDocs.OFFICIAL_DOCS_ALLOWED_TOOLS);
  const tools = defs.knowledge.KNOWLEDGE_TOOLS.filter(
    (tool) => allowed.has(tool.name),
  );
  return profile({
    id: 'official_docs_replay:read_only:exact',
    runtime: 'official_docs_replay',
    audience: 'evaluation_only',
    globalTools: tools,
    providerToolCount: 0,
    conditionalMaximums: [
      'signed_trace_authorized',
      'capture_and_generation_flags_enabled',
      'channel_dual_allowlisted',
      'daily_quota_available',
    ],
  });
}

function metrics(snapshot: {
  prompt: Record<string, number>;
  profiles: Profile[];
  routed: {
    unique_tool_count: number;
    always_available_tool_count: number;
    missing_runtime_definition_count: number;
  };
  runtime: { unique_tool_count: number; not_declared_to_router_count: number };
  catalog: { missing_runtime_tool_count: number; missing_catalog_tool_count: number };
}): Record<string, number> {
  const maximum = (runtime: string, audience: string, field: 'custom_tool_count' | 'wire_schema_bytes') =>
    Math.max(...snapshot.profiles
      .filter((entry) => entry.runtime === runtime && entry.audience === audience)
      .map((entry) => entry[field]));
  return {
    routed_unique_tools: snapshot.routed.unique_tool_count,
    runtime_unique_tools: snapshot.runtime.unique_tool_count,
    runtime_tools_not_declared_to_router: snapshot.runtime.not_declared_to_router_count,
    routed_tools_missing_runtime_definition: snapshot.routed.missing_runtime_definition_count,
    maximum_conflicting_tool_overrides: Math.max(
      ...snapshot.profiles.map((entry) => entry.conflicting_override_count),
    ),
    runtime_tools_missing_prompt_catalog: snapshot.catalog.missing_runtime_tool_count,
    prompt_catalog_tools_missing_runtime: snapshot.catalog.missing_catalog_tool_count,
    always_available_tools: snapshot.routed.always_available_tool_count,
    tool_reference_bytes: snapshot.prompt.tool_reference_bytes,
    system_prompt_bytes: snapshot.prompt.system_prompt_bytes,
    maximum_slack_member_tools: maximum('slack_bolt', 'member_dm', 'custom_tool_count'),
    maximum_slack_admin_tools: maximum('slack_bolt', 'admin_dm', 'custom_tool_count'),
    maximum_slack_public_tools: Math.max(
      maximum('slack_bolt', 'public_channel_member', 'custom_tool_count'),
      maximum('slack_bolt', 'public_channel_admin', 'custom_tool_count'),
    ),
    maximum_slack_member_schema_bytes: maximum('slack_bolt', 'member_dm', 'wire_schema_bytes'),
    maximum_slack_admin_schema_bytes: maximum('slack_bolt', 'admin_dm', 'wire_schema_bytes'),
    maximum_slack_public_schema_bytes: Math.max(
      maximum('slack_bolt', 'public_channel_member', 'wire_schema_bytes'),
      maximum('slack_bolt', 'public_channel_admin', 'wire_schema_bytes'),
    ),
    web_anonymous_tools: maximum('web_chat', 'anonymous', 'custom_tool_count'),
    web_authenticated_admin_tools: maximum('web_chat', 'authenticated_admin', 'custom_tool_count'),
  };
}

function surfaceMaximums(profiles: Profile[]): Record<string, SurfaceMaximum> {
  const result: Record<string, SurfaceMaximum> = {};
  for (const entry of profiles) {
    const key = `${entry.runtime}:${entry.audience}`;
    const current = result[key] ?? {
      custom_tool_count: 0,
      wire_schema_bytes: 0,
      maximum_provider_tool_count: 0,
      maximum_provider_tool_wire_bytes: 0,
    };
    current.custom_tool_count = Math.max(current.custom_tool_count, entry.custom_tool_count);
    current.wire_schema_bytes = Math.max(current.wire_schema_bytes, entry.wire_schema_bytes);
    current.maximum_provider_tool_count = Math.max(
      current.maximum_provider_tool_count,
      entry.maximum_provider_tool_count,
    );
    current.maximum_provider_tool_wire_bytes = Math.max(
      current.maximum_provider_tool_wire_bytes,
      entry.maximum_provider_tool_wire_bytes,
    );
    result[key] = current;
  }
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)));
}

const CERTIFICATION_WIRE_REQUIREMENTS = {
  certification_overview: [
    'list_certification_tracks',
    'get_certification_module',
    'get_learner_progress',
    'check_credentials',
    'set_my_name',
  ],
  certification_learning: [
    'start_certification_module',
    'complete_certification_module',
    'get_learner_progress',
    'check_credentials',
    'checkpoint_teaching_progress',
    'get_build_phase_instructions',
    'save_learner_feedback',
    'set_my_name',
    'find_membership_products',
    'call_adcp_task',
  ],
  certification_assessment: [
    'get_learner_progress',
    'test_out_modules',
    'start_certification_exam',
    'complete_certification_exam',
    'check_credentials',
    'checkpoint_teaching_progress',
    'set_my_name',
    'find_membership_products',
    'call_adcp_task',
  ],
} as const;

function assertCertificationWireContract(profiles: Profile[]): void {
  const errors: string[] = [];
  for (const [setName, requirements] of Object.entries(CERTIFICATION_WIRE_REQUIREMENTS)) {
    const certificationProfiles = profiles.filter((entry) =>
      // Public app mentions deliberately expose only the read-only subset of
      // a routed certification domain. The full wire contract still applies
      // to every private/direct certification session.
      entry.selected_tool_sets?.includes(setName)
      && !entry.id.includes('public_mention'));
    if (certificationProfiles.length === 0) {
      errors.push(`Addie tool inventory has no ${setName} profiles`);
      continue;
    }
    for (const entry of certificationProfiles) {
      const available = new Set(entry.ordered_tool_names);
      for (const name of requirements) {
        if (!available.has(name)) errors.push(`${entry.id} is missing ${name}`);
      }
    }
  }
  if (errors.length > 0) {
    throw new Error(`Certification wire contract failed:\n- ${errors.join('\n- ')}`);
  }
}

/**
 * Web search is provider-managed: it intentionally has no custom definition
 * or handler in the web inventory. Keep its availability treatment aligned
 * with the runtime selector so a valid knowledge plan cannot be mistaken for
 * an incomplete registration and silently become the broad safe fallback.
 */
function assertWebProviderManagedToolParity(profiles: Profile[]): void {
  const errors: string[] = [];
  for (const audience of ['authenticated_member', 'authenticated_admin']) {
    const entry = profiles.find((profile) =>
      profile.id === `web_chat:${audience}:routed:knowledge`);
    if (!entry) {
      errors.push(`Addie tool inventory has no web knowledge profile for ${audience}`);
      continue;
    }
    if (JSON.stringify(entry.selected_tool_sets) !== JSON.stringify(['knowledge'])) {
      errors.push(`${entry.id} must retain its exact knowledge route`);
    }
    if (JSON.stringify(entry.maximum_provider_tool_names) !== JSON.stringify(['web_search'])) {
      errors.push(`${entry.id} must model provider-managed web_search`);
    }
  }
  if (errors.length > 0) {
    throw new Error(`Web provider-managed tool parity failed:\n- ${errors.join('\n- ')}`);
  }
}

/** Keep the generated direct-Slack inventory on the runtime bounded selector. */
function assertDirectSlackBoundedSelectionParity(profiles: Profile[]): void {
  const errors: string[] = [];
  for (const audience of [
    'member_dm',
    'admin_dm',
    'private_mention_member',
    'private_mention_admin',
    'public_mention_member',
    'public_mention_admin',
  ]) {
    const knowledge = profiles.find((entry) =>
      entry.id === `slack_bolt:${audience}:routed:knowledge`);
    const fallback = profiles.find((entry) =>
      entry.id === `slack_bolt:${audience}:safe_fallback`);
    if (!knowledge || JSON.stringify(knowledge.selected_tool_sets) !== JSON.stringify(['knowledge'])) {
      errors.push(`Addie tool inventory has no exact bounded knowledge profile for ${audience}`);
    }
    if (!fallback || JSON.stringify(fallback.selected_tool_sets) !== JSON.stringify(SAFE_KNOWLEDGE_FALLBACK_TOOL_SETS)) {
      errors.push(`Addie tool inventory has no exact safe fallback profile for ${audience}`);
    }
  }
  for (const audience of ['member_dm', 'admin_dm']) {
    for (const [kind, expected] of [
      ['learning', ['certification_learning', ...SAFE_KNOWLEDGE_FALLBACK_TOOL_SETS, 'illustrations']],
      ['assessment', ['certification_assessment', ...SAFE_KNOWLEDGE_FALLBACK_TOOL_SETS, 'illustrations']],
      ['mixed', ['certification_learning', 'certification_assessment', ...SAFE_KNOWLEDGE_FALLBACK_TOOL_SETS, 'illustrations']],
    ] as const) {
      const entry = profiles.find((profile) =>
        profile.id === `slack_bolt:${audience}:certification_${kind}_session`);
      if (!entry || JSON.stringify(entry.selected_tool_sets) !== JSON.stringify(expected)) {
        errors.push(`Addie tool inventory has no exact trusted ${kind} certification profile for ${audience}`);
      }
    }
  }
  if (profiles.some((entry) => entry.id.includes('_mention_') && entry.route?.includes('certification_') && entry.route.endsWith('_session'))) {
    errors.push('Addie tool inventory must not model trusted certification sessions for mentions');
  }
  const publicMentionAllowedNames = new Set<string>(PUBLIC_MENTION_READ_ONLY_TOOL_NAMES);
  for (const entry of profiles.filter((profile) =>
    profile.runtime === 'slack_bolt' && profile.audience.startsWith('public_mention_')
  )) {
    const disallowedCustomTools = entry.ordered_tool_names.filter((name) => !publicMentionAllowedNames.has(name));
    const disallowedProviderTools = entry.maximum_provider_tool_names.filter((name) => !publicMentionAllowedNames.has(name));
    if (disallowedCustomTools.length > 0 || disallowedProviderTools.length > 0) {
      errors.push(`${entry.id} exceeds the audited public-mention read-only surface: ${[
        ...disallowedCustomTools,
        ...disallowedProviderTools,
      ].join(', ')}`);
    }
  }
  if (errors.length > 0) {
    throw new Error(`Direct Slack bounded-selection parity failed:\n- ${errors.join('\n- ')}`);
  }
}

function loadBudget(): BudgetFile | null {
  if (!fs.existsSync(BUDGET_FILE)) return null;
  const parsed = JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8')) as BudgetFile;
  const expectedKeys = [...METRIC_NAMES].sort();
  const baselineKeys = Object.keys(parsed.baseline?.metrics ?? {}).sort();
  const maximumKeys = Object.keys(parsed.maximums ?? {}).sort();
  const valuesAreValid = [...Object.values(parsed.baseline?.metrics ?? {}),
    ...Object.values(parsed.maximums ?? {})]
    .every((value) => Number.isSafeInteger(value) && value >= 0);
  if (
    parsed.schema_version !== 4
    || !parsed.baseline?.id
    || JSON.stringify(baselineKeys) !== JSON.stringify(expectedKeys)
    || JSON.stringify(maximumKeys) !== JSON.stringify(expectedKeys)
    || !valuesAreValid
    || !parsed.surface_maximums
    || !/^[a-f0-9]{64}$/.test(parsed.profile_ids_sha256 ?? '')
    || !/^[a-f0-9]{64}$/.test(parsed.profile_contract_sha256 ?? '')
    || !Object.values(parsed.surface_maximums).every((surface) =>
      Object.keys(surface).sort().join(',') === [
        'custom_tool_count',
        'maximum_provider_tool_count',
        'maximum_provider_tool_wire_bytes',
        'wire_schema_bytes',
      ].join(',')
      && Object.values(surface).every((value) => Number.isSafeInteger(value) && value >= 0))
  ) {
    throw new Error(`Invalid Addie tool-surface budget: ${BUDGET_FILE}`);
  }
  return parsed;
}

function assertBudget(
  current: Record<string, number>,
  currentSurfaces: Record<string, SurfaceMaximum>,
  profiles: Profile[],
  budget: BudgetFile,
): void {
  const errors: string[] = [];
  const profileIdsSha256 = sha256(JSON.stringify(profiles.map((entry) => entry.id)));
  const profileContractSha256 = sha256(JSON.stringify(profiles));
  if (profileIdsSha256 !== budget.profile_ids_sha256) {
    errors.push(`profile ID set changed: current=${profileIdsSha256} budget=${budget.profile_ids_sha256}`);
  }
  if (profileContractSha256 !== budget.profile_contract_sha256) {
    errors.push(`reviewed profile contract changed: current=${profileContractSha256} budget=${budget.profile_contract_sha256}`);
  }
  for (const [metric, maximum] of Object.entries(budget.maximums)) {
    const value = current[metric];
    if (value === undefined) errors.push(`Unknown budget metric: ${metric}`);
    else if (value > maximum) errors.push(`${metric}: ${value} exceeds maximum ${maximum}`);
  }
  const currentKeys = Object.keys(currentSurfaces).sort();
  const budgetKeys = Object.keys(budget.surface_maximums).sort();
  if (JSON.stringify(currentKeys) !== JSON.stringify(budgetKeys)) {
    errors.push(`surface profiles differ: current=${currentKeys.join(',')} budget=${budgetKeys.join(',')}`);
  }
  for (const [surface, values] of Object.entries(currentSurfaces)) {
    const ceiling = budget.surface_maximums[surface];
    if (!ceiling) continue;
    for (const [metric, value] of Object.entries(values)) {
      const maximum = ceiling[metric as keyof SurfaceMaximum];
      if (value > maximum) errors.push(`${surface}.${metric}: ${value} exceeds maximum ${maximum}`);
    }
  }
  if (errors.length) throw new Error(`Addie tool-surface budget exceeded:\n- ${errors.join('\n- ')}`);
}

async function buildSnapshot() {
  const defs = await loadDefinitions();
  const profiles = [
    ...buildSlackBoltProfiles(defs),
    ...buildWebProfiles(defs),
    ...buildAuxiliaryProfiles(defs),
    buildBoundedReplayProfile(defs),
  ].sort((left, right) => left.id.localeCompare(right.id));
  assertCertificationWireContract(profiles);
  assertWebProviderManagedToolParity(profiles);
  assertDirectSlackBoundedSelectionParity(profiles);
  const routedNames = new Set([
    ...defs.toolSets.ALWAYS_AVAILABLE_TOOLS,
    ...defs.toolSets.ALWAYS_AVAILABLE_ADMIN_TOOLS,
    ...Object.values(defs.toolSets.TOOL_SETS)
      .filter((set) => set.routerVisible !== false)
      .flatMap((set) => set.tools),
  ]);
  const runtimeNames = new Set(profiles.flatMap((entry) => entry.ordered_tool_names));
  const routedSlackRuntimeNames = new Set(profiles
    .filter((entry) => entry.runtime === 'slack_bolt')
    .flatMap((entry) => entry.ordered_tool_names));
  const missingRuntimeDefinitions = [...routedNames]
    .filter((name) => name !== 'web_search' && !routedSlackRuntimeNames.has(name))
    .sort();
  const runtimeNamesNotDeclaredToRouter = [...routedSlackRuntimeNames]
    .filter((name) => !routedNames.has(name))
    .sort();

  const { ADDIE_TOOL_REFERENCE } = await import('../server/src/addie/prompts.js');
  const { ADDIE_TOOL_NAMES } = await import(
    '../server/src/addie/generated/tool-catalog.generated.js'
  );
  const { loadResponseStyle, loadRules } = await import('../server/src/addie/rules/index.js');
  const rules = loadRules();
  const responseStyle = loadResponseStyle();
  const maximumPromptProfile = profiles.reduce((maximum, entry) =>
    entry.tool_reference_bytes > maximum.tool_reference_bytes ? entry : maximum,
  );
  const maximumToolReference = buildAddieToolReference({
    availableToolNames: maximumPromptProfile.ordered_tool_names,
    selectedToolSetNames: maximumPromptProfile.selected_tool_sets,
  });
  const systemPrompt = assembleAddieSystemPrompt(rules, maximumToolReference, responseStyle);
  const catalogTokens = new Set<string>(ADDIE_TOOL_NAMES);
  const runtimeToolsMissingFromCatalog = [...runtimeNames]
    .filter((name) => !catalogTokens.has(name))
    .sort();
  // The catalog also documents conditionally registered, non-routed tools.
  // Inventory parity is a runtime safety property: every tool a router can
  // select must have a definition/handler on at least one modeled runtime.
  const catalogToolsMissingFromRuntime = [...catalogTokens]
    .filter((name) => routedNames.has(name) && !runtimeNames.has(name))
    .sort();

  const snapshot = {
    schema_version: 2,
    measurement: {
      scope: 'Declared maximum runtime profiles. Conditional integrations and permissions are treated as enabled; actual requests can be smaller.',
      wire_shape: 'Exact ordered Anthropic custom-tool JSON after global/request last-value deduplication and final ephemeral cache breakpoint.',
      prompt_shape: 'Each profile records the request-scoped tool reference built from its exact ordered tool names and selected capability sets; top-level prompt bytes are the largest measured production profile.',
      provider_tools: 'Provider-native web search is counted separately and is unavailable on the streaming path.',
      registration_guard: 'Registration-source hashes force review when runtime assembly changes; the shared wire projector prevents measurement drift.',
    },
    nonblocking_targets: {
      typical_conversation_custom_tools: '8-12',
      note: 'Directional consolidation target; current exact baselines remain the enforced no-growth ceilings.',
    },
    registration_source_sha256: Object.fromEntries(REGISTRATION_SOURCES.map((relativePath) => [
      relativePath,
      sha256(fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8')),
    ])),
    routed: {
      tool_set_count: Object.values(defs.toolSets.TOOL_SETS)
        .filter((set) => set.routerVisible !== false).length,
      compatibility_tool_set_count: Object.values(defs.toolSets.TOOL_SETS)
        .filter((set) => set.routerVisible === false).length,
      unique_tool_count: routedNames.size,
      always_available_tool_count: defs.toolSets.ALWAYS_AVAILABLE_TOOLS.length,
      always_available_admin_tool_count: defs.toolSets.ALWAYS_AVAILABLE_ADMIN_TOOLS.length,
      missing_runtime_definition_count: missingRuntimeDefinitions.length,
      missing_runtime_definitions: missingRuntimeDefinitions,
    },
    runtime: {
      unique_tool_count: runtimeNames.size,
      not_declared_to_router_count: runtimeNamesNotDeclaredToRouter.length,
      not_declared_to_router: runtimeNamesNotDeclaredToRouter,
      not_declared_to_router_scope: 'Modern routed Slack Bolt profiles only',
    },
    prompt: {
      rules_bytes: Buffer.byteLength(rules, 'utf8'),
      tool_reference_bytes: Buffer.byteLength(maximumToolReference, 'utf8'),
      complete_offline_tool_reference_bytes: Buffer.byteLength(ADDIE_TOOL_REFERENCE, 'utf8'),
      response_style_bytes: Buffer.byteLength(responseStyle, 'utf8'),
      system_prompt_bytes: Buffer.byteLength(systemPrompt, 'utf8'),
      system_prompt_sha256: sha256(systemPrompt),
    },
    catalog: {
      missing_runtime_tool_count: runtimeToolsMissingFromCatalog.length,
      missing_runtime_tools: runtimeToolsMissingFromCatalog,
      missing_catalog_tool_count: catalogToolsMissingFromRuntime.length,
      missing_catalog_tools: catalogToolsMissingFromRuntime,
    },
    profiles,
  };
  const current = metrics(snapshot);
  const currentSurfaces = surfaceMaximums(profiles);
  const profileIdsSha256 = sha256(JSON.stringify(profiles.map((entry) => entry.id)));
  const profileContractSha256 = sha256(JSON.stringify(profiles));
  const budget = loadBudget();
  if (budget) assertBudget(current, currentSurfaces, profiles, budget);
  return {
    ...snapshot,
    baseline: budget ? {
      id: budget.baseline.id,
      metrics: budget.baseline.metrics,
      deltas: Object.fromEntries(Object.entries(current).map(([key, value]) => [
        key,
        value - (budget.baseline.metrics[key] ?? value),
      ])),
    } : null,
    budgets: budget ? {
      maximums: budget.maximums,
      surface_maximums: budget.surface_maximums,
      profile_ids_sha256: budget.profile_ids_sha256,
      profile_contract_sha256: budget.profile_contract_sha256,
      status: 'within_budget',
    } : null,
    profile_contract: {
      profile_ids_sha256: profileIdsSha256,
      profile_contract_sha256: profileContractSha256,
    },
  };
}

async function main(): Promise<void> {
  const checkMode = process.argv.includes('--check');
  const snapshot = await buildSnapshot();
  const rendered = `${JSON.stringify(snapshot, null, 2)}\n`;
  if (checkMode) {
    if (!snapshot.baseline || !snapshot.budgets) {
      throw new Error(`Missing required Addie tool-surface budget: ${BUDGET_FILE}`);
    }
    const existing = fs.existsSync(OUTPUT_FILE) ? fs.readFileSync(OUTPUT_FILE, 'utf8') : '';
    if (existing !== rendered) {
      throw new Error(`Stale Addie tool-surface inventory: ${OUTPUT_FILE}\nRun: npm run build:addie-tools`);
    }
    console.log('✓ Addie runtime tool/prompt inventory is current and within budget.');
    return;
  }
  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, rendered);
  console.log(`✓ Wrote ${OUTPUT_FILE}`);
  if (!snapshot.baseline) console.warn(`! No budget file found yet: ${BUDGET_FILE}`);
}

await main();
