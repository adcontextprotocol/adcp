/**
 * Unit tests for the Addie response post-processor.
 */

import { describe, it, expect } from 'vitest';
import {
  stripBannedRituals,
  __test_BANNED_RITUAL_LITERALS,
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
