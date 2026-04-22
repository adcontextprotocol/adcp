import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

/**
 * #2735 — channel privacy TOCTOU recheck.
 *
 * Admin settings routes validate `is_private === true` at write time,
 * but Slack lets a channel owner convert a private channel public
 * afterward. `sendChannelMessage({ requirePrivate: true })` must catch
 * that drift at send time via `verifyChannelStillPrivate` and refuse
 * to post sensitive content. Channels that were never sensitive
 * (default `requirePrivate: false`) keep the original behavior.
 */

// Mock the slack HTTP layer so we can drive `getChannelInfo`'s cached
// behavior deterministically and observe `chat.postMessage` without a
// real network call.
const postedMessages: Array<{ channel: string; text: string; blocks?: unknown }> = [];
const channelInfoResponses = new Map<string, { is_private: boolean; name: string; id: string } | null>();

vi.mock('../../src/slack/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/slack/client.js')>();
  // Replace the internals that hit Slack so the rest of the module
  // behaves as usual (including the 30min cache layer we want to
  // exercise). We stub `conversations.info` and `chat.postMessage`
  // at the module seams rather than at the network layer so the
  // tests don't need to reach into `slackRequest` / `slackPostRequest`.
  return actual;
});

// The module under test re-reads env on import, so set a fake token
// before importing.
process.env.SLACK_BOT_TOKEN = 'xoxb-test-fake';

// Fake fetch that the slack client uses under the hood.
const originalFetch = globalThis.fetch;
beforeEach(() => {
  postedMessages.length = 0;
  channelInfoResponses.clear();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof input === 'string' ? input : input.toString();
    const parsed = new URL(urlStr);
    // conversations.info is a GET — params in query string
    if (parsed.pathname.endsWith('/conversations.info')) {
      const channelId = parsed.searchParams.get('channel') ?? '';
      const info = channelInfoResponses.get(channelId);
      if (info === undefined || info === null) {
        return new Response(JSON.stringify({ ok: false, error: 'channel_not_found' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true, channel: info }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    // chat.postMessage is a POST with JSON body
    if (parsed.pathname.endsWith('/chat.postMessage')) {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      postedMessages.push({
        channel: body.channel,
        text: body.text,
        ...(body.blocks ? { blocks: body.blocks } : {}),
      });
      return new Response(JSON.stringify({ ok: true, ts: '1234.5678' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`Unexpected fetch URL: ${urlStr}`);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('verifyChannelStillPrivate + sendChannelMessage({ requirePrivate })', () => {
  it('posts to a still-private channel when requirePrivate is set', async () => {
    channelInfoResponses.set('C_priv', { id: 'C_priv', name: 'billing', is_private: true });
    const { sendChannelMessage } = await import('../../src/slack/client.js');

    const result = await sendChannelMessage(
      'C_priv',
      { text: 'sensitive content' },
      { requirePrivate: true },
    );

    expect(result.ok).toBe(true);
    expect(postedMessages).toHaveLength(1);
    expect(postedMessages[0]).toMatchObject({ channel: 'C_priv', text: 'sensitive content' });
  });

  it('refuses to post to a now-public channel when requirePrivate is set', async () => {
    channelInfoResponses.set('C_now_public', { id: 'C_now_public', name: 'billing-leak', is_private: false });
    const { sendChannelMessage } = await import('../../src/slack/client.js');

    const result = await sendChannelMessage(
      'C_now_public',
      { text: 'sensitive content' },
      { requirePrivate: true },
    );

    expect(result.ok).toBe(false);
    expect(result.skipped).toBe('not_private');
    expect(result.error).toBe('channel_no_longer_private');
    expect(postedMessages).toHaveLength(0);
  });

  it('fails closed when the channel cannot be fetched (conservative for sensitive content)', async () => {
    channelInfoResponses.set('C_missing', null);
    const { sendChannelMessage } = await import('../../src/slack/client.js');

    const result = await sendChannelMessage(
      'C_missing',
      { text: 'sensitive content' },
      { requirePrivate: true },
    );

    expect(result.ok).toBe(false);
    expect(result.skipped).toBe('not_private');
    expect(postedMessages).toHaveLength(0);
  });

  it('ignores the gate (posts even to a public channel) when requirePrivate is not set', async () => {
    // This is the default behavior for WG / announcement channels that
    // are intentionally public. The gate is opt-in so we don't break
    // those flows.
    channelInfoResponses.set('C_pub', { id: 'C_pub', name: 'announcements', is_private: false });
    const { sendChannelMessage } = await import('../../src/slack/client.js');

    const result = await sendChannelMessage('C_pub', { text: 'broadcast' });

    expect(result.ok).toBe(true);
    expect(postedMessages).toHaveLength(1);
  });

  it('verifyChannelStillPrivate returns true/false matching channel state', async () => {
    channelInfoResponses.set('C_p', { id: 'C_p', name: 'priv', is_private: true });
    channelInfoResponses.set('C_q', { id: 'C_q', name: 'pub', is_private: false });
    const { verifyChannelStillPrivate } = await import('../../src/slack/client.js');

    expect(await verifyChannelStillPrivate('C_p')).toBe(true);
    expect(await verifyChannelStillPrivate('C_q')).toBe(false);
  });
});
