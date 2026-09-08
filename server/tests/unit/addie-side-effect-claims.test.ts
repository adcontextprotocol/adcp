import { describe, expect, it } from 'vitest';
import {
  enforceSideEffectClaimReceipts,
  isSideEffectTool,
  UNCONFIRMED_SIDE_EFFECT_FALLBACK,
} from '../../src/addie/side-effect-claims.js';
import type { ToolExecution } from '../../src/addie/model-providers/tool-orchestration.js';

const issue = (number: number, is_error = false): ToolExecution => ({
  tool_name: 'create_github_issue',
  parameters: {},
  result: `Issue created: [#${number}](https://github.com/adcontextprotocol/adcp/issues/${number})`,
  is_error,
  duration_ms: 1,
  sequence: number,
  normalized_result: { status: 'ok', user_summary: 'Issue created.', source: 'classified' },
});

const tool = (tool_name: string, is_error = false, result = 'Synthetic completed action.'): ToolExecution => ({
  tool_name,
  parameters: {},
  result,
  is_error,
  duration_ms: 1,
  sequence: 1,
  normalized_result: { status: 'ok', user_summary: 'Synthetic completed action.', source: 'structured' },
});

describe('side-effect receipt guard — escalation 567', () => {
  it('allows a confirmed GitHub claim only when its number and URL match the same-turn receipt', () => {
    const text = 'I filed issue #701: https://github.com/adcontextprotocol/adcp/issues/701';
    expect(enforceSideEffectClaimReceipts(text, [issue(701)])).toEqual({ text, enforced: false, reason: null });
  });

  it('blocks a plausible issue number when the model never called the tool', () => {
    const result = enforceSideEffectClaimReceipts("I've opened GitHub issue #701.", []);
    expect(result).toMatchObject({ text: UNCONFIRMED_SIDE_EFFECT_FALLBACK, enforced: true, reason: 'unverified_GitHub_issue_claim' });
  });

  it.each([
    'Issue created: [#701](https://github.com/adcontextprotocol/adcp/issues/701)',
    'Successfully created GitHub issue #701.',
    'Done — #701: https://github.com/adcontextprotocol/adcp/issues/701',
    'Created GitHub issue #701: https://github.com/adcontextprotocol/adcp/issues/701',
  ])('blocks receipt-like success prose without a current-turn receipt: %s', (text) => {
    expect(enforceSideEffectClaimReceipts(text, [])).toMatchObject({ enforced: true });
  });

  it.each(['error', 'timeout', 'malformed'])('blocks an issue claim after a %s receipt', (kind) => {
    const failed = kind === 'malformed'
      ? { ...issue(701), result: 'GitHub returned an unstructured success-looking response.' }
      : issue(701, true);
    expect(enforceSideEffectClaimReceipts("I've filed issue #701.", [failed]))
      .toMatchObject({ text: UNCONFIRMED_SIDE_EFFECT_FALLBACK, enforced: true });
  });

  it('does not let an earlier turn receipt authorize a later turn claim', () => {
    expect(enforceSideEffectClaimReceipts("I've created issue #701.", []))
      .toMatchObject({ enforced: true, reason: 'unverified_GitHub_issue_claim' });
  });

  it('requires one-to-one exact matching for multiple issue receipts', () => {
    const good = 'I opened issue #701 and opened issue #702: https://github.com/adcontextprotocol/adcp/issues/701 https://github.com/adcontextprotocol/adcp/issues/702';
    expect(enforceSideEffectClaimReceipts(good, [issue(701), issue(702)])).toMatchObject({ enforced: false });
    expect(enforceSideEffectClaimReceipts("I opened issue #701 and issue #999.", [issue(701), issue(702)]))
      .toMatchObject({ enforced: true, reason: 'github_issue_receipt_claim_mismatch' });
    expect(enforceSideEffectClaimReceipts("I opened issue #701.", [issue(701), issue(702)]))
      .toMatchObject({ enforced: true, reason: 'github_issue_receipt_claim_mismatch' });
  });

  it('blocks mixed success/failure claims but permits repeated verified references', () => {
    expect(enforceSideEffectClaimReceipts("I've submitted issue #701 and issue #702.", [issue(701), issue(702, true)]))
      .toMatchObject({ enforced: true });
    expect(enforceSideEffectClaimReceipts("I've submitted issue #701 and issue #701.", [issue(701)]))
      .toMatchObject({ enforced: false });
    expect(enforceSideEffectClaimReceipts(
      'Issue created: [#701](https://github.com/adcontextprotocol/adcp/issues/701). See https://github.com/adcontextprotocol/adcp/issues/701.',
      [issue(701)],
    )).toMatchObject({ enforced: false });
  });

  it('does not treat drafts or future promises as completed external actions', () => {
    expect(enforceSideEffectClaimReceipts('I drafted a GitHub issue for your review.', [])).toMatchObject({ enforced: false });
    expect(enforceSideEffectClaimReceipts('I will create the GitHub issue after you confirm.', [])).toMatchObject({ enforced: false });
  });

  it.each([
    ["I've filed issue #701.", []],
    ["I've opened issue #701.", []],
    ["I've created issue #701.", []],
    ["I've submitted issue #701.", []],
    ["I've filed #701.", []],
    ['I opened https://github.com/adcontextprotocol/adcp/issues/701', []],
    ['GitHub issue https://github.com/adcontextprotocol/adcp/issues/701 has been filed.', []],
  ] as const)('blocks wording variant %s', (text, executions) => {
    expect(enforceSideEffectClaimReceipts(text, executions)).toMatchObject({ enforced: true });
  });

  it('also guards non-GitHub mutations', () => {
    expect(enforceSideEffectClaimReceipts("I've sent the invoice.", [])).toMatchObject({ enforced: true });
    expect(enforceSideEffectClaimReceipts("I've sent the invoice.", [tool('send_invoice')])).toMatchObject({ enforced: false });
    expect(enforceSideEffectClaimReceipts("I've resent the invoice.", [{
      ...tool('resend_invoice'),
      result: '❌ Could not resend invoice: timeout',
    }])).toMatchObject({ enforced: true });
    expect(enforceSideEffectClaimReceipts("I've scheduled the meeting.", [{
      ...tool('schedule_meeting'),
      result: '⚠️ You need to be an admin to schedule a meeting.',
    }])).toMatchObject({ enforced: true });
    expect(enforceSideEffectClaimReceipts("I've scheduled the meeting.", [
      tool('schedule_meeting', false, ''),
    ])).toMatchObject({ enforced: true });
  });

  it('guards passive external-state claims and mismatched external URLs', () => {
    expect(enforceSideEffectClaimReceipts('The resource has been bookmarked.', []))
      .toMatchObject({ enforced: true });
    expect(enforceSideEffectClaimReceipts(
      'I created a payment link: https://payments.invalid/checkout',
      [{ ...tool('create_payment_link'), result: '{"success":true,"payment_url":"https://payments.example/checkout"}' }],
    )).toMatchObject({ enforced: true, reason: 'side_effect_receipt_claim_mismatch' });
  });

  it('binds every labelled non-GitHub outcome identifier and URL to its exact receipt', () => {
    const receipt = tool(
      'schedule_meeting',
      false,
      'Meeting scheduled: meeting_id=meet_701; join_url=https://calendar.example/meet_701',
    );
    const confirmed = 'I scheduled the meeting. Meeting ID meet_701. Join at https://calendar.example/meet_701';
    expect(enforceSideEffectClaimReceipts(confirmed, [receipt])).toMatchObject({ enforced: false });
    expect(enforceSideEffectClaimReceipts(
      'I scheduled the meeting. Meeting ID meet_999. Join at https://calendar.example/meet_999',
      [receipt],
    )).toMatchObject({ enforced: true, reason: 'side_effect_receipt_claim_mismatch' });
    expect(enforceSideEffectClaimReceipts('I scheduled the meeting. The meeting is confirmed.', [receipt]))
      .toMatchObject({ enforced: false });
    expect(enforceSideEffectClaimReceipts('I scheduled the meeting. The meeting is on Monday.', [receipt]))
      .toMatchObject({ enforced: false });
  });

  it('requires the tool for the claimed operation, not merely another tool in the same family', () => {
    expect(enforceSideEffectClaimReceipts('I cancelled the meeting.', [tool('update_meeting')]))
      .toMatchObject({ enforced: true });
    expect(enforceSideEffectClaimReceipts('I resent the invoice.', [tool('send_invoice')]))
      .toMatchObject({ enforced: true });
    expect(enforceSideEffectClaimReceipts('I created a meeting.', [tool('create_event')]))
      .toMatchObject({ enforced: true });
  });

  it('guards terse completion wording but leaves an ordinary meeting agenda alone', () => {
    expect(enforceSideEffectClaimReceipts('Invoice sent successfully.', [])).toMatchObject({ enforced: true });
    expect(enforceSideEffectClaimReceipts('Done — invoice sent.', [])).toMatchObject({ enforced: true });
    expect(enforceSideEffectClaimReceipts('I created a meeting agenda for you.', [])).toMatchObject({ enforced: false });
  });

  it('does not let a meeting agenda phrase exempt a separate mutation claim', () => {
    expect(enforceSideEffectClaimReceipts(
      'I added the member. Here is the meeting agenda.',
      [],
    )).toMatchObject({
      text: UNCONFIRMED_SIDE_EFFECT_FALLBACK,
      enforced: true,
      reason: 'unverified_external_state_change_claim',
    });
    expect(enforceSideEffectClaimReceipts(
      'I added the member. Here is the meeting agenda.',
      [tool('add_member_to_org')],
    )).toMatchObject({ enforced: false });
  });

  it('guards a mutation conjoined with a meeting agenda', () => {
    const text = 'I created a meeting agenda and added the member.';
    expect(enforceSideEffectClaimReceipts(text, [])).toMatchObject({ enforced: true });
    expect(enforceSideEffectClaimReceipts(text, [tool('add_member_to_org')]))
      .toMatchObject({ enforced: false });
  });

  it('binds RSVP claims to the RSVP operation instead of attendee addition', () => {
    expect(enforceSideEffectClaimReceipts("I've RSVP'd.", [tool('add_meeting_attendee')]))
      .toMatchObject({ enforced: true, reason: 'unverified_meeting_RSVP_claim' });
    expect(enforceSideEffectClaimReceipts("I've RSVP'd.", [tool('rsvp_to_meeting')]))
      .toMatchObject({ enforced: false });
  });

  it.each(['empty', 'error', 'recoverable_error', 'access_denied', 'invalid_input'] as const)(
    'does not treat a structured %s result as a successful receipt',
    (status) => {
      expect(enforceSideEffectClaimReceipts("I've scheduled the meeting.", [{
        ...tool('schedule_meeting', false, 'No meeting was scheduled.'),
        normalized_result: { status, user_summary: 'No meeting was scheduled.', source: 'structured' },
      }])).toMatchObject({ enforced: true, reason: 'unverified_meeting_scheduled_claim' });
    },
  );

  it('binds every generic mutation verb to its adjacent target', () => {
    expect(enforceSideEffectClaimReceipts(
      'I added an agenda item and updated the member.',
      [tool('add_member_to_org', false, 'Member added: member_id=mem_701')],
    )).toMatchObject({ enforced: true, reason: 'unverified_external_state_change_claim' });
  });

  it('requires an outcome ID and URL to appear together in one exact receipt', () => {
    const text = 'I scheduled the meeting. Meeting ID meet_701. Join at https://calendar.example/meet_999';
    expect(enforceSideEffectClaimReceipts(text, [
      tool('schedule_meeting', false, 'Meeting scheduled: meeting_id=meet_701'),
      tool('schedule_meeting', false, 'Meeting scheduled: join_url=https://calendar.example/meet_999'),
    ])).toMatchObject({ enforced: true, reason: 'side_effect_receipt_claim_mismatch' });
  });

  it('permits multiple exact identifiers from separate receipts in one turn', () => {
    const text = 'I sent the invoice. Invoice ID inv_701. I sent the invoice. Invoice ID inv_702.';
    expect(enforceSideEffectClaimReceipts(text, [
      tool('send_invoice', false, 'Invoice sent: invoice_id=inv_701'),
      tool('send_invoice', false, 'Invoice sent: invoice_id=inv_702'),
    ])).toMatchObject({ enforced: false });
  });

  it('does not authorize a URL prefix when the exact receipt URL differs', () => {
    expect(enforceSideEffectClaimReceipts(
      'I created a payment link: https://payments.example/checkout',
      [tool('create_payment_link', false, 'https://payments.example/checkout/secret')],
    )).toMatchObject({ enforced: true, reason: 'side_effect_receipt_claim_mismatch' });
  });

  it('does not treat an unrelated documentation URL as a claimed mutation receipt', () => {
    const text = 'I sent the invoice. Documentation is available at https://docs.example/invoices.';
    expect(enforceSideEffectClaimReceipts(text, [tool('send_invoice')])).toMatchObject({ enforced: false });
  });

  it('binds a payment URL offered in a follow-up payment sentence', () => {
    expect(enforceSideEffectClaimReceipts(
      'I created a payment link. You can pay here: https://payments.invalid/checkout',
      [tool('create_payment_link', false, 'https://payments.example/checkout')],
    )).toMatchObject({ enforced: true, reason: 'side_effect_receipt_claim_mismatch' });
  });

  it('does not block ordinary read-only first-person prose or retryable resolve reads', () => {
    expect(enforceSideEffectClaimReceipts('I created a summary and resolved the ambiguity.', []))
      .toMatchObject({ enforced: false });
    expect(isSideEffectTool('resolve_brand')).toBe(false);
    expect(isSideEffectTool('resolve_catalog')).toBe(false);
    expect(isSideEffectTool('resolve_property')).toBe(false);
  });

  it('does not mistake a related issue reference for a newly-created receipt', () => {
    const text = 'I filed issue #701 to track this, related to #689.';
    expect(enforceSideEffectClaimReceipts(text, [issue(701)])).toMatchObject({ enforced: false });
  });

  it('guards supported mutations outside the GitHub, billing, and meeting tool families', () => {
    expect(enforceSideEffectClaimReceipts(
      'I generated a perspective illustration. Illustration URL: https://images.example/generated-701',
      [],
    )).toMatchObject({ enforced: true });
    expect(enforceSideEffectClaimReceipts(
      'I transferred the brand ownership. Reference: ownership_701',
      [tool('transfer_brand_ownership', false, 'Ownership transferred: reference=ownership_701')],
    )).toMatchObject({ enforced: false });
  });

  it('does not permit a draft tool to confirm actual filing', () => {
    expect(enforceSideEffectClaimReceipts("I've filed issue #701.", [tool('draft_github_issue')]))
      .toMatchObject({ enforced: true, reason: 'unverified_GitHub_issue_claim' });
  });
});
