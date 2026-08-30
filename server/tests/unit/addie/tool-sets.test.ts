import { describe, it, expect } from 'vitest';
import { ADDIE_TOOL_CATALOG } from '../../../src/addie/generated/tool-catalog.generated.js';
import {
  AGENT_VALIDATION_TOOLS,
  ADMIN_DOMAIN_TOOL_SETS,
  ALWAYS_AVAILABLE_ADMIN_TOOLS,
  ALWAYS_AVAILABLE_TOOLS,
  COMMUNITY_GROUP_TOOLS,
  LEGACY_ADMIN_GROUP_TOOLS,
  LEGACY_ADMIN_TOOLS,
  LEGACY_AGENT_TESTING_TOOLS,
  LEGACY_MEMBER_TOOLS,
  MEMBER_PROFILE_TOOLS,
  PROPERTY_CATALOG_TOOLS,
  SAFE_KNOWLEDGE_FALLBACK_TOOL_SETS,
  TOOL_SETS,
  buildUnavailableSetsHint,
  getToolsForSets,
  getValidToolSetNames,
} from '../../../src/addie/tool-sets.js';

describe('getToolsForSets', () => {
  describe('admin always-available tools', () => {
    it('includes resolve_escalation for admins without admin set routed', () => {
      const tools = getToolsForSets(['knowledge'], true, false);
      expect(tools).toContain('resolve_escalation');
      expect(tools).toContain('list_escalations');
    });

    it('excludes resolve_escalation for non-admins', () => {
      const tools = getToolsForSets(['knowledge'], false, false);
      expect(tools).not.toContain('resolve_escalation');
    });

    it('includes admin always-available tools even with no sets selected', () => {
      const tools = getToolsForSets([], true, false);
      for (const tool of ALWAYS_AVAILABLE_ADMIN_TOOLS) {
        expect(tools).toContain(tool);
      }
    });
  });

  describe('bounded admin domains', () => {
    it('keeps every router-visible admin domain at twelve tools or fewer', () => {
      for (const [name, tools] of Object.entries(ADMIN_DOMAIN_TOOL_SETS)) {
        expect(tools.length, name).toBeLessThanOrEqual(12);
        expect(TOOL_SETS[name].tools).toEqual(tools);
      }
    });

    it('preserves the exact 66-tool legacy surface without exposing it to new router plans', () => {
      expect(LEGACY_ADMIN_TOOLS).toHaveLength(66);
      expect(new Set(LEGACY_ADMIN_TOOLS).size).toBe(66);
      expect(TOOL_SETS.admin.tools).toEqual(LEGACY_ADMIN_TOOLS);
      expect(TOOL_SETS.admin.routerVisible).toBe(false);
      expect(getValidToolSetNames(true).has('admin')).toBe(false);
    });

    it('keeps the mixed group surface only as an in-flight compatibility shim', () => {
      expect(LEGACY_ADMIN_GROUP_TOOLS).toHaveLength(12);
      expect(TOOL_SETS.admin_groups.tools).toEqual(LEGACY_ADMIN_GROUP_TOOLS);
      expect(TOOL_SETS.admin_groups.routerVisible).toBe(false);
      expect(getValidToolSetNames(true).has('admin_groups')).toBe(false);

      for (const name of [
        'admin_group_structure',
        'admin_group_leadership',
        'admin_group_membership',
      ]) {
        const customTools = getToolsForSets([name], true, false)
          .filter((toolName) => toolName !== 'web_search');
        expect(customTools.length, name).toBeLessThanOrEqual(12);
      }
    });

    it('loads only the selected admin domain and rejects it for non-admins', () => {
      const adminTools = getToolsForSets(['admin_prospects'], true, false);
      expect(adminTools).toContain('query_prospects');
      expect(adminTools).not.toContain('merge_organizations');
      expect(adminTools).not.toContain('create_event');

      const memberTools = getToolsForSets(['admin_prospects'], false, false);
      expect(memberTools).not.toContain('query_prospects');
    });

    it('keeps the legacy set callable only as a continuity shim', () => {
      const tools = getToolsForSets(['admin'], true, false);
      expect(tools).toContain('query_prospects');
      expect(tools).toContain('merge_organizations');
      expect(buildUnavailableSetsHint([], true)).not.toContain('**admin**');
    });

    it('generates the compact catalog from router-visible domains only', () => {
      expect(ADDIE_TOOL_CATALOG).toContain('- **admin_prospects**');
      expect(ADDIE_TOOL_CATALOG).toContain('- **admin_organizations**');
      expect(ADDIE_TOOL_CATALOG).toContain('- **admin_group_structure**');
      expect(ADDIE_TOOL_CATALOG).toContain('- **admin_group_leadership**');
      expect(ADDIE_TOOL_CATALOG).toContain('- **admin_group_membership**');
      expect(ADDIE_TOOL_CATALOG).not.toContain('- **admin_groups**');
      expect(ADDIE_TOOL_CATALOG).not.toContain('- **admin** *(admin only)*');
    });
  });

  describe('certification workflow', () => {
    it('keeps every instructed checkpoint, build, feedback, and credential-recovery tool on the routed surface', () => {
      const tools = getToolsForSets(['certification'], false, false);

      expect(tools).toEqual(expect.arrayContaining([
        'start_certification_module',
        'complete_certification_module',
        'check_credentials',
        'checkpoint_teaching_progress',
        'get_build_phase_instructions',
        'save_learner_feedback',
        'set_my_name',
        'find_membership_products',
        'call_adcp_task',
      ]));
    });
  });

  describe('Sponsored Intelligence workflow', () => {
    it('exposes the complete SI host surface only when its domain is selected', () => {
      const siTools = [
        'get_si_availability',
        'list_si_agents',
        'connect_to_si_agent',
        'send_to_si_agent',
        'end_si_session',
        'get_si_session_status',
      ];

      expect(getToolsForSets(['sponsored_intelligence'], false, false)).toEqual(
        expect.arrayContaining(siTools),
      );
      expect(getToolsForSets(['knowledge'], false, false)).not.toEqual(
        expect.arrayContaining(siTools),
      );
    });
  });

  describe('bounded agent and property domains', () => {
    it('routes the complete property audit, enrichment, catalog, and dispute surface', () => {
      expect(getToolsForSets(['property_catalog'], false, false)).toEqual(
        expect.arrayContaining([
          'check_property_list',
          'enhance_property',
          'resolve_catalog',
          'browse_catalog',
          'dispute_catalog_entry',
        ]),
      );
    });

    it('keeps agent validation and property-catalog workflows isolated', () => {
      const validation = getToolsForSets(['agent_validation'], false, false);
      const property = getToolsForSets(['property_catalog'], false, false);

      expect(validation).toEqual(expect.arrayContaining([
        'validate_adagents',
        'check_publisher_authorization',
        'evaluate_agent_quality',
        'grade_agent_signing',
      ]));
      expect(validation).not.toContain('resolve_property');
      expect(validation).not.toContain('dispute_catalog_entry');
      expect(property).toContain('resolve_property');
      expect(property).toContain('dispute_catalog_entry');
      expect(property).not.toContain('evaluate_agent_quality');
      expect(property).not.toContain('diagnose_agent_auth');
    });

    it('preserves the exact legacy union without exposing it to new router plans', () => {
      expect(AGENT_VALIDATION_TOOLS).toHaveLength(12);
      expect(PROPERTY_CATALOG_TOOLS).toHaveLength(9);
      expect(LEGACY_AGENT_TESTING_TOOLS).toHaveLength(21);
      expect(new Set(LEGACY_AGENT_TESTING_TOOLS).size).toBe(21);
      expect(TOOL_SETS.agent_testing.tools).toEqual(LEGACY_AGENT_TESTING_TOOLS);
      expect(TOOL_SETS.agent_testing.routerVisible).toBe(false);
      expect(getValidToolSetNames(false).has('agent_testing')).toBe(false);
      expect(getValidToolSetNames(false).has('agent_validation')).toBe(true);
      expect(getValidToolSetNames(false).has('property_catalog')).toBe(true);
    });

    it('keeps the old combined set callable only as a continuity shim', () => {
      const tools = getToolsForSets(['agent_testing'], false, false);
      expect(tools).toEqual(expect.arrayContaining([
        'evaluate_agent_quality',
        'resolve_property',
        'dispute_catalog_entry',
      ]));
      expect(buildUnavailableSetsHint([], false)).not.toContain('**agent_testing**');
      expect(ADDIE_TOOL_CATALOG).toContain('- **agent_validation**');
      expect(ADDIE_TOOL_CATALOG).toContain('- **property_catalog**');
      expect(ADDIE_TOOL_CATALOG).not.toContain('- **agent_testing**');
    });
  });

  describe('brand canonical-document workflow', () => {
    it('routes the complete publish, reciprocity, notification, and logo surface separately from directory lookup', () => {
      expect(getToolsForSets(['brand_registry'], false, false)).toEqual(
        expect.arrayContaining([
          'upload_brand_logo',
          'publish_brand_canonical_document',
          'add_to_brand_refs',
          'check_mutual_assertion',
          'notify_pending_verification',
        ]),
      );
      expect(getToolsForSets(['directory'], false, false)).not.toContain('save_brand');
      expect(getToolsForSets(['directory'], false, false)).not.toContain('publish_brand_canonical_document');
    });
  });

  describe('member billing workflow', () => {
    it('exposes only identity-bound self-service tools to members', () => {
      const tools = getToolsForSets(['member_billing'], false, false);
      const memberBillingTools = [
        'find_membership_products',
        'create_payment_link',
        'send_invoice',
        'confirm_send_invoice',
        'get_billing_portal',
      ];

      expect(TOOL_SETS.member_billing.tools).toEqual(memberBillingTools);
      expect(tools).toEqual(expect.arrayContaining(memberBillingTools));
      for (const adminTool of TOOL_SETS.billing.tools) {
        expect(tools).not.toContain(adminTool);
      }
      expect(TOOL_SETS.billing.tools.filter((tool) => memberBillingTools.includes(tool))).toEqual([]);
    });
  });

  describe('public channel filtering', () => {
    it('excludes get_account_link from always-available tools in public channels', () => {
      const tools = getToolsForSets([], false, true);
      expect(tools).not.toContain('get_account_link');
    });

    it('includes get_account_link in private channels', () => {
      const tools = getToolsForSets([], false, false);
      expect(tools).toContain('get_account_link');
    });

    it('includes get_account_link by default', () => {
      const tools = getToolsForSets([]);
      expect(tools).toContain('get_account_link');
    });

    it('skips member and admin billing sets in public channels', () => {
      const billingTools = [...TOOL_SETS.member_billing.tools, ...TOOL_SETS.billing.tools];
      const tools = getToolsForSets(['member_billing', 'billing'], true, true);
      for (const billingTool of billingTools) {
        expect(tools).not.toContain(billingTool);
      }
    });

    it('includes billing tool set in private channels for admins', () => {
      const tools = getToolsForSets(['billing'], true, false);
      expect(tools).toContain('send_payment_request');
      expect(tools).not.toContain('find_membership_products');
    });

    it('keeps Stripe customer relinks behind the precision-gated billing set', () => {
      expect(TOOL_SETS.billing.requiresPrecision).toBe(true);
      expect(TOOL_SETS.billing.tools).toContain('preview_org_stripe_customer_update');
      expect(TOOL_SETS.billing.tools).toContain('confirm_org_stripe_customer_update');
      expect(TOOL_SETS.admin.tools).not.toContain('preview_org_stripe_customer_update');
      expect(TOOL_SETS.admin.tools).not.toContain('confirm_org_stripe_customer_update');
    });

    it('still includes non-enrollment always-available tools in public channels', () => {
      const tools = getToolsForSets([], false, true);
      expect(tools).toContain('escalate_to_admin');
      expect(tools).toContain('capture_learning');
    });

    it('still includes knowledge tools in public channels', () => {
      const tools = getToolsForSets(['knowledge'], false, true);
      expect(tools).toContain('search_docs');
    });
  });

  describe('bounded member-facing domains', () => {
    it.each([
      ['member_profile', 7],
      ['community_groups', 11],
      ['publishing', 12],
      ['github', 4],
      ['illustrations', 1],
      ['knowledge', 3],
      ['community_research', 6],
      ['schema_reference', 4],
      ['directory', 9],
      ['brand_registry', 10],
      ['agent_validation', 12],
      ['property_catalog', 9],
    ] as const)('keeps %s at twelve tools or fewer', (name, expectedCount) => {
      expect(TOOL_SETS[name].tools).toHaveLength(expectedCount);
      expect(TOOL_SETS[name].tools.length).toBeLessThanOrEqual(12);
    });

    it('preserves the exact legacy member surface without exposing it to new router plans', () => {
      expect(MEMBER_PROFILE_TOOLS).toHaveLength(7);
      expect(COMMUNITY_GROUP_TOOLS).toHaveLength(11);
      expect(LEGACY_MEMBER_TOOLS).toHaveLength(21);
      expect(new Set(LEGACY_MEMBER_TOOLS).size).toBe(21);
      expect(TOOL_SETS.member.tools).toEqual(LEGACY_MEMBER_TOOLS);
      expect(TOOL_SETS.member.routerVisible).toBe(false);
      expect(getValidToolSetNames(false).has('member')).toBe(false);
      expect(getValidToolSetNames(false).has('member_profile')).toBe(true);
      expect(getValidToolSetNames(false).has('community_groups')).toBe(true);
    });

    it('keeps profile, community-group, and publishing workflows isolated', () => {
      const profile = getToolsForSets(['member_profile'], false, false);
      const groups = getToolsForSets(['community_groups'], false, false);
      const publishing = getToolsForSets(['publishing'], false, false);

      expect(profile).toContain('get_my_profile');
      expect(profile).not.toContain('join_working_group');
      expect(profile).not.toContain('draft_social_posts');
      expect(groups).toContain('join_working_group');
      expect(groups).toContain('bookmark_resource');
      expect(groups).not.toContain('get_my_profile');
      expect(groups).not.toContain('attach_content_asset');
      expect(publishing).toContain('list_perspectives');
      expect(publishing).toContain('attach_content_asset');
      expect(publishing).toContain('draft_social_posts');
      expect(publishing).not.toContain('get_my_profile');
      expect(publishing).not.toContain('join_working_group');
    });

    it('keeps the legacy member set callable only as a continuity shim', () => {
      const tools = getToolsForSets(['member'], false, false);
      expect(tools).toEqual(expect.arrayContaining([
        'get_my_profile',
        'join_working_group',
        'draft_social_posts',
      ]));
      expect(buildUnavailableSetsHint([], false)).not.toContain('**member**');
      expect(ADDIE_TOOL_CATALOG).toContain('- **member_profile**');
      expect(ADDIE_TOOL_CATALOG).toContain('- **community_groups**');
      expect(ADDIE_TOOL_CATALOG).not.toContain('- **member**');
    });

    it('routes GitHub issue tools without exposing them globally', () => {
      const routed = getToolsForSets(['github'], false, false);
      expect(routed).toEqual(expect.arrayContaining([
        'draft_github_issue',
        'create_github_issue',
        'get_github_issue',
      ]));
      expect(getToolsForSets(['knowledge'], false, false)).not.toContain('draft_github_issue');
    });

    it('keeps protocol, community, and schema retrieval in separate domains', () => {
      const knowledge = getToolsForSets(['knowledge'], false, false);
      const community = getToolsForSets(['community_research'], false, false);
      const schemas = getToolsForSets(['schema_reference'], false, false);

      expect(knowledge).toContain('search_docs');
      expect(knowledge).not.toContain('search_slack');
      expect(knowledge).not.toContain('validate_json');
      expect(community).toContain('search_slack');
      expect(community).not.toContain('search_docs');
      expect(schemas).toContain('validate_json');
      expect(schemas).not.toContain('search_docs');
    });

    it('preserves safe pre-split research tools when routing is unavailable', () => {
      const fallback = getToolsForSets(
        [...SAFE_KNOWLEDGE_FALLBACK_TOOL_SETS],
        false,
        false,
      );

      expect(fallback).toContain('search_docs');
      expect(fallback).toContain('search_slack');
      expect(fallback).toContain('validate_json');
      expect(fallback).not.toContain('draft_github_issue');
      expect(fallback).not.toContain('create_github_issue');
    });

    it('cuts the global member surface to six escape hatches', () => {
      expect(ALWAYS_AVAILABLE_TOOLS).toHaveLength(6);
    });
  });

  describe('ALWAYS_AVAILABLE overlap invariant', () => {
    it('no always-available tool (regular or admin) appears in any set tools array', () => {
      // If a guaranteed tool is also in a set's tools array, that set's
      // description will (by construction) describe that capability. When the
      // set appears in the unavailable-sets hint, Sonnet reads the description
      // and hallucinates that the capability is off — even though the tool is
      // loaded via ALWAYS_AVAILABLE_TOOLS or ALWAYS_AVAILABLE_ADMIN_TOOLS.
      // Keeping these arrays disjoint is the only way to prevent that class of
      // hallucination. See #2998.
      const always = new Set([...ALWAYS_AVAILABLE_TOOLS, ...ALWAYS_AVAILABLE_ADMIN_TOOLS]);
      for (const [setName, set] of Object.entries(TOOL_SETS)) {
        for (const tool of set.tools) {
          expect(
            always.has(tool),
            `${setName}.tools contains "${tool}" which is also in ALWAYS_AVAILABLE_TOOLS or ALWAYS_AVAILABLE_ADMIN_TOOLS. ` +
            `Remove it from the set's tools array — it is already guaranteed and duplicating it ` +
            `causes Sonnet to hallucinate unavailability from set descriptions.`,
          ).toBe(false);
        }
      }
    });
  });
});

describe('buildUnavailableSetsHint', () => {
  it('returns empty when all sets are selected', () => {
    const allSets = Object.keys(TOOL_SETS);
    expect(buildUnavailableSetsHint(allSets, true)).toBe('');
  });

  it('lists an always-available escape-hatch section when sets are unavailable', () => {
    const hint = buildUnavailableSetsHint(['knowledge'], false);
    expect(hint).toContain('Always Available');
    expect(hint).toContain('escalate_to_admin');
  });

  it('describes GitHub issue filing only in the GitHub domain', () => {
    const hint = buildUnavailableSetsHint(['knowledge'], false);
    const contentSection = hint.match(/- \*\*content\*\*:[^\n]*/)?.[0] ?? '';
    expect(contentSection).not.toMatch(/github issue/i);
    expect(hint).toMatch(/- \*\*github\*\*:.*GitHub issue/i);
  });

  it('never advertises tools that are not actually in ALWAYS_AVAILABLE_TOOLS (drift guard)', () => {
    const hint = buildUnavailableSetsHint(['knowledge'], false);
    // Extract tool names from the "Always Available" section: lines of the
    // form `- <tool_name> — blurb`.
    const section = hint.split('## Capabilities That ARE Always Available')[1] ?? '';
    const advertised = [...section.matchAll(/^- (\w+) — /gm)].map((m) => m[1]);
    expect(advertised.length).toBeGreaterThan(0);
    for (const tool of advertised) {
      expect(
        ALWAYS_AVAILABLE_TOOLS,
        `Hint advertised "${tool}" as always-available but it is not in ALWAYS_AVAILABLE_TOOLS`,
      ).toContain(tool);
    }
  });
});
