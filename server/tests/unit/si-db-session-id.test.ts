import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/db/client.js', () => ({ query: queryMock }));

import { SiDatabase } from '../../src/db/si-db.js';

describe('SI session identifiers', () => {
  beforeEach(() => queryMock.mockReset());

  it('uses a full UUID for public session handles', async () => {
    queryMock.mockImplementationOnce(async (_sql: string, params: unknown[]) => ({
      rows: [{
        id: 'row-1',
        session_id: params[0],
        host_type: 'addy',
        host_identifier: 'thread-1',
        member_profile_id: null,
        brand_name: 'Acme',
        user_slack_id: null,
        user_email: null,
        user_name: null,
        user_anonymous_id: 'anon-1',
        identity_consent_granted: false,
        status: 'active',
        termination_reason: null,
        initial_context: null,
        campaign_id: null,
        offer_id: null,
        handoff_data: null,
        message_count: 0,
        created_at: new Date(),
        last_activity_at: new Date(),
        terminated_at: null,
      }],
    }));

    const created = await new SiDatabase().createSession({
      host_type: 'addy',
      host_identifier: 'thread-1',
      brand_name: 'Acme',
      user_anonymous_id: 'anon-1',
    });

    expect(created.session_id).toMatch(
      /^si_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('bounds message history in SQL and applies offset pagination', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });

    const messages = await new SiDatabase().getSessionMessages('si_session', 500, 25);

    expect(messages).toEqual([]);
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining('LIMIT $2 OFFSET $3'),
      ['si_session', 100, 25],
    );
  });
});
