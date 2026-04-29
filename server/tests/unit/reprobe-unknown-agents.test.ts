import { describe, it, expect } from 'vitest';
import {
  aggregateOutcomes,
  isDnsOrConnectFailure,
  type ProbeOutcome,
} from '../../scripts/reprobe-unknown-agents.js';

// Pure-logic regression tests for the report-shape contract emitted by
// `reprobe-unknown-agents.ts`. The script's main loop is too coupled (DB,
// dynamic import of member-profiles) to test cheaply, but the *aggregator*
// is a pure function — we feed it synthetic outcomes and pin the report
// shape that operators paste back into the issue. If anyone changes the
// report shape, this test fails loudly.
//
// Style mirrors `crawler-type-update-policy.test.ts` (5/5 pass pattern).

describe('reprobe report aggregator', () => {
  it('groups classified outcomes by inferred type', () => {
    const outcomes: ProbeOutcome[] = [
      { url: 'https://a/', inferred: 'sales', classification: 'classified' },
      { url: 'https://b/', inferred: 'sales', classification: 'classified' },
      { url: 'https://c/', inferred: 'creative', classification: 'classified' },
      { url: 'https://d/', inferred: 'signals', classification: 'classified' },
    ];
    const report = aggregateOutcomes(outcomes, {
      scanned: 4,
      skipped: 0,
      elapsedMs: 1234,
      dryRun: false,
    });
    expect(report.newly_classified).toEqual({ sales: 2, creative: 1, signals: 1, buying: 0 });
    expect(report.still_unknown).toBe(0);
    expect(report.probe_failed).toBe(0);
    expect(report.dns_failed).toBe(0);
    expect(report.scanned).toBe(4);
    expect(report.elapsed_ms).toBe(1234);
    expect(report.dry_run).toBe(false);
  });

  it('counts still_unknown separately and caps the sample at 10 URLs', () => {
    const outcomes: ProbeOutcome[] = [];
    for (let i = 0; i < 25; i++) {
      outcomes.push({ url: `https://u${i}/`, inferred: null, classification: 'still_unknown' });
    }
    const report = aggregateOutcomes(outcomes, {
      scanned: 25,
      skipped: 0,
      elapsedMs: 0,
      dryRun: true,
    });
    expect(report.still_unknown).toBe(25);
    expect(report.still_unknown_sample.length).toBe(10);
    expect(report.still_unknown_sample[0]).toBe('https://u0/');
    expect(report.newly_classified).toEqual({ sales: 0, creative: 0, signals: 0, buying: 0 });
  });

  it('separates probe_failed (HTTP/timeout) from dns_failed', () => {
    const outcomes: ProbeOutcome[] = [
      { url: 'https://gone/',     inferred: null, classification: 'dns_failed' },
      { url: 'https://refused/',  inferred: null, classification: 'dns_failed' },
      { url: 'https://5xx/',      inferred: null, classification: 'probe_failed' },
      { url: 'https://timeout/',  inferred: null, classification: 'probe_failed' },
      { url: 'https://timeout2/', inferred: null, classification: 'probe_failed' },
    ];
    const report = aggregateOutcomes(outcomes, {
      scanned: 5,
      skipped: 0,
      elapsedMs: 9999,
      dryRun: false,
    });
    expect(report.dns_failed).toBe(2);
    expect(report.probe_failed).toBe(3);
    expect(report.still_unknown).toBe(0);
    // 'unknown' inferred type should never reach this counter — that case is
    // routed to still_unknown / probe_failed earlier in the pipeline.
    expect(report.newly_classified).toEqual({ sales: 0, creative: 0, signals: 0, buying: 0 });
  });

  it('preserves report fields for operator paste-back: scanned, skipped, elapsed, dry_run', () => {
    const report = aggregateOutcomes([], {
      scanned: 100,
      skipped: 7,
      elapsedMs: 60_000,
      dryRun: true,
    });
    expect(report.scanned).toBe(100);
    expect(report.skipped_already_classified).toBe(7);
    expect(report.elapsed_ms).toBe(60_000);
    expect(report.dry_run).toBe(true);
    expect(report.still_unknown_sample).toEqual([]);
  });

  it('classifies DNS / connect-refused error messages by name', () => {
    expect(isDnsOrConnectFailure('getaddrinfo ENOTFOUND example.com')).toBe(true);
    expect(isDnsOrConnectFailure('connect ECONNREFUSED 127.0.0.1:443')).toBe(true);
    expect(isDnsOrConnectFailure('NXDOMAIN response')).toBe(true);
    expect(isDnsOrConnectFailure('EHOSTUNREACH')).toBe(true);
    // HTTP / timeout errors are NOT dns_failed — they go to probe_failed so
    // we can scope retry-with-backoff at the right granularity.
    expect(isDnsOrConnectFailure('Probe timeout')).toBe(false);
    expect(isDnsOrConnectFailure('HTTP 503 Service Unavailable')).toBe(false);
    expect(isDnsOrConnectFailure(undefined)).toBe(false);
    expect(isDnsOrConnectFailure(null)).toBe(false);
  });
});
