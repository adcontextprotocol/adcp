import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  ageInDays,
  bucketForSummary,
  extractAaoUrls,
  extractReferencedEscalationIds,
} from '../../src/addie/jobs/escalation-triage-signals.js';

const mocks = vi.hoisted(() => ({
  getEscalation: vi.fn(),
  probeUrlStatus: vi.fn(),
}));

vi.mock('../../src/db/escalation-db.js', () => ({
  getEscalation: mocks.getEscalation,
  listEscalations: vi.fn(),
}));

vi.mock('../../src/addie/jobs/escalation-triage-signals.js', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, probeUrlStatus: mocks.probeUrlStatus };
});

import { buildGithubIssueDraft, classifyEscalation } from '../../src/addie/jobs/escalation-triage.js';

describe('escalation-triage signals', () => {
  it('extracts agenticadvertising.org URLs from free text and strips trailing punctuation', () => {
    const urls = extractAaoUrls(
      'Bug: the page at https://agenticadvertising.org/terms returns 404; also https://agenticadvertising.org/dashboard/team.',
    );
    expect(urls).toEqual([
      'https://agenticadvertising.org/terms',
      'https://agenticadvertising.org/dashboard/team',
    ]);
  });

  it('returns [] for null/empty/no-match input', () => {
    expect(extractAaoUrls(null)).toEqual([]);
    expect(extractAaoUrls('')).toEqual([]);
    expect(extractAaoUrls('no urls here')).toEqual([]);
  });

  it('parses "Cancel escalation #96" and "Follow-up to escalation #275"', () => {
    expect(extractReferencedEscalationIds('Cancel escalation #96 - user has self-generated a Zoom link'))
      .toEqual([96]);
    expect(extractReferencedEscalationIds('Follow-up to escalation #275: email provided'))
      .toEqual([275]);
    expect(extractReferencedEscalationIds('FOLLOW-UP on escalation 283: receipt number provided'))
      .toEqual([283]);
  });

  it('does not match arbitrary "#123" occurrences outside escalation context', () => {
    expect(extractReferencedEscalationIds('See ticket #123 for details')).toEqual([]);
  });

  it('does not match bare "escalation 42" outside a cancel/follow-up prefix', () => {
    expect(extractReferencedEscalationIds('Also see escalation 42 for background')).toEqual([]);
  });

  it('computes age in whole days', () => {
    const now = new Date('2026-04-24T12:00:00Z');
    expect(ageInDays(new Date('2026-04-24T00:00:00Z'), now)).toBe(0);
    expect(ageInDays('2026-04-22T12:00:00Z', now)).toBe(2);
    expect(ageInDays('2026-01-29T00:00:00Z', now)).toBe(85);
  });

  it('buckets summaries heuristically', () => {
    expect(bucketForSummary('Bug: /terms returns 404')).toBe('bug');
    expect(bucketForSummary('Needs a Stripe payment link')).toBe('billing');
    expect(bucketForSummary('Please invite Sarah to the workspace')).toBe('invite');
    expect(bucketForSummary('Wants to publish a blog post')).toBe('content');
    expect(bucketForSummary('Something unclassifiable about organizations')).toBe('ops-other');
    expect(bucketForSummary(null)).toBe('ops-other');
  });

  it('does NOT classify "returns 200" or "returns 301" as bug (success status ≠ bug)', () => {
    // Regression: an earlier regex used `returns \w` which inverted verdicts
    // on success signals. The bug-keyword list must not match these.
    expect(bucketForSummary('The /terms page now returns 200 after the fix')).not.toBe('bug');
    expect(bucketForSummary('Page returns 301 redirect as expected')).not.toBe('bug');
  });
});

describe('classifyEscalation', () => {
  beforeEach(() => {
    mocks.getEscalation.mockReset();
    mocks.probeUrlStatus.mockReset();
  });

  function esc(overrides: Partial<Record<string, unknown>> = {}) {
    // Default: 3 days old so stale-ops rule doesn't fire unless the test opts in.
    return {
      id: 1,
      thread_id: null,
      message_id: null,
      slack_user_id: null,
      workos_user_id: null,
      user_display_name: null,
      user_email: null,
      user_slack_handle: null,
      category: 'needs_human_action',
      priority: 'normal',
      summary: 'A generic support request',
      original_request: null,
      addie_context: null,
      notification_channel_id: null,
      notification_sent_at: null,
      notification_message_ts: null,
      status: 'open',
      resolved_by: null,
      resolved_at: null,
      resolution_notes: null,
      perspective_id: null,
      perspective_slug: null,
      created_at: new Date(Date.now() - 3 * 86_400_000),
      updated_at: new Date(Date.now() - 3 * 86_400_000),
      ...overrides,
    } as Parameters<typeof classifyEscalation>[0];
  }

  it('high-confidence resolve for cancellations of a resolved escalation', async () => {
    mocks.getEscalation.mockResolvedValue({ id: 96, status: 'resolved' });
    const v = await classifyEscalation(
      esc({ id: 97, summary: 'Cancel escalation #96 - user no longer needs help.' }),
      21,
    );
    expect(v?.suggested_status).toBe('resolved');
    expect(v?.confidence).toBe('high');
    expect(v?.evidence).toEqual(expect.arrayContaining(['ref=#96 status=resolved']));
  });

  it('no verdict when the referenced escalation is still open', async () => {
    mocks.getEscalation.mockResolvedValue({ id: 275, status: 'open' });
    const v = await classifyEscalation(
      esc({ id: 276, summary: 'Follow-up to escalation #275: here is the email' }),
      21,
    );
    expect(v).toBeNull();
  });

  it('suggests file_as_issue when the referenced URL still 404s and bucket is bug', async () => {
    mocks.probeUrlStatus.mockResolvedValue(404);
    const v = await classifyEscalation(
      esc({ summary: 'Bug: https://agenticadvertising.org/terms returns 404' }),
      21,
    );
    expect(v?.suggested_status).toBe('file_as_issue');
    expect(v?.confidence).toBe('medium');
    expect(v?.proposed_github_issue).toBeDefined();
    expect(v?.proposed_github_issue?.repo).toContain('/');
    expect(v?.proposed_github_issue?.labels).toEqual(expect.arrayContaining(['from-escalation', 'needs-triage']));
  });

  it('does not re-propose file_as_issue when the escalation already has a github_issue_url', async () => {
    mocks.probeUrlStatus.mockResolvedValue(404);
    const v = await classifyEscalation(
      esc({
        summary: 'Bug: https://agenticadvertising.org/terms returns 404',
        github_issue_url: 'https://github.com/adcontextprotocol/adcp/issues/9999',
      }),
      21,
    );
    expect(v).toBeNull();
  });

  it('medium-confidence resolve when URL now responds successfully', async () => {
    mocks.probeUrlStatus.mockResolvedValue(301);
    const v = await classifyEscalation(
      esc({ summary: 'Bug: https://agenticadvertising.org/terms cannot GET /terms' }),
      21,
    );
    expect(v?.suggested_status).toBe('resolved');
    expect(v?.confidence).toBe('medium');
    expect(v?.bucket).toBe('bug');
  });

  it('low-confidence resolve for stale non-bug ops bucket', async () => {
    const v = await classifyEscalation(
      esc({
        summary: 'Please resend the invoice to David at dlc@corp.com',
        created_at: new Date(Date.now() - 40 * 86_400_000),
      }),
      21,
    );
    expect(v?.suggested_status).toBe('resolved');
    expect(v?.confidence).toBe('low');
    expect(v?.bucket).toBe('billing');
  });

  it('returns null for recent ops escalations', async () => {
    const v = await classifyEscalation(
      esc({
        summary: 'Please resend the invoice',
        created_at: new Date(Date.now() - 3 * 86_400_000),
      }),
      21,
    );
    expect(v).toBeNull();
  });

  it('ignores self-references (N === escalation.id) in cancellation summaries', async () => {
    // Guards against a bad regex regression that would silently self-resolve.
    const v = await classifyEscalation(
      esc({ id: 97, summary: 'Cancel escalation #97 - duplicate filed by mistake' }),
      21,
    );
    // getEscalation should never be called for self-ref — test fails if mock returned resolved.
    expect(mocks.getEscalation).not.toHaveBeenCalledWith(97);
    expect(v).toBeNull();
  });

  it('sanitises @mentions and image tags that could inject into the filed issue', async () => {
    const draft = buildGithubIssueDraft(
      {
        ...esc({
          summary: 'Bug: @adcontextprotocol/core please fix this.',
          addie_context: 'User pasted ![tracking](https://evil.example/pixel.gif) inline.',
        }),
      } as Parameters<typeof buildGithubIssueDraft>[0],
      [],
    );

    expect(draft.body).not.toMatch(/(^|\s)@adcontextprotocol\/core/);
    expect(draft.body).toContain('`@adcontextprotocol`');
    expect(draft.body).not.toContain('![tracking]');
    expect(draft.body).toContain('[tracking](');
  });

  it('omits user PII from the proposed issue body', async () => {
    // PII lives in dedicated columns (user_email, user_slack_handle,
    // user_display_name) and in original_request, which we skip entirely.
    // The body must only carry Addie-authored text (summary + addie_context).
    const draft = buildGithubIssueDraft(
      {
        ...esc({
          summary: 'Bug: /some-page is broken when users visit it',
          user_email: 'pii@example.com',
          user_slack_handle: 'pii-slack',
          user_display_name: 'Jane Doe',
          original_request: 'Hi team, I am jane.doe@example.com and my page broke',
          addie_context: 'User confirmed the issue; capturing for platform review.',
        }),
      } as Parameters<typeof buildGithubIssueDraft>[0],
      ['https://agenticadvertising.org/some-page'],
    );

    expect(draft.body).not.toContain('pii@example.com');
    expect(draft.body).not.toContain('pii-slack');
    expect(draft.body).not.toContain('Jane Doe');
    expect(draft.body).not.toContain('jane.doe@example.com');
    expect(draft.body).toContain('## Summary');
    expect(draft.body).toContain('Bug: /some-page is broken');
  });

  it('returns null (no signal) when every URL probe fails, even for stale ops-bucket content', async () => {
    // Probe returning null for every URL shouldn't silently fall through to
    // Rule 3 when the summary actually describes a bug — that would flip the
    // verdict on a genuine network-error day. Default here is bug-bucket via
    // "Bug:" prefix, so stale-ops must NOT apply.
    mocks.probeUrlStatus.mockResolvedValue(null);
    const v = await classifyEscalation(
      esc({
        summary: 'Bug: https://agenticadvertising.org/terms returns an error',
        created_at: new Date(Date.now() - 60 * 86_400_000),
      }),
      21,
    );
    expect(v).toBeNull();
  });
});
