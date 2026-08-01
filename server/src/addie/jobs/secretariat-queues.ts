/**
 * GitHub-backed data for the Secretariat console's Queues dashboard.
 *
 * Assembles four panels from the GitHub REST/search API: P0/P1 issues
 * needing attention, unrouted triage, the WG-review backlog, and the 3.2
 * burn-down. Read-only — this module never writes to GitHub. Results are
 * cached for QUEUES_CACHE_TTL_MS since none of these panels need to be
 * real-time.
 *
 * Kept separate from server/src/routes/secretariat-admin.ts so the
 * query/merge/dedupe logic can be unit tested without pulling in the
 * WorkOS auth stack that route file's Express middleware depends on.
 */

import { createLogger } from '../../logger.js';
import { resolveGitHubToken } from './github-app-token.js';

const logger = createLogger('secretariat-queues');

const API_TIMEOUT_MS = 10_000;
const SEARCH_PAGE_SIZE = 100;
const MAX_QUEUE_ITEMS = 8;
const QUEUES_CACHE_TTL_MS = 5 * 60_000;

const NEEDS_WG_REVIEW_LABEL = 'needs-wg-review';
const P0_MILESTONE_TITLE = 'P0 Bugs';
const PRIORITY_P0_LABEL = 'priority:P0';
const PRIORITY_P1_LABEL = 'priority:P1';
const CLAUDE_TRIAGING_LABEL = 'claude-triaging';
/** How long a `claude-triaging` label can sit before we call it stuck. The
 *  routine normally swaps it for `claude-triaged` in 1-3 minutes; the
 *  clear-stuck-claude-triaging workflow already sweeps anything over 30
 *  minutes, so 1 hour here means "the sweep missed one too." */
const CLAUDE_TRIAGING_STUCK_MS = 60 * 60_000;
const BURNDOWN_MILESTONE_TITLE = '3.2.0';
const CONTEXT_MILESTONE_TITLES = ['P0 Bugs', 'Spec Backlog', '4.0'];

async function ghFetch(token: string, url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'aao-secretariat/1.0',
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

interface GhSearchIssue {
  number: number;
  title: string;
  html_url: string;
  created_at: string;
  milestone: { title: string } | null;
  labels: Array<{ name: string } | string>;
}

interface GhSearchResult {
  total_count: number;
  items: GhSearchIssue[];
}

interface GhMilestone {
  number: number;
  title: string;
  open_issues: number;
  closed_issues: number;
}

export interface QueueIssueSummary {
  number: number;
  title: string;
  url: string;
  ageDays: number;
  tags: string[];
}

export interface NeedsAttentionQueue {
  count: number;
  items: QueueIssueSummary[];
  viewAllUrl: string;
}

export interface TriageQueue {
  count: number;
  items: QueueIssueSummary[];
  viewAllUrl: string;
}

export interface WaitingOnWgQueue {
  count: number;
  ageBuckets: { under7d: number; d7to30d: number; over30d: number };
  items: QueueIssueSummary[];
  viewAllUrl: string;
}

export interface MilestoneContext {
  title: string;
  openIssues: number;
}

export interface BurnDownQueue {
  milestoneTitle: string;
  closedIssues: number;
  openIssues: number;
  openPrs: number;
  otherMilestones: MilestoneContext[];
  viewAllUrl: string;
}

export interface QueuesSnapshot {
  needsAttention: NeedsAttentionQueue;
  triage: TriageQueue;
  waitingOnWg: WaitingOnWgQueue;
  burnDown: BurnDownQueue;
  fetchedAt: string;
}

function ageInDays(createdAt: string): number {
  return Math.floor((Date.now() - new Date(createdAt).getTime()) / (24 * 60 * 60 * 1000));
}

function labelNames(issue: GhSearchIssue): string[] {
  return issue.labels.map((label) => (typeof label === 'string' ? label : label.name));
}

function toQueueItem(issue: GhSearchIssue, tags: string[]): QueueIssueSummary {
  return {
    number: issue.number,
    title: issue.title,
    url: issue.html_url,
    ageDays: ageInDays(issue.created_at),
    tags,
  };
}

/**
 * GitHub's search API rejects boolean OR across qualifier *types* ("Logical
 * operators only apply to text, not to qualifiers") — a comma-separated
 * list of values within a single `label:` qualifier is the one supported
 * OR shape. Anything that needs to union across qualifier types (e.g.
 * milestone OR label) runs as separate queries and gets merged/deduped
 * here instead.
 */
function mergeDedupIssues(...groups: GhSearchIssue[][]): GhSearchIssue[] {
  const byNumber = new Map<number, GhSearchIssue>();
  for (const group of groups) {
    for (const issue of group) {
      if (!byNumber.has(issue.number)) byNumber.set(issue.number, issue);
    }
  }
  return [...byNumber.values()].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );
}

/** Web-UI equivalent of the search query, so "view all on GitHub" always
 *  matches what the panel actually counted. */
function issuesWebUrl(repo: string, qualifiers: string): string {
  return `https://github.com/${repo}/issues?q=${encodeURIComponent(`is:issue is:open ${qualifiers}`)}`;
}

async function searchIssues(token: string, repo: string, qualifiers: string, isPr = false): Promise<GhSearchResult> {
  const query = `repo:${repo} ${isPr ? 'is:pr' : 'is:issue'} is:open ${qualifiers}`;
  const params = new URLSearchParams({
    q: query,
    sort: 'created',
    order: 'asc',
    per_page: String(SEARCH_PAGE_SIZE),
  });
  const resp = await ghFetch(token, `https://api.github.com/search/issues?${params.toString()}`);
  if (!resp.ok) {
    throw new Error(`GitHub issue search failed (${resp.status}) for: ${qualifiers}`);
  }
  return (await resp.json()) as GhSearchResult;
}

async function fetchMilestones(token: string, repo: string): Promise<GhMilestone[]> {
  const resp = await ghFetch(token, `https://api.github.com/repos/${repo}/milestones?state=all&per_page=100`);
  if (!resp.ok) {
    throw new Error(`GitHub milestones fetch failed: ${resp.status}`);
  }
  return (await resp.json()) as GhMilestone[];
}

/** P0/P1 — needs attention now: milestone `P0 Bugs` union label
 *  `priority:P0`/`priority:P1`, deduped. */
async function buildNeedsAttentionQueue(token: string, repo: string): Promise<NeedsAttentionQueue> {
  const priorityQualifier = `label:"${PRIORITY_P0_LABEL}","${PRIORITY_P1_LABEL}"`;
  const [milestoneResult, priorityResult] = await Promise.all([
    searchIssues(token, repo, `milestone:"${P0_MILESTONE_TITLE}"`),
    searchIssues(token, repo, priorityQualifier),
  ]);
  const merged = mergeDedupIssues(milestoneResult.items, priorityResult.items);
  const items = merged.slice(0, MAX_QUEUE_ITEMS).map((issue) => {
    const labels = labelNames(issue);
    const tags: string[] = [];
    if (issue.milestone?.title === P0_MILESTONE_TITLE || labels.includes(PRIORITY_P0_LABEL)) tags.push('P0');
    if (labels.includes(PRIORITY_P1_LABEL)) tags.push('P1');
    return toQueueItem(issue, tags);
  });
  return { count: merged.length, items, viewAllUrl: issuesWebUrl(repo, priorityQualifier) };
}

/** Triage — needs assignment/eval: no milestone assigned yet, plus anything
 *  stuck mid-triage (claude-triaging label older than the stuck threshold). */
async function buildTriageQueue(token: string, repo: string): Promise<TriageQueue> {
  const cutoffIso = new Date(Date.now() - CLAUDE_TRIAGING_STUCK_MS).toISOString();
  const noMilestoneQualifier = 'no:milestone';
  const [noMilestoneResult, stuckResult] = await Promise.all([
    searchIssues(token, repo, noMilestoneQualifier),
    searchIssues(token, repo, `label:"${CLAUDE_TRIAGING_LABEL}" updated:<${cutoffIso}`),
  ]);
  const merged = mergeDedupIssues(noMilestoneResult.items, stuckResult.items);
  // `no:milestone`'s total_count is authoritative for that half of the
  // union; the only items it can't already cover are stuck-triaging issues
  // that *do* carry a milestone.
  const stuckWithMilestone = stuckResult.items.filter((issue) => issue.milestone).length;
  const items = merged.slice(0, MAX_QUEUE_ITEMS).map((issue) => {
    const tags: string[] = [];
    if (!issue.milestone) tags.push('no milestone');
    if (labelNames(issue).includes(CLAUDE_TRIAGING_LABEL)) tags.push('stuck triaging');
    return toQueueItem(issue, tags);
  });
  return {
    count: noMilestoneResult.total_count + stuckWithMilestone,
    items,
    viewAllUrl: issuesWebUrl(repo, noMilestoneQualifier),
  };
}

/** Waiting on WG: open issues labeled `needs-wg-review`, bucketed by age. */
async function buildWaitingOnWgQueue(token: string, repo: string): Promise<WaitingOnWgQueue> {
  const qualifier = `label:"${NEEDS_WG_REVIEW_LABEL}"`;
  const result = await searchIssues(token, repo, qualifier);
  const ageBuckets = { under7d: 0, d7to30d: 0, over30d: 0 };
  // Buckets are computed from the fetched page (oldest-first, capped at
  // SEARCH_PAGE_SIZE); `count` below is exact via total_count regardless.
  // Once total_count exceeds the page size the freshest tier can undercount
  // since the newest items are the ones left off the page.
  for (const issue of result.items) {
    const age = ageInDays(issue.created_at);
    if (age < 7) ageBuckets.under7d++;
    else if (age <= 30) ageBuckets.d7to30d++;
    else ageBuckets.over30d++;
  }
  const items = result.items.slice(0, MAX_QUEUE_ITEMS).map((issue) => toQueueItem(issue, []));
  return { count: result.total_count, ageBuckets, items, viewAllUrl: issuesWebUrl(repo, qualifier) };
}

/** 3.2 burn-down: milestone progress plus a one-line context row of nearby
 *  milestones. Milestone open/closed counts come straight off the
 *  milestone object — no search needed. */
async function buildBurnDownQueue(token: string, repo: string): Promise<BurnDownQueue> {
  const [milestones, openPrsResult] = await Promise.all([
    fetchMilestones(token, repo),
    searchIssues(token, repo, `milestone:"${BURNDOWN_MILESTONE_TITLE}"`, true),
  ]);
  const byTitle = new Map(milestones.map((m) => [m.title, m]));
  const target = byTitle.get(BURNDOWN_MILESTONE_TITLE);
  const otherMilestones = CONTEXT_MILESTONE_TITLES.map((title) => ({
    title,
    openIssues: byTitle.get(title)?.open_issues ?? 0,
  }));
  const viewAllUrl = target
    ? `https://github.com/${repo}/milestone/${target.number}`
    : issuesWebUrl(repo, `milestone:"${BURNDOWN_MILESTONE_TITLE}"`);
  return {
    milestoneTitle: BURNDOWN_MILESTONE_TITLE,
    closedIssues: target?.closed_issues ?? 0,
    openIssues: target?.open_issues ?? 0,
    openPrs: openPrsResult.total_count,
    otherMilestones,
    viewAllUrl,
  };
}

/** Builds the full snapshot with no caching. Exported mainly for tests;
 *  callers wanting the cache should use `getQueuesSnapshot`. */
export async function buildQueuesSnapshot(repo: string): Promise<QueuesSnapshot | null> {
  const token = await resolveGitHubToken();
  if (!token) {
    logger.warn('No GitHub credential available; cannot build queues snapshot');
    return null;
  }
  try {
    const [needsAttention, triage, waitingOnWg, burnDown] = await Promise.all([
      buildNeedsAttentionQueue(token, repo),
      buildTriageQueue(token, repo),
      buildWaitingOnWgQueue(token, repo),
      buildBurnDownQueue(token, repo),
    ]);
    return { needsAttention, triage, waitingOnWg, burnDown, fetchedAt: new Date().toISOString() };
  } catch (error) {
    logger.warn({ err: error, repo }, 'Queues snapshot: GitHub lookup failed');
    return null;
  }
}

let queuesCache: { snapshot: QueuesSnapshot; expiresAtMs: number } | null = null;

export async function getQueuesSnapshot(repo: string): Promise<QueuesSnapshot | null> {
  if (queuesCache && queuesCache.expiresAtMs > Date.now()) {
    return queuesCache.snapshot;
  }
  const snapshot = await buildQueuesSnapshot(repo);
  if (snapshot) {
    queuesCache = { snapshot, expiresAtMs: Date.now() + QUEUES_CACHE_TTL_MS };
  }
  return snapshot;
}

/** Test seam: clear the in-memory cache between test cases. */
export function resetQueuesCache(): void {
  queuesCache = null;
}
