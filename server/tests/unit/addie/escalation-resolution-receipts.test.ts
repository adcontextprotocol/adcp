import { afterEach, describe, expect, it, vi } from 'vitest';
import * as escalationDb from '../../../src/db/escalation-db.js';
import * as guard from '../../../src/services/escalation-resolution-guard.js';
import * as email from '../../../src/notifications/email.js';
import * as slack from '../../../src/slack/client.js';
import { createAdminToolHandlers } from '../../../src/addie/mcp/admin-tools.js';
import { enforceOutcomeClaims } from '../../../src/addie/outcome-claims.js';

afterEach(() => vi.restoreAllMocks());

describe('resolution receipts', () => {
  it.each(['email', 'slack', 'email_fallback', 'failed', 'disabled'])(
    'binds saved resolution and notification evidence: %s', async channel => {
      vi.spyOn(escalationDb, 'getEscalation').mockResolvedValue({ id: 42, status: 'open', summary: 'Campaign setup help', user_email: 'dayo@example.test', ...(channel === 'slack' || channel === 'email_fallback' ? { slack_user_id: 'U_DAYO' } : {}) } as escalationDb.Escalation);
      vi.spyOn(guard, 'guardEscalationResolution').mockResolvedValue({ ok: true });
      vi.spyOn(escalationDb, 'updateEscalationStatus').mockResolvedValue({ id: 42, status: 'resolved' } as escalationDb.Escalation);
      const emailSend = vi.spyOn(email, 'sendEscalationResolutionEmail').mockResolvedValue(channel !== 'failed');
      const slackSend = vi.spyOn(slack, 'sendDirectMessage').mockResolvedValue({ ok: channel === 'slack' });
      const result = await createAdminToolHandlers().get('resolve_escalation')!({ escalation_id: 42, notify_user: channel !== 'disabled' });
      const notified = channel !== 'failed' && channel !== 'disabled';
      expect(JSON.parse(result)).toMatchObject({ success: true, escalation_id: 42, status: 'resolved', notification_sent: notified, notification_channel: notified ? channel === 'slack' ? 'slack' : 'email' : null });
      const final = enforceOutcomeClaims("I've resolved escalation #42 and notified the user.", [{ tool_name: 'resolve_escalation', parameters: {}, result, is_error: false, sequence: 1, duration_ms: 1 }]);
      expect(final.reason).toBeNull();
      expect(final.text).toContain('marked as resolved');
      expect(final.text).not.toContain("haven't created");
      if (channel === 'disabled') {
        expect(emailSend).not.toHaveBeenCalled();
        expect(slackSend).not.toHaveBeenCalled();
      }
    },
  );

  it('does not issue a success receipt if persistence fails', async () => {
    vi.spyOn(escalationDb, 'getEscalation').mockResolvedValue({ id: 42, status: 'open' } as escalationDb.Escalation);
    vi.spyOn(guard, 'guardEscalationResolution').mockResolvedValue({ ok: true });
    vi.spyOn(escalationDb, 'updateEscalationStatus').mockResolvedValue(null);
    const send = vi.spyOn(email, 'sendEscalationResolutionEmail');
    expect(await createAdminToolHandlers().get('resolve_escalation')!({ escalation_id: 42 })).toContain('Failed to update');
    expect(send).not.toHaveBeenCalled();
  });
});
