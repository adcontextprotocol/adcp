/**
 * Tests for `resolveEditorialChannel`: admin-UI DB setting only.
 *
 *   - DB setting populated → return the trimmed channel id
 *   - DB setting null/empty/whitespace → return null (caller skips)
 *   - DB read throws → return null (log at error level)
 *
 * The `SLACK_EDITORIAL_REVIEW_CHANNEL` env var used to be a fallback
 * path during the env→DB migration window (PR #3000). Prod now has
 * the DB value set, so the env fallback was dropped. Setting the env
 * var in a test here must NOT affect the resolver's return value.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockGetEditorialChannel } = vi.hoisted(() => ({
  mockGetEditorialChannel: vi.fn<any>(),
}));

vi.mock('../../server/src/db/system-settings-db.js', () => ({
  getEditorialChannel: (...args: unknown[]) => mockGetEditorialChannel(...args),
}));

// Module-under-test imports slack/client + visual + drafter + DB client
// transitively. Stub everything we don't need so module init is a no-op.
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
  // Under pool:'threads' (see vitest.config.ts), the module registry is shared
  // across concurrent test files. Without this, a cached module from another
  // thread bleeds into this file's await import() calls — causing stale-mock
  // TypeErrors that only appear under Conductor multi-workspace load.
  vi.resetModules();
  vi.clearAllMocks();
  delete process.env.SLACK_EDITORIAL_REVIEW_CHANNEL;
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.SLACK_EDITORIAL_REVIEW_CHANNEL;
  else process.env.SLACK_EDITORIAL_REVIEW_CHANNEL = ORIGINAL_ENV;
});

describe('resolveEditorialChannel', () => {
  it('returns the DB setting when configured', async () => {
    mockGetEditorialChannel.mockResolvedValueOnce({
      channel_id: 'C0FROMDB01',
      channel_name: 'admin-editorial-review',
    });

    const { resolveEditorialChannel } = await import('../../server/src/addie/jobs/announcement-trigger.js');
    expect(await resolveEditorialChannel()).toBe('C0FROMDB01');
  });

  it('env var is ignored when DB setting is populated', async () => {
    // The env fallback was dropped; prod now relies on the admin UI.
    mockGetEditorialChannel.mockResolvedValueOnce({
      channel_id: 'C0FROMDB01',
      channel_name: 'admin-editorial-review',
    });
    process.env.SLACK_EDITORIAL_REVIEW_CHANNEL = 'C0STALEENVCHANNEL';

    const { resolveEditorialChannel } = await import('../../server/src/addie/jobs/announcement-trigger.js');
    expect(await resolveEditorialChannel()).toBe('C0FROMDB01');
  });

  it('returns null when DB setting is unset (env var is not a fallback)', async () => {
    mockGetEditorialChannel.mockResolvedValueOnce({ channel_id: null, channel_name: null });
    // Previously this would fall back to the env var. After #3000 rollout
    // completed, a stale env var would otherwise mask a misconfigured DB.
    process.env.SLACK_EDITORIAL_REVIEW_CHANNEL = 'C0STALEENVCHANNEL';

    const { resolveEditorialChannel } = await import('../../server/src/addie/jobs/announcement-trigger.js');
    expect(await resolveEditorialChannel()).toBeNull();
  });

  it('treats empty-string DB channel_id as unset', async () => {
    mockGetEditorialChannel.mockResolvedValueOnce({ channel_id: '', channel_name: null });
    const { resolveEditorialChannel } = await import('../../server/src/addie/jobs/announcement-trigger.js');
    expect(await resolveEditorialChannel()).toBeNull();
  });

  it('treats whitespace-only DB channel_id as unset', async () => {
    mockGetEditorialChannel.mockResolvedValueOnce({
      channel_id: '   ',
      channel_name: 'whatever',
    });
    const { resolveEditorialChannel } = await import('../../server/src/addie/jobs/announcement-trigger.js');
    expect(await resolveEditorialChannel()).toBeNull();
  });

  it('trims whitespace from DB channel_id', async () => {
    mockGetEditorialChannel.mockResolvedValueOnce({
      channel_id: '  C0FROMDB01  ',
      channel_name: 'editorial',
    });
    const { resolveEditorialChannel } = await import('../../server/src/addie/jobs/announcement-trigger.js');
    expect(await resolveEditorialChannel()).toBe('C0FROMDB01');
  });

  it('returns null when DB read throws (logs at error level)', async () => {
    mockGetEditorialChannel.mockRejectedValueOnce(new Error('db connection reset'));
    // Even with env set, a DB failure no longer silently activates a
    // fallback — the job skips and logs instead.
    process.env.SLACK_EDITORIAL_REVIEW_CHANNEL = 'C0STALEENVCHANNEL';

    const { resolveEditorialChannel } = await import('../../server/src/addie/jobs/announcement-trigger.js');
    expect(await resolveEditorialChannel()).toBeNull();
  });
});
