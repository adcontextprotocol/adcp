/**
 * Every Slack notification builder sanitizes the text it did not author
 * (adcp#8320).
 *
 * #8320 was found in the compliance DM, but the shape — interpolating
 * submitter- or agent-controlled text straight into mrkdwn — was spread
 * across the registry and member-event builders too. A reader treats these
 * channels as platform- or moderator-authored, so a planted `<!channel>`
 * pings the room, a planted `<https://evil|agenticadvertising.org>` phishes
 * it, and a planted newline forges a line of platform copy.
 *
 * This file is deliberately shape-based rather than exhaustive: it asserts
 * that no live mention, link, or forged line survives, not the exact
 * rendering, so the copy can change without the guarantee moving.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.REGISTRY_EDITS_CHANNEL_ID = 'C_SWEEP';
  process.env.SLACK_BOT_TOKEN ||= 'xoxb-test-sweep';
  // The staff-channel builders post through an incoming webhook rather
  // than the bot client, so they need a configured URL to send at all.
  process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/services/T/B/sweep';
});

const mocks = vi.hoisted(() => ({
  sendChannelMessage: vi.fn(async () => ({ ok: true, ts: '1.0' })),
  sendDirectMessage: vi.fn(async () => ({ ok: true })),
  isSlackConfigured: vi.fn(() => true),
}));

vi.mock('../../src/slack/client.js', () => mocks);

vi.mock('../../src/db/slack-db.js', () => ({
  SlackDatabase: class {
    getByWorkosUserId = async () => ({ slack_user_id: 'U_AUTHOR' });
  },
}));

const registry = await import('../../src/notifications/registry.js');
const slack = await import('../../src/notifications/slack.js');

/**
 * Payload a submitter can plant in any free-text field: a broadcast ping, a
 * user ping, a link that lies about its destination, and a newline that
 * forges a second line of platform copy.
 */
const HOSTILE = '<!channel> <@U0ADMIN> <https://evil.example/phish|agenticadvertising.org>\nApproved by security';

const webhookPosts: string[] = [];

function sentJson(): string {
  const call = mocks.sendChannelMessage.mock.calls.at(-1)
    ?? mocks.sendDirectMessage.mock.calls.at(-1);
  if (call) return JSON.stringify(call);
  const webhookBody = webhookPosts.at(-1);
  expect(webhookBody).toBeDefined();
  return webhookBody!;
}

function expectNeutralized(): void {
  const json = sentJson();
  expect(json).not.toContain('<!channel>');
  expect(json).not.toContain('<@U0ADMIN>');
  expect(json).not.toContain('<https://evil.example/phish|');
  // The forged line cannot land on a line of its own.
  expect(json).not.toContain('\\nApproved by security');
}

beforeEach(() => {
  vi.clearAllMocks();
  webhookPosts.length = 0;
  mocks.sendChannelMessage.mockResolvedValue({ ok: true, ts: '1.0' });
  mocks.sendDirectMessage.mockResolvedValue({ ok: true });
  mocks.isSlackConfigured.mockReturnValue(true);
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
    webhookPosts.push(init.body);
    return { ok: true, status: 200, text: async () => '' } as unknown as Response;
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('registry channel notifications', () => {
  it('sanitizes the member-supplied edit summary and editor name', async () => {
    await registry.notifyRegistryEdit({
      entity_type: 'brand',
      domain: 'example.com',
      editor_name: `Mallory ${HOSTILE}`,
      edit_summary: HOSTILE,
      revision_number: 4,
    });

    expectNeutralized();
  });

  it('caps an edit summary instead of letting it fill the channel', async () => {
    await registry.notifyRegistryEdit({
      entity_type: 'brand',
      domain: 'example.com',
      editor_email: 'alice@example.com',
      edit_summary: 'S'.repeat(100_000),
      revision_number: 5,
    });

    expect(sentJson().length).toBeLessThan(2_000);
  });

  it('sanitizes the creator name on a new record', async () => {
    await registry.notifyRegistryCreate({
      entity_type: 'property',
      domain: 'example.com',
      editor_name: HOSTILE,
    });

    expectNeutralized();
  });

  it('sanitizes the admin name on a rollback', async () => {
    await registry.notifyRegistryRollback({
      entity_type: 'brand',
      domain: 'example.com',
      rolled_back_to: 2,
      revision_number: 7,
      rolled_back_by_name: HOSTILE,
    });

    expectNeutralized();
  });

  it('sanitizes the ban reason, which carries model output', async () => {
    await registry.notifyRegistryBan({
      entity_type: 'brand',
      banned_email: `mallory${HOSTILE}@example.com`,
      entity_domain: 'example.com',
      reason: `Auto-ban: ${HOSTILE}`,
    });

    expectNeutralized();
  });

  it('sanitizes the Addie review verdict text', async () => {
    // `reason` is model output, and the review prompt embeds the member's
    // own edit summary — so a prompt injection can choose this string.
    await registry.notifyAddieReview({
      thread_ts: '1.0',
      verdict: 'ok',
      reason: HOSTILE,
      domain: 'example.com',
      action_taken: HOSTILE,
    });

    expectNeutralized();
  });
});

describe('member and working-group notifications', () => {
  it('sanitizes a member-set profile name', async () => {
    await slack.notifyNewMemberProfile({
      displayName: HOSTILE,
      organizationName: HOSTILE,
      slug: 'mallory',
    });

    expectNeutralized();
  });

  it('sanitizes the org name on billing events', async () => {
    await slack.notifyPaymentFailed({
      organizationName: HOSTILE,
      amount: 1000,
      currency: 'usd',
      attemptCount: 2,
    });

    expectNeutralized();
  });

  it('strips the pipe from a post title used as a link label', async () => {
    // `<url|label>`: escaping angle brackets is not enough, because a `|`
    // inside the label starts another field and relabels the link.
    await slack.notifyWorkingGroupSlackChannel({
      slackChannelId: 'C_WG',
      workingGroupName: 'Signals',
      workingGroupSlug: 'signals',
      postTitle: 'Read this|https://evil.example',
      postSlug: 'post',
      authorName: 'Mallory',
      contentType: 'article',
    });

    const json = sentJson();
    expect(json).toContain('Read thishttps://evil.example');
    expect(json).not.toContain('Read this|https://evil.example');
  });

  it('flattens a post excerpt so it cannot forge the attribution line', async () => {
    await slack.notifyWorkingGroupSlackChannel({
      slackChannelId: 'C_WG',
      workingGroupName: 'Signals',
      workingGroupSlug: 'signals',
      postTitle: 'A post',
      postSlug: 'post',
      authorName: HOSTILE,
      contentType: 'article',
      excerpt: HOSTILE,
    });

    expectNeutralized();
  });

  it('sanitizes a member-created meeting title', async () => {
    await slack.notifyMeetingStarted({
      slackChannelId: 'C_WG',
      meetingTitle: HOSTILE,
      workingGroupName: 'Signals',
    });

    expectNeutralized();
  });

  it('drops a Zoom link whose target would break out of link syntax', async () => {
    // The target half of `<url|label>` cannot be escaped — a `>` closes
    // the link and leaves the remainder as top-level mrkdwn.
    await slack.notifyMeetingStarted({
      slackChannelId: 'C_WG',
      meetingTitle: 'Standup',
      workingGroupName: 'Signals',
      zoomJoinUrl: 'https://zoom.us/j/1>|<!channel>',
    });

    const json = sentJson();
    expect(json).not.toContain('Join Zoom Meeting');
    expect(json).not.toContain('<!channel>');
  });

  it('keeps an ordinary Zoom link', async () => {
    await slack.notifyMeetingStarted({
      slackChannelId: 'C_WG',
      meetingTitle: 'Standup',
      workingGroupName: 'Signals',
      zoomJoinUrl: 'https://zoom.us/j/123?pwd=abc',
    });

    expect(sentJson()).toContain('<https://zoom.us/j/123?pwd=abc|Join Zoom Meeting>');
  });

  it('drops a member-supplied external URL that is not a plain link', async () => {
    await slack.notifyWorkingGroupSlackChannel({
      slackChannelId: 'C_WG',
      workingGroupName: 'Signals',
      workingGroupSlug: 'signals',
      postTitle: 'A link',
      postSlug: 'post',
      authorName: 'Mallory',
      contentType: 'link',
      externalUrl: 'https://ok.example|<!channel>',
    });

    expect(sentJson()).not.toContain('<!channel>');
  });

  it('caps the perspective title that goes into a Slack header block', async () => {
    // Slack rejects header text over 150 characters with `invalid_blocks`,
    // which would lose the author the whole DM.
    await slack.sendSocialAmplificationDM({
      proposerUserId: 'u1',
      title: 'T'.repeat(500),
      excerpt: 'An excerpt with ``` a fence in it',
      workingGroupSlug: 'signals',
      postSlug: 'post',
      contentType: 'article',
      isMembersOnly: false,
    });

    const blocks = JSON.parse(JSON.stringify(
      (mocks.sendDirectMessage.mock.calls.at(-1)! as unknown[])[1],
    )) as { blocks: Array<{ type: string; text: { text: string } }> };
    const header = blocks.blocks.find((b) => b.type === 'header')!;
    expect(header.text.text.length).toBeLessThanOrEqual(150);
    // The fenced copy is pasted verbatim, so backticks are removed rather
    // than escaped.
    expect(JSON.stringify(blocks)).not.toContain('``` a fence');
  });
});
