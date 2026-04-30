import { describe, it, expect } from 'vitest';
import { matchRuleIdFromMessage } from '../../src/addie/home/builders/rules/prompt-rules.js';

// The message_source inference used by bolt-app.ts and addie-chat.ts:
// matchRuleIdFromMessage(text) != null → 'cta_chip', else → 'typed'
function inferMessageSource(text: string | null | undefined): 'cta_chip' | 'typed' {
  return matchRuleIdFromMessage(text) ? 'cta_chip' : 'typed';
}

describe('message_source tagging', () => {
  describe('CTA chip detection', () => {
    it('tags Sage "Start module" prompts as cta_chip', () => {
      // These were in the old string-based stopgap (migration 451 replaces it).
      expect(inferMessageSource('Start module A1')).toBe('cta_chip');
      expect(inferMessageSource('Start module A2')).toBe('cta_chip');
      expect(inferMessageSource('Start module A3')).toBe('cta_chip');
      expect(inferMessageSource('Start module B1')).toBe('cta_chip');
    });

    it('tags cert continue-in-progress prompts as cta_chip', () => {
      // Dynamic matchClick patterns for in-progress modules
      expect(inferMessageSource("Let's keep going with A1. Where did we leave off?")).toBe('cta_chip');
      expect(inferMessageSource("Let's keep going with B2. Where did we leave off?")).toBe('cta_chip');
    });

    it('tags known suggested-prompt text as cta_chip', () => {
      expect(inferMessageSource('Pick up where I left off in certification.')).toBe('cta_chip');
    });
  });

  describe('typed message detection', () => {
    it('tags an organic question as typed', () => {
      expect(inferMessageSource('What is the difference between DSP and SSP?')).toBe('typed');
    });

    it('tags a free-form message as typed', () => {
      expect(inferMessageSource('hi can you help me with my agent')).toBe('typed');
    });

    it('tags paraphrased CTA text as typed (heuristic is verbatim-only)', () => {
      expect(inferMessageSource('How do I start module A1?')).toBe('typed');
    });

    it('returns typed for null/undefined/empty', () => {
      expect(inferMessageSource(null)).toBe('typed');
      expect(inferMessageSource(undefined)).toBe('typed');
      expect(inferMessageSource('')).toBe('typed');
    });
  });
});
