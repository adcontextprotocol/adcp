import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db/client.js', () => ({
  query: vi.fn(),
}));

import { query } from '../../src/db/client.js';
import { AddieDatabase } from '../../src/db/addie-db.js';

const queryMock = vi.mocked(query);

const rows = [
  { id: 1, text: 'public update', channel_name: 'public-room', username: 'public-user', permalink: 'https://slack/public', created_at: new Date() },
  { id: 2, text: 'allowed update', channel_name: 'private-allowed', username: 'allowed-user', permalink: 'https://slack/allowed', created_at: new Date() },
  { id: 3, text: 'denied update', channel_name: 'private-denied', username: 'denied-user', permalink: 'https://slack/denied', created_at: new Date() },
];

describe('AddieDatabase Slack knowledge ACL', () => {
  beforeEach(() => {
    queryMock.mockReset();
    queryMock.mockImplementation(async (sql, params = []) => {
      const statement = String(sql);
      const allowed = params.find(Array.isArray) as string[] | undefined;
      const channelPattern = statement.includes('TO_TIMESTAMP(slack_ts::numeric)')
        ? String(params[0] ?? '').replaceAll('%', '').toLowerCase()
        : '';
      const visible = rows.filter((row) => {
        if (channelPattern && !row.channel_name.includes(channelPattern)) return false;
        if (row.channel_name === 'public-room') return true;
        if (row.channel_name === 'private-allowed') return allowed?.includes('C_ALLOWED') === true;
        return allowed?.includes('C_DENIED') === true;
      });
      return { rows: visible, rowCount: visible.length } as never;
    });
  });

  it('defaults Slack search to public-only and excludes denied private rows', async () => {
    const db = new AddieDatabase();
    const result = await db.searchSlackMessages('update');

    expect(result.map((row) => row.channel_name)).toEqual(['public-room']);
    const [sql, params] = queryMock.mock.calls[0];
    expect(String(sql)).toContain('NOT EXISTS');
    expect(String(sql)).not.toContain('ANY(');
    expect(params).toEqual(['update', 10]);
  });

  it('returns public and explicitly allowed private search rows only', async () => {
    const db = new AddieDatabase();
    const result = await db.searchSlackMessages('update', {
      accessiblePrivateChannelIds: ['C_ALLOWED'],
    });

    expect(result.map((row) => row.channel_name)).toEqual(['public-room', 'private-allowed']);
    expect(result.map((row) => row.channel_name)).not.toContain('private-denied');
    const [sql, params] = queryMock.mock.calls[0];
    expect(String(sql)).toContain('slack_channel_id = ANY($3::text[])');
    expect(params).toEqual(['update', 10, ['C_ALLOWED']]);
  });

  it('defaults broad channel activity to public-only', async () => {
    const db = new AddieDatabase();
    const result = await db.getChannelActivity('');

    expect(result.map((row) => row.channel_name)).toEqual(['public-room']);
    const [sql, params] = queryMock.mock.calls[0];
    expect(String(sql)).toContain('NOT EXISTS');
    expect(String(sql)).not.toContain('ANY(');
    expect(params).toEqual(['%%', 30, 25]);
  });

  it('filters broad and partial channel activity to public plus allowed private rows', async () => {
    const db = new AddieDatabase();
    const broad = await db.getChannelActivity('', {
      accessiblePrivateChannelIds: ['C_ALLOWED'],
    });
    const partial = await db.getChannelActivity('private', {
      accessiblePrivateChannelIds: ['C_ALLOWED'],
    });

    expect(broad.map((row) => row.channel_name)).toEqual(['public-room', 'private-allowed']);
    expect(partial.map((row) => row.channel_name)).toEqual(['private-allowed']);
    expect(partial.map((row) => row.channel_name)).not.toContain('private-denied');
    const [sql, params] = queryMock.mock.calls[1];
    expect(String(sql)).toContain('slack_channel_id = ANY($4::text[])');
    expect(params).toEqual(['%private%', 30, 25, ['C_ALLOWED']]);
  });
});
