import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DigestRecord } from '../../src/db/digest-db.js';

const getLatestApprovedDigest = vi.fn();
const getDigestByDate = vi.fn();
const markSent = vi.fn();
const getDigestEmailRecipients = vi.fn();
const getUserWorkingGroupMap = vi.fn();
const sendTrackedBatchMarketingEmails = vi.fn();
const buildPromptMarkdown = vi.fn(() => 'Rendered Prompt markdown');
const publishDigestAsPerspective = vi.fn(async () => undefined);
const withNewsletterSendLock = vi.fn(async (_newsletterId: string, _editionId: number, work: () => Promise<unknown>) => ({
  acquired: true as const,
  value: await work(),
}));

vi.mock('../../src/db/digest-db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/db/digest-db.js')>();
  return {
    ...actual,
    createDigest: vi.fn(),
    getDigestByDate,
    getLatestApprovedDigest,
    setReviewMessage: vi.fn(),
    updateDigestContent: vi.fn(),
    markSent,
    getDigestEmailRecipients,
    getUserWorkingGroupMap,
    isLegacyContent: (content: unknown) =>
      !content || typeof content !== 'object' || (content as { contentVersion?: number }).contentVersion !== 2,
    getPersonaCluster: vi.fn(() => 'newcomer'),
  };
});

vi.mock('../../src/newsletters/the-prompt/index.js', () => ({
  thePromptConfig: {
    cadence: {
      generateHourET: 7,
      sendHourET: 10,
      shouldRunToday: vi.fn(() => false),
    },
    buildMarkdown: buildPromptMarkdown,
  },
}));

vi.mock('../../src/db/working-group-db.js', () => ({
  WorkingGroupDatabase: class {
    getWorkingGroupBySlug = vi.fn();
  },
}));

vi.mock('../../src/slack/client.js', () => ({
  sendChannelMessage: vi.fn(async () => ({ ok: true })),
}));

vi.mock('../../src/notifications/email.js', () => ({
  sendTrackedBatchMarketingEmails,
}));

vi.mock('../../src/addie/templates/weekly-digest.js', () => ({
  renderDigestEmail: vi.fn(() => ({ html: '<p>The Prompt</p>', text: 'The Prompt' })),
  renderDigestSlack: vi.fn(() => ({ text: 'The Prompt' })),
  renderDigestReview: vi.fn(() => ({ text: 'Review' })),
}));

vi.mock('../../src/addie/services/digest-builder.js', () => ({
  buildDigestContent: vi.fn(),
  hasMinimumContent: vi.fn(() => true),
  generateDigestSubject: vi.fn(() => 'The Prompt test subject'),
}));

vi.mock('../../src/addie/services/digest-publisher.js', () => ({
  publishDigestAsPerspective,
}));

vi.mock('../../src/newsletters/cover.js', () => ({
  generateCoverForEdition: vi.fn(),
}));

vi.mock('../../src/newsletters/send-lock.js', () => ({
  withNewsletterSendLock,
}));

vi.mock('../../src/db/newsletter-suggestions-db.js', () => ({
  markSuggestionsIncluded: vi.fn(),
}));

function approvedDigest(overrides: Partial<DigestRecord> = {}): DigestRecord {
  return {
    id: 123,
    edition_date: new Date('2026-06-05T00:00:00.000Z'),
    status: 'approved',
    approved_by: 'editor',
    approved_at: new Date('2026-06-12T14:22:39.869Z'),
    review_channel_id: null,
    review_message_ts: null,
    content: {
      contentVersion: 2,
      openingTake: 'Opening take',
      whatToWatch: [],
      fromTheInside: [],
      voices: [],
      newMembers: [],
      generatedAt: '2026-06-05T10:00:00.000Z',
    },
    created_at: new Date('2026-06-05T11:00:00.000Z'),
    sent_at: null,
    send_stats: null,
    perspective_id: null,
    has_cover_image: false,
    ...overrides,
  };
}

describe('runWeeklyDigestJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withNewsletterSendLock.mockImplementation(async (_newsletterId: string, _editionId: number, work: () => Promise<unknown>) => ({
      acquired: true as const,
      value: await work(),
    }));
    getDigestEmailRecipients.mockResolvedValue([
      {
        workos_user_id: 'user_123',
        email: 'reader@example.com',
        first_name: 'Reader',
        has_slack: false,
        persona: null,
        journey_stage: null,
        seat_type: 'contributor',
        wg_count: 0,
        cert_modules_completed: 0,
        cert_total_modules: 0,
        is_member: true,
        has_profile: true,
      },
    ]);
    getUserWorkingGroupMap.mockResolvedValue(new Map());
    sendTrackedBatchMarketingEmails.mockResolvedValue({ sent: 1, skipped: 0, failed: 0 });
    markSent.mockResolvedValue(true);
    getDigestByDate.mockResolvedValue(approvedDigest());
  });

  it('sends an older approved digest even when today is not a cadence day', async () => {
    getLatestApprovedDigest.mockResolvedValue(approvedDigest());

    const { runWeeklyDigestJob } = await import('../../src/addie/jobs/weekly-digest.js');
    const result = await runWeeklyDigestJob();

    expect(result.sent).toBe(1);
    expect(sendTrackedBatchMarketingEmails).toHaveBeenCalledTimes(1);
    expect(markSent).toHaveBeenCalledWith(123, expect.objectContaining({ email_count: 1 }));
    await vi.waitFor(() => {
      expect(buildPromptMarkdown).toHaveBeenCalledWith(expect.objectContaining({ openingTake: 'Opening take' }));
      expect(publishDigestAsPerspective).toHaveBeenCalledWith(
        123,
        expect.objectContaining({ openingTake: 'Opening take' }),
        '2026-06-05',
        'The Prompt test subject',
        'Rendered Prompt markdown',
      );
    });
    expect(getDigestByDate).toHaveBeenCalledWith('2026-06-05');
    expect(withNewsletterSendLock).toHaveBeenCalledWith('the_prompt', 123, expect.any(Function));
  });

  it('does not deliver when a manual sender holds the edition lock', async () => {
    getLatestApprovedDigest.mockResolvedValue(approvedDigest());
    withNewsletterSendLock.mockResolvedValueOnce({ acquired: false });

    const { runWeeklyDigestJob } = await import('../../src/addie/jobs/weekly-digest.js');
    const result = await runWeeklyDigestJob();

    expect(result.sent).toBe(0);
    expect(sendTrackedBatchMarketingEmails).not.toHaveBeenCalled();
    expect(markSent).not.toHaveBeenCalled();
  });
});
