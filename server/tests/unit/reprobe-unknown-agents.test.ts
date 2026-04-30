// Set WorkOS env vars BEFORE any imports — `member-profiles.ts` (transitively
// loaded via the script's static `import { resolveAgentTypes }`) constructs
// a WorkOS client at module-init time. We don't exercise WorkOS in this
// test, so dummy creds are fine; the import just needs to not throw.
process.env.WORKOS_API_KEY ||= 'sk_test_dummy_for_unit_tests';
process.env.WORKOS_CLIENT_ID ||= 'client_test_dummy_for_unit_tests';

import { describe, it, expect, vi } from 'vitest';
import {
  aggregateOutcomes,
  decideWrite,
  isDnsOrConnectFailure,
  probeOne,
  type AgentToProbe,
  type ProbeOutcome,
} from '../../scripts/reprobe-unknown-agents.js';
import type { AgentCapabilityProfile } from '../../src/capabilities.js';

// Tests for `reprobe-unknown-agents.ts`.
//
// Coverage matrix (Brian's bar):
//   (a) successful classification path        → "writes the new type" test
//   (b) probe-failed path (timeout)           → "preserves existing on probe_failed" test
//   (c) DNS-failed path (NXDOMAIN)            → "routes ENOTFOUND to dns_failed" test
//   (d) idempotency on re-run after success   → "set-A SELECT filter prevents..." test
//   (e) silent-corruption risk                → THE BIG ONE: a previously-classified
//                                                 row must NOT regress on a transient
//                                                 probe failure. Asserted directly via
//                                                 `decideWrite` and `probeOne` mock.

describe('reprobe report aggregator', () => {
  it('groups classified outcomes by inferred type', () => {
    const outcomes: ProbeOutcome[] = [
      { url: 'https://a/', inferred: 'sales',    classification: 'classified', elapsed_ms: 1200 },
      { url: 'https://b/', inferred: 'sales',    classification: 'classified', elapsed_ms: 800  },
      { url: 'https://c/', inferred: 'creative', classification: 'classified', elapsed_ms: 500  },
      { url: 'https://d/', inferred: 'signals',  classification: 'classified', elapsed_ms: 300  },
    ];
    const report = aggregateOutcomes(outcomes, {
      scanned: 4, skipped: 0, elapsedMs: 1234, dryRun: false,
    });
    expect(report.newly_classified).toEqual({ sales: 2, creative: 1, signals: 1, buying: 0 });
    expect(report.still_unknown).toBe(0);
    expect(report.probe_failed).toBe(0);
    expect(report.dns_failed).toBe(0);
    expect(report.scanned).toBe(4);
    expect(report.elapsed_ms).toBe(1234);
    expect(report.dry_run).toBe(false);
    // Slowest-first ordering for operator visibility.
    expect(report.slowest[0]).toEqual({ url: 'https://a/', elapsed_ms: 1200 });
  });

  it('counts still_unknown separately and caps the sample at 10 URLs', () => {
    const outcomes: ProbeOutcome[] = [];
    for (let i = 0; i < 25; i++) {
      outcomes.push({
        url: `https://u${i}/`, inferred: null, classification: 'still_unknown', elapsed_ms: 0,
      });
    }
    const report = aggregateOutcomes(outcomes, {
      scanned: 25, skipped: 0, elapsedMs: 0, dryRun: true,
    });
    expect(report.still_unknown).toBe(25);
    expect(report.still_unknown_sample.length).toBe(10);
    expect(report.still_unknown_sample[0]).toBe('https://u0/');
    expect(report.newly_classified).toEqual({ sales: 0, creative: 0, signals: 0, buying: 0 });
  });

  it('separates probe_failed (HTTP/timeout) from dns_failed', () => {
    const outcomes: ProbeOutcome[] = [
      { url: 'https://gone/',     inferred: null, classification: 'dns_failed',   elapsed_ms: 0 },
      { url: 'https://refused/',  inferred: null, classification: 'dns_failed',   elapsed_ms: 0 },
      { url: 'https://5xx/',      inferred: null, classification: 'probe_failed', elapsed_ms: 0 },
      { url: 'https://timeout/',  inferred: null, classification: 'probe_failed', elapsed_ms: 0 },
      { url: 'https://timeout2/', inferred: null, classification: 'probe_failed', elapsed_ms: 0 },
    ];
    const report = aggregateOutcomes(outcomes, {
      scanned: 5, skipped: 0, elapsedMs: 9999, dryRun: false,
    });
    expect(report.dns_failed).toBe(2);
    expect(report.probe_failed).toBe(3);
    expect(report.still_unknown).toBe(0);
    expect(report.newly_classified).toEqual({ sales: 0, creative: 0, signals: 0, buying: 0 });
  });

  it('preserves report fields for operator paste-back: scanned, skipped, elapsed, dry_run', () => {
    const report = aggregateOutcomes([], {
      scanned: 100, skipped: 7, elapsedMs: 60_000, dryRun: true,
    });
    expect(report.scanned).toBe(100);
    expect(report.skipped_already_classified).toBe(7);
    expect(report.elapsed_ms).toBe(60_000);
    expect(report.dry_run).toBe(true);
    expect(report.still_unknown_sample).toEqual([]);
    expect(report.preserved_existing_classification).toBe(0);
  });

  it('classifies DNS / connect-refused error messages by name', () => {
    expect(isDnsOrConnectFailure('getaddrinfo ENOTFOUND example.com')).toBe(true);
    expect(isDnsOrConnectFailure('connect ECONNREFUSED 127.0.0.1:443')).toBe(true);
    expect(isDnsOrConnectFailure('NXDOMAIN response')).toBe(true);
    expect(isDnsOrConnectFailure('EHOSTUNREACH')).toBe(true);
    expect(isDnsOrConnectFailure('Probe timeout')).toBe(false);
    expect(isDnsOrConnectFailure('HTTP 503 Service Unavailable')).toBe(false);
    expect(isDnsOrConnectFailure(undefined)).toBe(false);
    expect(isDnsOrConnectFailure(null)).toBe(false);
  });
});

describe('reprobe write decision (silent-corruption rule)', () => {
  it('always writes when probe classified the agent', () => {
    expect(decideWrite('classified', 'sales', true)).toEqual({ write: true, inferred: 'sales' });
    expect(decideWrite('classified', 'sales', false)).toEqual({ write: true, inferred: 'sales' });
  });

  it('writes NULL when probe succeeded but no class found (still_unknown)', () => {
    expect(decideWrite('still_unknown', 'unknown', true)).toEqual({ write: true, inferred: null });
    expect(decideWrite('still_unknown', 'unknown', false)).toEqual({ write: true, inferred: null });
  });

  it('REFUSES to write on probe_failed when row already exists (silent-corruption guard)', () => {
    // This is the load-bearing case. If we wrote NULL here, a previously
    // classified row could be regressed by a single transient HTTP 5xx. The
    // crawler's upsertCapabilities does ON CONFLICT DO UPDATE inferred_type,
    // so a NULL write would clobber 'sales' / 'creative' / 'signals'.
    expect(decideWrite('probe_failed', 'unknown', true))
      .toEqual({ write: false, reason: 'preserve_existing' });
    expect(decideWrite('dns_failed', 'unknown', true))
      .toEqual({ write: false, reason: 'preserve_existing' });
  });

  it('REFUSES to write on probe_failed for new agents (no ground truth)', () => {
    expect(decideWrite('probe_failed', 'unknown', false))
      .toEqual({ write: false, reason: 'no_ground_truth' });
    expect(decideWrite('dns_failed', 'unknown', false))
      .toEqual({ write: false, reason: 'no_ground_truth' });
  });
});

describe('reprobe probeOne — end-to-end with mocked deps', () => {
  function makeAgent(overrides: Partial<AgentToProbe> = {}): AgentToProbe {
    return {
      url: 'https://agent.example/',
      protocol: 'mcp',
      name: 'agent',
      hadSnapshot: true,
      ...overrides,
    };
  }

  it('(a) successful classification path: writes the new type via upsert', async () => {
    const upsert = vi.fn(async () => undefined);
    const profile: AgentCapabilityProfile = {
      agent_url: 'https://agent.example/',
      protocol: 'mcp',
      discovered_tools: [],
      last_discovered: new Date().toISOString(),
    };
    const out = await probeOne(
      makeAgent(),
      {
        discoverCapabilities: vi.fn(async () => profile),
        inferTypeFromProfile: vi.fn(() => 'sales' as const),
        upsertCapabilities: upsert,
        timeoutMs: 100,
        now: () => 1000,
      },
      false,
    );
    expect(out.classification).toBe('classified');
    expect(out.inferred).toBe('sales');
    expect(out.preserved_existing).toBe(false);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledWith(profile, 'sales');
  });

  it('(b) probe-failed path (timeout): does NOT call upsert; reports preserved_existing=true', async () => {
    const upsert = vi.fn(async () => undefined);
    // Hang past the timeout to force the timeout race rejection.
    const out = await probeOne(
      makeAgent({ hadSnapshot: true }),
      {
        discoverCapabilities: () => new Promise(() => {}),
        inferTypeFromProfile: () => 'unknown',
        upsertCapabilities: upsert,
        timeoutMs: 10,
      },
      false,
    );
    expect(out.classification).toBe('probe_failed');
    expect(out.preserved_existing).toBe(true);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('(c) DNS-failed path (NXDOMAIN): routes to dns_failed, no upsert', async () => {
    const upsert = vi.fn(async () => undefined);
    const out = await probeOne(
      makeAgent({ hadSnapshot: true }),
      {
        discoverCapabilities: async () => {
          throw new Error('getaddrinfo ENOTFOUND nope.example');
        },
        inferTypeFromProfile: () => 'unknown',
        upsertCapabilities: upsert,
        timeoutMs: 1000,
      },
      false,
    );
    expect(out.classification).toBe('dns_failed');
    expect(out.preserved_existing).toBe(true);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('(c2) DNS-shaped error inside discovery_error field also routes to dns_failed', async () => {
    const upsert = vi.fn(async () => undefined);
    const profile: AgentCapabilityProfile = {
      agent_url: 'https://agent.example/',
      protocol: 'mcp',
      discovered_tools: [],
      last_discovered: new Date().toISOString(),
      discovery_error: 'connect ECONNREFUSED 127.0.0.1:443',
    };
    const out = await probeOne(
      makeAgent({ hadSnapshot: true }),
      {
        discoverCapabilities: async () => profile,
        inferTypeFromProfile: () => 'unknown',
        upsertCapabilities: upsert,
        timeoutMs: 1000,
      },
      false,
    );
    expect(out.classification).toBe('dns_failed');
    expect(out.preserved_existing).toBe(true);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('(c3) HTTP-5xx-shaped discovery_error routes to probe_failed (not dns_failed)', async () => {
    const upsert = vi.fn(async () => undefined);
    const profile: AgentCapabilityProfile = {
      agent_url: 'https://agent.example/',
      protocol: 'mcp',
      discovered_tools: [],
      last_discovered: new Date().toISOString(),
      discovery_error: 'HTTP 503 Service Unavailable',
    };
    const out = await probeOne(
      makeAgent({ hadSnapshot: true }),
      {
        discoverCapabilities: async () => profile,
        inferTypeFromProfile: () => 'unknown',
        upsertCapabilities: upsert,
        timeoutMs: 1000,
      },
      false,
    );
    expect(out.classification).toBe('probe_failed');
    expect(out.preserved_existing).toBe(true);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('(d) idempotency: probe succeeds (still_unknown) — write of NULL is safe because row was already null', async () => {
    // A re-run on a known-NULL row that the second probe also can't classify.
    // Writing NULL here is a no-op against the existing NULL row, so this
    // path is allowed (and gives us a fresh last_discovered timestamp).
    const upsert = vi.fn(async () => undefined);
    const profile: AgentCapabilityProfile = {
      agent_url: 'https://agent.example/',
      protocol: 'mcp',
      discovered_tools: [{ name: 'mystery_tool', description: '', input_schema: {}, verified_at: '' }],
      last_discovered: new Date().toISOString(),
    };
    const out = await probeOne(
      makeAgent({ hadSnapshot: true }),
      {
        discoverCapabilities: async () => profile,
        inferTypeFromProfile: () => 'unknown',
        upsertCapabilities: upsert,
        timeoutMs: 1000,
      },
      false,
    );
    expect(out.classification).toBe('still_unknown');
    expect(out.preserved_existing).toBe(false);
    expect(upsert).toHaveBeenCalledWith(profile, null);
  });

  it('(e) SILENT-CORRUPTION GUARD: a transient probe failure must NOT overwrite a prior classification', async () => {
    // Scenario: agent X was previously classified `sales` by another path
    // (e.g., a parallel crawler tick that raced ahead between our SELECT
    // and our probe). Our re-probe runs and hits a transient HTTP 5xx.
    // The script MUST refuse to call upsertCapabilities — otherwise the
    // ON CONFLICT DO UPDATE inferred_type=EXCLUDED would regress 'sales'
    // back to NULL on the snapshot row.
    const upsert = vi.fn(async () => undefined);
    const profile: AgentCapabilityProfile = {
      agent_url: 'https://agent.example/',
      protocol: 'mcp',
      discovered_tools: [],
      last_discovered: new Date().toISOString(),
      discovery_error: 'HTTP 503 Service Unavailable',
    };
    const out = await probeOne(
      // hadSnapshot=true: we know there's already a row. Its current state
      // is opaque to probeOne — the silent-corruption rule MUST hold even
      // if a parallel writer just classified the row as 'sales'.
      makeAgent({ hadSnapshot: true }),
      {
        discoverCapabilities: async () => profile,
        inferTypeFromProfile: () => 'unknown',
        upsertCapabilities: upsert,
        timeoutMs: 1000,
      },
      false,
    );
    expect(out.classification).toBe('probe_failed');
    expect(out.preserved_existing).toBe(true);
    // The load-bearing assertion: we did NOT touch the DB.
    expect(upsert).not.toHaveBeenCalled();
  });

  it('dry-run: never calls upsert even on the classified path', async () => {
    const upsert = vi.fn(async () => undefined);
    const profile: AgentCapabilityProfile = {
      agent_url: 'https://agent.example/',
      protocol: 'mcp',
      discovered_tools: [],
      last_discovered: new Date().toISOString(),
    };
    const out = await probeOne(
      makeAgent(),
      {
        discoverCapabilities: async () => profile,
        inferTypeFromProfile: () => 'creative' as const,
        upsertCapabilities: upsert,
        timeoutMs: 1000,
      },
      true, // dry-run
    );
    expect(out.classification).toBe('classified');
    expect(out.inferred).toBe('creative');
    expect(upsert).not.toHaveBeenCalled();
  });

  it('records per-agent elapsed_ms for the slow-tail report', async () => {
    let t = 1_000_000;
    const profile: AgentCapabilityProfile = {
      agent_url: 'https://agent.example/',
      protocol: 'mcp',
      discovered_tools: [],
      last_discovered: new Date().toISOString(),
    };
    const out = await probeOne(
      makeAgent(),
      {
        discoverCapabilities: async () => {
          t += 1234;
          return profile;
        },
        inferTypeFromProfile: () => 'sales' as const,
        upsertCapabilities: async () => undefined,
        now: () => t,
        timeoutMs: 5000,
      },
      true,
    );
    expect(out.elapsed_ms).toBe(1234);
  });
});
