/**
 * Unit tests for the Addie response post-processor.
 */

import { describe, it, expect } from 'vitest';
import {
  stripBannedRituals,
  truncateLongResponseToShortQuestion,
  __test_BANNED_RITUAL_LITERALS,
  __test_lengthThresholds,
} from '../../../src/addie/response-postprocess.js';

describe('stripBannedRituals', () => {
  it('strips a leading "the honest answer is"', () => {
    const input = "The honest answer is, AdCP standardizes flows that already exist.";
    expect(stripBannedRituals(input)).toBe("AdCP standardizes flows that already exist.");
  });

  it('strips "great question" with em-dash', () => {
    const input = "Great question — the principal is liable for spend.";
    expect(stripBannedRituals(input)).toBe("The principal is liable for spend.");
  });

  it('strips "that\'s a great question." sentence opener', () => {
    const input = "That's a great question. The principal — the brand or agency — is responsible.";
    // Strip leaves "The principal..." which already starts capitalized.
    expect(stripBannedRituals(input)).toBe("The principal — the brand or agency — is responsible.");
  });

  it('strips mid-sentence "the honest answer is" and re-capitalizes', () => {
    const input = "There are multiple angles. But the honest answer is that Scope3 was a founding contributor.";
    // After strip: "There are multiple angles. But that Scope3 was..."
    // The "But" is still capitalized after "."; the inner phrase is removed.
    const output = stripBannedRituals(input);
    expect(output).not.toMatch(/honest answer/i);
    expect(output).toContain("Scope3 was a founding contributor");
  });

  it('strips "to be clear," at sentence start', () => {
    const input = "To be clear, AdCP does not introduce new identifiers.";
    expect(stripBannedRituals(input)).toBe("AdCP does not introduce new identifiers.");
  });

  it('does NOT strip phrases inside fenced code blocks', () => {
    const input = "Here is the example log:\n```\nThe honest answer is that this user said \"great question\"\n```\nAnd that's the format.";
    const output = stripBannedRituals(input);
    expect(output).toContain("The honest answer is that this user said");
    expect(output).toContain("great question");
    // "And that's the format" should remain
    expect(output).toMatch(/that's the format/);
  });

  it('is idempotent — running twice equals running once', () => {
    const input = "Great question — that's a sharp question. The honest answer is, no.";
    const once = stripBannedRituals(input);
    const twice = stripBannedRituals(once);
    expect(twice).toBe(once);
  });

  it('preserves text with no banned phrases unchanged', () => {
    const input = "AdCP operates at the campaign layer. Buyers and sellers negotiate terms over the protocol.";
    expect(stripBannedRituals(input)).toBe(input);
  });

  it('handles empty input', () => {
    expect(stripBannedRituals('')).toBe('');
  });

  it('handles input that is ONLY a banned phrase', () => {
    const input = "Great question.";
    expect(stripBannedRituals(input)).toBe("");
  });

  it('every literal in the banned list is actually stripped by the regex', () => {
    // Forward-parity: any literal we declare banned must be removed when present.
    for (const phrase of __test_BANNED_RITUAL_LITERALS) {
      const input = `${phrase}. The substance.`;
      const output = stripBannedRituals(input);
      expect(output, `failed to strip "${phrase}"`).not.toMatch(
        new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      );
    }
  });

  it('strips with case insensitivity', () => {
    expect(stripBannedRituals("THE HONEST ANSWER IS, no.")).toBe("No.");
    expect(stripBannedRituals("Great Question - here's the deal.")).toBe("Here's the deal.");
  });

  it('strips multiple banned phrases in the same response', () => {
    const input = "Great question. To be clear, AdCP is a campaign-layer protocol. Sharp question — let me explain.";
    const output = stripBannedRituals(input);
    expect(output).not.toMatch(/great question/i);
    expect(output).not.toMatch(/to be clear/i);
    expect(output).not.toMatch(/sharp question/i);
    expect(output).toContain("AdCP is a campaign-layer protocol");
  });
});

describe('truncateLongResponseToShortQuestion', () => {
  const { SHORT_QUESTION_MAX_WORDS, RESPONSE_CAP_WORDS, TRUNCATION_SUFFIX } = __test_lengthThresholds;

  // Build a deterministic prose string of N words made of N short sentences.
  function makeProse(words: number): string {
    const sentences: string[] = [];
    let used = 0;
    let i = 0;
    while (used < words) {
      const w = Math.min(8, words - used);
      // Each sentence has `w` tokens — w-1 word tokens + 1 trailing terminator-included token.
      const tokens: string[] = [];
      for (let j = 0; j < w - 1; j++) tokens.push(`word${i++}`);
      tokens.push(`final${i++}.`);
      sentences.push(tokens.join(' '));
      used += w;
    }
    return sentences.join(' ');
  }

  it('returns text unchanged when the question is long', () => {
    const longQ = Array.from({ length: SHORT_QUESTION_MAX_WORDS + 5 }, (_, i) => `q${i}`).join(' ');
    const longResp = makeProse(RESPONSE_CAP_WORDS + 50);
    expect(truncateLongResponseToShortQuestion(longQ, longResp)).toBe(longResp);
  });

  it('returns text unchanged when the response is at or below the cap', () => {
    const q = "What is X?";
    const resp = makeProse(RESPONSE_CAP_WORDS); // exactly at cap
    expect(truncateLongResponseToShortQuestion(q, resp)).toBe(resp);
  });

  it('truncates and appends the suffix when question is short and response is long', () => {
    const q = "What does AdCP not do?"; // 5 words
    const resp = makeProse(300);
    const out = truncateLongResponseToShortQuestion(q, resp);
    expect(out).not.toBe(resp);
    expect(out).toContain(TRUNCATION_SUFFIX.trim());
    // Word count of body should be at or below the truncation target plus the
    // suffix (a handful of words).
    const bodyWords = out.replace(TRUNCATION_SUFFIX, '').trim().split(/\s+/).length;
    expect(bodyWords).toBeLessThanOrEqual(150);
  });

  it('preserves complete sentences at the truncation boundary', () => {
    const q = "What is X?";
    const resp = makeProse(250);
    const out = truncateLongResponseToShortQuestion(q, resp);
    // Body should end with a sentence terminator before the suffix.
    const body = out.slice(0, out.length - TRUNCATION_SUFFIX.length).trim();
    expect(body).toMatch(/[.!?]$/);
  });

  it('keeps the first sentence even if it alone exceeds the target', () => {
    const q = "What is X?";
    // One giant sentence of 200 words.
    const giant = Array.from({ length: 199 }, (_, i) => `word${i}`).join(' ') + ' end.';
    const out = truncateLongResponseToShortQuestion(q, giant);
    expect(out).toContain('end.');
    expect(out).toContain(TRUNCATION_SUFFIX.trim());
  });

  it('does not truncate inside fenced code blocks', () => {
    const q = "What is X?";
    const codeBlock = '```\n' + Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n') + '\n```';
    const resp = makeProse(50) + '\n\n' + codeBlock + '\n\n' + makeProse(80);
    const out = truncateLongResponseToShortQuestion(q, resp);
    if (out !== resp) {
      // If we truncated, the code block should appear whole or be excluded entirely.
      const fenceCount = (out.match(/```/g) || []).length;
      expect(fenceCount % 2).toBe(0); // matched pairs only
    }
  });

  it('idempotent on already-truncated text', () => {
    const q = "What is X?";
    const resp = makeProse(300);
    const once = truncateLongResponseToShortQuestion(q, resp);
    const twice = truncateLongResponseToShortQuestion(q, once);
    expect(twice).toBe(once);
  });

  it('handles empty inputs gracefully', () => {
    expect(truncateLongResponseToShortQuestion('', 'something')).toBe('something');
    expect(truncateLongResponseToShortQuestion('what?', '')).toBe('');
  });
});
