import { describe, test, expect } from 'vitest';
import {
  detectHallucinatedAction,
  HALLUCINATION_PATTERNS,
} from '../../src/addie/claude-client.js';

type ToolExecution = {
  tool_name: string;
  tool_use_id: string;
  is_error?: boolean;
  result?: unknown;
};

const ok = (tool: string): ToolExecution => ({
  tool_name: tool,
  tool_use_id: `tu_${tool}`,
  is_error: false,
});
const err = (tool: string): ToolExecution => ({
  tool_name: tool,
  tool_use_id: `tu_${tool}_err`,
  is_error: true,
});

describe('detectHallucinatedAction — fake escalations (#3720)', () => {
  test('flags "ticket #228" with no escalate_to_admin call', () => {
    const text = 'Done — the team has been notified (ticket #228).';
    expect(detectHallucinatedAction(text, [])).toMatch(/Possible hallucinated action/);
  });

  test('flags "team has been notified" with no escalate_to_admin call', () => {
    expect(detectHallucinatedAction('the team has been notified', []))
      .toMatch(/Possible hallucinated action/);
  });

  test('flags "I\'ve flagged this" with no escalate_to_admin call', () => {
    expect(detectHallucinatedAction("I've flagged this for the team.", []))
      .toMatch(/Possible hallucinated action/);
  });

  test('flags "I\'ve opened a ticket" with no escalate_to_admin / GitHub-issue call', () => {
    expect(detectHallucinatedAction("I've opened a support ticket for you.", []))
      .toMatch(/Possible hallucinated action/);
  });

  test('does NOT flag escalation language when escalate_to_admin succeeded', () => {
    const text = 'The team has been notified.';
    expect(detectHallucinatedAction(text, [ok('escalate_to_admin')])).toBeNull();
  });

  test('does NOT flag ticket language when create_github_issue succeeded', () => {
    expect(detectHallucinatedAction("I've filed an issue for you.", [ok('create_github_issue')]))
      .toBeNull();
  });

  test('flags fake escalation even if a different tool succeeded', () => {
    // Calling search_docs is not a substitute for actually escalating.
    expect(detectHallucinatedAction('the team has been notified', [ok('search_docs')]))
      .toMatch(/Possible hallucinated action/);
  });

  test('flags fake escalation when escalate_to_admin was called but errored', () => {
    expect(detectHallucinatedAction('the team has been notified', [err('escalate_to_admin')]))
      .toMatch(/Possible hallucinated action/);
  });

  test('does not match "ticket" outside the action-claim shape', () => {
    // "submit a ticket" is informational instruction, not a claim of having done so.
    // Pattern requires a number after "ticket" or specific creation verbs.
    expect(detectHallucinatedAction(
      'You can submit a ticket through the support portal.',
      [],
    )).toBeNull();
  });

  test('matches "team will be notified" passive future-tense too', () => {
    expect(detectHallucinatedAction('The team will be notified shortly.', []))
      .toMatch(/Possible hallucinated action/);
  });

  test('does NOT flag bare ticket reference without a creation verb', () => {
    expect(detectHallucinatedAction('See ticket #3720 for details.', []))
      .toBeNull();
    expect(detectHallucinatedAction('You mentioned ticket 42 in the last message.', []))
      .toBeNull();
  });

  test('does NOT flag third-party narration of a ticket creation', () => {
    expect(detectHallucinatedAction(
      'Stripe opened a ticket on your behalf last week.',
      [],
    )).toBeNull();
    expect(detectHallucinatedAction(
      'GitHub filed an issue for the regression yesterday.',
      [],
    )).toBeNull();
  });

  test('still flags first-person "I created ticket #N" with creation verb', () => {
    expect(detectHallucinatedAction("I've created ticket #228 for you.", []))
      .toMatch(/Possible hallucinated action/);
    expect(detectHallucinatedAction('I just opened ticket 99.', []))
      .toMatch(/Possible hallucinated action/);
  });

  test('Greg-thread shape (the original repro) still trips the lint', () => {
    const greg = 'Done — the team has been notified (ticket #228) and will track down the invoice and resend it to admin@example.com.';
    expect(detectHallucinatedAction(greg, [])).toMatch(/Possible hallucinated action/);
  });
});

describe('HALLUCINATION_PATTERNS coverage', () => {
  test('every pattern has a non-empty expectedTools list', () => {
    for (const { pattern, expectedTools } of HALLUCINATION_PATTERNS) {
      expect(expectedTools.length, `Pattern ${pattern.source} has no expected tools`).toBeGreaterThan(0);
    }
  });

  test('every pattern is case-insensitive', () => {
    for (const { pattern } of HALLUCINATION_PATTERNS) {
      expect(pattern.flags, `Pattern ${pattern.source} should be case-insensitive`).toContain('i');
    }
  });
});
