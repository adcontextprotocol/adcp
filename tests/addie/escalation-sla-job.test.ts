import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockAddSystemEscalationUpdate,
  mockGetEscalationChannel,
  mockGetClient,
  mockDbClient,
  mockListEscalationsForSlaEnforcement,
  mockMarkEscalationSlaNotified,
  mockSendChannelMessage,
  mockSendDirectMessage,
} = vi.hoisted(() => ({
  mockAddSystemEscalationUpdate: vi.fn<any>(),
  mockGetEscalationChannel: vi.fn<any>(),
  mockDbClient: {
    query: vi.fn<any>(),
    release: vi.fn<any>(),
  },
  mockGetClient: vi.fn<any>(),
  mockListEscalationsForSlaEnforcement: vi.fn<any>(),
  mockMarkEscalationSlaNotified: vi.fn<any>(),
  mockSendChannelMessage: vi.fn<any>(),
  mockSendDirectMessage: vi.fn<any>(),
}));

vi.mock('../../server/src/db/client.js', () => ({
  getClient: () => mockGetClient(),
}));

vi.mock('../../server/src/db/escalation-db.js', () => ({
  addSystemEscalationUpdate: (...args: unknown[]) => mockAddSystemEscalationUpdate(...args),
  describeEscalationSla: (escalation: any, now: Date) => {
    const createdAt = new Date(escalation.created_at).getTime();
    const updatedAt = new Date(escalation.updated_at).getTime();
    return {
      age_hours: Math.max(0, (now.getTime() - createdAt) / (60 * 60 * 1000)),
      hours_since_update: Math.max(0, (now.getTime() - updatedAt) / (60 * 60 * 1000)),
      needs_follow_up: true,
      label: 'Needs update',
      threshold_hours: 24,
    };
  },
  listEscalationsForSlaEnforcement: (...args: unknown[]) => mockListEscalationsForSlaEnforcement(...args),
  markEscalationSlaNotified: (...args: unknown[]) => mockMarkEscalationSlaNotified(...args),
}));

vi.mock('../../server/src/db/system-settings-db.js', () => ({
  getEscalationChannel: (...args: unknown[]) => mockGetEscalationChannel(...args),
}));

vi.mock('../../server/src/slack/client.js', () => ({
  sendChannelMessage: (...args: unknown[]) => mockSendChannelMessage(...args),
  sendDirectMessage: (...args: unknown[]) => mockSendDirectMessage(...args),
}));

import { runEscalationSlaJob } from '../../server/src/addie/jobs/escalation-sla.js';

const NOW = new Date('2026-06-17T12:00:00Z');

function escalation(overrides: Partial<any> = {}) {
  return {
    id: 42,
    status: 'in_progress',
    priority: 'high',
    summary: 'Needs admin help',
    created_at: new Date('2026-06-15T12:00:00Z'),
    updated_at: new Date('2026-06-16T10:00:00Z'),
    user_display_name: 'Test User',
    user_email: 'test@example.com',
    user_slack_handle: null,
    workos_user_id: 'user_123',
    slack_user_id: null,
    thread_id: null,
    notification_channel_id: 'C_OLD',
    notification_message_ts: '1710000000.000',
    sla_admin_last_notified_at: null,
    sla_requester_last_notified_at: NOW,
    sla_follow_up_count: 0,
    ...overrides,
  };
}

beforeEach(() => {
  mockAddSystemEscalationUpdate.mockReset();
  mockDbClient.query.mockReset();
  mockDbClient.release.mockReset();
  mockGetClient.mockReset();
  mockGetEscalationChannel.mockReset();
  mockListEscalationsForSlaEnforcement.mockReset();
  mockMarkEscalationSlaNotified.mockReset();
  mockSendChannelMessage.mockReset();
  mockSendDirectMessage.mockReset();

  mockGetClient.mockResolvedValue(mockDbClient);
  mockDbClient.query.mockImplementation(async (sql: string) => {
    if (sql.includes('pg_try_advisory_lock')) {
      return { rows: [{ pg_try_advisory_lock: true }] };
    }
    if (sql.includes('pg_advisory_unlock')) {
      return { rows: [{ pg_advisory_unlock: true }] };
    }
    return { rows: [] };
  });
  mockGetEscalationChannel.mockResolvedValue({ channel_id: 'C_NEW' });
  mockSendChannelMessage.mockResolvedValue({ ok: true, ts: '1710000001.000' });
});

describe('runEscalationSlaJob', () => {
  it('does not thread an SLA alert under a message from a different escalation channel', async () => {
    mockListEscalationsForSlaEnforcement.mockResolvedValue([escalation()]);

    const result = await runEscalationSlaJob({ now: NOW });

    expect(result.admin_alerted).toBe(1);
    expect(mockSendChannelMessage).toHaveBeenCalledWith(
      'C_NEW',
      expect.objectContaining({ thread_ts: undefined }),
      { requirePrivate: true },
    );
    expect(mockMarkEscalationSlaNotified).toHaveBeenCalledWith(42, {
      admin: true,
      requester: false,
    });
  });

  it('threads an SLA alert when the original notification was in the configured channel', async () => {
    mockGetEscalationChannel.mockResolvedValue({ channel_id: 'C_ESCALATIONS' });
    mockListEscalationsForSlaEnforcement.mockResolvedValue([
      escalation({ notification_channel_id: 'C_ESCALATIONS' }),
    ]);

    await runEscalationSlaJob({ now: NOW });

    expect(mockSendChannelMessage).toHaveBeenCalledWith(
      'C_ESCALATIONS',
      expect.objectContaining({ thread_ts: '1710000000.000' }),
      { requirePrivate: true },
    );
  });
});
