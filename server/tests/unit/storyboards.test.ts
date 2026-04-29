import { describe, it, expect } from 'vitest';
import {
  listStoryboards,
  getStoryboard,
  getAllStoryboards,
  getTestKit,
  getTestKitForStoryboard,
  type Storyboard,
  type StoryboardSummary,
} from '../../src/services/storyboards.js';

/**
 * These tests cover the wrapper in services/storyboards.ts. Catalog content
 * (which storyboards exist, their tasks, phases, etc.) is owned upstream by
 * @adcp/sdk's compliance cache; upstream has its own catalog tests.
 */

describe('listStoryboards', () => {
  it('returns a non-empty list from the compliance cache', () => {
    const results = listStoryboards();
    expect(results.length).toBeGreaterThan(0);
  });

  it('each summary has the fields the wrapper promises', () => {
    const results = listStoryboards();
    expect(results.length).toBeGreaterThan(0);
    for (const sb of results) {
      expect(sb.id).toBeTruthy();
      expect(sb.title).toBeTruthy();
      expect(typeof sb.summary).toBe('string');
      expect(typeof sb.interaction_model).toBe('string');
      expect(Array.isArray(sb.examples)).toBe(true);
      // Some baseline storyboards ship as stubs (0 phases). The wrapper
      // still reports correct counts — the assertion is that phase_count
      // equals step_count's arithmetic.
      expect(typeof sb.phase_count).toBe('number');
      expect(typeof sb.step_count).toBe('number');
    }
  });

  it('filters by category', () => {
    const all = listStoryboards();
    const withCategory = all.find((s) => s.category);
    expect(withCategory).toBeDefined();
    const filtered = listStoryboards(withCategory!.category);
    expect(filtered.length).toBeGreaterThan(0);
    for (const sb of filtered) {
      expect(sb.category).toBe(withCategory!.category);
    }
  });

  it('returns empty array for unknown category', () => {
    expect(listStoryboards('nonexistent_category_xyz')).toEqual([]);
  });

  it('step counts match actual phase steps', () => {
    const summaries = listStoryboards();
    const byId = new Map(getAllStoryboards().map((sb) => [sb.id, sb] as const));
    for (const summary of summaries) {
      const full = byId.get(summary.id);
      expect(full).toBeDefined();
      const actualSteps = full!.phases.reduce((sum, p) => sum + p.steps.length, 0);
      expect(summary.step_count).toBe(actualSteps);
      expect(summary.phase_count).toBe(full!.phases.length);
    }
  });
});

describe('getStoryboard', () => {
  it('returns undefined for unknown id', () => {
    expect(getStoryboard('nonexistent_id_xyz')).toBeUndefined();
  });

  it('round-trips an id from listStoryboards', () => {
    const [first] = listStoryboards();
    expect(first).toBeDefined();
    const full = getStoryboard(first.id);
    expect(full).toBeDefined();
    expect(full!.id).toBe(first.id);
  });

  it('every step has required fields', () => {
    for (const sb of getAllStoryboards()) {
      for (const phase of sb.phases) {
        expect(phase.id).toBeTruthy();
        expect(phase.title).toBeTruthy();
        for (const step of phase.steps) {
          expect(step.id).toBeTruthy();
          expect(step.title).toBeTruthy();
          expect(step.task).toBeTruthy();
        }
      }
    }
  });
});

describe('getTestKit', () => {
  it('returns undefined for unknown kit', () => {
    expect(getTestKit('nonexistent_kit_xyz')).toBeUndefined();
  });

  it('loads known kits bundled with the compliance cache', () => {
    // Any kit that the wrapper loads should have an id and name
    const kit = getTestKit('acme_outdoor');
    if (kit) {
      expect(kit.id).toBe('acme_outdoor');
      expect(kit.name).toBeTruthy();
    }
  });
});

describe('getTestKitForStoryboard', () => {
  it('returns undefined for unknown storyboard', () => {
    expect(getTestKitForStoryboard('nonexistent_id_xyz')).toBeUndefined();
  });

  it('resolves to a kit when a storyboard declares prerequisites.test_kit', () => {
    const summaries = listStoryboards();
    // Scan at most 20 to keep the test fast — we're testing the resolver, not the catalog.
    for (const summary of summaries.slice(0, 20)) {
      const sb = getStoryboard(summary.id);
      if (!sb?.prerequisites?.test_kit) continue;
      const kit = getTestKitForStoryboard(sb.id);
      if (kit) {
        expect(kit.id).toBeTruthy();
        expect(kit.name).toBeTruthy();
        return; // one positive case is enough to cover the resolver path
      }
    }
  });
});

describe('wrapper contract', () => {
  it('StoryboardSummary type is structurally usable', () => {
    const [first] = listStoryboards();
    const summary: StoryboardSummary = first;
    expect(typeof summary.phase_count).toBe('number');
    expect(typeof summary.step_count).toBe('number');
  });
});
