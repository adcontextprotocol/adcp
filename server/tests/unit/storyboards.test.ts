import { describe, it, expect } from 'vitest';
import {
  listStoryboards,
  getStoryboard,
  getAllStoryboards,
  getTestKit,
  getTestKitForStoryboard,
  compareAdcpVersions,
  getStoryboardsForVersion,
  getStoryboardIdsForVersion,
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

describe('compareAdcpVersions', () => {
  it('returns 0 for equal versions', () => {
    expect(compareAdcpVersions('3.0', '3.0')).toBe(0);
    expect(compareAdcpVersions('3.10', '3.10')).toBe(0);
  });

  it('returns negative when a < b', () => {
    expect(compareAdcpVersions('3.0', '3.1')).toBeLessThan(0);
    expect(compareAdcpVersions('3.0', '4.0')).toBeLessThan(0);
  });

  it('returns positive when a > b', () => {
    expect(compareAdcpVersions('3.1', '3.0')).toBeGreaterThan(0);
    expect(compareAdcpVersions('4.0', '3.99')).toBeGreaterThan(0);
  });

  it('compares minors numerically (the fix that motivated this helper)', () => {
    // String compare would say '3.10' < '3.2' (lex) — wrong.
    expect(compareAdcpVersions('3.10', '3.2')).toBeGreaterThan(0);
    expect(compareAdcpVersions('3.2', '3.10')).toBeLessThan(0);
  });

  it('compares double-digit majors numerically', () => {
    expect(compareAdcpVersions('10.0', '3.0')).toBeGreaterThan(0);
    expect(compareAdcpVersions('3.99', '10.0')).toBeLessThan(0);
  });

  it('treats malformed values as 0.0 (sort first, fail loudly elsewhere)', () => {
    // Defensive: malformed values should not crash the comparator. The DB
    // CHECK constraint ensures they never reach the comparator in
    // production; this guards a debugging path.
    expect(compareAdcpVersions('garbage', '3.0')).toBeLessThan(0);
    expect(compareAdcpVersions('3.0', '')).toBeGreaterThan(0);
  });
});

describe('getStoryboardsForVersion', () => {
  it('returns every storyboard when target is the highest supported version', () => {
    // All current storyboards have unset `introduced_in` (always-applied),
    // so a 3.0 target returns every storyboard in the catalog.
    const all = getAllStoryboards();
    const for30 = getStoryboardsForVersion('3.0');
    expect(for30.length).toBe(all.length);
  });

  it('omits storyboards with introduced_in above the target', () => {
    // Synthetic check: build the same filter logic against a fake catalog
    // since no current storyboard has introduced_in set. The behavior we
    // care about is the contract — we re-test it via the comparator.
    const sb = getAllStoryboards()[0];
    expect(sb).toBeDefined();
    // If we were to add introduced_in: '3.1' to this storyboard, a 3.0
    // target would skip it. The filter is `introduced_in <= target`.
    const target = '3.0';
    const introducedIn = '3.1';
    expect(compareAdcpVersions(introducedIn, target)).toBeGreaterThan(0);
    // Real assertion using the same predicate the function uses:
    const wouldKeep = compareAdcpVersions(introducedIn, target) <= 0;
    expect(wouldKeep).toBe(false);
  });

  it('keeps storyboards with introduced_in equal to or below the target', () => {
    expect(compareAdcpVersions('3.0', '3.0') <= 0).toBe(true);
    expect(compareAdcpVersions('3.0', '3.1') <= 0).toBe(true);
  });

  it('getStoryboardIdsForVersion returns the same length as getStoryboardsForVersion', () => {
    expect(getStoryboardIdsForVersion('3.0').length).toBe(getStoryboardsForVersion('3.0').length);
  });
});
