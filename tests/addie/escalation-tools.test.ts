import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import type { MemberContext } from '../../server/src/addie/member-context.js';

// Mock escalation-db
const mockListEscalationsForUser = jest.fn();
jest.mock('../../server/src/db/escalation-db.js', () => ({
  createEscalation: jest.fn(),
  markNotificationSent: jest.fn(),
  listEscalationsForUser: (...args: unknown[]) => mockListEscalationsForUser(...args),
}));

// Mock slack client
jest.mock('../../server/src/slack/client.js', () => ({
  sendChannelMessage: jest.fn().mockResolvedValue({ ok: true }),
}));

// Mock system settings
jest.mock('../../server/src/db/system-settings-db.js', () => ({
  getEscalationChannel: jest.fn().mockResolvedValue({ channel_id: 'C_ESCALATION' }),
}));

// Mock thread service
jest.mock('../../server/src/addie/thread-service.js', () => ({
  getThreadService: jest.fn().mockReturnValue({
    flagThread: jest.fn(),
    getThreadWithMessages: jest.fn(),
  }),
}));

// Mock addie-db
jest.mock('../../server/src/db/addie-db.js', () => ({
  AddieDatabase: jest.fn().mockImplementation(() => ({
    createInsightSource: jest.fn(),
  })),
}));

const mockMemberContext: MemberContext = {
  is_mapped: true,
  is_member: true,
  workos_user: {
    workos_user_id: 'user_test123',
    email: 'test@example.com',
    first_name: 'Test',
    last_name: 'User',
  } as MemberContext['workos_user'],
  organization: {
    workos_organization_id: 'org_test456',
    name: 'Test Corp',
    subscription_status: 'active',
    is_personal: false,
  },
};

beforeEach(() => {
  jest.clearAllMocks();
  mockListEscalationsForUser.mockResolvedValue([]);
});

describe('get_escalation_status', () => {
  test('returns empty message when user has no escalations', async () => {
    mockListEscalationsForUser.mockResolvedValue([]);

    const { createEscalationToolHandlers } = await import('../../server/src/addie/mcp/escalation-tools.js');
    const handlers = createEscalationToolHandlers(mockMemberContext, 'U_SLACK_123', 'thread_abc');
    const getStatus = handlers.get('get_escalation_status')!;

    const result = await getStatus({});
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(true);
    expect(parsed.escalations).toHaveLength(0);
    expect(parsed.message).toContain("don't have any previous support requests");
  });

  test('returns formatted escalation list', async () => {
    mockListEscalationsForUser.mockResolvedValue([
      {
        id: 42,
        summary: 'Invoice never received',
        status: 'in_progress',
        created_at: new Date('2026-01-04T10:00:00Z'),
        resolution_notes: null,
        thread_id: null,
        message_id: null,
        slack_user_id: 'U_SLACK_123',
        workos_user_id: 'user_test123',
        user_display_name: 'Test User',
        user_email: 'test@example.com',
        user_slack_handle: 'testuser',
        category: 'needs_human_action',
        priority: 'high',
        original_request: 'I never got my invoice',
        addie_context: 'User has an active subscription',
        notification_channel_id: null,
        notification_sent_at: null,
        notification_message_ts: null,
        resolved_by: null,
        resolved_at: null,
        updated_at: new Date(),
      },
    ]);

    const { createEscalationToolHandlers } = await import('../../server/src/addie/mcp/escalation-tools.js');
    const handlers = createEscalationToolHandlers(mockMemberContext, 'U_SLACK_123', 'thread_abc');
    const getStatus = handlers.get('get_escalation_status')!;

    const result = await getStatus({});
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(true);
    expect(parsed.escalations).toHaveLength(1);
    expect(parsed.escalations[0].id).toBe(42);
    expect(parsed.escalations[0].summary).toBe('Invoice never received');
    expect(parsed.escalations[0].status).toBe('in_progress');
    expect(parsed.escalations[0].status_label).toContain('In progress');
    expect(mockListEscalationsForUser).toHaveBeenCalledWith('user_test123', 'U_SLACK_123');
  });

  test('returns error when user identity is unavailable', async () => {
    const { createEscalationToolHandlers } = await import('../../server/src/addie/mcp/escalation-tools.js');
    // No member context, no slack user ID
    const handlers = createEscalationToolHandlers(null, undefined, undefined);
    const getStatus = handlers.get('get_escalation_status')!;

    const result = await getStatus({});
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(false);
    expect(parsed.message).toContain("don't have enough information");
  });

  test('handles DB errors gracefully', async () => {
    mockListEscalationsForUser.mockRejectedValue(new Error('DB connection failed'));

    const { createEscalationToolHandlers } = await import('../../server/src/addie/mcp/escalation-tools.js');
    const handlers = createEscalationToolHandlers(mockMemberContext, 'U_SLACK_123', 'thread_abc');
    const getStatus = handlers.get('get_escalation_status')!;

    const result = await getStatus({});
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(false);
    expect(parsed.message).toContain('trouble looking up');
  });
});
