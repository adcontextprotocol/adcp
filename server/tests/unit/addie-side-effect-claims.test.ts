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
});

const tool = (tool_name: string, is_error = false): ToolExecution => ({
  tool_name,
  parameters: {},
  result: 'Synthetic completed action.',
  is_error,
  duration_ms: 1,
  sequence: 1,
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
    const good = 'I opened issue #701 and issue #702: https://github.com/adcontextprotocol/adcp/issues/701 https://github.com/adcontextprotocol/adcp/issues/702';
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
  });

  it('guards passive external-state claims and mismatched external URLs', () => {
    expect(enforceSideEffectClaimReceipts('The resource has been bookmarked.', []))
      .toMatchObject({ enforced: true });
    expect(enforceSideEffectClaimReceipts(
      'I created a payment link: https://payments.invalid/checkout',
      [{ ...tool('create_payment_link'), result: '{"success":true,"payment_url":"https://payments.example/checkout"}' }],
    )).toMatchObject({ enforced: true, reason: 'payment_link_receipt_claim_mismatch' });
  });

  it('does not block ordinary read-only first-person prose or retryable resolve reads', () => {
    expect(enforceSideEffectClaimReceipts('I created a summary and resolved the ambiguity.', []))
      .toMatchObject({ enforced: false });
    expect(isSideEffectTool('resolve_brand')).toBe(false);
    expect(isSideEffectTool('resolve_catalog')).toBe(false);
    expect(isSideEffectTool('resolve_property')).toBe(false);
  });

  it('does not permit a draft tool to confirm actual filing', () => {
    expect(enforceSideEffectClaimReceipts("I've filed issue #701.", [tool('draft_github_issue')]))
      .toMatchObject({ enforced: true, reason: 'unverified_GitHub_issue_claim' });
  });
});
