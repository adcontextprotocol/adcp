import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db/client.js', () => ({
  query: vi.fn(),
}));

import { query } from '../../src/db/client.js';
import {
  ACCOUNT_LINK_CORRELATION_TTL_MS,
  cleanupAccountLinkCorrelations,
  consumeAccountLinkCorrelation,
  createAccountLinkCorrelation,
  isAccountLinkCorrelationToken,
  recordProactiveEvent,
} from '../../src/db/addie-account-link-correlation-db.js';

const mockedQuery = vi.mocked(query);

describe('account-link origin correlation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('stores only a token hash after validating the exact initiating thread', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-27T10:00:00Z'));
    mockedQuery.mockResolvedValueOnce({ rows: [{ correlation_id: 'correlation-a' }], rowCount: 1 } as never);

    const token = await createAccountLinkCorrelation({
      surface: 'slack',
      threadId: 'thread-a',
      initiatingUserId: 'U123',
    });

    expect(isAccountLinkCorrelationToken(token)).toBe(true);
    const [sql, params] = mockedQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('t.thread_id = $3');
    expect(sql).toContain('t.channel = $2');
    expect(sql).toContain('t.user_id = $4');
    expect(sql).toContain("t.user_type = 'slack'");
    expect(params[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(params[0]).not.toBe(token);
    expect(params.slice(1, 4)).toEqual(['slack', 'thread-a', 'U123']);
    expect(params[4]).toEqual(new Date(Date.now() + ACCOUNT_LINK_CORRELATION_TTL_MS));
  });

  it('does not issue a bearer token when thread ownership validation fails', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    await expect(createAccountLinkCorrelation({
      surface: 'slack',
      threadId: 'thread-owned-by-someone-else',
      initiatingUserId: 'U123',
    })).resolves.toBeUndefined();
  });

  it('consumes the correlated origin without consulting a more recent conversation', async () => {
    mockedQuery.mockResolvedValueOnce({
      rows: [{
        correlation_id: 'correlation-a',
        surface: 'slack',
        thread_id: 'origin-thread',
        initiating_user_id: 'U123',
        external_id: 'D123:111.222',
      }],
      rowCount: 1,
    } as never);

    const origin = await consumeAccountLinkCorrelation('a'.repeat(43), {
      surface: 'slack',
      initiatingUserId: 'U123',
    });

    expect(origin).toEqual({
      correlationId: 'correlation-a',
      surface: 'slack',
      threadId: 'origin-thread',
      initiatingUserId: 'U123',
      externalId: 'D123:111.222',
    });
    const [sql, params] = mockedQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('SET consumed_at = NOW()');
    expect(sql).toContain('c.expires_at > NOW()');
    expect(sql).toContain('c.consumed_at IS NULL');
    expect(sql).toContain('t.external_id = c.external_id');
    expect(sql).not.toContain('ORDER BY');
    expect(sql).not.toContain('last_message_at');
    expect(params.slice(1)).toEqual(['slack', 'U123']);
  });

  it.each([
    'expired correlation',
    'replayed correlation',
    'mismatched user',
    'mismatched thread state',
  ])('rejects %s when the atomic validation updates no row', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    await expect(consumeAccountLinkCorrelation('b'.repeat(43), {
      surface: 'slack',
      initiatingUserId: 'U-other',
    })).resolves.toBeUndefined();
  });

  it('persists proactive outcomes as identifier-only events', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    await recordProactiveEvent({
      eventType: 'account_linked',
      correlationId: 'correlation-a',
      surface: 'slack',
      threadId: 'origin-thread',
      initiatingUserId: 'U123',
      deliveryStatus: 'delivered',
      reasonCode: 'slack_correlated_thread_delivered',
    });

    const [sql, params] = mockedQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO addie_proactive_events');
    expect(params).toEqual([
      'account_linked',
      'correlation-a',
      'slack',
      'origin-thread',
      'U123',
      'delivered',
      'slack_correlated_thread_delivered',
    ]);
    expect(sql).not.toContain('content');
  });

  it('accepts only fixed-length base64url correlation tokens', () => {
    expect(isAccountLinkCorrelationToken('a'.repeat(43))).toBe(true);
    expect(isAccountLinkCorrelationToken('a'.repeat(42))).toBe(false);
    expect(isAccountLinkCorrelationToken(`${'a'.repeat(42)}=`)).toBe(false);
    expect(isAccountLinkCorrelationToken(['a'.repeat(43)])).toBe(false);
  });

  it('cleans up expired correlation audit rows after the retention window', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 3 } as never);

    await expect(cleanupAccountLinkCorrelations(24)).resolves.toBe(3);

    const [sql, params] = mockedQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('DELETE FROM addie_account_link_correlations');
    expect(sql).toContain('make_interval(hours => $1)');
    expect(params).toEqual([24]);
  });
});
