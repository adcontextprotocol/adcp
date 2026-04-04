import { describe, it, expect } from 'vitest';
import {
  listStoryboards,
  getStoryboard,
  getTestKit,
  getTestKitForStoryboard,
  type Storyboard,
  type StoryboardSummary,
} from '../../src/services/storyboards.js';

describe('listStoryboards', () => {
  it('returns all storyboards when no category filter', () => {
    const results = listStoryboards();
    expect(results.length).toBeGreaterThanOrEqual(3);

    const ids = results.map((s) => s.id);
    expect(ids).toContain('creative_template');
    expect(ids).toContain('creative_ad_server');
    expect(ids).toContain('creative_sales_agent');
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
    const validPrefixes = ['creative/', 'media-buy/'];
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

  it('returns undefined for storyboard without test kit', () => {
    const kit = getTestKitForStoryboard('creative_ad_server');
    expect(kit).toBeUndefined();
  });

  it('returns undefined for unknown storyboard', () => {
    const kit = getTestKitForStoryboard('nonexistent');
    expect(kit).toBeUndefined();
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
});
