import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const resolveGitHubToken = vi.fn();
const fetchMock = vi.fn();

vi.mock('../../src/addie/jobs/github-app-token.js', () => ({
  resolveGitHubToken,
}));

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function hoursAgoIso(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

interface FixtureIssue {
  number: number;
  title: string;
  html_url: string;
  created_at: string;
  milestone: { title: string } | null;
  labels: Array<{ name: string }>;
}

function fixtureIssue(overrides: Partial<FixtureIssue> & { number: number }): FixtureIssue {
  return {
    title: `Issue ${overrides.number}`,
    html_url: `https://github.com/adcontextprotocol/adcp/issues/${overrides.number}`,
    created_at: daysAgoIso(1),
    milestone: null,
    labels: [],
    ...overrides,
  };
}

function searchResult(items: FixtureIssue[], totalCount?: number) {
  return { total_count: totalCount ?? items.length, items };
}

const REPO = 'adcontextprotocol/adcp';

/** Mutable fixture state read by the routing fetch mock below. Each test
 *  only needs to override the slice(s) it cares about; everything else
 *  falls back to an empty-but-valid default. */
let state: {
  needsAttentionMilestone: ReturnType<typeof searchResult>;
  needsAttentionPriority: ReturnType<typeof searchResult>;
  triageNoMilestone: ReturnType<typeof searchResult>;
  triageStuck: ReturnType<typeof searchResult>;
  waitingOnWg: ReturnType<typeof searchResult>;
  burnDownPrs: ReturnType<typeof searchResult>;
  milestones: Array<{ number: number; title: string; open_issues: number; closed_issues: number }>;
};

function resetState() {
  state = {
    needsAttentionMilestone: searchResult([]),
    needsAttentionPriority: searchResult([]),
    triageNoMilestone: searchResult([]),
    triageStuck: searchResult([]),
    waitingOnWg: searchResult([]),
    burnDownPrs: searchResult([]),
    milestones: [
      { number: 7, title: '3.2.0', open_issues: 118, closed_issues: 17 },
      { number: 8, title: 'P0 Bugs', open_issues: 2, closed_issues: 23 },
      { number: 9, title: 'Spec Backlog', open_issues: 77, closed_issues: 38 },
      { number: 5, title: '4.0', open_issues: 36, closed_issues: 4 },
    ],
  };
}

function routeFetch(url: string): Response {
  const parsed = new URL(url);
  if (parsed.pathname === '/search/issues') {
    const q = parsed.searchParams.get('q') || '';
    if (q.includes('milestone:"P0 Bugs"')) return json(state.needsAttentionMilestone);
    if (q.includes('"priority:P0","priority:P1"')) return json(state.needsAttentionPriority);
    if (q.includes('no:milestone')) return json(state.triageNoMilestone);
    if (q.includes('label:"claude-triaging"')) return json(state.triageStuck);
    if (q.includes('label:"needs-wg-review"')) return json(state.waitingOnWg);
    if (q.includes('is:pr')) return json(state.burnDownPrs);
    throw new Error(`Unexpected search query in test: ${q}`);
  }
  if (parsed.pathname.endsWith('/milestones')) return json(state.milestones);
  throw new Error(`Unexpected URL in test: ${url}`);
}

describe('secretariat queues snapshot', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    resetState();
    vi.stubGlobal('fetch', fetchMock);
    resolveGitHubToken.mockResolvedValue('test-token');
    fetchMock.mockImplementation(async (url: string) => routeFetch(url));
    // The module keeps an in-memory cache across dynamic imports within this
    // file (Node caches the resolved module); clear it so each test starts
    // from a guaranteed cache miss regardless of execution order.
    const { resetQueuesCache } = await import('../../src/addie/jobs/secretariat-queues.js');
    resetQueuesCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('unions the P0 Bugs milestone with priority:P0/P1 labels, dedupes by issue number, and tags each item', async () => {
    // #1 comes back from the milestone query only (no priority label on this copy).
    const issue1 = fixtureIssue({ number: 1, created_at: daysAgoIso(10), milestone: { title: 'P0 Bugs' } });
    // #1 also matches the priority query (real overlap) — must not be double-counted.
    const issue1FromPriority = fixtureIssue({ number: 1, created_at: daysAgoIso(10), labels: [{ name: 'priority:P0' }] });
    const issue2 = fixtureIssue({ number: 2, created_at: daysAgoIso(5), labels: [{ name: 'priority:P0' }] });
    const issue3 = fixtureIssue({ number: 3, created_at: daysAgoIso(20), labels: [{ name: 'priority:P1' }] });
    const issue4 = fixtureIssue({ number: 4, created_at: daysAgoIso(1), labels: [{ name: 'priority:P0' }, { name: 'priority:P1' }] });

    state.needsAttentionMilestone = searchResult([issue1]);
    state.needsAttentionPriority = searchResult([issue1FromPriority, issue2, issue3, issue4]);

    const { buildQueuesSnapshot } = await import('../../src/addie/jobs/secretariat-queues.js');
    const snapshot = await buildQueuesSnapshot(REPO);

    expect(snapshot).not.toBeNull();
    const needsAttention = snapshot!.needsAttention;
    expect(needsAttention.count).toBe(4);
    expect(needsAttention.items.map((i) => i.number)).toEqual([3, 1, 2, 4]); // oldest first
    expect(needsAttention.items.find((i) => i.number === 1)!.tags).toEqual(['P0']); // via milestone match
    expect(needsAttention.items.find((i) => i.number === 2)!.tags).toEqual(['P0']);
    expect(needsAttention.items.find((i) => i.number === 3)!.tags).toEqual(['P1']);
    expect(needsAttention.items.find((i) => i.number === 4)!.tags).toEqual(['P0', 'P1']);
    expect(needsAttention.viewAllUrl).toBe(
      `https://github.com/${REPO}/issues?q=${encodeURIComponent('is:issue is:open label:"priority:P0","priority:P1"')}`
    );
  });

  it('triage counts no:milestone total_count plus stuck-triaging issues that already carry a milestone', async () => {
    const noMilestoneA = fixtureIssue({ number: 10, created_at: daysAgoIso(8) });
    const noMilestoneB = fixtureIssue({ number: 11, created_at: daysAgoIso(2) });
    // Stuck issue that already has a milestone — the one case `no:milestone` can't cover.
    const stuckWithMilestone = fixtureIssue({
      number: 12,
      created_at: hoursAgoIso(3),
      milestone: { title: 'Spec Backlog' },
      labels: [{ name: 'claude-triaging' }],
    });
    // Stuck issue with no milestone — already implied by no:milestone's total_count.
    const stuckNoMilestone = fixtureIssue({
      number: 13,
      created_at: daysAgoIso(6),
      labels: [{ name: 'claude-triaging' }],
    });

    state.triageNoMilestone = searchResult([noMilestoneA, noMilestoneB], 50);
    state.triageStuck = searchResult([stuckWithMilestone, stuckNoMilestone]);

    const { buildQueuesSnapshot } = await import('../../src/addie/jobs/secretariat-queues.js');
    const snapshot = await buildQueuesSnapshot(REPO);

    const triage = snapshot!.triage;
    // 50 (no:milestone total_count) + 1 (the one stuck issue that carries a milestone)
    expect(triage.count).toBe(51);
    expect(triage.items.map((i) => i.number)).toEqual([10, 13, 11, 12]); // oldest first
    expect(triage.items.find((i) => i.number === 12)!.tags).toEqual(['stuck triaging']);
    expect(triage.items.find((i) => i.number === 13)!.tags).toEqual(['no milestone', 'stuck triaging']);
    expect(triage.items.find((i) => i.number === 10)!.tags).toEqual(['no milestone']);
    expect(triage.viewAllUrl).toBe(
      `https://github.com/${REPO}/issues?q=${encodeURIComponent('is:issue is:open no:milestone')}`
    );
  });

  it('buckets waiting-on-WG issues by age and reports the exact total_count regardless of page size', async () => {
    const fresh = fixtureIssue({ number: 20, created_at: daysAgoIso(3) });
    const mid = fixtureIssue({ number: 21, created_at: daysAgoIso(10) });
    const stale = fixtureIssue({ number: 22, created_at: daysAgoIso(45) });
    state.waitingOnWg = searchResult([fresh, mid, stale], 116);

    const { buildQueuesSnapshot } = await import('../../src/addie/jobs/secretariat-queues.js');
    const snapshot = await buildQueuesSnapshot(REPO);

    const waitingOnWg = snapshot!.waitingOnWg;
    expect(waitingOnWg.count).toBe(116);
    expect(waitingOnWg.ageBuckets).toEqual({ under7d: 1, d7to30d: 1, over30d: 1 });
    expect(waitingOnWg.items).toHaveLength(3);
  });

  it('reports the 3.2 burn-down from milestone open/closed counts plus a context row of nearby milestones', async () => {
    state.burnDownPrs = searchResult([], 1);

    const { buildQueuesSnapshot } = await import('../../src/addie/jobs/secretariat-queues.js');
    const snapshot = await buildQueuesSnapshot(REPO);

    expect(snapshot!.burnDown).toEqual({
      milestoneTitle: '3.2.0',
      closedIssues: 17,
      openIssues: 118,
      openPrs: 1,
      otherMilestones: [
        { title: 'P0 Bugs', openIssues: 2 },
        { title: 'Spec Backlog', openIssues: 77 },
        { title: '4.0', openIssues: 36 },
      ],
      viewAllUrl: `https://github.com/${REPO}/milestone/7`,
    });
  });

  it('returns null without calling GitHub when no credential is available', async () => {
    resolveGitHubToken.mockResolvedValue(null);

    const { buildQueuesSnapshot } = await import('../../src/addie/jobs/secretariat-queues.js');
    const snapshot = await buildQueuesSnapshot(REPO);

    expect(snapshot).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null for the whole snapshot when any underlying GitHub lookup fails', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/milestones')) return json({ message: 'boom' }, 500);
      return routeFetch(url);
    });

    const { buildQueuesSnapshot } = await import('../../src/addie/jobs/secretariat-queues.js');
    const snapshot = await buildQueuesSnapshot(REPO);

    expect(snapshot).toBeNull();
  });

  it('caches a snapshot for repeat callers and only refetches after resetQueuesCache', async () => {
    const { getQueuesSnapshot, resetQueuesCache } = await import('../../src/addie/jobs/secretariat-queues.js');

    await getQueuesSnapshot(REPO);
    const callsAfterFirst = fetchMock.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    await getQueuesSnapshot(REPO);
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst); // cache hit, no new fetches

    resetQueuesCache();
    await getQueuesSnapshot(REPO);
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst * 2);
  });

  it('serves the last good snapshot marked stale when a refresh fails, and recovers', async () => {
    const { getQueuesSnapshot } = await import('../../src/addie/jobs/secretariat-queues.js');
    vi.useFakeTimers();
    try {
      const first = await getQueuesSnapshot(REPO);
      expect(first).not.toBeNull();
      expect(first?.stale).toBeUndefined();

      // Expire the cache, then make every GitHub call fail.
      vi.setSystemTime(Date.now() + 6 * 60_000);
      fetchMock.mockImplementation(async () => {
        throw new Error('GitHub down');
      });
      const fallback = await getQueuesSnapshot(REPO);
      expect(fallback).not.toBeNull();
      expect(fallback?.stale).toBe(true);
      expect(fallback?.needsAttention).toEqual(first?.needsAttention);
      expect(fallback?.fetchedAt).toBe(first?.fetchedAt);

      // GitHub healthy again: next expired read refreshes and clears stale.
      fetchMock.mockImplementation(async (url: string) => routeFetch(url));
      vi.setSystemTime(Date.now() + 6 * 60_000);
      const recovered = await getQueuesSnapshot(REPO);
      expect(recovered?.stale).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
