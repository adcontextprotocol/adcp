import { describe, it, expect } from 'vitest';
import {
  listStoryboards,
  getStoryboard,
  getTestKit,
  getTestKitForStoryboard,
  extractScenariosFromStoryboard,
  type Storyboard,
  type StoryboardSummary,
} from '../../src/services/storyboards.js';

describe('listStoryboards', () => {
  it('returns all storyboards when no category filter', () => {
    const results = listStoryboards();
    expect(results.length).toBeGreaterThanOrEqual(25);

    const ids = results.map((s) => s.id);
    expect(ids).toContain('capability_discovery');
    expect(ids).toContain('schema_validation');
    expect(ids).toContain('behavioral_analysis');
    expect(ids).toContain('error_compliance');
    expect(ids).toContain('media_buy_state_machine');
    expect(ids).toContain('creative_template');
    expect(ids).toContain('creative_ad_server');
    expect(ids).toContain('creative_sales_agent');
    expect(ids).toContain('creative_lifecycle');
    expect(ids).toContain('media_buy_seller');
    expect(ids).toContain('media_buy_guaranteed_approval');
    expect(ids).toContain('media_buy_non_guaranteed');
    expect(ids).toContain('media_buy_proposal_mode');
    expect(ids).toContain('media_buy_governance_escalation');
    expect(ids).toContain('media_buy_catalog_creative');
    expect(ids).toContain('campaign_governance_denied');
    expect(ids).toContain('campaign_governance_conditions');
    expect(ids).toContain('campaign_governance_delivery');
    expect(ids).toContain('signal_marketplace');
    expect(ids).toContain('signal_owned');
    expect(ids).toContain('social_platform');
    expect(ids).toContain('si_session');
    expect(ids).toContain('brand_rights');
    expect(ids).toContain('property_governance');
    expect(ids).toContain('content_standards');
  });

  it('each summary has required fields', () => {
    const results = listStoryboards();
    for (const sb of results) {
      expect(sb.id).toBeTruthy();
      expect(sb.title).toBeTruthy();
      expect(sb.category).toBeTruthy();
      expect(sb.summary).toBeTruthy();
      expect(sb.interaction_model).toBeTruthy();
      expect(sb.examples.length).toBeGreaterThan(0);
      expect(sb.phase_count).toBeGreaterThan(0);
      expect(sb.step_count).toBeGreaterThan(0);
    }
  });

  it('filters by category', () => {
    const templates = listStoryboards('creative_template');
    expect(templates.length).toBe(1);
    expect(templates[0].id).toBe('creative_template');

    const adServers = listStoryboards('creative_ad_server');
    expect(adServers.length).toBe(1);
    expect(adServers[0].id).toBe('creative_ad_server');

    const signalMarketplace = listStoryboards('signal_marketplace');
    expect(signalMarketplace.length).toBe(1);
    expect(signalMarketplace[0].id).toBe('signal_marketplace');

    const signalOwned = listStoryboards('signal_owned');
    expect(signalOwned.length).toBe(1);
    expect(signalOwned[0].id).toBe('signal_owned');
  });

  it('returns empty array for unknown category', () => {
    const results = listStoryboards('nonexistent_category');
    expect(results).toEqual([]);
  });

  it('step counts match actual phase steps', () => {
    const results = listStoryboards();
    for (const summary of results) {
      const full = getStoryboard(summary.id);
      expect(full).toBeDefined();
      const actualSteps = full!.phases.reduce((sum, p) => sum + p.steps.length, 0);
      expect(summary.step_count).toBe(actualSteps);
      expect(summary.phase_count).toBe(full!.phases.length);
    }
  });
});

describe('getStoryboard', () => {
  it('returns full storyboard by id', () => {
    const sb = getStoryboard('creative_template');
    expect(sb).toBeDefined();
    expect(sb!.id).toBe('creative_template');
    expect(sb!.title).toContain('template');
    expect(sb!.agent.interaction_model).toBe('stateless_transform');
  });

  it('returns undefined for unknown id', () => {
    expect(getStoryboard('nonexistent')).toBeUndefined();
  });

  it('creative_template has 3 phases covering the stateless workflow', () => {
    const sb = getStoryboard('creative_template')!;
    expect(sb.phases.length).toBe(3);

    const phaseIds = sb.phases.map((p) => p.id);
    expect(phaseIds).toContain('format_exposure');
    expect(phaseIds).toContain('preview');
    expect(phaseIds).toContain('build');
  });

  it('creative_ad_server has stateful pre-loaded interaction model', () => {
    const sb = getStoryboard('creative_ad_server')!;
    expect(sb.agent.interaction_model).toBe('stateful_preloaded');
    expect(sb.agent.capabilities).toContain('has_creative_library');
  });

  it('creative_sales_agent has stateful push interaction model', () => {
    const sb = getStoryboard('creative_sales_agent')!;
    expect(sb.agent.interaction_model).toBe('stateful_push');
  });

  it('signal_marketplace has marketplace_catalog interaction model', () => {
    const sb = getStoryboard('signal_marketplace')!;
    expect(sb.agent.interaction_model).toBe('marketplace_catalog');
    expect(sb.agent.capabilities).toContain('catalog_signals');
  });

  it('signal_owned has owned_signals interaction model', () => {
    const sb = getStoryboard('signal_owned')!;
    expect(sb.agent.interaction_model).toBe('owned_signals');
  });

  it('every step has required fields', () => {
    const storyboards = listStoryboards();
    for (const summary of storyboards) {
      const sb = getStoryboard(summary.id)!;
      for (const phase of sb.phases) {
        expect(phase.id).toBeTruthy();
        expect(phase.title).toBeTruthy();
        expect(phase.narrative).toBeTruthy();
        expect(phase.steps.length).toBeGreaterThan(0);

        for (const step of phase.steps) {
          expect(step.id).toBeTruthy();
          expect(step.title).toBeTruthy();
          expect(step.narrative).toBeTruthy();
          expect(step.task).toBeTruthy();
          expect(step.schema_ref).toBeTruthy();
          expect(step.doc_ref).toBeTruthy();
          expect(step.expected).toBeTruthy();
        }
      }
    }
  });

  it('schema_ref paths point to known schema directories', () => {
    const storyboards = listStoryboards();
    const validPrefixes = ['creative/', 'media-buy/', 'account/', 'governance/', 'signals/', 'protocol/', 'sponsored-intelligence/', 'brand/', 'property/', 'content-standards/'];
    for (const summary of storyboards) {
      const sb = getStoryboard(summary.id)!;
      for (const phase of sb.phases) {
        for (const step of phase.steps) {
          const hasValidPrefix = validPrefixes.some((p) => step.schema_ref.startsWith(p));
          expect(hasValidPrefix).toBe(true);
        }
      }
    }
  });
});

describe('getTestKit', () => {
  it('returns acme_outdoor test kit', () => {
    const kit = getTestKit('acme_outdoor');
    expect(kit).toBeDefined();
    expect(kit!.name).toBe('Acme Outdoor');
  });

  it('returns nova_motors test kit', () => {
    const kit = getTestKit('nova_motors');
    expect(kit).toBeDefined();
    expect(kit!.name).toBe('Nova Motors');
  });

  it('nova_motors test kit has signal definitions', () => {
    const kit = getTestKit('nova_motors')!;
    const signals = kit as unknown as { signals: { marketplace: unknown[]; owned: unknown[] } };
    expect(signals.signals.marketplace.length).toBeGreaterThanOrEqual(3);
    expect(signals.signals.owned.length).toBeGreaterThanOrEqual(3);
  });

  it('test kit has brand data', () => {
    const kit = getTestKit('acme_outdoor')!;
    expect(kit.brand).toBeDefined();
    const brand = kit.brand as Record<string, unknown>;
    expect(brand.brand_id).toBe('acme_outdoor');
  });

  it('test kit has image assets', () => {
    const kit = getTestKit('acme_outdoor')!;
    const assets = kit.assets as { images: Array<{ id: string; width: number; height: number }> };
    expect(assets.images.length).toBeGreaterThanOrEqual(4);

    const ids = assets.images.map((i) => i.id);
    expect(ids).toContain('hero_300x250');
    expect(ids).toContain('hero_728x90');
  });

  it('returns undefined for unknown kit', () => {
    expect(getTestKit('nonexistent')).toBeUndefined();
  });
});

describe('getTestKitForStoryboard', () => {
  it('resolves test kit for creative_template storyboard', () => {
    const kit = getTestKitForStoryboard('creative_template');
    expect(kit).toBeDefined();
    expect(kit!.id).toBe('acme_outdoor');
  });

  it('resolves test kit for creative_sales_agent storyboard', () => {
    const kit = getTestKitForStoryboard('creative_sales_agent');
    expect(kit).toBeDefined();
    expect(kit!.id).toBe('acme_outdoor');
  });

  it('resolves test kit for signal_marketplace storyboard', () => {
    const kit = getTestKitForStoryboard('signal_marketplace');
    expect(kit).toBeDefined();
    expect(kit!.id).toBe('nova_motors');
  });

  it('resolves test kit for signal_owned storyboard', () => {
    const kit = getTestKitForStoryboard('signal_owned');
    expect(kit).toBeDefined();
    expect(kit!.id).toBe('nova_motors');
  });

  it('returns undefined for storyboard without test kit', () => {
    const kit = getTestKitForStoryboard('creative_ad_server');
    expect(kit).toBeUndefined();
  });

  it('returns undefined for unknown storyboard', () => {
    const kit = getTestKitForStoryboard('nonexistent');
    expect(kit).toBeUndefined();
  });
});

describe('media buy storyboard', () => {
  it('media_buy_seller has media_buy_seller interaction model', () => {
    const sb = getStoryboard('media_buy_seller')!;
    expect(sb.agent.interaction_model).toBe('media_buy_seller');
    expect(sb.agent.capabilities).toContain('sells_media');
    expect(sb.agent.capabilities).toContain('accepts_briefs');
  });

  it('media_buy_seller covers the full buy lifecycle', () => {
    const sb = getStoryboard('media_buy_seller')!;
    const phaseIds = sb.phases.map((p) => p.id);
    expect(phaseIds).toContain('account_setup');
    expect(phaseIds).toContain('governance_setup');
    expect(phaseIds).toContain('product_discovery');
    expect(phaseIds).toContain('proposal_refinement');
    expect(phaseIds).toContain('create_buy');
    expect(phaseIds).toContain('creative_sync');
    expect(phaseIds).toContain('delivery_monitoring');
  });

  it('media_buy_seller uses core media buy tasks', () => {
    const sb = getStoryboard('media_buy_seller')!;
    const tasks = sb.phases.flatMap((p) => p.steps.map((s) => s.task));
    expect(tasks).toContain('sync_accounts');
    expect(tasks).toContain('sync_governance');
    expect(tasks).toContain('get_products');
    expect(tasks).toContain('create_media_buy');
    expect(tasks).toContain('get_media_buys');
    expect(tasks).toContain('sync_creatives');
    expect(tasks).toContain('get_media_buy_delivery');
    expect(tasks).toContain('list_creative_formats');
  });

  it('filters by media_buy_seller category', () => {
    const results = listStoryboards('media_buy_seller');
    expect(results.length).toBe(1);
    expect(results[0].id).toBe('media_buy_seller');
  });
});

describe('media buy storyboard variants', () => {
  it('guaranteed_approval focuses on async IO signing', () => {
    const sb = getStoryboard('media_buy_guaranteed_approval')!;
    expect(sb).toBeDefined();
    const phaseIds = sb.phases.map((p) => p.id);
    expect(phaseIds).toContain('create_buy_submitted');
    expect(phaseIds).toContain('poll_approval');
    expect(phaseIds).toContain('confirm_active');
  });

  it('non_guaranteed uses auction-based buying with bid adjustments', () => {
    const sb = getStoryboard('media_buy_non_guaranteed')!;
    expect(sb).toBeDefined();
    const tasks = sb.phases.flatMap((p) => p.steps.map((s) => s.task));
    expect(tasks).toContain('update_media_buy');
    // No account setup needed for non-guaranteed
    expect(tasks).not.toContain('sync_accounts');
  });

  it('proposal_mode uses proposal_id instead of packages', () => {
    const sb = getStoryboard('media_buy_proposal_mode')!;
    expect(sb).toBeDefined();
    const phaseIds = sb.phases.map((p) => p.id);
    expect(phaseIds).toContain('accept_proposal');
    expect(phaseIds).toContain('brief_with_proposals');
  });

  it('governance_escalation covers the full governance loop', () => {
    const sb = getStoryboard('media_buy_governance_escalation')!;
    expect(sb).toBeDefined();
    const tasks = sb.phases.flatMap((p) => p.steps.map((s) => s.task));
    expect(tasks).toContain('sync_governance');
    expect(tasks).toContain('sync_plans');
    expect(tasks).toContain('check_governance');
    expect(tasks).toContain('report_plan_outcome');
    expect(tasks).toContain('get_plan_audit_logs');
  });

  it('catalog_creative covers catalog sync, events, and optimization', () => {
    const sb = getStoryboard('media_buy_catalog_creative')!;
    expect(sb).toBeDefined();
    const tasks = sb.phases.flatMap((p) => p.steps.map((s) => s.task));
    expect(tasks).toContain('sync_catalogs');
    expect(tasks).toContain('sync_event_sources');
    expect(tasks).toContain('log_event');
    expect(tasks).toContain('provide_performance_feedback');
    expect(tasks).toContain('get_media_buy_delivery');
  });

  it('each variant has a unique category', () => {
    const variants = [
      'media_buy_seller',
      'media_buy_guaranteed_approval',
      'media_buy_non_guaranteed',
      'media_buy_proposal_mode',
      'media_buy_governance_escalation',
      'media_buy_catalog_creative',
    ];
    for (const id of variants) {
      const results = listStoryboards(id);
      expect(results.length).toBe(1);
      expect(results[0].id).toBe(id);
    }
  });

  it('all media buy variants resolve acme_outdoor test kit', () => {
    const variants = [
      'media_buy_seller',
      'media_buy_guaranteed_approval',
      'media_buy_proposal_mode',
      'media_buy_governance_escalation',
    ];
    for (const id of variants) {
      const kit = getTestKitForStoryboard(id);
      expect(kit).toBeDefined();
      expect(kit!.id).toBe('acme_outdoor');
    }
  });
});

describe('storyboard interaction models', () => {
  it('stateless template storyboard uses no sync_creatives or list_creatives', () => {
    const sb = getStoryboard('creative_template')!;
    const tasks = sb.phases.flatMap((p) => p.steps.map((s) => s.task));
    expect(tasks).not.toContain('sync_creatives');
    expect(tasks).not.toContain('list_creatives');
    expect(tasks).toContain('list_creative_formats');
    expect(tasks).toContain('preview_creative');
    expect(tasks).toContain('build_creative');
  });

  it('ad server storyboard uses list_creatives and build_creative but not sync_creatives', () => {
    const sb = getStoryboard('creative_ad_server')!;
    const tasks = sb.phases.flatMap((p) => p.steps.map((s) => s.task));
    expect(tasks).toContain('list_creatives');
    expect(tasks).toContain('build_creative');
    expect(tasks).not.toContain('sync_creatives');
  });

  it('sales agent storyboard uses sync_creatives and preview_creative but not build_creative', () => {
    const sb = getStoryboard('creative_sales_agent')!;
    const tasks = sb.phases.flatMap((p) => p.steps.map((s) => s.task));
    expect(tasks).toContain('sync_creatives');
    expect(tasks).toContain('preview_creative');
    expect(tasks).not.toContain('build_creative');
  });

  it('signal_marketplace uses get_signals and activate_signal with a verification phase', () => {
    const sb = getStoryboard('signal_marketplace')!;
    const tasks = sb.phases.flatMap((p) => p.steps.map((s) => s.task));
    expect(tasks).toContain('get_signals');
    expect(tasks).toContain('activate_signal');

    const phaseIds = sb.phases.map((p) => p.id);
    expect(phaseIds).toContain('verification');
    expect(phaseIds).toContain('platform_activation');
    expect(phaseIds).toContain('agent_activation');
  });

  it('signal_owned uses get_signals and activate_signal without a verification phase', () => {
    const sb = getStoryboard('signal_owned')!;
    const tasks = sb.phases.flatMap((p) => p.steps.map((s) => s.task));
    expect(tasks).toContain('get_signals');
    expect(tasks).toContain('activate_signal');

    const phaseIds = sb.phases.map((p) => p.id);
    expect(phaseIds).not.toContain('verification');
    expect(phaseIds).toContain('platform_activation');
    expect(phaseIds).toContain('agent_activation');
  });

  it('both signal storyboards cover platform and agent destination types', () => {
    for (const id of ['signal_marketplace', 'signal_owned']) {
      const sb = getStoryboard(id)!;
      const phaseIds = sb.phases.map((p) => p.id);
      expect(phaseIds).toContain('platform_activation');
      expect(phaseIds).toContain('agent_activation');
    }
  });
});

describe('extractScenariosFromStoryboard', () => {
  it('extracts deduped scenarios from media_buy_seller', () => {
    const sb = getStoryboard('media_buy_seller')!;
    const scenarios = extractScenariosFromStoryboard(sb);
    expect(scenarios).toContain('full_sales_flow');
    expect(scenarios).toContain('create_media_buy');
    expect(scenarios).toContain('media_buy_lifecycle');
    expect(scenarios).toContain('reporting_flow');
    expect(scenarios).toContain('creative_lifecycle');
    expect(scenarios).toContain('creative_sync');
    // Should be deduped
    const duplicates = scenarios.filter((s, i) => scenarios.indexOf(s) !== i);
    expect(duplicates).toEqual([]);
  });

  it('returns empty array for storyboard with no comply_scenario', () => {
    const fakeSb = {
      id: 'test',
      version: '1.0.0',
      title: 'test',
      category: 'test',
      summary: 'test',
      narrative: 'test',
      agent: { interaction_model: 'test', capabilities: [], examples: [] },
      caller: { role: 'test', example: 'test' },
      phases: [{
        id: 'p1',
        title: 'test',
        narrative: 'test',
        steps: [{
          id: 's1',
          title: 'test',
          narrative: 'test',
          task: 'test',
          schema_ref: 'test',
          doc_ref: 'test',
          stateful: false,
          expected: 'test',
        }],
      }],
    } as unknown as import('../../src/services/storyboards.js').Storyboard;
    expect(extractScenariosFromStoryboard(fakeSb)).toEqual([]);
  });
});

describe('capability_discovery storyboard', () => {
  it('has protocol_discovery phase with get_adcp_capabilities task', () => {
    const sb = getStoryboard('capability_discovery')!;
    expect(sb).toBeDefined();
    expect(sb.agent.interaction_model).toBe('media_buy_seller');
    const tasks = sb.phases.flatMap((p) => p.steps.map((s) => s.task));
    expect(tasks).toContain('get_adcp_capabilities');
  });

  it('references protocol schema paths', () => {
    const sb = getStoryboard('capability_discovery')!;
    const refs = sb.phases.flatMap((p) => p.steps.map((s) => s.schema_ref));
    expect(refs.some((r) => r.startsWith('protocol/'))).toBe(true);
  });
});

describe('campaign governance storyboards', () => {
  it('denied storyboard covers plan registration and denial', () => {
    const sb = getStoryboard('campaign_governance_denied')!;
    expect(sb).toBeDefined();
    const tasks = sb.phases.flatMap((p) => p.steps.map((s) => s.task));
    expect(tasks).toContain('sync_plans');
    expect(tasks).toContain('check_governance');
  });

  it('conditions storyboard covers conditional approval and media buy creation', () => {
    const sb = getStoryboard('campaign_governance_conditions')!;
    expect(sb).toBeDefined();
    const tasks = sb.phases.flatMap((p) => p.steps.map((s) => s.task));
    expect(tasks).toContain('sync_plans');
    expect(tasks).toContain('check_governance');
    expect(tasks).toContain('create_media_buy');
  });

  it('delivery storyboard covers monitoring and drift re-check', () => {
    const sb = getStoryboard('campaign_governance_delivery')!;
    expect(sb).toBeDefined();
    const tasks = sb.phases.flatMap((p) => p.steps.map((s) => s.task));
    expect(tasks).toContain('sync_plans');
    expect(tasks).toContain('check_governance');
    expect(tasks).toContain('get_media_buy_delivery');
  });

  it('all governance storyboards resolve acme_outdoor test kit', () => {
    for (const id of ['campaign_governance_denied', 'campaign_governance_conditions', 'campaign_governance_delivery']) {
      const kit = getTestKitForStoryboard(id);
      expect(kit).toBeDefined();
      expect(kit!.id).toBe('acme_outdoor');
    }
  });
});

describe('creative_lifecycle storyboard', () => {
  it('covers sync, list, build, and preview tasks', () => {
    const sb = getStoryboard('creative_lifecycle')!;
    expect(sb).toBeDefined();
    expect(sb.agent.interaction_model).toBe('stateful_preloaded');
    const tasks = sb.phases.flatMap((p) => p.steps.map((s) => s.task));
    expect(tasks).toContain('list_creative_formats');
    expect(tasks).toContain('sync_creatives');
    expect(tasks).toContain('list_creatives');
    expect(tasks).toContain('preview_creative');
    expect(tasks).toContain('build_creative');
  });

  it('has phases covering the full lifecycle', () => {
    const sb = getStoryboard('creative_lifecycle')!;
    const phaseIds = sb.phases.map((p) => p.id);
    expect(phaseIds).toContain('discover_formats');
    expect(phaseIds).toContain('sync_multiple');
    expect(phaseIds).toContain('list_and_filter');
    expect(phaseIds).toContain('build_and_preview');
  });
});

describe('social_platform storyboard', () => {
  it('covers account setup, audiences, creatives, events, and financials', () => {
    const sb = getStoryboard('social_platform')!;
    expect(sb).toBeDefined();
    expect(sb.agent.interaction_model).toBe('media_buy_seller');
    const tasks = sb.phases.flatMap((p) => p.steps.map((s) => s.task));
    expect(tasks).toContain('sync_accounts');
    expect(tasks).toContain('list_accounts');
    expect(tasks).toContain('sync_audiences');
    expect(tasks).toContain('sync_creatives');
    expect(tasks).toContain('log_event');
    expect(tasks).toContain('get_account_financials');
  });

  it('resolves acme_outdoor test kit', () => {
    const kit = getTestKitForStoryboard('social_platform');
    expect(kit).toBeDefined();
    expect(kit!.id).toBe('acme_outdoor');
  });
});

describe('si_session storyboard', () => {
  it('covers the full SI session lifecycle', () => {
    const sb = getStoryboard('si_session')!;
    expect(sb).toBeDefined();
    expect(sb.agent.interaction_model).toBe('si_platform');
    const tasks = sb.phases.flatMap((p) => p.steps.map((s) => s.task));
    expect(tasks).toContain('si_get_offering');
    expect(tasks).toContain('si_initiate_session');
    expect(tasks).toContain('si_send_message');
    expect(tasks).toContain('si_terminate_session');
  });

  it('resolves nova_motors test kit', () => {
    const kit = getTestKitForStoryboard('si_session');
    expect(kit).toBeDefined();
    expect(kit!.id).toBe('nova_motors');
  });
});

describe('brand_rights storyboard', () => {
  it('covers brand identity discovery and rights lifecycle', () => {
    const sb = getStoryboard('brand_rights')!;
    expect(sb).toBeDefined();
    expect(sb.agent.interaction_model).toBe('brand_rights_holder');
    const tasks = sb.phases.flatMap((p) => p.steps.map((s) => s.task));
    expect(tasks).toContain('get_brand_identity');
    expect(tasks).toContain('get_rights');
    expect(tasks).toContain('acquire_rights');
    expect(tasks).toContain('update_rights');
    expect(tasks).toContain('creative_approval');
  });

  it('resolves acme_outdoor test kit', () => {
    const kit = getTestKitForStoryboard('brand_rights');
    expect(kit).toBeDefined();
    expect(kit!.id).toBe('acme_outdoor');
  });
});

describe('property_governance storyboard', () => {
  it('covers property list CRUD and delivery validation', () => {
    const sb = getStoryboard('property_governance')!;
    expect(sb).toBeDefined();
    expect(sb.agent.interaction_model).toBe('governance_agent');
    const tasks = sb.phases.flatMap((p) => p.steps.map((s) => s.task));
    expect(tasks).toContain('create_property_list');
    expect(tasks).toContain('list_property_lists');
    expect(tasks).toContain('get_property_list');
    expect(tasks).toContain('update_property_list');
    expect(tasks).toContain('delete_property_list');
    expect(tasks).toContain('validate_property_delivery');
  });

  it('resolves acme_outdoor test kit', () => {
    const kit = getTestKitForStoryboard('property_governance');
    expect(kit).toBeDefined();
    expect(kit!.id).toBe('acme_outdoor');
  });
});

describe('content_standards storyboard', () => {
  it('covers content standards CRUD, calibration, and delivery validation', () => {
    const sb = getStoryboard('content_standards')!;
    expect(sb).toBeDefined();
    expect(sb.agent.interaction_model).toBe('governance_agent');
    const tasks = sb.phases.flatMap((p) => p.steps.map((s) => s.task));
    expect(tasks).toContain('create_content_standards');
    expect(tasks).toContain('list_content_standards');
    expect(tasks).toContain('get_content_standards');
    expect(tasks).toContain('update_content_standards');
    expect(tasks).toContain('calibrate_content');
    expect(tasks).toContain('validate_content_delivery');
  });

  it('resolves acme_outdoor test kit', () => {
    const kit = getTestKitForStoryboard('content_standards');
    expect(kit).toBeDefined();
    expect(kit!.id).toBe('acme_outdoor');
  });
});

describe('schema_validation storyboard', () => {
  it('covers schema compliance and temporal validation', () => {
    const sb = getStoryboard('schema_validation')!;
    expect(sb).toBeDefined();
    const phaseIds = sb.phases.map((p) => p.id);
    expect(phaseIds).toContain('schema_compliance');
    expect(phaseIds).toContain('temporal_validation');
    const tasks = sb.phases.flatMap((p) => p.steps.map((s) => s.task));
    expect(tasks).toContain('get_products');
    expect(tasks).toContain('create_media_buy');
  });
});

describe('behavioral_analysis storyboard', () => {
  it('covers brief filtering, consistency, and pricing edge cases', () => {
    const sb = getStoryboard('behavioral_analysis')!;
    expect(sb).toBeDefined();
    const phaseIds = sb.phases.map((p) => p.id);
    expect(phaseIds).toContain('behavior_analysis');
    expect(phaseIds).toContain('response_consistency');
    expect(phaseIds).toContain('pricing_edge_cases');
  });

  it('resolves acme_outdoor test kit', () => {
    const kit = getTestKitForStoryboard('behavioral_analysis');
    expect(kit).toBeDefined();
    expect(kit!.id).toBe('acme_outdoor');
  });
});

describe('error_compliance storyboard', () => {
  it('covers error responses, structure, and transport bindings', () => {
    const sb = getStoryboard('error_compliance')!;
    expect(sb).toBeDefined();
    const phaseIds = sb.phases.map((p) => p.id);
    expect(phaseIds).toContain('error_responses');
    expect(phaseIds).toContain('error_structure');
    expect(phaseIds).toContain('error_transport');
    const tasks = sb.phases.flatMap((p) => p.steps.map((s) => s.task));
    expect(tasks).toContain('create_media_buy');
    expect(tasks).toContain('get_products');
  });
});

describe('media_buy_state_machine storyboard', () => {
  it('covers state transitions and terminal enforcement', () => {
    const sb = getStoryboard('media_buy_state_machine')!;
    expect(sb).toBeDefined();
    const phaseIds = sb.phases.map((p) => p.id);
    expect(phaseIds).toContain('setup');
    expect(phaseIds).toContain('state_transitions');
    expect(phaseIds).toContain('terminal_enforcement');
    const tasks = sb.phases.flatMap((p) => p.steps.map((s) => s.task));
    expect(tasks).toContain('get_products');
    expect(tasks).toContain('create_media_buy');
    expect(tasks).toContain('update_media_buy');
  });

  it('resolves acme_outdoor test kit', () => {
    const kit = getTestKitForStoryboard('media_buy_state_machine');
    expect(kit).toBeDefined();
    expect(kit!.id).toBe('acme_outdoor');
  });
});
