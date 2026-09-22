/**
 * Unit tests for the Addie response post-processor.
 */

import { describe, it, expect } from 'vitest';
import {
  stripBannedRituals,
  rewritePersonaCollapse,
  hasPersonaCollapse,
  applyResponsePipeline,
  __test_BANNED_RITUAL_LITERALS,
  __test_EMPTY_RESPONSE_FALLBACK,
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

describe('rewritePersonaCollapse', () => {
  it('removes the verbatim AI-1462 leak sentence, keeps surrounding prose', () => {
    const input =
      "I appreciate the detailed breakdown. I'm Claude, an AI assistant made by Anthropic — I don't operate publisher properties. Let me work the validator problem with you.";
    const out = rewritePersonaCollapse(input);
    expect(out).not.toMatch(/claude/i);
    expect(out).not.toMatch(/anthropic/i);
    expect(out).toContain("I appreciate the detailed breakdown.");
    expect(out).toContain("Let me work the validator problem with you.");
  });

  it('removes an "I am Claude" disclosure', () => {
    const input = "I am Claude. AdCP operates at the campaign layer.";
    const out = rewritePersonaCollapse(input);
    expect(out).not.toMatch(/claude/i);
    expect(out).toContain("AdCP operates at the campaign layer.");
  });

  it('removes vendor-disclosure phrasings (made/created/trained by Anthropic/OpenAI)', () => {
    expect(rewritePersonaCollapse("I was created by Anthropic.")).not.toMatch(/anthropic/i);
    expect(rewritePersonaCollapse("I'm a model trained by OpenAI.")).not.toMatch(/openai/i);
    expect(rewritePersonaCollapse("This assistant is powered by Claude.")).not.toMatch(/claude/i);
  });

  it('removes generic LLM self-references used to step out of persona', () => {
    expect(rewritePersonaCollapse("As an AI language model, I cannot do that.")).not.toMatch(
      /language model/i
    );
    expect(rewritePersonaCollapse("I'm just a large language model after all.")).not.toMatch(
      /large language model/i
    );
  });

  it('does NOT touch legitimate "Claude Code" / "Claude Desktop" client references', () => {
    const input =
      "To connect, install the MCP server in Claude Desktop or Claude Code, then run the setup command.";
    expect(rewritePersonaCollapse(input)).toBe(input);
  });

  it('does NOT touch the bare word "Claude" outside an identity disclosure', () => {
    const input = "Point your coding agent (Claude Code, Cursor, Windsurf) at the skill file.";
    expect(rewritePersonaCollapse(input)).toBe(input);
  });

  it('does NOT touch a bare "as a model" without an AI/language qualifier', () => {
    const input = "AdCP serves as a model for cross-seller negotiation in other verticals.";
    expect(rewritePersonaCollapse(input)).toBe(input);
  });

  it('does NOT strip disclosures quoted inside fenced code blocks', () => {
    const input =
      "Here is the leak we caught:\n```\nI'm Claude, an AI assistant made by Anthropic\n```\nThat phrasing is what the backstop removes.";
    const out = rewritePersonaCollapse(input);
    expect(out).toContain("I'm Claude, an AI assistant made by Anthropic");
    expect(out).toContain("That phrasing is what the backstop removes.");
  });

  it('is idempotent — running twice equals running once', () => {
    const input =
      "Sure. I'm Claude, made by Anthropic. AdCP standardizes campaign-layer flows.";
    const once = rewritePersonaCollapse(input);
    const twice = rewritePersonaCollapse(once);
    expect(twice).toBe(once);
  });

  it('keeps version numbers and Markdown intact when removing a disclosure', () => {
    const clean = 'AdCP 3.2 uses `media_buy.reporting_delivery`.\n\n- **Core**: Poll for results.';
    expect(rewritePersonaCollapse("I'm Claude. " + clean)).toBe(clean);
  });

  it('returns empty when every sentence is a persona-collapse disclosure', () => {
    const input =
      "I'm Claude, an AI assistant made by Anthropic. As a large language model, I have no real-world identity.";
    expect(rewritePersonaCollapse(input).trim()).toBe('');
  });

  it('keeps a non-disclosure refusal sentence while scrubbing only the leak', () => {
    // The backstop targets model/persona disclosure, not every refusal. A
    // plain "I can't do that" line survives; only the identity leak is removed.
    const input =
      "I'm Claude, an AI assistant made by Anthropic. I can't directly access your ad server.";
    const out = rewritePersonaCollapse(input);
    expect(out).not.toMatch(/claude|anthropic/i);
    expect(out).toContain("I can't directly access your ad server.");
  });

  it('preserves clean text with no disclosure unchanged', () => {
    const input = "AdCP operates at the campaign layer. Buyers and sellers negotiate over the protocol.";
    expect(rewritePersonaCollapse(input)).toBe(input);
  });

  it('handles empty input', () => {
    expect(rewritePersonaCollapse('')).toBe('');
  });
});

describe('hasPersonaCollapse', () => {
  it('is true when a disclosure is present', () => {
    expect(hasPersonaCollapse("I'm Claude, an AI assistant made by Anthropic.")).toBe(true);
  });

  it('is false for clean prose and legitimate client references', () => {
    expect(hasPersonaCollapse("AdCP operates at the campaign layer.")).toBe(false);
    expect(hasPersonaCollapse("Install the MCP server in Claude Desktop.")).toBe(false);
  });
});

describe('applyResponsePipeline', () => {
  it('preserves every returned ticket and the pagination footer for a short list request', () => {
    const rows = Array.from({ length: 10 }, (_, index) =>
      `- #${700 + index}: Sam needs help with campaign setup. The record is open and needs an administrator to review the supplied configuration.`);
    const response = `There are 12 open tickets; showing the first 10.\n\n${rows.join('\n')}\n\nTwo more tickets remain on the next page.`;

    expect(applyResponsePipeline('What tickets are open?', response)).toBe(response);
  });

  it('preserves code and the final instructions after a short request', () => {
    const code = '```ts\n' + Array.from({ length: 40 }, (_, index) => `const value${index} = ${index};`).join('\n') + '\n```';
    const response = `Run this complete example.\n\n${code}\n\nThen inspect the returned errors before using the result.`;

    expect(applyResponsePipeline('Show me the example.', response)).toBe(response);
  });

  it('substitutes the empty-response fallback when the model returns empty text', () => {
    expect(applyResponsePipeline('?', '')).toBe(__test_EMPTY_RESPONSE_FALLBACK);
    expect(applyResponsePipeline('what happened?', '   ')).toBe(__test_EMPTY_RESPONSE_FALLBACK);
  });

  it('substitutes the fallback when stripBannedRituals leaves an empty result', () => {
    // A response that's nothing but ritual phrases.
    const ritualOnly = "Great question. The honest answer is, sharp question.";
    expect(applyResponsePipeline('?', ritualOnly)).toBe(__test_EMPTY_RESPONSE_FALLBACK);
  });

  it('removes ritual phrases without discarding substantive sentences', () => {
    const q = "What is X?";
    const sentences: string[] = [];
    for (let i = 0; i < 50; i++) {
      sentences.push(`This is sentence ${i} content.`);
    }
    const longRitual = "Great question. " + sentences.join(' ');
    const out = applyResponsePipeline(q, longRitual);
    expect(out).not.toMatch(/great question/i);
    expect(out).toBe(sentences.join(' '));
  });

  it('passes short clean responses through unchanged', () => {
    const q = "What is X?";
    const short = "X is the protocol.";
    expect(applyResponsePipeline(q, short)).toBe(short);
  });

  it('scrubs a persona-collapse disclosure but keeps the substantive answer', () => {
    const q = "Can you set up the publisher properties?";
    const raw =
      "I'm Claude, an AI assistant made by Anthropic. The validator is failing because display_970x250 isn't in the format catalog yet.";
    const out = applyResponsePipeline(q, raw);
    expect(out).not.toMatch(/claude/i);
    expect(out).not.toMatch(/anthropic/i);
    expect(out).toContain("format catalog");
  });

  it('substitutes the fallback when the whole response is a persona-collapse disclosure', () => {
    const raw =
      "I'm Claude, an AI assistant made by Anthropic. As a large language model, I have no real-world identity.";
    expect(applyResponsePipeline('set this up', raw)).toBe(__test_EMPTY_RESPONSE_FALLBACK);
  });
});
