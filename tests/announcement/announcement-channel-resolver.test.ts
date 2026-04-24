/**
 * Tests for `resolveEditorialChannel`: DB-first with env var fallback.
 *
 * The resolver is the narrow seam that lets Stage 1 + backfill switch
 * from the legacy SLACK_EDITORIAL_REVIEW_CHANNEL env var to the admin-UI
 * `editorial_slack_channel` system setting without breaking existing
 * prod config. Behavior:
 *   - DB setting populated → use it
 *   - DB setting null → fall back to env
 *   - DB setting null AND env unset/empty → return null; caller skips
 *   - DB read throws → fall back to env (don't block the job on a
 *     transient DB read)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockGetEditorialChannel } = vi.hoisted(() => ({
  mockGetEditorialChannel: vi.fn<any>(),
}));

vi.mock('../../server/src/db/system-settings-db.js', () => ({
  getEditorialChannel: (...args: unknown[]) => mockGetEditorialChannel(...args),
}));

// The module-under-test imports slack/client + visual + drafter + DB
// client transitively. We stub everything we don't need so module init
// is a no-op.
vi.mock('../../server/src/db/client.js', () => ({
  query: vi.fn(),
  getPool: () => ({ connect: async () => ({ query: vi.fn(), release: () => {} }) }),
}));
vi.mock('../../server/src/slack/client.js', () => ({
  sendChannelMessage: vi.fn(),
  deleteChannelMessage: vi.fn(),
}));
vi.mock('../../server/src/services/announcement-drafter.js', () => ({
  draftAnnouncement: vi.fn(),
}));
vi.mock('../../server/src/services/announcement-visual.js', () => ({
  resolveAnnouncementVisual: vi.fn(),
  isSafeVisualUrl: () => true,
  AAO_FALLBACK_VISUAL_URL: '',
}));

const ORIGINAL_ENV = process.env.SLACK_EDITORIAL_REVIEW_CHANNEL;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.SLACK_EDITORIAL_REVIEW_CHANNEL;
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.SLACK_EDITORIAL_REVIEW_CHANNEL;
  else process.env.SLACK_EDITORIAL_REVIEW_CHANNEL = ORIGINAL_ENV;
});

describe('resolveEditorialChannel', () => {
  it('returns the DB setting when configured (preferred over env)', async () => {
    mockGetEditorialChannel.mockResolvedValueOnce({
      channel_id: 'C0FROMDB01',
      channel_name: 'admin-editorial-review',
    });
    process.env.SLACK_EDITORIAL_REVIEW_CHANNEL = 'C0FROMENV01';

    const { resolveEditorialChannel } = await import('../../server/src/addie/jobs/announcement-trigger.js');
    const resolved = await resolveEditorialChannel();
    expect(resolved).toBe('C0FROMDB01');
  });

  it('falls back to env var when the DB setting is null', async () => {
    mockGetEditorialChannel.mockResolvedValueOnce({ channel_id: null, channel_name: null });
    process.env.SLACK_EDITORIAL_REVIEW_CHANNEL = 'C0FROMENV01';

    const { resolveEditorialChannel } = await import('../../server/src/addie/jobs/announcement-trigger.js');
    expect(await resolveEditorialChannel()).toBe('C0FROMENV01');
  });

  it('returns null when both DB and env are unset', async () => {
    mockGetEditorialChannel.mockResolvedValueOnce({ channel_id: null, channel_name: null });
    delete process.env.SLACK_EDITORIAL_REVIEW_CHANNEL;

    const { resolveEditorialChannel } = await import('../../server/src/addie/jobs/announcement-trigger.js');
    expect(await resolveEditorialChannel()).toBeNull();
  });

  it('treats empty string env as unset', async () => {
    mockGetEditorialChannel.mockResolvedValueOnce({ channel_id: null, channel_name: null });
    process.env.SLACK_EDITORIAL_REVIEW_CHANNEL = '';

    const { resolveEditorialChannel } = await import('../../server/src/addie/jobs/announcement-trigger.js');
    expect(await resolveEditorialChannel()).toBeNull();
  });

  it('treats whitespace-only env as unset', async () => {
    mockGetEditorialChannel.mockResolvedValueOnce({ channel_id: null, channel_name: null });
    process.env.SLACK_EDITORIAL_REVIEW_CHANNEL = '   ';

    const { resolveEditorialChannel } = await import('../../server/src/addie/jobs/announcement-trigger.js');
    expect(await resolveEditorialChannel()).toBeNull();
  });

  it('trims whitespace from env fallback', async () => {
    mockGetEditorialChannel.mockResolvedValueOnce({ channel_id: null, channel_name: null });
    process.env.SLACK_EDITORIAL_REVIEW_CHANNEL = '  C0FROMENV01  ';

    const { resolveEditorialChannel } = await import('../../server/src/addie/jobs/announcement-trigger.js');
    expect(await resolveEditorialChannel()).toBe('C0FROMENV01');
  });

  it('falls back to env when the DB read throws (transient failures should not block the job)', async () => {
    mockGetEditorialChannel.mockRejectedValueOnce(new Error('db connection reset'));
    process.env.SLACK_EDITORIAL_REVIEW_CHANNEL = 'C0FROMENV01';

    const { resolveEditorialChannel } = await import('../../server/src/addie/jobs/announcement-trigger.js');
    expect(await resolveEditorialChannel()).toBe('C0FROMENV01');
  });

  it('returns null when DB throws and env unset (safe no-op for the caller)', async () => {
    mockGetEditorialChannel.mockRejectedValueOnce(new Error('db connection reset'));
    delete process.env.SLACK_EDITORIAL_REVIEW_CHANNEL;

    const { resolveEditorialChannel } = await import('../../server/src/addie/jobs/announcement-trigger.js');
    expect(await resolveEditorialChannel()).toBeNull();
  });
});
