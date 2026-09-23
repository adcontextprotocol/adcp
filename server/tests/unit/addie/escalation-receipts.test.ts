import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemberContext } from '../../../src/addie/member-context.js';

const mocks = vi.hoisted(() => ({
  createEscalation: vi.fn(),
  markNotificationSent: vi.fn(),
  flagThread: vi.fn(),
  sendChannelMessage: vi.fn(),
  getEscalationChannel: vi.fn(),
}));

vi.mock('../../../src/db/escalation-db.js', () => ({
  createEscalation: mocks.createEscalation,
  markNotificationSent: mocks.markNotificationSent,
  listEscalationsForUser: vi.fn(),
}));
vi.mock('../../../src/addie/thread-service.js', () => ({
  getThreadService: () => ({ flagThread: mocks.flagThread }),
}));
vi.mock('../../../src/slack/client.js', () => ({ sendChannelMessage: mocks.sendChannelMessage }));
vi.mock('../../../src/db/system-settings-db.js', () => ({ getEscalationChannel: mocks.getEscalationChannel }));

import { createEscalationToolHandlers } from '../../../src/addie/mcp/escalation-tools.js';
import { ToolError } from '../../../src/addie/tool-error.js';

const memberContext = {
  workos_user: { workos_user_id: 'user_dayo', email: 'dayo@example.com' },
} as MemberContext;
const request = { summary: 'Registration verification email never arrived', category: 'needs_human_action' };

function handler(context: MemberContext | null = memberContext, slackUserId?: string) {
  return createEscalationToolHandlers(context, slackUserId, 'thread_1').get('escalate_to_admin')!;
}

describe('escalation persisted receipts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createEscalation.mockResolvedValue({ id: 42 });
    mocks.flagThread.mockResolvedValue(undefined);
    mocks.getEscalationChannel.mockResolvedValue({ channel_id: 'private_support' });
    mocks.sendChannelMessage.mockResolvedValue({ ok: true, ts: '123.456' });
    mocks.markNotificationSent.mockResolvedValue(undefined);
  });

  it('rejects anonymous writes even when the caller supplies contact details', async () => {
    await expect(handler(null)({ ...request, user_email: 'dayo@example.com' }))
      .rejects.toThrow('support@agenticadvertising.org');
    expect(mocks.createEscalation).not.toHaveBeenCalled();
    expect(mocks.sendChannelMessage).not.toHaveBeenCalled();
  });

  it('returns a persisted receipt and requires private notification delivery', async () => {
    const result = JSON.parse(await handler()(request));
    expect(result).toMatchObject({ success: true, escalation_id: 42, notification_sent: true });
    expect(mocks.createEscalation).toHaveBeenCalledWith(expect.objectContaining({
      workos_user_id: 'user_dayo', user_email: 'dayo@example.com',
    }));
    expect(mocks.sendChannelMessage).toHaveBeenCalledWith(
      'private_support', expect.any(Object), { requirePrivate: true },
    );
    expect(JSON.stringify(result)).not.toContain('dayo@example.com');
  });

  it('preserves the existing authenticated Slack escalation path', async () => {
    const result = JSON.parse(await handler(null, 'U_DAYO')(request));
    expect(result).toMatchObject({ success: true, escalation_id: 42 });
    expect(mocks.createEscalation).toHaveBeenCalledWith(expect.objectContaining({ slack_user_id: 'U_DAYO' }));
  });

  it('reports failed persistence as a tool error rather than a successful narrative', async () => {
    mocks.createEscalation.mockRejectedValue(new Error('database unavailable'));
    await expect(handler()(request)).rejects.toBeInstanceOf(ToolError);
    expect(mocks.flagThread).not.toHaveBeenCalled();
    expect(mocks.sendChannelMessage).not.toHaveBeenCalled();
  });

  it('retains the persisted receipt if flagging the conversation fails', async () => {
    mocks.flagThread.mockRejectedValue(new Error('flag failed'));
    expect(JSON.parse(await handler()(request)))
      .toMatchObject({ success: true, escalation_id: 42, notification_sent: true });
    expect(mocks.createEscalation).toHaveBeenCalledTimes(1);
  });

  it.each(['unconfigured', 'settings failure', 'delivery failure', 'delivery rejected'])
    ('does not invent a notification when %s', async (scenario) => {
      if (scenario === 'unconfigured') mocks.getEscalationChannel.mockResolvedValue({ channel_id: null });
      if (scenario === 'settings failure') mocks.getEscalationChannel.mockRejectedValue(new Error('settings failed'));
      if (scenario === 'delivery failure') mocks.sendChannelMessage.mockRejectedValue(new Error('delivery failed'));
      if (scenario === 'delivery rejected') mocks.sendChannelMessage.mockResolvedValue({ ok: false });

      const result = JSON.parse(await handler()(request));
      expect(result).toMatchObject({ success: true, escalation_id: 42, notification_sent: false });
      expect(result.message).toContain('support@agenticadvertising.org');
      expect(result.message).not.toContain('has been notified');
      expect(mocks.markNotificationSent).not.toHaveBeenCalled();
    });

  it('reports delivery truthfully when recording its status fails after Slack accepted it', async () => {
    mocks.markNotificationSent.mockRejectedValue(new Error('status update failed'));
    expect(JSON.parse(await handler()(request)))
      .toMatchObject({ success: true, escalation_id: 42, notification_sent: true });
  });
});
