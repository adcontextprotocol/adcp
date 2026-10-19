/**
 * The backlog signal (adcp#8338).
 *
 * A per-submission Slack post cannot show accumulation, and accumulation
 * is exactly what the #8337 fail-safe produces during an Anthropic outage
 * or on a deployment with no `ANTHROPIC_API_KEY`. The digest is the
 * moderator-facing count-and-oldest-age signal; this file pins when it
 * fires, what it says, and that nothing submitter-authored rides along.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.REGISTRY_EDITS_CHANNEL_ID = 'C_REGISTRY';
  process.env.APP_URL = 'https://agenticadvertising.org';
});

const mocks = vi.hoisted(() => ({
  getBacklog: vi.fn(),
  sendChannelMessage: vi.fn(async () => 'ts.1'),
  isSlackConfigured: vi.fn(() => true),
}));

vi.mock('../../src/db/registry-review-queue-db.js', () => ({
  getRegistryReviewBacklog: mocks.getBacklog,
}));

vi.mock('../../src/slack/client.js', () => ({
  sendChannelMessage: mocks.sendChannelMessage,
  isSlackConfigured: mocks.isSlackConfigured,
}));

import {
  runRegistryReviewDigestJob,
  STALE_THRESHOLD_HOURS,
} from '../../src/addie/jobs/registry-review-digest.js';

function backlog(overrides: Record<string, unknown> = {}) {
  return {
    pending_brands: 3,
    pending_properties: 1,
    pending_records: 4,
    flagged_edits: 2,
    total: 6,
    oldest_created_at: '2026-10-01T00:00:00.000Z',
    oldest_age_hours: 96,
    generated_at: '2026-10-05T00:00:00.000Z',
    ...overrides,
  };
}

/** The mrkdwn body of the posted message. */
function postedText(): string {
  const call = mocks.sendChannelMessage.mock.calls.at(-1) as
    | [string, { text: string; blocks: Array<{ text: { text: string } }> }]
    | undefined;
  expect(call).toBeDefined();
  return call![1].blocks[0].text.text;
}

describe('registry review backlog digest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isSlackConfigured.mockReturnValue(true);
  });

  it('stays quiet when nothing is waiting', async () => {
    mocks.getBacklog.mockResolvedValue(backlog({
      pending_brands: 0, pending_properties: 0, pending_records: 0,
      flagged_edits: 0, total: 0, oldest_created_at: null, oldest_age_hours: null,
    }));

    const result = await runRegistryReviewDigestJob();

    expect(result).toMatchObject({ total: 0, posted: false });
    expect(mocks.sendChannelMessage).not.toHaveBeenCalled();
  });

  it('stays quiet while the queue is still fresh', async () => {
    mocks.getBacklog.mockResolvedValue(backlog({ oldest_age_hours: STALE_THRESHOLD_HOURS - 1 }));

    const result = await runRegistryReviewDigestJob();

    expect(result.posted).toBe(false);
    expect(mocks.sendChannelMessage).not.toHaveBeenCalled();
  });

  it('posts the count and the oldest age once the queue goes stale', async () => {
    mocks.getBacklog.mockResolvedValue(backlog());

    const result = await runRegistryReviewDigestJob();

    expect(result).toMatchObject({
      total: 6,
      pendingRecords: 4,
      flaggedEdits: 2,
      oldestAgeHours: 96,
      posted: true,
    });

    const text = postedText();
    expect(text).toContain('6 registry submissions waiting on a moderator');
    expect(text).toContain('4 pending records');
    expect(text).toContain('2 live edits');
    // 96h reads as days, which is the number that makes an outage obvious.
    expect(text).toContain('*4d*');
    expect(text).toContain('/admin/registry-review');
  });

  it('reports a single waiting submission in the singular', async () => {
    mocks.getBacklog.mockResolvedValue(backlog({
      pending_brands: 1, pending_properties: 0, pending_records: 1,
      flagged_edits: 0, total: 1, oldest_age_hours: 50,
    }));

    await runRegistryReviewDigestJob();

    const text = postedText();
    expect(text).toContain('1 registry submission waiting on a moderator');
    expect(text).toContain('1 pending record ');
  });

  it('carries no submitter- or model-authored text into the channel', async () => {
    mocks.getBacklog.mockResolvedValue(backlog());

    await runRegistryReviewDigestJob();

    // The message is composed entirely of platform-computed counts, ages
    // and a fixed link. Per-record detail — domains, edit summaries, the
    // model's reason — belongs on the admin page, not in a line the room
    // reads as platform copy (adcp#8320, #8330).
    const [, message] = mocks.sendChannelMessage.mock.calls.at(-1) as [string, { text: string }];
    const body = JSON.stringify(message);
    expect(body).not.toMatch(/<!channel>|<!here>|<@U/);
    expect(message.text).toBe('6 registry submissions waiting on a moderator');
  });

  it('reports not-posted when Slack is unconfigured rather than throwing', async () => {
    mocks.isSlackConfigured.mockReturnValue(false);
    mocks.getBacklog.mockResolvedValue(backlog());

    const result = await runRegistryReviewDigestJob();

    expect(result.posted).toBe(false);
    expect(mocks.sendChannelMessage).not.toHaveBeenCalled();
  });

  it('reports not-posted when the Slack call fails', async () => {
    mocks.getBacklog.mockResolvedValue(backlog());
    mocks.sendChannelMessage.mockRejectedValueOnce(new Error('channel_not_found'));

    const result = await runRegistryReviewDigestJob();

    expect(result.posted).toBe(false);
    expect(result.total).toBe(6);
  });
});
