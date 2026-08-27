import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemberContext } from '../../../src/addie/member-context.js';

const mocks = vi.hoisted(() => ({
  listEscalationsForUser: vi.fn(),
}));

vi.mock('../../../src/db/escalation-db.js', () => ({
  createEscalation: vi.fn(),
  markNotificationSent: vi.fn(),
  listEscalationsForUser: mocks.listEscalationsForUser,
}));

vi.mock('../../../src/addie/thread-service.js', () => ({
  getThreadService: vi.fn(),
}));

vi.mock('../../../src/slack/client.js', () => ({
  sendChannelMessage: vi.fn(),
}));

vi.mock('../../../src/db/system-settings-db.js', () => ({
  getEscalationChannel: vi.fn(),
}));

import { createEscalationToolHandlers } from '../../../src/addie/mcp/escalation-tools.js';

describe('get_escalation_status temporal output', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns an ISO instant and explicit timezone instead of a locale-only date', async () => {
    mocks.listEscalationsForUser.mockResolvedValue([{
      id: 42,
      summary: 'Access request',
      status: 'open',
      created_at: new Date('2026-08-27T06:45:30.000Z'),
      resolution_notes: null,
    }]);
    const memberContext = {
      workos_user: { workos_user_id: 'user_123' },
    } as MemberContext;
    const handler = createEscalationToolHandlers(memberContext).get('get_escalation_status');

    const result = JSON.parse(await handler!({}));

    expect(result.escalations[0]).toEqual(expect.objectContaining({
      submitted_at: '2026-08-27T06:45:30.000Z',
      submitted_time_zone: 'UTC',
    }));
    expect(result.escalations[0]).not.toHaveProperty('submitted');
  });
});
