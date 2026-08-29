import { describe, it, expect } from 'vitest';
import { ADDIE_TOOL_CATALOG } from '../../../src/addie/generated/tool-catalog.generated.js';
import {
  ADMIN_DOMAIN_TOOL_SETS,
  ALWAYS_AVAILABLE_ADMIN_TOOLS,
  ALWAYS_AVAILABLE_TOOLS,
  LEGACY_ADMIN_TOOLS,
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

  describe('property catalog workflow', () => {
    it('routes the complete audit, enrichment, catalog, and dispute surface', () => {
      expect(getToolsForSets(['agent_testing'], false, false)).toEqual(
        expect.arrayContaining([
          'check_property_list',
          'enhance_property',
          'resolve_catalog',
          'browse_catalog',
          'dispute_catalog_entry',
        ]),
      );
    });
  });

  describe('brand canonical-document workflow', () => {
    it('routes the complete publish, reciprocity, notification, and logo surface', () => {
      expect(getToolsForSets(['directory'], false, false)).toEqual(
        expect.arrayContaining([
          'upload_brand_logo',
          'publish_brand_canonical_document',
          'add_to_brand_refs',
          'check_mutual_assertion',
          'notify_pending_verification',
        ]),
      );
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
      ['publishing', 9],
      ['github', 3],
      ['illustrations', 1],
    ] as const)('keeps %s at twelve tools or fewer', (name, expectedCount) => {
      expect(TOOL_SETS[name].tools).toHaveLength(expectedCount);
      expect(TOOL_SETS[name].tools.length).toBeLessThanOrEqual(12);
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
