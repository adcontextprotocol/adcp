import { describe, it, expect } from 'vitest';
import {
  classifyScopeKey,
  inferDisplayTier,
  microsToUsd,
  NAMESPACE_FALLBACK_TIER,
} from '../../src/routes/admin/addie-costs-helpers.js';

/**
 * #2945 — admin observability for the per-user cost cap. These tests
 * pin the namespace/tier classification that drives which daily cap is
 * displayed in the leaderboard. The SQL queries themselves are
 * validated by running the admin page after deploy; the risk the tests
 * cover is that a future wiring change could silently misclassify a
 * new scope-key shape and surface the wrong cap.
 */

describe('classifyScopeKey', () => {
  // Keep this aligned with the SQL NAMESPACE_CASE expression in
  // addie-costs.ts — the two classifiers must agree so the admin page
  // can't claim a namespace count that the leaderboard can't reproduce.
  const cases: Array<[string, ReturnType<typeof classifyScopeKey>]> = [
    ['email:abc123def4567890', 'email'],
    ['slack:U12345', 'slack'],
    ['mcp:oauth-user-001', 'mcp'],
    ['tavus:ip:10.0.0.1', 'tavus'],
    ['anon:hashed-ip-abc', 'anon'],
    ['user_01H2ABC', 'workos'],
    ['something-else', 'unknown'],
    ['', 'unknown'],
  ];

  it.each(cases)('classifies %s as %s', (key, expected) => {
    expect(classifyScopeKey(key)).toBe(expected);
  });

  it('does not treat a scope-key that happens to contain a prefix later in the string as that namespace', () => {
    expect(classifyScopeKey('legacy_email:abc')).toBe('unknown');
    expect(classifyScopeKey('org_slack:U12')).toBe('unknown');
  });
});

describe('inferDisplayTier', () => {
  it('promotes to member_paid when the joined org has an active subscription', () => {
    expect(inferDisplayTier('workos', true)).toBe('member_paid');
    // Subscription status wins over namespace fallback even for a
    // notionally-anonymous namespace — in practice this only fires
    // for `workos` keys, but the promotion rule is namespace-agnostic
    // so that e.g. a future `slack:`-keyed row that we later resolve
    // to a paying member through a secondary join path still displays
    // the correct cap.
    expect(inferDisplayTier('slack', true)).toBe('member_paid');
  });

  it('falls back to namespace-level tier when subscription status is unknown', () => {
    expect(inferDisplayTier('workos', null)).toBe('member_free');
    expect(inferDisplayTier('slack', null)).toBe('member_free');
    expect(inferDisplayTier('email', null)).toBe('anonymous');
    expect(inferDisplayTier('mcp', null)).toBe('anonymous');
    expect(inferDisplayTier('tavus', null)).toBe('anonymous');
    expect(inferDisplayTier('anon', null)).toBe('anonymous');
  });

  it('falls back to namespace-level tier when subscription status is explicitly false', () => {
    // A user whose org had a subscription but canceled — not a paying
    // member any more. Must NOT be displayed as member_paid.
    expect(inferDisplayTier('workos', false)).toBe('member_free');
    expect(inferDisplayTier('email', false)).toBe('anonymous');
  });

  it('has a fallback entry for every namespace', () => {
    // Guard against adding a new Namespace literal and forgetting to
    // wire it into NAMESPACE_FALLBACK_TIER.
    const namespaces = ['email', 'slack', 'mcp', 'tavus', 'anon', 'workos', 'unknown'] as const;
    for (const ns of namespaces) {
      expect(NAMESPACE_FALLBACK_TIER[ns]).toBeDefined();
    }
  });
});

describe('microsToUsd', () => {
  it('converts micros to USD rounded to 2 decimal places', () => {
    expect(microsToUsd(1_000_000)).toBe(1);
    expect(microsToUsd(2_500_000)).toBe(2.5);
    expect(microsToUsd(0)).toBe(0);
    // $0.001234 → rounds to $0.00
    expect(microsToUsd(1_234)).toBe(0);
    // $0.005 boundary → 0.01 (half up)
    expect(microsToUsd(5_000)).toBe(0.01);
  });

  it('handles large spend without floating-point drift', () => {
    // Summing a day's spend for a leaderboard row — 250,000 micros ×
    // 1000 events = 250M micros = $250. Must not drift to $249.9999.
    expect(microsToUsd(250_000_000)).toBe(250);
  });
});
