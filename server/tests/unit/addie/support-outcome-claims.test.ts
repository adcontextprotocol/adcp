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
    "I'll flag your registration issue.",
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
    expect(enforceOutcomeClaims(text, [], 'Registration is broken.')).toEqual({ text: DIRECT_SUPPORT, reason: 'Unconfirmed support escalation' });
  });

  it.each([
    "I've flagged the parts of your answer that need work.",
    "I've flagged this caveat in the example.",
    "I've flagged the team's answer for review.",
    "I've flagged a problem in your answer.",
    "I've flagged this issue in the example.",
    "I've sent the request to the seller.",
    'The request has been sent to the seller.',
    'This has been flagged as an example of targeting.',
  ])('preserves teaching and ordinary delivery even after a support discussion: %s', text => {
    for (const context of ['', 'Earlier registration was broken; now continue the lesson.']) {
      expect(enforceOutcomeClaims(text, [], context)).toEqual({ text, reason: null });
    }
  });

  it.each(["I've flagged this for the team.", 'This has been flagged for support.'])(
    'requires receipts for an explicit support destination without history: %s', text => {
      expect(enforceOutcomeClaims(text, []).text).toBe(DIRECT_SUPPORT);
    },
  );

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
    expect(enforceOutcomeClaims("I've flagged this.", [], `Registration is broken. ${history}`).text).toBe(DIRECT_SUPPORT);
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


describe('operation-aware support receipts', () => {
  const resolved = (notified = true, status = 'resolved') => execution(JSON.stringify({
    success: true, escalation_id: 42, status, notification_sent: notified,
    notification_channel: notified ? 'email' : null,
  }), { tool_name: 'resolve_escalation' });

  it('confirms resolution and an email to the user without inventing a creation or team notification', () => {
    const result = enforceOutcomeClaims("I've resolved escalation #42 and notified the user.", [resolved()]);
    expect(result).toEqual({ text: 'Escalation #42 is marked as resolved. The user notification was sent via email.', reason: null });
  });

  it('keeps resolution and notification evidence independent', () => {
    expect(enforceOutcomeClaims("I've resolved escalation #42 and notified the user.", [resolved(false)]).text)
      .toBe('Escalation #42 is marked as resolved. I could not confirm a user notification.');
    expect(enforceOutcomeClaims('Escalation #42 is resolved.', [resolved(false, 'wont_do')]).text)
      .toContain('marked as wont_do');
  });

  it('does not let creation authorize resolution, or resolution authorize creation/team notification', () => {
    expect(enforceOutcomeClaims('Escalation #42 is resolved.', [receipt()]).reason).toBe('Unconfirmed support resolution');
    expect(enforceOutcomeClaims("I've escalated this.", [resolved()]).text).toBe(DIRECT_SUPPORT);
    expect(enforceOutcomeClaims("I've notified the team.", [resolved()]).text).toBe(DIRECT_SUPPORT);
  });

  it.each([
    execution(JSON.stringify({ success: true, escalation_id: 42, status: 'resolved', notification_sent: true }), { tool_name: 'resolve_escalation' }),
    execution(JSON.stringify({ success: false, escalation_id: 42, status: 'resolved', notification_sent: false }), { tool_name: 'resolve_escalation' }),
    { ...resolved(), is_error: true },
    { ...resolved(), tool_name: 'search_docs' },
  ])('fails closed for unsupported resolution evidence %#', result => {
    expect(enforceOutcomeClaims('Escalation #42 is resolved.', [result]).reason).toBe('Unconfirmed support resolution');
  });

  it('does not infer a full document attachment from a saved summary', () => {
    const result = enforceOutcomeClaims("I've forwarded the full document to the team.", [receipt()]);
    expect(result.text).toBe('Support request #42 is saved. The team notification was sent.');
    expect(result.text).not.toContain('document');
  });
});


it.each([
  "I've resolved the schema ambiguity.",
  "I've notified the member about the event.",
  "I haven't resolved the escalation.",
  "I can't confirm escalation #42 is resolved.",
  'If escalation #42 is resolved, we can continue.',
  'No escalation is resolved.',
])('preserves unrelated outcomes and qualified resolution statements: %s', text => {
  expect(enforceOutcomeClaims(text, [])).toEqual({ text, reason: null });
});

it.each([
  "I've notified the user about the escalation. A support request was created.",
  "A support request was created. I've emailed the user about the escalation.",
  "I've notified the user and created a support request.",
])('retains creation evidence while denying an unsupported user notification: %s', text => {
  const result = enforceOutcomeClaims(text, [receipt()], 'Create an escalation.');
  expect(result.text).toContain('Support request #42 is saved. The team notification was sent.');
  expect(result.text).toContain('I could not confirm a notification to the user.');
  expect(result.text).not.toContain('saved resolution');
  expect(result.text.match(/Support request #42/g)).toHaveLength(1);
  expect(result.reason).toBe('Unconfirmed support notification');
});

it('does not let an unsupported resolution suppress an independent creation receipt', () => {
  const result = enforceOutcomeClaims("Escalation #42 is resolved. I've escalated the issue.", [receipt()]);
  expect(result.text).toContain("I haven't confirmed a saved resolution");
  expect(result.text).toContain('Support request #42 is saved. The team notification was sent.');
  expect(result.reason).toBe('Unconfirmed support resolution');
});
