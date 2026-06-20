import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const client = {
    query: vi.fn(),
    release: vi.fn(),
  };

  return {
    client,
    getClient: vi.fn(async () => client),
    addSystemEscalationUpdate: vi.fn(),
    describeEscalationSla: vi.fn(),
    listEscalationsForSlaEnforcement: vi.fn(),
    markEscalationSlaNotified: vi.fn(),
    getEscalationChannel: vi.fn(),
    sendChannelMessage: vi.fn(),
    sendDirectMessage: vi.fn(),
  };
});

vi.mock('../../src/db/client.js', () => ({
  getClient: mocks.getClient,
}));

vi.mock('../../src/db/escalation-db.js', () => ({
  addSystemEscalationUpdate: mocks.addSystemEscalationUpdate,
  describeEscalationSla: mocks.describeEscalationSla,
  listEscalationsForSlaEnforcement: mocks.listEscalationsForSlaEnforcement,
  markEscalationSlaNotified: mocks.markEscalationSlaNotified,
}));

vi.mock('../../src/db/system-settings-db.js', () => ({
  getEscalationChannel: mocks.getEscalationChannel,
}));

vi.mock('../../src/slack/client.js', () => ({
  sendChannelMessage: mocks.sendChannelMessage,
  sendDirectMessage: mocks.sendDirectMessage,
}));

import { runEscalationSlaJob } from '../../src/addie/jobs/escalation-sla.js';

function makeEscalation(overrides: Record<string, unknown> = {}) {
  return {
    id: 15,
    thread_id: null,
    message_id: null,
    slack_user_id: null,
    workos_user_id: null,
    user_display_name: 'Jane Doe',
    user_email: 'jane@example.com',
    user_slack_handle: null,
    category: 'needs_human_action',
    priority: 'normal',
    summary: 'Needs help with account setup',
    original_request: null,
    addie_context: null,
    notification_channel_id: 'CADMIN',
    notification_sent_at: new Date('2026-06-18T09:00:00Z'),
    notification_message_ts: '1718710800.000000',
    status: 'open',
    resolved_by: null,
    resolved_at: null,
    resolution_notes: null,
    perspective_id: null,
    perspective_slug: null,
    github_issue_url: null,
    github_issue_number: null,
    github_issue_repo: null,
    dedup_key: null,
    sla_admin_last_notified_at: null,
    sla_requester_last_notified_at: null,
    sla_follow_up_count: 0,
    created_at: new Date('2026-06-18T09:00:00Z'),
    updated_at: new Date('2026-06-18T09:00:00Z'),
    ...overrides,
  };
}

describe('runEscalationSlaJob', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getClient.mockResolvedValue(mocks.client);
    mocks.client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) {
        return { rows: [{ pg_try_advisory_lock: true }] };
      }
      if (sql.includes('pg_advisory_unlock')) {
        return { rows: [{ pg_advisory_unlock: true }] };
      }
      return { rows: [] };
    });
    mocks.describeEscalationSla.mockReturnValue({
      age_hours: 25,
      hours_since_update: 25,
      needs_follow_up: true,
      label: 'Needs pickup',
      threshold_hours: 24,
    });
    mocks.listEscalationsForSlaEnforcement.mockResolvedValue([]);
    mocks.getEscalationChannel.mockResolvedValue({ channel_id: 'CADMIN', channel_name: 'aao-admin' });
    mocks.sendChannelMessage.mockResolvedValue({ ok: true, ts: '1718800000.000000' });
    mocks.sendDirectMessage.mockResolvedValue({ ok: true });
    mocks.addSystemEscalationUpdate.mockResolvedValue({ id: 1 });
  });

  it('does not scan or send when another SLA run holds the advisory lock', async () => {
    mocks.client.query.mockResolvedValueOnce({ rows: [{ pg_try_advisory_lock: false }] });

    const result = await runEscalationSlaJob();

    expect(result).toEqual({
      scanned: 0,
      admin_alerted: 0,
      requester_updated: 0,
      requester_dm_sent: 0,
      skipped_no_channel: 0,
      errors: 0,
      locked_out: true,
    });
    expect(mocks.listEscalationsForSlaEnforcement).not.toHaveBeenCalled();
    expect(mocks.getEscalationChannel).not.toHaveBeenCalled();
    expect(mocks.sendChannelMessage).not.toHaveBeenCalled();
    expect(mocks.markEscalationSlaNotified).not.toHaveBeenCalled();
    expect(mocks.client.release).toHaveBeenCalledWith(false);
    expect(mocks.client.query).toHaveBeenCalledTimes(1);
  });

  it('posts due reminders and releases the advisory lock', async () => {
    mocks.listEscalationsForSlaEnforcement.mockResolvedValue([
      makeEscalation(),
    ]);

    const result = await runEscalationSlaJob({
      now: new Date('2026-06-19T10:00:00Z'),
    });

    expect(result).toEqual({
      scanned: 1,
      admin_alerted: 1,
      requester_updated: 1,
      requester_dm_sent: 0,
      skipped_no_channel: 0,
      errors: 0,
    });
    expect(mocks.sendChannelMessage).toHaveBeenCalledTimes(1);
    expect(mocks.sendChannelMessage).toHaveBeenCalledWith(
      'CADMIN',
      expect.objectContaining({
        text: expect.stringContaining('Escalation SLA follow-up needed: #15'),
        thread_ts: '1718710800.000000',
      }),
      { requirePrivate: true },
    );
    expect(mocks.addSystemEscalationUpdate).toHaveBeenCalledWith(
      15,
      expect.stringContaining('support request #15'),
      true,
    );
    expect(mocks.markEscalationSlaNotified).toHaveBeenCalledWith(15, {
      admin: true,
      requester: true,
    });
    const lockCall = mocks.client.query.mock.calls.find(([sql]) =>
      String(sql).includes('pg_try_advisory_lock'),
    );
    const unlockCall = mocks.client.query.mock.calls.find(([sql]) =>
      String(sql).includes('pg_advisory_unlock'),
    );
    expect(unlockCall).toEqual([
      'SELECT pg_advisory_unlock($1) AS pg_advisory_unlock',
      lockCall?.[1],
    ]);
    expect(mocks.client.release).toHaveBeenCalledWith(false);
  });

  it('releases the advisory lock when the run fails after acquiring it', async () => {
    const error = new Error('db unavailable');
    mocks.listEscalationsForSlaEnforcement.mockRejectedValue(error);

    await expect(runEscalationSlaJob()).rejects.toThrow('db unavailable');

    expect(mocks.client.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_unlock($1) AS pg_advisory_unlock',
      expect.any(Array),
    );
    expect(mocks.client.release).toHaveBeenCalledWith(false);
  });

  it('destroys the client when advisory unlock fails', async () => {
    mocks.client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) {
        return { rows: [{ pg_try_advisory_lock: true }] };
      }
      if (sql.includes('pg_advisory_unlock')) {
        throw new Error('network reset');
      }
      return { rows: [] };
    });

    const result = await runEscalationSlaJob();

    expect(result.scanned).toBe(0);
    expect(mocks.client.release).toHaveBeenCalledWith(true);
  });

  it('destroys the client when advisory unlock returns false', async () => {
    mocks.client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) {
        return { rows: [{ pg_try_advisory_lock: true }] };
      }
      if (sql.includes('pg_advisory_unlock')) {
        return { rows: [{ pg_advisory_unlock: false }] };
      }
      return { rows: [] };
    });

    const result = await runEscalationSlaJob();

    expect(result.scanned).toBe(0);
    expect(mocks.client.release).toHaveBeenCalledWith(true);
  });
});
