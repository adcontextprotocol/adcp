/**
 * The five Slack surfaces that still carried their own local escaper now go
 * through `utils/slack-escape.ts` (adcp#8326, follow-up to #8320).
 *
 * All five escaped `& < >` and stopped there, so none of them flattened a
 * newline: a member- or model-authored org name, event title, display name
 * or digest headline could still forge an extra line in a message the reader
 * treats as platform copy. These tests are shape-based — no live mention, no
 * lying link, no forged line — so copy can change without the guarantee
 * moving.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sendChannelMessage: vi.fn(async () => ({ ok: true, ts: '1.0' })),
  sendDirectMessage: vi.fn(async () => ({ ok: true })),
  openGroupDM: vi.fn(async () => 'G_ADMINS'),
  deleteChannelMessage: vi.fn(async () => ({ ok: true })),
  query: vi.fn(async () => ({ rows: [] })),
  getWorkingGroupBySlug: vi.fn(async () => ({ slack_channel_id: 'C_EDITORIAL' })),
}));

vi.mock('../../src/slack/client.js', () => ({
  sendChannelMessage: mocks.sendChannelMessage,
  sendDirectMessage: mocks.sendDirectMessage,
  openGroupDM: mocks.openGroupDM,
  deleteChannelMessage: mocks.deleteChannelMessage,
  isSlackConfigured: () => true,
}));

vi.mock('../../src/db/client.js', () => ({
  query: mocks.query,
  getPool: () => ({ connect: async () => ({ query: mocks.query, release: () => {} }) }),
}));

vi.mock('../../src/db/working-group-db.js', () => ({
  WorkingGroupDatabase: class {
    getWorkingGroupBySlug = mocks.getWorkingGroupBySlug;
  },
}));

const orgGroupDm = await import('../../src/slack/org-group-dm.js');
const welcomeSocial = await import('../../src/notifications/welcome-social-posts.js');
const eventRecap = await import('../../src/addie/jobs/event-recap-nudge.js');
const announcements = await import('../../src/addie/jobs/announcement-trigger.js');
const digest = await import('../../src/addie/templates/weekly-digest.js');

/**
 * A broadcast ping, a user ping, a link that lies about its destination, and
 * a newline that forges a second line of platform copy.
 */
const HOSTILE =
  '<!channel> <@U0ADMIN> <https://evil.example/phish|agenticadvertising.org>\nApproved by security';

/**
 * The forged-line check is the one that discriminates for most of these
 * surfaces: the old escapers already turned `<` into `&lt;`, so the mention
 * and link checks pass on `main` too. They stay because they are the
 * guarantee a reader cares about, and the announcement and digest cases do
 * discriminate on more than the newline.
 */
function expectNeutralized(json: string): void {
  expect(json).not.toContain('<!channel>');
  expect(json).not.toContain('<@U0ADMIN>');
  expect(json).not.toContain('<https://evil.example/phish|');
  expect(json).not.toContain('\\nApproved by security');
  expect(json).not.toContain('\nApproved by security');
}

function lastSent(): string {
  const call = mocks.sendChannelMessage.mock.calls.at(-1)
    ?? mocks.sendDirectMessage.mock.calls.at(-1);
  expect(call).toBeDefined();
  return JSON.stringify(call);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sendChannelMessage.mockResolvedValue({ ok: true, ts: '1.0' });
  mocks.sendDirectMessage.mockResolvedValue({ ok: true });
  mocks.openGroupDM.mockResolvedValue('G_ADMINS');
  mocks.query.mockResolvedValue({ rows: [] });
  mocks.getWorkingGroupBySlug.mockResolvedValue({ slack_channel_id: 'C_EDITORIAL' });
});

describe('org admin group DM', () => {
  /** Two mapped admins, so `sendToOrgAdmins` takes the group-DM branch. */
  function twoMappedAdmins() {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('slack_user_mappings')) {
        return { rows: [{ slack_user_id: 'U1' }, { slack_user_id: 'U2' }] };
      }
      if (sql.includes('org_admin_group_dms')) {
        return { rows: [{ slack_channel_id: 'G_ADMINS', admin_slack_user_ids: ['U1', 'U2'] }] };
      }
      return { rows: [] };
    });
  }

  it('sanitizes a WorkOS org name and a member-set display name', async () => {
    twoMappedAdmins();

    await orgGroupDm.notifyJoinRequest({
      orgId: 'org_1',
      orgName: HOSTILE,
      adminEmails: ['admin@example.com', 'admin2@example.com'],
      requesterEmail: 'mallory@example.com',
      requesterFirstName: 'Mallory',
      requesterLastName: HOSTILE,
    });

    expect(mocks.sendChannelMessage).toHaveBeenCalled();
    expectNeutralized(lastSent());
  });

  it('sanitizes the same fields on the single-admin direct-DM fallback', async () => {
    // One mapped admin is below the group-DM minimum, so this goes out as a
    // DM built from the same blocks.
    mocks.query.mockImplementation(async (sql: string) =>
      sql.includes('slack_user_mappings') ? { rows: [{ slack_user_id: 'U1' }] } : { rows: [] },
    );

    await orgGroupDm.notifyMemberAdded({
      orgId: 'org_1',
      orgName: HOSTILE,
      adminEmails: ['admin@example.com'],
      memberEmail: 'mallory@example.com',
      memberFirstName: 'Mallory',
      memberLastName: HOSTILE,
      role: 'member',
    });

    expect(mocks.sendDirectMessage).toHaveBeenCalled();
    expectNeutralized(lastSent());
  });
});

describe('welcome social posts DM', () => {
  it('sanitizes the Slack display name the member set themselves', async () => {
    await welcomeSocial.sendWelcomeSocialPosts({
      slackUserId: 'U_NEW',
      displayName: HOSTILE,
      isBot: false,
    });

    expectNeutralized(lastSent());
  });
});

describe('event recap nudge', () => {
  it('sanitizes a member-created event title', async () => {
    mocks.query.mockResolvedValue({
      rows: [{
        id: 'evt_1',
        title: HOSTILE,
        start_time: '2026-01-01T00:00:00Z',
        end_time: '2026-01-01T01:00:00Z',
      }],
    });

    await eventRecap.runEventRecapNudgeJob();

    expectNeutralized(lastSent());
  });
});

describe('announcement reminder card', () => {
  it('sanitizes the org name and defuses a bare URL inside it', () => {
    const text = announcements.buildReminderText({
      orgName: `${HOSTILE} https://evil.example/pay`,
      daysSinceSlack: 3,
    });

    expectNeutralized(JSON.stringify(text));
    // Slack auto-links a bare URL even with no mrkdwn syntax around it.
    expect(text).not.toContain('https://evil.example/pay');
    expect(text).toContain('https:/​/evil.example/pay');
  });

  it('sanitizes the org name on the dead-parent fallback', () => {
    expectNeutralized(JSON.stringify(
      announcements.buildDeadParentText({ orgName: HOSTILE, daysSinceSlack: 9 }),
    ));
  });
});

describe('weekly digest Slack render', () => {
  function content(overrides: Record<string, unknown> = {}) {
    return {
      contentVersion: 2,
      openingTake: 'A normal opening take.',
      whatToWatch: [],
      fromTheInside: [],
      voices: [],
      newMembers: [],
      generatedAt: '2026-04-01T00:00:00Z',
      ...overrides,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }

  it('sanitizes generated headlines, takeaways and group summaries', () => {
    const rendered = digest.renderDigestSlack(
      content({
        openingTake: HOSTILE,
        whatToWatch: [{
          title: HOSTILE,
          url: 'https://news.example/a',
          summary: '',
          whyItMatters: HOSTILE,
          takeaways: [HOSTILE],
          tags: ['official'],
        }],
        fromTheInside: [{ name: HOSTILE, summary: HOSTILE, nextMeeting: HOSTILE }],
        voices: [{ title: HOSTILE, url: 'https://blog.example/p', authorName: HOSTILE }],
        specInsight: { title: HOSTILE, body: HOSTILE, relatedSpecSections: [] },
        takeActions: [{ text: HOSTILE, ctaLabel: HOSTILE, ctaUrl: 'https://agenticadvertising.org/x' }],
      }),
      '2026-04-01',
    );

    const json = JSON.stringify(rendered);
    expect(json).not.toContain('<!channel>');
    expect(json).not.toContain('<@U0ADMIN>');
    expect(json).not.toContain('<https://evil.example/phish|');
    // The quote-line surfaces must not gain a line of their own.
    expect(json).not.toContain('\\nApproved by security');
  });

  it('drops a link whose target would break out of <url|label> syntax', () => {
    const rendered = digest.renderDigestSlack(
      content({
        whatToWatch: [{
          title: 'A headline',
          url: 'https://news.example/a>|<!channel>',
          summary: '',
          whyItMatters: 'Because.',
          tags: ['official'],
        }],
      }),
      '2026-04-01',
    );

    const json = JSON.stringify(rendered);
    expect(json).not.toContain('<!channel>');
    expect(json).toContain('A headline');
  });

  it('keeps an ordinary link and the editor note line breaks', () => {
    const rendered = digest.renderDigestSlack(
      content({
        editorsNote: 'First line\nSecond line',
        whatToWatch: [{
          title: 'A headline',
          url: 'https://news.example/a',
          summary: '',
          whyItMatters: 'Because.',
          tags: ['official'],
        }],
      }),
      '2026-04-01',
    );

    const json = JSON.stringify(rendered);
    expect(json).toContain('<https://news.example/a|A headline>');
    // The editor's note is a prose block; its own line breaks are the
    // formatting and must survive.
    expect(json).toContain('> First line\\n> Second line');
  });
});
