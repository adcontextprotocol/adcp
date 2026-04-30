/**
 * Unit tests for the Katie-pattern extractor.
 *
 * The pattern is: a substantive non-bot message, followed by Addie's bot
 * message, followed by another substantive non-bot message. The extractor
 * has to be robust to out-of-order Slack timestamps, short ack messages,
 * threads where Addie posted twice, and threads where the human follow-up
 * came BEFORE Addie (suppression case — owned by shadow-evaluator, not us).
 */

import { describe, it, expect } from 'vitest';
import { __test_extractKatiePattern as extractKatiePattern } from '../../../src/addie/jobs/shadow-corrected-capture.js';

type SlackMsg = { user?: string; text?: string; bot_id?: string; ts: string };

const HUMAN = (ts: string, text: string): SlackMsg => ({ user: 'U_HUMAN', text, ts });
const ADDIE = (ts: string, text: string): SlackMsg => ({
  user: 'U_BOT',
  bot_id: 'B_ADDIE',
  text,
  ts,
});

describe('extractKatiePattern', () => {
  it('returns null when there are fewer than two messages', () => {
    expect(extractKatiePattern([])).toBeNull();
    expect(
      extractKatiePattern([HUMAN('1.0', 'How does the registry work?')]),
    ).toBeNull();
  });

  it('returns null when only Addie posted (no human follow-up)', () => {
    const messages = [
      HUMAN('1.0', 'How does an agent get registered on the AAO registry?'),
      ADDIE('2.0', "Here's how registration works: there are two paths…"),
    ];
    expect(extractKatiePattern(messages)).toBeNull();
  });

  it('returns null when humans posted but Addie did not', () => {
    const messages = [
      HUMAN('1.0', 'How does an agent get registered on the AAO registry?'),
      HUMAN('2.0', "Free if you self-host adagents.json. Members can list it publicly."),
    ];
    expect(extractKatiePattern(messages)).toBeNull();
  });

  it('extracts the Katie pattern: question → Addie → human follow-up', () => {
    const messages = [
      HUMAN('1.0', 'How does an agent get registered on the AAO registry? Do you have to pay and do you have to be an AAO member?'),
      ADDIE('2.0', "Here's how agent registration works: there are two paths to get an agent into the registry."),
      HUMAN('3.0', "TLDR: it's free and you don't have to be a member BUT only members can see your agent until you are a member."),
    ];
    const result = extractKatiePattern(messages);
    expect(result).not.toBeNull();
    expect(result!.question).toContain('AAO registry');
    expect(result!.addieResponse).toContain('two paths');
    expect(result!.humanResponses).toHaveLength(1);
    expect(result!.humanResponses[0]).toContain('TLDR');
  });

  it('ignores human follow-ups that are too short to be substantive', () => {
    const messages = [
      HUMAN('1.0', 'How does the registry work? Do I need a membership?'),
      ADDIE('2.0', "Here's how it works — registration is via adagents.json or the dashboard."),
      HUMAN('3.0', 'thx'), // too short — should be filtered
    ];
    expect(extractKatiePattern(messages)).toBeNull();
  });

  it('uses the most recent Addie message, not the first', () => {
    const messages = [
      HUMAN('1.0', 'How does an agent get registered on the AAO registry?'),
      ADDIE('2.0', 'Stale earlier reply that should not anchor the comparison.'),
      HUMAN('3.0', "Wait, that doesn't address my second question about cost."),
      ADDIE('4.0', 'Updated answer covering both registration and cost details.'),
      HUMAN('5.0', "Still confusing — TLDR is it's free unless you want public listing."),
    ];
    const result = extractKatiePattern(messages);
    expect(result).not.toBeNull();
    expect(result!.addieResponse).toContain('Updated answer');
    // Only the human reply AFTER the most recent Addie message counts.
    expect(result!.humanResponses).toHaveLength(1);
    expect(result!.humanResponses[0]).toContain('TLDR');
  });

  it('handles out-of-order Slack messages by sorting on ts', () => {
    // Slack sometimes returns thread replies out of order; the extractor
    // sorts by ts before pattern-matching.
    const messages = [
      ADDIE('2.0', "Here's how registration works: two paths."),
      HUMAN('3.0', "TLDR: it's free unless you want public listing."),
      HUMAN('1.0', 'How does an agent get registered on the AAO registry?'),
    ];
    const result = extractKatiePattern(messages);
    expect(result).not.toBeNull();
    expect(result!.question).toContain('AAO registry');
    expect(result!.humanResponses).toHaveLength(1);
  });

  it('treats messages from a non-Addie bot as bot messages too', () => {
    // A different bot in the thread (e.g., Slackbot, GitHub bot) shouldn't
    // be counted as a human follow-up. We rely on `bot_id` being set.
    const messages: SlackMsg[] = [
      HUMAN('1.0', 'How does an agent get registered on the AAO registry?'),
      ADDIE('2.0', "Here's how it works — two paths."),
      { user: 'U_OTHER_BOT', bot_id: 'B_OTHER', text: 'A linked PR was just merged in adcontextprotocol/adcp', ts: '3.0' },
    ];
    expect(extractKatiePattern(messages)).toBeNull();
  });

  it('captures multiple substantive human follow-ups when present', () => {
    const messages = [
      HUMAN('1.0', 'How does an agent get registered on the AAO registry?'),
      ADDIE('2.0', "Here's how it works — two paths to get into the registry."),
      HUMAN('3.0', "TLDR: it's free unless you want public listing."),
      HUMAN('4.0', "Also worth noting: the public listing path needs Builder tier and up."),
    ];
    const result = extractKatiePattern(messages);
    expect(result).not.toBeNull();
    expect(result!.humanResponses).toHaveLength(2);
  });
});
