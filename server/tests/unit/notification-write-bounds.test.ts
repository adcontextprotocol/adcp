/**
 * The notification write seam bounds what can be stored (adcp#8320).
 *
 * `notifyUser` is the usual way in, but a handful of callers insert a row
 * directly — so flattening, truncation and the link-shape check live in
 * `createNotification` rather than in the service. Without that, a
 * multi-line or multi-kilobyte title reaches both renderers (a Slack DM,
 * where it forges extra lines, and the web list, where it is the whole
 * item) no matter which entry point wrote it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../src/db/client.js', () => ({ query: dbMocks.query }));

const {
  isSafeNotificationPath,
  NotificationDatabase,
  NOTIFICATION_BODY_MAX_LENGTH,
  NOTIFICATION_TITLE_MAX_LENGTH,
} = await import('../../src/db/notification-db.js');

const db = new NotificationDatabase();

/** Positional insert params: title is $6, body is $7, url is $8. */
function insertedValues(): { title: string; body: string | null; url: string | null } {
  const [, params] = dbMocks.query.mock.calls.at(-1) as [string, unknown[]];
  return { title: params[5] as string, body: params[6] as string | null, url: params[7] as string | null };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.query.mockResolvedValue({ rows: [{ id: 'n1' }], rowCount: 1 });
});

describe('NotificationDatabase.createNotification', () => {
  it('flattens a multi-line title to one line', async () => {
    await db.createNotification({
      recipientUserId: 'u1',
      type: 'test',
      title: 'Agent failed\nStatus: passing\u0000Verified: yes',
    });

    expect(insertedValues().title).toBe('Agent failed Status: passing Verified: yes');
  });

  it('truncates both halves at their caps', async () => {
    await db.createNotification({
      recipientUserId: 'u1',
      type: 'test',
      title: 'T'.repeat(5_000),
      body: 'B'.repeat(20_000),
    });

    const { title, body } = insertedValues();
    expect(title).toBe(`${'T'.repeat(NOTIFICATION_TITLE_MAX_LENGTH)}…`);
    expect(body).toBe(`${'B'.repeat(NOTIFICATION_BODY_MAX_LENGTH)}…`);
  });

  it('stores no body when the caller has no detail to give', async () => {
    await db.createNotification({ recipientUserId: 'u1', type: 'test', title: 'Plain' });

    expect(insertedValues().body).toBeNull();
  });

  it('keeps site-relative links and drops everything else', async () => {
    for (const url of ['/registry?tab=agents', '/working-groups/signals']) {
      await db.createNotification({ recipientUserId: 'u1', type: 'test', title: 'x', url });
      expect(insertedValues().url).toBe(url);
    }

    // `javascript:` would run on click in the web list; `//host` jumps
    // off-site; `>`/`|` break out of Slack's `<url|label>` syntax.
    // `/\evil.example` matters because the WHATWG URL parser folds the
    // backslash to a slash for http(s), making it protocol-relative.
    for (const url of ['javascript:alert(1)', 'https://evil.example', '//evil.example', '/\\evil.example', '/ok|<!channel>']) {
      await db.createNotification({ recipientUserId: 'u1', type: 'test', title: 'x', url });
      expect(insertedValues().url).toBeNull();
    }
  });
});

describe('isSafeNotificationPath', () => {
  it('accepts the shapes every caller actually passes', () => {
    expect(isSafeNotificationPath('/registry?tab=agents')).toBe(true);
    expect(isSafeNotificationPath('/events/adcp-summit-2026')).toBe(true);
  });

  it('rejects absolute, protocol-relative, and link-breaking paths', () => {
    expect(isSafeNotificationPath('https://evil.example')).toBe(false);
    expect(isSafeNotificationPath('javascript:alert(1)')).toBe(false);
    expect(isSafeNotificationPath('//evil.example')).toBe(false);
    expect(isSafeNotificationPath('/a>b')).toBe(false);
    expect(isSafeNotificationPath('/a|b')).toBe(false);
    expect(isSafeNotificationPath('/a b')).toBe(false);
    expect(isSafeNotificationPath('/\\evil.example')).toBe(false);
    expect(isSafeNotificationPath('/a\u0000b')).toBe(false);
  });
});
