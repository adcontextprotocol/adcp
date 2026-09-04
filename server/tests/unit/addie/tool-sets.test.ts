import { describe, it, expect } from 'vitest';
import { ADDIE_TOOL_CATALOG } from '../../../src/addie/generated/tool-catalog.generated.js';
import {
  AGENT_AUTHENTICATION_TOOLS,
  AGENT_END_TO_END_TOOLS,
  AGENT_QUALITY_TOOLS,
  AGENT_REGISTRY_TOOLS,
  AGENT_VALIDATION_TOOLS,
  ADMIN_BILLING_ACCOUNT_TOOLS,
  ADMIN_BILLING_DISCOUNT_TOOLS,
  ADMIN_BILLING_DOMAIN_TOOL_SETS,
  ADMIN_BILLING_PAYMENT_TOOLS,
  ADMIN_BILLING_TOOLS,
  ADMIN_BRAND_LOGO_REVIEW_TOOLS,
  ADMIN_BRAND_REGISTRY_INTEGRITY_TOOLS,
  ADMIN_BRANDS_TOOLS,
  ADMIN_DOMAIN_TOOL_SETS,
  ADMIN_ORGANIZATION_INTEGRITY_TOOLS,
  ADMIN_ORGANIZATION_MEMBER_RECORDS_TOOLS,
  ADMIN_ORGANIZATIONS_TOOLS,
  ADMIN_PROSPECT_DOMAIN_TOOL_SETS,
  ADMIN_PROSPECT_PIPELINE_TOOLS,
  ADMIN_PROSPECT_RESEARCH_TOOLS,
  ADMIN_PROSPECTS_TOOLS,
  AGENT_PUBLISHER_DIRECTORY_TOOLS,
  ALWAYS_AVAILABLE_ADMIN_TOOLS,
  ALWAYS_AVAILABLE_TOOLS,
  BRAND_REGISTRY_IDENTITY_TOOLS,
  BRAND_REGISTRY_RECORDS_TOOLS,
  BRAND_REGISTRY_TOOLS,
  CERTIFICATION_ASSESSMENT_TOOLS,
  CERTIFICATION_LEARNING_TOOLS,
  CERTIFICATION_OVERVIEW_TOOLS,
  COMMUNITY_GROUP_CONTRIBUTION_TOOLS,
  COMMUNITY_GROUP_DISCOVERY_TOOLS,
  COMMUNITY_GROUP_FULL_PARTICIPATION_TOOLS,
  COMMUNITY_GROUP_MEMBERSHIP_TOOLS,
  COMMUNITY_GROUP_TOOLS,
  COUNCIL_INTEREST_TOOLS,
  DIRECTORY_COMPATIBILITY_TOOLS,
  MEMBER_PROFILE_TOOLS,
  MEETING_ATTENDANCE_TOOLS,
  MEETING_FULL_ADMINISTRATION_TOOLS,
  MEETING_SCHEDULING_TOOLS,
  MEETING_SERIES_TOPIC_TOOLS,
  MEETING_TOOLS,
  PARTNER_DIRECTORY_TOOLS,
  PUBLISHING_AUTHOR_TOOLS,
  PUBLISHING_PROMOTION_TOOLS,
  PUBLISHING_REVIEW_TOOLS,
  PROPERTY_CATALOG_TOOLS,
  PROPERTY_IDENTIFIER_CATALOG_TOOLS,
  PROPERTY_LIST_ENRICHMENT_TOOLS,
  PROPERTY_REGISTRY_RECORD_TOOLS,
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

    it('withholds admin escalation records from public channels', () => {
      const tools = getToolsForSets(['knowledge'], true, true);
      expect(tools).not.toContain('resolve_escalation');
      expect(tools).not.toContain('list_escalations');
    });
  });

  describe('bounded admin domains', () => {
    it('keeps every router-visible admin domain at twelve tools or fewer', () => {
      for (const [name, tools] of Object.entries(ADMIN_DOMAIN_TOOL_SETS)) {
        expect(tools.length, name).toBeLessThanOrEqual(12);
        expect(TOOL_SETS[name].tools).toEqual(tools);
      }
    });

    it('keeps admin group operations in their bounded domains', () => {
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

    it('loads only the selected prospect domain and rejects it for non-admins', () => {
      const pipelineTools = getToolsForSets(['admin_prospect_pipeline'], true, false);
      expect(pipelineTools).toContain('query_prospects');
      expect(pipelineTools).not.toContain('enrich_company');
      expect(pipelineTools).not.toContain('merge_organizations');

      const researchTools = getToolsForSets(['admin_prospect_research'], true, false);
      expect(researchTools).toContain('enrich_company');
      expect(researchTools).not.toContain('query_prospects');

      const memberTools = getToolsForSets(['admin_prospect_pipeline'], false, false);
      expect(memberTools).not.toContain('query_prospects');
    });

    it('generates the compact catalog from router-visible domains only', () => {
      expect(ADDIE_TOOL_CATALOG).toContain('- **admin_prospect_pipeline**');
      expect(ADDIE_TOOL_CATALOG).toContain('- **admin_prospect_research**');
      expect(ADDIE_TOOL_CATALOG).not.toContain('- **admin_prospects**');
      expect(ADDIE_TOOL_CATALOG).toContain('- **admin_organization_integrity**');
      expect(ADDIE_TOOL_CATALOG).toContain('- **admin_organization_member_records**');
      expect(ADDIE_TOOL_CATALOG).not.toContain('- **admin_organizations**');
      expect(ADDIE_TOOL_CATALOG).toContain('- **admin_brand_registry_integrity**');
      expect(ADDIE_TOOL_CATALOG).toContain('- **admin_brand_logo_review**');
      expect(ADDIE_TOOL_CATALOG).not.toContain('- **admin_brands**');
      expect(ADDIE_TOOL_CATALOG).toContain('- **admin_billing_payments**');
      expect(ADDIE_TOOL_CATALOG).toContain('- **admin_billing_discounts**');
      expect(ADDIE_TOOL_CATALOG).toContain('- **admin_billing_account**');
      expect(ADDIE_TOOL_CATALOG).not.toContain('- **billing**');
      expect(ADDIE_TOOL_CATALOG).toContain('- **brand_registry_records**');
      expect(ADDIE_TOOL_CATALOG).toContain('- **brand_registry_identity**');
      expect(ADDIE_TOOL_CATALOG).not.toContain('- **brand_registry**');
      expect(ADDIE_TOOL_CATALOG).toContain('- **partner_directory**');
      expect(ADDIE_TOOL_CATALOG).toContain('- **agent_publisher_directory**');
      expect(ADDIE_TOOL_CATALOG).not.toContain('- **directory**');
      expect(ADDIE_TOOL_CATALOG).toContain('- **admin_group_structure**');
      expect(ADDIE_TOOL_CATALOG).toContain('- **admin_group_leadership**');
      expect(ADDIE_TOOL_CATALOG).toContain('- **admin_group_membership**');
      expect(ADDIE_TOOL_CATALOG).toContain('- **publishing_author**');
      expect(ADDIE_TOOL_CATALOG).toContain('- **publishing_review**');
      expect(ADDIE_TOOL_CATALOG).toContain('- **publishing_promotion**');
      expect(ADDIE_TOOL_CATALOG).toContain('- **certification_overview**');
      expect(ADDIE_TOOL_CATALOG).toContain('- **certification_learning**');
      expect(ADDIE_TOOL_CATALOG).toContain('- **certification_assessment**');
    });

    it('keeps organization integrity and member records separate while retaining the exact hidden alias', () => {
      expect(ADMIN_ORGANIZATION_INTEGRITY_TOOLS).toEqual([
        'merge_organizations', 'find_duplicate_orgs', 'check_domain_health', 'manage_organization_domains',
      ]);
      expect(ADMIN_ORGANIZATION_MEMBER_RECORDS_TOOLS).toEqual([
        'update_org_member_role', 'list_slack_users_by_org', 'list_paying_members', 'update_member_logo', 'update_member_profile',
      ]);
      expect(ADMIN_ORGANIZATIONS_TOOLS).toEqual([
        ...ADMIN_ORGANIZATION_INTEGRITY_TOOLS,
        ...ADMIN_ORGANIZATION_MEMBER_RECORDS_TOOLS,
      ]);
      expect(ADMIN_ORGANIZATIONS_TOOLS).toHaveLength(9);
      expect(TOOL_SETS.admin_organizations.tools).toEqual(ADMIN_ORGANIZATIONS_TOOLS);
      expect(TOOL_SETS.admin_organizations.routerVisible).toBe(false);
      expect(getValidToolSetNames(true).has('admin_organizations')).toBe(false);
      for (const name of ['admin_organization_integrity', 'admin_organization_member_records']) {
        expect(getValidToolSetNames(true).has(name), name).toBe(true);
        expect(getValidToolSetNames(false).has(name), name).toBe(false);
      }
      expect(getToolsForSets(['admin_organization_integrity'], true, false)).toEqual(
        expect.arrayContaining(ADMIN_ORGANIZATION_INTEGRITY_TOOLS),
      );
      expect(getToolsForSets(['admin_organization_integrity'], true, false)).not.toEqual(
        expect.arrayContaining(['update_org_member_role', 'list_paying_members']),
      );
      expect(getToolsForSets(['admin_organization_member_records'], true, false)).toEqual(
        expect.arrayContaining(ADMIN_ORGANIZATION_MEMBER_RECORDS_TOOLS),
      );
      expect(getToolsForSets(['admin_organization_member_records'], true, false)).not.toEqual(
        expect.arrayContaining(['merge_organizations', 'check_domain_health']),
      );
      expect(getToolsForSets(['admin_organizations'], true, false)).toEqual(
        expect.arrayContaining(ADMIN_ORGANIZATIONS_TOOLS),
      );
      expect(getToolsForSets(['admin_organization_member_records'], false, false)).not.toEqual(
        expect.arrayContaining(ADMIN_ORGANIZATION_MEMBER_RECORDS_TOOLS),
      );
    });

    it('keeps brand-registry integrity and logo review separate while retaining the exact hidden alias', () => {
      expect(ADMIN_BRAND_REGISTRY_INTEGRITY_TOOLS).toEqual([
        'list_missing_brands', 'list_missing_properties', 'list_pending_community_mirrors',
        'transfer_brand_ownership', 'list_orphaned_brands',
      ]);
      expect(ADMIN_BRAND_LOGO_REVIEW_TOOLS).toEqual([
        'list_pending_brand_logos', 'list_brand_logos', 'review_brand_logo',
      ]);
      expect(ADMIN_BRANDS_TOOLS).toEqual([
        'list_missing_brands', 'list_missing_properties', 'list_pending_brand_logos', 'list_brand_logos',
        'review_brand_logo', 'list_pending_community_mirrors', 'transfer_brand_ownership', 'list_orphaned_brands',
      ]);
      expect(ADMIN_BRANDS_TOOLS).toHaveLength(8);
      expect(TOOL_SETS.admin_brands.tools).toEqual(ADMIN_BRANDS_TOOLS);
      expect(TOOL_SETS.admin_brands.routerVisible).toBe(false);
      expect(getValidToolSetNames(true).has('admin_brands')).toBe(false);
      for (const name of ['admin_brand_registry_integrity', 'admin_brand_logo_review']) {
        expect(getValidToolSetNames(true).has(name), name).toBe(true);
        expect(getValidToolSetNames(false).has(name), name).toBe(false);
      }
      expect(getToolsForSets(['admin_brand_registry_integrity'], true, false)).toEqual(
        expect.arrayContaining(ADMIN_BRAND_REGISTRY_INTEGRITY_TOOLS),
      );
      expect(getToolsForSets(['admin_brand_registry_integrity'], true, false)).not.toEqual(
        expect.arrayContaining(ADMIN_BRAND_LOGO_REVIEW_TOOLS),
      );
      expect(getToolsForSets(['admin_brand_logo_review'], true, false)).toEqual(
        expect.arrayContaining(ADMIN_BRAND_LOGO_REVIEW_TOOLS),
      );
      expect(getToolsForSets(['admin_brand_logo_review'], true, false)).not.toEqual(
        expect.arrayContaining(ADMIN_BRAND_REGISTRY_INTEGRITY_TOOLS),
      );
      expect(getToolsForSets(['admin_brands'], true, false)).toEqual(
        expect.arrayContaining(ADMIN_BRANDS_TOOLS),
      );
      expect(getToolsForSets(['admin_brand_logo_review'], false, false)).not.toEqual(
        expect.arrayContaining(ADMIN_BRAND_LOGO_REVIEW_TOOLS),
      );
    });

    it('keeps admin billing workflows separate while retaining the exact hidden alias', () => {
      expect(ADMIN_BILLING_PAYMENT_TOOLS).toEqual([
        'send_payment_request', 'resend_invoice', 'list_pending_invoices',
      ]);
      expect(ADMIN_BILLING_DISCOUNT_TOOLS).toEqual([
        'grant_discount', 'remove_discount', 'list_discounts', 'create_promotion_code',
      ]);
      expect(ADMIN_BILLING_ACCOUNT_TOOLS).toEqual([
        'update_billing_email', 'preview_org_stripe_customer_update',
        'confirm_org_stripe_customer_update', 'get_account',
      ]);
      expect(ADMIN_BILLING_TOOLS).toEqual([
        'send_payment_request', 'grant_discount', 'remove_discount', 'list_discounts',
        'create_promotion_code', 'resend_invoice', 'update_billing_email',
        'preview_org_stripe_customer_update', 'confirm_org_stripe_customer_update',
        'list_pending_invoices', 'get_account',
      ]);
      expect(TOOL_SETS.billing.tools).toEqual(ADMIN_BILLING_TOOLS);
      expect(TOOL_SETS.billing.routerVisible).toBe(false);
      expect(getValidToolSetNames(true).has('billing')).toBe(false);
      for (const [name, domainTools] of Object.entries(ADMIN_BILLING_DOMAIN_TOOL_SETS)) {
        expect(getValidToolSetNames(true).has(name), name).toBe(true);
        expect(getValidToolSetNames(false).has(name), name).toBe(false);
        expect(getToolsForSets([name], true, false)).toEqual(expect.arrayContaining(domainTools));
        expect(TOOL_SETS[name].requiresPrecision).toBe(true);
      }
      expect(getToolsForSets(['admin_billing_payments'], true, false)).not.toEqual(
        expect.arrayContaining(ADMIN_BILLING_DISCOUNT_TOOLS),
      );
      expect(getToolsForSets(['admin_billing_discounts'], true, false)).not.toEqual(
        expect.arrayContaining(ADMIN_BILLING_ACCOUNT_TOOLS),
      );
      expect(getToolsForSets(['admin_billing_account'], true, false)).not.toEqual(
        expect.arrayContaining(ADMIN_BILLING_PAYMENT_TOOLS),
      );
      expect(getToolsForSets(['billing'], true, false)).toEqual(
        expect.arrayContaining(ADMIN_BILLING_TOOLS),
      );
    });

    it('keeps prospect records and research separate while retaining the exact hidden alias', () => {
      expect(ADMIN_PROSPECT_PIPELINE_TOOLS).toEqual([
        'add_prospect', 'update_prospect', 'query_prospects', 'claim_prospect',
      ]);
      expect(ADMIN_PROSPECT_RESEARCH_TOOLS).toEqual([
        'enrich_company', 'prospect_search_lusha', 'triage_prospect_domain', 'suggest_prospects',
      ]);
      expect(ADMIN_PROSPECTS_TOOLS).toEqual([
        'add_prospect', 'update_prospect', 'enrich_company', 'query_prospects',
        'prospect_search_lusha', 'claim_prospect', 'triage_prospect_domain', 'suggest_prospects',
      ]);
      expect(TOOL_SETS.admin_prospects.tools).toEqual(ADMIN_PROSPECTS_TOOLS);
      expect(TOOL_SETS.admin_prospects.routerVisible).toBe(false);
      expect(getValidToolSetNames(true).has('admin_prospects')).toBe(false);
      for (const [name, domainTools] of Object.entries(ADMIN_PROSPECT_DOMAIN_TOOL_SETS)) {
        expect(getValidToolSetNames(true).has(name), name).toBe(true);
        expect(getValidToolSetNames(false).has(name), name).toBe(false);
        expect(getToolsForSets([name], true, false)).toEqual(expect.arrayContaining(domainTools));
      }
      expect(getToolsForSets(['admin_prospect_pipeline'], true, false)).not.toEqual(
        expect.arrayContaining(ADMIN_PROSPECT_RESEARCH_TOOLS),
      );
      expect(getToolsForSets(['admin_prospect_research'], true, false)).not.toEqual(
        expect.arrayContaining(ADMIN_PROSPECT_PIPELINE_TOOLS),
      );
      expect(getToolsForSets(['admin_prospects'], true, false)).toEqual(
        expect.arrayContaining(ADMIN_PROSPECTS_TOOLS),
      );
    });
  });

  describe('certification workflow', () => {
    it('keeps overview, learning, and assessment workflows bounded', () => {
      expect(CERTIFICATION_OVERVIEW_TOOLS).toHaveLength(5);
      expect(CERTIFICATION_LEARNING_TOOLS).toHaveLength(10);
      expect(CERTIFICATION_ASSESSMENT_TOOLS).toHaveLength(9);
      expect(CERTIFICATION_OVERVIEW_TOOLS).toContain('list_certification_tracks');
      expect(CERTIFICATION_OVERVIEW_TOOLS).not.toContain('start_certification_module');
      expect(CERTIFICATION_LEARNING_TOOLS).toContain('get_build_phase_instructions');
      expect(CERTIFICATION_LEARNING_TOOLS).not.toContain('start_certification_exam');
      expect(CERTIFICATION_ASSESSMENT_TOOLS).toContain('start_certification_exam');
      expect(CERTIFICATION_ASSESSMENT_TOOLS).not.toContain('complete_certification_module');
    });

    it('preserves completion prerequisites and recovery pairs on each mutating workflow', () => {
      for (const name of ['certification_learning', 'certification_assessment']) {
        const tools = getToolsForSets([name], false, false);
        expect(tools).toEqual(expect.arrayContaining([
          'get_learner_progress',
          'check_credentials',
          'checkpoint_teaching_progress',
          'set_my_name',
          'find_membership_products',
          'call_adcp_task',
        ]));
      }
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
    it('keeps property registry, list enrichment, and identifier catalog workflows isolated', () => {
      expect(PROPERTY_REGISTRY_RECORD_TOOLS).toEqual([
        'resolve_property', 'save_property', 'list_properties', 'list_missing_properties',
      ]);
      expect(PROPERTY_LIST_ENRICHMENT_TOOLS).toEqual([
        'check_property_list', 'enhance_property',
      ]);
      expect(PROPERTY_IDENTIFIER_CATALOG_TOOLS).toEqual([
        'resolve_catalog', 'browse_catalog', 'dispute_catalog_entry',
      ]);
      expect(PROPERTY_CATALOG_TOOLS).toEqual([
        ...PROPERTY_REGISTRY_RECORD_TOOLS,
        ...PROPERTY_LIST_ENRICHMENT_TOOLS,
        ...PROPERTY_IDENTIFIER_CATALOG_TOOLS,
      ]);
      expect(PROPERTY_REGISTRY_RECORD_TOOLS.filter((tool) => new Set<string>(PROPERTY_LIST_ENRICHMENT_TOOLS).has(tool))).toEqual([]);
      expect(PROPERTY_REGISTRY_RECORD_TOOLS.filter((tool) => new Set<string>(PROPERTY_IDENTIFIER_CATALOG_TOOLS).has(tool))).toEqual([]);
      expect(PROPERTY_LIST_ENRICHMENT_TOOLS.filter((tool) => new Set<string>(PROPERTY_IDENTIFIER_CATALOG_TOOLS).has(tool))).toEqual([]);
    });

    it('keeps registry, quality, authentication, and property workflows isolated', () => {
      const registry = getToolsForSets(['agent_registry'], false, false);
      const quality = getToolsForSets(['agent_quality'], false, false);
      const authentication = getToolsForSets(['agent_authentication'], false, false);
      const endToEnd = getToolsForSets(['agent_end_to_end'], false, false);
      const propertyRecords = getToolsForSets(['property_registry_records'], false, false);
      const propertyList = getToolsForSets(['property_list_enrichment'], false, false);
      const propertyCatalog = getToolsForSets(['property_identifier_catalog'], false, false);

      expect(registry).toEqual(expect.arrayContaining([
        'validate_adagents',
        'check_publisher_authorization',
        'validate_agent',
      ]));
      expect(registry).not.toContain('evaluate_agent_quality');
      expect(registry).not.toContain('diagnose_agent_auth');
      expect(quality).toEqual(expect.arrayContaining([
        'evaluate_agent_quality',
        'test_rfp_response',
        'test_io_execution',
      ]));
      expect(quality).not.toContain('test_adcp_agent');
      expect(quality).not.toContain('compare_media_kit');
      expect(authentication).toEqual(expect.arrayContaining([
        'grade_agent_signing',
        'diagnose_agent_auth',
      ]));
      expect(authentication).not.toContain('evaluate_agent_quality');
      expect(endToEnd).toEqual(expect.arrayContaining([
        ...AGENT_REGISTRY_TOOLS,
        ...AGENT_QUALITY_TOOLS,
        ...AGENT_AUTHENTICATION_TOOLS,
      ]));
      expect(endToEnd).not.toContain('test_adcp_agent');
      expect(endToEnd).not.toContain('compare_media_kit');
      expect(propertyRecords).toContain('resolve_property');
      expect(propertyRecords).not.toContain('check_property_list');
      expect(propertyList).toContain('enhance_property');
      expect(propertyList).not.toContain('browse_catalog');
      expect(propertyCatalog).toContain('dispute_catalog_entry');
      expect(propertyCatalog).not.toContain('resolve_property');
      for (const propertyTools of [propertyRecords, propertyList, propertyCatalog]) {
        expect(propertyTools).not.toContain('evaluate_agent_quality');
        expect(propertyTools).not.toContain('diagnose_agent_auth');
      }
    });

    it('keeps narrow agent routes visible and the exact legacy union hidden', () => {
      expect(AGENT_REGISTRY_TOOLS).toEqual([
        'validate_adagents', 'resolve_brand', 'get_agent_status',
        'check_publisher_authorization', 'validate_agent',
      ]);
      expect(AGENT_QUALITY_TOOLS).toEqual([
        'evaluate_agent_quality', 'test_rfp_response', 'test_io_execution',
      ]);
      expect(AGENT_AUTHENTICATION_TOOLS).toEqual([
        'grade_agent_signing', 'diagnose_agent_auth',
      ]);
      expect(AGENT_END_TO_END_TOOLS).toEqual([
        ...AGENT_REGISTRY_TOOLS,
        ...AGENT_QUALITY_TOOLS,
        ...AGENT_AUTHENTICATION_TOOLS,
      ]);
      expect(AGENT_VALIDATION_TOOLS).toEqual([
        'validate_adagents', 'resolve_brand', 'get_agent_status',
        'check_publisher_authorization', 'test_adcp_agent',
        'evaluate_agent_quality', 'grade_agent_signing', 'diagnose_agent_auth',
        'compare_media_kit', 'test_rfp_response', 'test_io_execution', 'validate_agent',
      ]);
      expect(TOOL_SETS.property_catalog.tools).toEqual(PROPERTY_CATALOG_TOOLS);
      expect(TOOL_SETS.property_catalog.routerVisible).toBe(false);
      expect(TOOL_SETS.agent_validation.tools).toEqual(AGENT_VALIDATION_TOOLS);
      expect(TOOL_SETS.agent_validation.routerVisible).toBe(false);
      expect(getValidToolSetNames(false).has('agent_validation')).toBe(false);
      expect(getValidToolSetNames(false).has('agent_registry')).toBe(true);
      expect(getValidToolSetNames(false).has('agent_quality')).toBe(true);
      expect(getValidToolSetNames(false).has('agent_authentication')).toBe(true);
      expect(getValidToolSetNames(false).has('agent_end_to_end')).toBe(true);
      expect(getValidToolSetNames(false).has('property_catalog')).toBe(false);
      expect(getValidToolSetNames(false).has('property_registry_records')).toBe(true);
      expect(getValidToolSetNames(false).has('property_list_enrichment')).toBe(true);
      expect(getValidToolSetNames(false).has('property_identifier_catalog')).toBe(true);

      expect(getToolsForSets(['property_registry_records'], false, false)).toHaveLength(10);
      expect(getToolsForSets(['property_list_enrichment'], false, false)).toHaveLength(8);
      expect(getToolsForSets(['property_identifier_catalog'], false, false)).toHaveLength(9);
      expect(getToolsForSets(['property_registry_records'], true, false)).toHaveLength(12);
      expect(getToolsForSets(['property_list_enrichment'], true, false)).toHaveLength(10);
      expect(getToolsForSets(['property_identifier_catalog'], true, false)).toHaveLength(11);
    });

    it.each(['agent_registry', 'agent_quality', 'agent_authentication', 'agent_end_to_end'] as const)(
      'keeps %s available to members and admins without exposing deprecated aliases',
      (setName) => {
        const member = getToolsForSets([setName], false, false);
        const admin = getToolsForSets([setName], true, false);
        for (const tool of TOOL_SETS[setName].tools) {
          expect(member).toContain(tool);
          expect(admin).toContain(tool);
        }
        expect(member).not.toContain('test_adcp_agent');
        expect(member).not.toContain('compare_media_kit');
        expect(admin).not.toContain('test_adcp_agent');
        expect(admin).not.toContain('compare_media_kit');
      },
    );
  });

  describe('bounded meeting domains', () => {
    it('keeps scheduling, attendance, and recurring-topic workflows small while retaining the exact hidden legacy union', () => {
      expect(MEETING_ATTENDANCE_TOOLS).toEqual([
        'list_upcoming_meetings', 'get_my_meetings', 'get_meeting_details',
        'rsvp_to_meeting', 'add_meeting_attendee',
      ]);
      expect(MEETING_SCHEDULING_TOOLS).toEqual([
        'schedule_meeting', 'list_upcoming_meetings', 'cancel_meeting', 'update_meeting',
      ]);
      expect(MEETING_SERIES_TOPIC_TOOLS).toEqual([
        'list_upcoming_meetings', 'cancel_meeting_series', 'update_topic_subscriptions',
        'manage_committee_topics',
      ]);
      expect(MEETING_TOOLS).toEqual([
        'schedule_meeting', 'list_upcoming_meetings', 'get_my_meetings',
        'get_meeting_details', 'rsvp_to_meeting', 'cancel_meeting',
        'cancel_meeting_series', 'update_meeting', 'add_meeting_attendee',
        'update_topic_subscriptions', 'manage_committee_topics',
      ]);
      expect(MEETING_FULL_ADMINISTRATION_TOOLS).toEqual(MEETING_TOOLS);
      expect(MEETING_TOOLS).toBe(MEETING_FULL_ADMINISTRATION_TOOLS);
      expect(TOOL_SETS.meetings.tools).toEqual(MEETING_TOOLS);
      expect(TOOL_SETS.meetings.routerVisible).toBe(false);
      expect(getValidToolSetNames(false).has('meetings')).toBe(false);
      for (const name of [
        'meeting_attendance', 'meeting_scheduling', 'meeting_series_topics', 'meeting_full_administration',
      ]) {
        expect(getValidToolSetNames(false).has(name), name).toBe(true);
        expect(TOOL_SETS[name].tools.length, name).toBeLessThanOrEqual(11);
      }
    });

    it('keeps the read-before-mutation tool paired with each applicable meeting workflow', () => {
      expect(getToolsForSets(['meeting_attendance'], false, false)).toEqual(expect.arrayContaining([
        'list_upcoming_meetings', 'add_meeting_attendee',
      ]));
      expect(getToolsForSets(['meeting_scheduling'], false, false)).toEqual(expect.arrayContaining([
        'list_upcoming_meetings', 'cancel_meeting', 'update_meeting',
      ]));
      expect(getToolsForSets(['meeting_series_topics'], false, false)).toEqual(expect.arrayContaining([
        'list_upcoming_meetings', 'cancel_meeting_series',
      ]));
    });
  });

  describe('brand canonical-document workflow', () => {
    it('keeps registry records and identity verification separate while retaining the exact hidden alias', () => {
      expect(BRAND_REGISTRY_RECORDS_TOOLS).toEqual([
        'research_brand', 'resolve_brand', 'save_brand', 'list_brands', 'list_missing_brands',
      ]);
      expect(BRAND_REGISTRY_IDENTITY_TOOLS).toEqual([
        'upload_brand_logo', 'publish_brand_canonical_document', 'add_to_brand_refs',
        'check_mutual_assertion', 'notify_pending_verification',
      ]);
      expect(BRAND_REGISTRY_TOOLS).toEqual([
        'research_brand', 'resolve_brand', 'save_brand', 'list_brands', 'list_missing_brands',
        'upload_brand_logo', 'publish_brand_canonical_document', 'add_to_brand_refs',
        'check_mutual_assertion', 'notify_pending_verification',
      ]);
      expect(TOOL_SETS.brand_registry.tools).toEqual(BRAND_REGISTRY_TOOLS);
      expect(TOOL_SETS.brand_registry.routerVisible).toBe(false);
      expect(getValidToolSetNames(false).has('brand_registry')).toBe(false);
      expect(getValidToolSetNames(false).has('brand_registry_records')).toBe(true);
      expect(getValidToolSetNames(false).has('brand_registry_identity')).toBe(true);
      expect(getToolsForSets(['brand_registry_records'], false, false)).toEqual(
        expect.arrayContaining(BRAND_REGISTRY_RECORDS_TOOLS),
      );
      expect(getToolsForSets(['brand_registry_records'], false, false).filter((name) =>
        (BRAND_REGISTRY_IDENTITY_TOOLS as readonly string[]).includes(name),
      )).toEqual([]);
      expect(getToolsForSets(['brand_registry_identity'], false, false)).toEqual(
        expect.arrayContaining(BRAND_REGISTRY_IDENTITY_TOOLS),
      );
      expect(getToolsForSets(['brand_registry_identity'], false, false).filter((name) =>
        (BRAND_REGISTRY_RECORDS_TOOLS as readonly string[]).includes(name),
      )).toEqual([]);
      expect(getToolsForSets(['brand_registry'], false, false)).toEqual(
        expect.arrayContaining(BRAND_REGISTRY_TOOLS),
      );
      expect(getToolsForSets(['directory'], false, false)).not.toContain('save_brand');
      expect(getToolsForSets(['directory'], false, false)).not.toContain('publish_brand_canonical_document');
    });
  });

  describe('authenticated directory workflow', () => {
    it('keeps partner and agent-publisher lookups separate while retaining the exact hidden alias', () => {
      expect(PARTNER_DIRECTORY_TOOLS).toEqual([
        'search_members', 'request_introduction', 'get_my_search_analytics', 'list_members', 'get_member',
      ]);
      expect(AGENT_PUBLISHER_DIRECTORY_TOOLS).toEqual([
        'list_agents', 'get_agent', 'list_publishers', 'lookup_domain',
      ]);
      expect(DIRECTORY_COMPATIBILITY_TOOLS).toEqual([
        ...PARTNER_DIRECTORY_TOOLS,
        ...AGENT_PUBLISHER_DIRECTORY_TOOLS,
      ]);
      expect(DIRECTORY_COMPATIBILITY_TOOLS).toHaveLength(9);
      expect(TOOL_SETS.directory.tools).toEqual(DIRECTORY_COMPATIBILITY_TOOLS);
      expect(TOOL_SETS.directory.routerVisible).toBe(false);
      expect(getValidToolSetNames(false).has('directory')).toBe(false);
      expect(getValidToolSetNames(false).has('partner_directory')).toBe(true);
      expect(getValidToolSetNames(false).has('agent_publisher_directory')).toBe(true);
      expect(getToolsForSets(['partner_directory'], false, false)).toEqual(
        expect.arrayContaining(PARTNER_DIRECTORY_TOOLS),
      );
      expect(getToolsForSets(['partner_directory'], false, false).filter((name) =>
        (AGENT_PUBLISHER_DIRECTORY_TOOLS as readonly string[]).includes(name),
      )).toEqual([]);
      expect(getToolsForSets(['agent_publisher_directory'], false, false)).toEqual(
        expect.arrayContaining(AGENT_PUBLISHER_DIRECTORY_TOOLS),
      );
      expect(getToolsForSets(['agent_publisher_directory'], false, false).filter((name) =>
        (PARTNER_DIRECTORY_TOOLS as readonly string[]).includes(name),
      )).toEqual([]);
      expect(getToolsForSets(['directory'], false, false)).toEqual(
        expect.arrayContaining(DIRECTORY_COMPATIBILITY_TOOLS),
      );
    });

    it.each([
      ['partner_directory', 10, 12],
      ['agent_publisher_directory', 9, 11],
    ] as const)('keeps %s authenticated member/admin surfaces within the typical target', (name, memberCount, adminCount) => {
      expect(getToolsForSets([name], false, false).filter((tool) => tool !== 'web_search')).toHaveLength(memberCount);
      expect(getToolsForSets([name], true, false).filter((tool) => tool !== 'web_search')).toHaveLength(adminCount);
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
      for (const adminTool of ADMIN_BILLING_TOOLS) {
        expect(tools).not.toContain(adminTool);
      }
      expect(ADMIN_BILLING_TOOLS.filter((tool) => memberBillingTools.includes(tool))).toEqual([]);
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

    it('skips member, bounded admin, and legacy billing sets in public channels', () => {
      const billingTools = [...TOOL_SETS.member_billing.tools, ...ADMIN_BILLING_TOOLS];
      const tools = getToolsForSets([
        'member_billing',
        'admin_billing_payments',
        'admin_billing_discounts',
        'admin_billing_account',
        'billing',
      ], true, true);
      for (const billingTool of billingTools) {
        expect(tools).not.toContain(billingTool);
      }
    });

    it('includes the selected bounded billing domain in private channels for admins', () => {
      const tools = getToolsForSets(['admin_billing_payments'], true, false);
      expect(tools).toContain('send_payment_request');
      expect(tools).not.toContain('grant_discount');
      expect(tools).not.toContain('find_membership_products');
    });

    it('keeps Stripe customer relinks behind the precision-gated account domain', () => {
      expect(TOOL_SETS.admin_billing_account.requiresPrecision).toBe(true);
      expect(TOOL_SETS.admin_billing_account.tools).toContain('preview_org_stripe_customer_update');
      expect(TOOL_SETS.admin_billing_account.tools).toContain('confirm_org_stripe_customer_update');
      expect(TOOL_SETS.admin_billing_payments.tools).not.toContain('preview_org_stripe_customer_update');
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
      ['community_group_discovery', 4],
      ['community_group_membership', 4],
      ['council_interest', 4],
      ['community_group_contribution', 3],
      ['community_group_full_participation', 11],
      ['publishing_author', 6],
      ['publishing_review', 4],
      ['publishing_promotion', 2],
      ['certification_overview', 5],
      ['certification_learning', 10],
      ['certification_assessment', 9],
      ['github', 4],
      ['illustrations', 1],
      ['knowledge', 3],
      ['community_research', 6],
      ['schema_reference', 4],
      ['partner_directory', 5],
      ['agent_publisher_directory', 4],
      ['brand_registry_records', 5],
      ['brand_registry_identity', 5],
      ['agent_registry', 5],
      ['agent_quality', 3],
      ['agent_authentication', 2],
      ['agent_end_to_end', 10],
      ['property_registry_records', 4],
      ['property_list_enrichment', 2],
      ['property_identifier_catalog', 3],
    ] as const)('keeps %s at twelve tools or fewer', (name, expectedCount) => {
      expect(TOOL_SETS[name].tools).toHaveLength(expectedCount);
      expect(TOOL_SETS[name].tools.length).toBeLessThanOrEqual(12);
    });

    it('keeps narrow group routes visible and the exact legacy union hidden', () => {
      expect(MEMBER_PROFILE_TOOLS).toHaveLength(7);
      expect(COMMUNITY_GROUP_TOOLS).toHaveLength(11);
      expect(COMMUNITY_GROUP_FULL_PARTICIPATION_TOOLS).toEqual(COMMUNITY_GROUP_TOOLS);
      expect(COMMUNITY_GROUP_TOOLS).toBe(COMMUNITY_GROUP_FULL_PARTICIPATION_TOOLS);
      expect(COMMUNITY_GROUP_DISCOVERY_TOOLS).toEqual([
        'list_working_groups', 'get_working_group', 'get_my_working_groups', 'list_committee_documents',
      ]);
      expect(COMMUNITY_GROUP_MEMBERSHIP_TOOLS).toEqual([
        'list_working_groups', 'get_working_group', 'join_working_group', 'request_working_group_invitation',
      ]);
      expect(COUNCIL_INTEREST_TOOLS).toEqual([
        'list_working_groups', 'express_council_interest', 'withdraw_council_interest', 'get_my_council_interests',
      ]);
      expect(COMMUNITY_GROUP_CONTRIBUTION_TOOLS).toEqual([
        'get_my_working_groups', 'create_working_group_post', 'bookmark_resource',
      ]);
      expect(getValidToolSetNames(false).has('member_profile')).toBe(true);
      for (const name of [
        'community_group_discovery', 'community_group_membership', 'council_interest',
        'community_group_contribution', 'community_group_full_participation',
      ]) {
        expect(getValidToolSetNames(false).has(name), name).toBe(true);
      }
      expect(TOOL_SETS.community_groups.tools).toEqual(COMMUNITY_GROUP_TOOLS);
      expect(TOOL_SETS.community_groups.routerVisible).toBe(false);
      expect(getValidToolSetNames(false).has('community_groups')).toBe(false);
    });

    it('keeps profile, community-group, and bounded publishing workflows isolated', () => {
      const profile = getToolsForSets(['member_profile'], false, false);
      const discovery = getToolsForSets(['community_group_discovery'], false, false);
      const membership = getToolsForSets(['community_group_membership'], false, false);
      const councilInterest = getToolsForSets(['council_interest'], false, false);
      const contribution = getToolsForSets(['community_group_contribution'], false, false);
      const author = getToolsForSets(['publishing_author'], false, false);
      const review = getToolsForSets(['publishing_review'], false, false);
      const promotion = getToolsForSets(['publishing_promotion'], false, false);

      expect(profile).toContain('get_my_profile');
      expect(profile).not.toContain('join_working_group');
      expect(profile).not.toContain('draft_social_posts');
      expect(discovery).toEqual(expect.arrayContaining(['list_working_groups', 'get_working_group', 'get_my_working_groups', 'list_committee_documents']));
      expect(discovery).not.toContain('join_working_group');
      expect(membership).toEqual(expect.arrayContaining(['list_working_groups', 'get_working_group', 'join_working_group', 'request_working_group_invitation']));
      expect(membership).not.toContain('express_council_interest');
      expect(councilInterest).toEqual(expect.arrayContaining(['list_working_groups', 'express_council_interest', 'withdraw_council_interest', 'get_my_council_interests']));
      expect(councilInterest).not.toContain('join_working_group');
      expect(contribution).toContain('create_working_group_post');
      expect(contribution).toContain('get_my_working_groups');
      expect(contribution).toContain('bookmark_resource');
      expect(contribution).not.toContain('get_my_profile');
      expect(contribution).not.toContain('attach_content_asset');
      expect(author).toContain('propose_content');
      expect(author).toContain('attach_content_asset');
      expect(author).not.toContain('approve_content');
      expect(author).not.toContain('draft_social_posts');
      expect(review).toContain('approve_content');
      expect(review).not.toContain('propose_content');
      expect(promotion).toContain('list_perspectives');
      expect(promotion).toContain('draft_social_posts');
      expect(promotion).not.toContain('attach_content_asset');
      expect(author).not.toContain('get_my_profile');
      expect(author).not.toContain('join_working_group');
    });

    it('keeps publishing routes visible', () => {
      expect(PUBLISHING_AUTHOR_TOOLS).toHaveLength(6);
      expect(PUBLISHING_REVIEW_TOOLS).toHaveLength(4);
      expect(PUBLISHING_PROMOTION_TOOLS).toHaveLength(2);
      expect(getValidToolSetNames(false).has('publishing_author')).toBe(true);
      expect(getValidToolSetNames(false).has('publishing_review')).toBe(true);
      expect(getValidToolSetNames(false).has('publishing_promotion')).toBe(true);
    });

    it('rejects removed pre-split aliases without expanding the request surface', () => {
      for (const name of ['admin', 'admin_groups', 'member', 'agent_testing', 'publishing', 'certification']) {
        expect(TOOL_SETS).not.toHaveProperty(name);
        expect(getValidToolSetNames(true).has(name)).toBe(false);
        expect(getToolsForSets([name], false, false)).toEqual(ALWAYS_AVAILABLE_TOOLS);
      }
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

  it('reinforces the request-scoped catalog when sets are omitted', () => {
    const hint = buildUnavailableSetsHint(['knowledge'], false);
    expect(hint).toContain('Request-Scoped Tool Boundary');
    expect(hint).toContain('authoritative custom-tool catalog');
  });

  it('does not enumerate omitted domains or expose per-conversation unavailability', () => {
    const hint = buildUnavailableSetsHint(['knowledge'], false);
    expect(hint).not.toContain('**github**');
    expect(hint).not.toContain('Capabilities Not Available in This Conversation');
    expect(hint).not.toContain('not available right now');
    expect(hint).not.toContain('I don\'t have access');
  });

  it('does not duplicate callable tool names outside the authoritative catalog', () => {
    const hint = buildUnavailableSetsHint(['knowledge'], false);
    expect(hint).not.toContain('escalate_to_admin');
    expect(hint).not.toContain('get_escalation_status');
    expect(hint).not.toContain('set_outreach_preference');
  });
});
