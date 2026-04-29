import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The slack client reads ADDIE_BOT_TOKEN / SLACK_BOT_TOKEN at module
// load — set a fake value BEFORE the import resolves (vi.hoisted runs
// before import statements) so slackRequest doesn't throw.
vi.hoisted(() => {
  process.env.ADDIE_BOT_TOKEN = 'xoxb-test-fake';
});

import {
  sendChannelMessage,
  verifyChannelStillPrivate,
  verifyChannelPrivacyForWrite,
  __resetChannelCacheForTests,
} from '../../src/slack/client.js';

/**
 * #2735 — channel privacy TOCTOU recheck.
 *
 * Admin settings routes validate `is_private === true` at write time,
 * but Slack lets a channel owner convert a private channel public
 * afterward. `sendChannelMessage({ requirePrivate: true })` must catch
 * that drift at send time via `verifyChannelStillPrivate` and refuse
 * to post sensitive content. `'strict-public-only'` lets a caller
 * tolerate `'unknown'` (verify failed) — used by the error notifier
 * to keep production-error alerting alive on a Slack blip.
 *
 * We stub `globalThis.fetch` directly so the real `slackRequest` +
 * `getChannelInfo` + `channelCache` all run end-to-end. The 30-minute
 * module-level cache is reset in `beforeEach` via
 * `__resetChannelCacheForTests` so each case starts with a clean
 * slate — without this, reusing a channel ID between cases would
 * silently mask regressions.
 */

const postedMessages: Array<{ channel: string; text: string; blocks?: unknown }> = [];
const channelInfoResponses = new Map<string, { is_private: boolean; name: string; id: string } | null>();

const originalFetch = globalThis.fetch;
beforeEach(() => {
  postedMessages.length = 0;
  channelInfoResponses.clear();
  __resetChannelCacheForTests();
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

describe('verifyChannelStillPrivate', () => {
  it('returns "private" when the channel is still private', async () => {
    channelInfoResponses.set('C_p', { id: 'C_p', name: 'priv', is_private: true });
    expect(await verifyChannelStillPrivate('C_p')).toBe('private');
  });

  it('returns "public" when the channel has been flipped public', async () => {
    channelInfoResponses.set('C_pub', { id: 'C_pub', name: 'pub', is_private: false });
    expect(await verifyChannelStillPrivate('C_pub')).toBe('public');
  });

  it('returns "unknown" when the info fetch fails', async () => {
    // No entry → fetch stub returns channel_not_found
    expect(await verifyChannelStillPrivate('C_missing')).toBe('unknown');
  });

  it('invalidates the cache after observing public drift so re-privatize is picked up immediately', async () => {
    // Observe public drift first (this caches nothing about being
    // public — we only cache successful info reads, and when we
    // detect is_private !== true we also clear the entry).
    channelInfoResponses.set('C_flip', { id: 'C_flip', name: 'flip', is_private: false });
    expect(await verifyChannelStillPrivate('C_flip')).toBe('public');

    // Admin re-privatizes. Without the invalidation the stale public
    // cache entry would keep us returning 'public' for the remaining
    // 30min TTL. With invalidation, the very next verify refetches
    // and sees 'private'.
    channelInfoResponses.set('C_flip', { id: 'C_flip', name: 'flip', is_private: true });
    expect(await verifyChannelStillPrivate('C_flip')).toBe('private');
  });
});

describe('sendChannelMessage({ requirePrivate: true })', () => {
  it('posts to a still-private channel', async () => {
    channelInfoResponses.set('C_priv', { id: 'C_priv', name: 'billing', is_private: true });
    const result = await sendChannelMessage(
      'C_priv',
      { text: 'sensitive content' },
      { requirePrivate: true },
    );
    expect(result.ok).toBe(true);
    expect(postedMessages).toHaveLength(1);
    expect(postedMessages[0]).toMatchObject({ channel: 'C_priv', text: 'sensitive content' });
  });

  it('refuses to post to a now-public channel with skipped="not_private"', async () => {
    channelInfoResponses.set('C_now_public', { id: 'C_now_public', name: 'billing-leak', is_private: false });
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

  it('refuses to post when privacy cannot be verified with skipped="privacy_unknown"', async () => {
    // Default mode fails closed on verify failures — we prefer a
    // dropped notification over a possible leak.
    const result = await sendChannelMessage(
      'C_missing',
      { text: 'sensitive content' },
      { requirePrivate: true },
    );
    expect(result.ok).toBe(false);
    expect(result.skipped).toBe('privacy_unknown');
    expect(result.error).toBe('channel_privacy_unknown');
    expect(postedMessages).toHaveLength(0);
  });

  it('posts unchanged to a public channel when requirePrivate is unset', async () => {
    // Default behavior for WG / announcement channels that are
    // intentionally public. The gate is opt-in.
    channelInfoResponses.set('C_pub', { id: 'C_pub', name: 'announcements', is_private: false });
    const result = await sendChannelMessage('C_pub', { text: 'broadcast' });
    expect(result.ok).toBe(true);
    expect(postedMessages).toHaveLength(1);
  });
});

describe('sendChannelMessage({ requirePrivate: "strict-public-only" })', () => {
  it('drops only on confirmed public — posts through on verify failure', async () => {
    // No channel_info entry → returns 'unknown'. In this mode, that
    // proceeds to the send so a Slack-API blip doesn't silence the
    // caller (used by error-notifier for production-error alerts).
    const result = await sendChannelMessage(
      'C_missing',
      { text: 'system error' },
      { requirePrivate: 'strict-public-only' },
    );
    expect(result.ok).toBe(true);
    expect(postedMessages).toHaveLength(1);
  });

  it('still drops on confirmed-public', async () => {
    channelInfoResponses.set('C_pub_confirmed', { id: 'C_pub_confirmed', name: 'leak', is_private: false });
    const result = await sendChannelMessage(
      'C_pub_confirmed',
      { text: 'system error' },
      { requirePrivate: 'strict-public-only' },
    );
    expect(result.ok).toBe(false);
    expect(result.skipped).toBe('not_private');
    expect(postedMessages).toHaveLength(0);
  });
});

/**
 * #3003 — write-time privacy check. The 7 admin settings PUT routes
 * previously had a silent fail-open on `getChannelInfo` null: if Slack
 * couldn't describe the channel (bot not a member, missing scope,
 * transient 5xx), the check was skipped and the write was accepted.
 * For private-required endpoints the downstream send-time gate
 * covered most cases, but the announcement endpoint (inverted:
 * require public) had no downstream gate and would silently misroute.
 *
 * `verifyChannelPrivacyForWrite` now fails closed on null with a
 * distinct `cannot_verify` reason so the caller can render a distinct
 * message ("invite the bot, retry") vs `wrong_privacy` ("pick
 * another channel").
 */
describe('verifyChannelPrivacyForWrite', () => {
  it('expected=private, channel is private → ok', async () => {
    channelInfoResponses.set('C_p', { id: 'C_p', name: 'priv', is_private: true });
    expect(await verifyChannelPrivacyForWrite('C_p', 'private')).toEqual({ ok: true });
  });

  it('expected=public, channel is public → ok', async () => {
    channelInfoResponses.set('C_pub', { id: 'C_pub', name: 'pub', is_private: false });
    expect(await verifyChannelPrivacyForWrite('C_pub', 'public')).toEqual({ ok: true });
  });

  it('expected=private, channel is public → wrong_privacy with actual/expected', async () => {
    channelInfoResponses.set('C_wrong', { id: 'C_wrong', name: 'wrong', is_private: false });
    expect(await verifyChannelPrivacyForWrite('C_wrong', 'private')).toEqual({
      ok: false,
      reason: 'wrong_privacy',
      actual: 'public',
      expected: 'private',
    });
  });

  it('expected=public, channel is private → wrong_privacy with actual/expected', async () => {
    channelInfoResponses.set('C_wrong2', { id: 'C_wrong2', name: 'wrong2', is_private: true });
    expect(await verifyChannelPrivacyForWrite('C_wrong2', 'public')).toEqual({
      ok: false,
      reason: 'wrong_privacy',
      actual: 'private',
      expected: 'public',
    });
  });

  it('cannot resolve the channel → cannot_verify (fail-closed)', async () => {
    // Previously this path silently accepted the write. The new
    // contract is: refuse with cannot_verify so the admin knows to
    // invite the bot and retry rather than saving an unverifiable
    // channel id that might misroute at send time.
    expect(await verifyChannelPrivacyForWrite('C_not_found', 'private')).toEqual({
      ok: false,
      reason: 'cannot_verify',
    });
    expect(await verifyChannelPrivacyForWrite('C_not_found', 'public')).toEqual({
      ok: false,
      reason: 'cannot_verify',
    });
  });
});
