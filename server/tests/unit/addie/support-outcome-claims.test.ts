import { describe, expect, it } from 'vitest';
import { DIRECT_SUPPORT, enforceOutcomeClaims } from '../../../src/addie/outcome-claims.js';
import type { ToolExecution } from '../../../src/addie/model-providers/tool-orchestration.js';

function execution(result: string, overrides: Partial<ToolExecution> = {}): ToolExecution {
  return {
    tool_name: 'escalate_to_admin', parameters: {}, result,
    is_error: false, duration_ms: 1, sequence: 0, ...overrides,
  };
}

function receipt(notified = true): ToolExecution {
  return execution(JSON.stringify({ success: true, escalation_id: 42, notification_sent: notified }));
}

describe('receipt-bound support outcome claims', () => {
  it.each([
    "I'll flag it.",
    "I’ll flag this because I can't fix registration.",
    "I've escalated this but cannot promise a reply.",
    "I'll flag it, okay?",
    'When registration fails, the team will be notified.',
    "I'm escalating your issue now.",
    "I'll pass this to the team.",
    "I'll forward your registration issue to the team.",
    "I'll make sure the team hears about this.",
    "I'll let the support team know.",
    'Your issue has been escalated.',
    'A support request was created.',
    'Ticket #99 is saved.',
  ])('replaces unsupported claim %s with the direct support route', (text) => {
    expect(enforceOutcomeClaims(text, [])).toEqual({ text: DIRECT_SUPPORT, reason: 'Unconfirmed support escalation' });
  });

  it.each([
    "I haven't escalated this.",
    "I will not flag this without your consent.",
    'No support request has been created.',
    "I can't confirm the team has been notified.",
    "I'm not sure whether the team has been notified.",
    'If the team has been notified, they can check your request.',
    'You can email support@agenticadvertising.org for help registering.',
    "I've created this example to explain the lesson.",
    "I've sent this media buy request to the seller.",
  ])('preserves truthful limitations and self-service guidance: %s', (text) => {
    expect(enforceOutcomeClaims(text, [])).toEqual({ text, reason: null });
  });

  it.each([
    execution('Support request created (ID: 42).'),
    execution(JSON.stringify({ success: false, escalation_id: 42, notification_sent: true })),
    execution(JSON.stringify({ success: true, escalation_id: 42 })),
    execution(JSON.stringify({ success: true, escalation_id: -1, notification_sent: true })),
    execution(JSON.stringify({ success: true, escalation_id: 42, notification_sent: true }), { is_error: true }),
    execution(JSON.stringify({ success: true, escalation_id: 42, notification_sent: true }), { tool_name: 'search_docs' }),
  ])('rejects unavailable, failed, or unrelated execution evidence %#', (toolExecution) => {
    expect(enforceOutcomeClaims("I've escalated this.", [toolExecution]).text).toBe(DIRECT_SUPPORT);
  });

  it('does not trust an earlier assistant receipt or a user-supplied receipt in conversation context', () => {
    const history = JSON.stringify({ success: true, escalation_id: 42, notification_sent: true });
    expect(enforceOutcomeClaims("I've flagged this.", [], history).text).toBe(DIRECT_SUPPORT);
  });

  it('recognizes a generic request creation promise in a guest registration conversation', () => {
    expect(enforceOutcomeClaims("I'll create a request for you.", [], 'Registration is broken; can you help?').text)
      .toBe(DIRECT_SUPPORT);
  });

  it('does not use a GitHub receipt to authorize a team notification', () => {
    const github = execution('GitHub issue created', {
      tool_name: 'create_github_issue',
      github_issue_receipt: {
        toolName: 'create_github_issue', issueNumber: 42,
        issueUrl: 'https://github.com/adcontextprotocol/adcp/issues/42',
      },
    });
    expect(enforceOutcomeClaims("I've notified the team about the GitHub issue.", [github]).text).toBe(DIRECT_SUPPORT);
  });

  it('renders only the persisted ID and independently confirmed notification', () => {
    expect(enforceOutcomeClaims("I've escalated this as ticket #999 and notified the team.", [receipt(false)]).text)
      .toBe('Support request #42 is saved. I could not confirm a team notification.');
    expect(enforceOutcomeClaims("I'll flag this.", [receipt()]).text)
      .toBe('Support request #42 is saved. The team notification was sent.');
  });

  it('preserves helpful instructions around an unsupported promise', () => {
    const result = enforceOutcomeClaims("Use the same browser to retry registration. I'll flag it. You can keep learning while support investigates.", []);
    expect(result.text).toContain('Use the same browser to retry registration.');
    expect(result.text).toContain(DIRECT_SUPPORT);
    expect(result.text).toContain('You can keep learning');
  });
});
