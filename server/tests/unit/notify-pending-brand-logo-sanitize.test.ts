/**
 * Pin: notifyPendingBrandLogo neutralizes Slack mrkdwn meta-characters in
 * user-controlled fields (upload note, uploader name) before posting to a
 * moderator-trusted channel. Without this, an uploader could plant
 * `<!channel>` / `<!here>` / `<@U…>` mentions to ping moderators, or
 * `<https://evil/|legit-text>` links to phish them.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// hoisted runs before module imports, so REGISTRY_EDITS_CHANNEL_ID is set
// before `registry.js` captures it at module load.
vi.hoisted(() => {
  process.env.REGISTRY_EDITS_CHANNEL_ID = 'C_TEST_LOGO_REVIEW';
});

const mocks = vi.hoisted(() => ({
  sendChannelMessage: vi.fn(),
  isSlackConfigured: vi.fn(() => true),
}));

vi.mock('../../src/slack/client.js', () => ({
  sendChannelMessage: (...args: unknown[]) => mocks.sendChannelMessage(...args),
  isSlackConfigured: () => mocks.isSlackConfigured(),
}));

import { notifyPendingBrandLogo } from '../../src/notifications/registry.js';

function lastSentBlocks() {
  const call = mocks.sendChannelMessage.mock.calls.at(-1);
  expect(call).toBeDefined();
  const [, message] = call!;
  return (message as { blocks: { text?: { text?: string }; fields?: { text: string }[] }[] }).blocks;
}

function lastSentJSON(): string {
  const blocks = lastSentBlocks();
  return JSON.stringify(blocks);
}

describe('notifyPendingBrandLogo mrkdwn sanitization', () => {
  beforeEach(() => {
    mocks.sendChannelMessage.mockReset();
    mocks.sendChannelMessage.mockResolvedValue({ ts: '1779110411.874' });
    mocks.isSlackConfigured.mockReturnValue(true);
  });

  it('neutralizes <!channel> / <!here> / <!everyone> mention tokens in upload note', async () => {
    await notifyPendingBrandLogo({
      domain: 'example.com',
      logo_id: 'logo_1',
      content_type: 'image/png',
      tags: ['primary'],
      uploader_email: 'alice@example.com',
      upload_note: 'Ping <!channel> and <!here> and <!everyone> please',
      source: 'community',
    });
    const json = lastSentJSON();
    // Angle brackets are escaped, broadcasts are zero-width-spaced.
    expect(json).not.toContain('<!channel>');
    expect(json).not.toContain('<!here>');
    expect(json).not.toContain('<!everyone>');
    expect(json).toContain('&lt;!​channel&gt;');
    expect(json).toContain('&lt;!​here&gt;');
  });

  it('neutralizes <@U…> user-mentions in upload note', async () => {
    await notifyPendingBrandLogo({
      domain: 'example.com',
      logo_id: 'logo_2',
      content_type: 'image/png',
      tags: ['primary'],
      upload_note: 'cc <@U12345> for review',
      source: 'community',
    });
    const json = lastSentJSON();
    expect(json).not.toContain('<@U12345>');
    expect(json).toContain('&lt;@U12345&gt;');
  });

  it('neutralizes <url|text> link syntax in upload note', async () => {
    await notifyPendingBrandLogo({
      domain: 'example.com',
      logo_id: 'logo_3',
      content_type: 'image/png',
      tags: ['primary'],
      upload_note: 'See <https://evil.example/phish|the brand site>',
      source: 'community',
    });
    const json = lastSentJSON();
    expect(json).not.toContain('<https://evil.example/phish|');
    expect(json).toContain('&lt;https://evil.example/phish|');
  });

  it('neutralizes mention tokens in uploader_name', async () => {
    await notifyPendingBrandLogo({
      domain: 'example.com',
      logo_id: 'logo_4',
      content_type: 'image/png',
      tags: ['primary'],
      uploader_name: 'Mallory <!channel>',
      source: 'community',
    });
    const json = lastSentJSON();
    expect(json).not.toContain('<!channel>');
  });

  it('leaves benign notes untouched', async () => {
    await notifyPendingBrandLogo({
      domain: 'example.com',
      logo_id: 'logo_5',
      content_type: 'image/png',
      tags: ['primary'],
      uploader_email: 'alice@example.com',
      upload_note: 'New press kit logo, vector master',
      source: 'community',
    });
    const json = lastSentJSON();
    expect(json).toContain('New press kit logo, vector master');
  });
});
