import { describe, test, expect, vi } from 'vitest';

// Mock the transitive dependencies that require env vars
vi.mock('../../server/src/routes/addie-chat.js', () => ({
  getChatClaudeClient: vi.fn(),
  prepareRequestWithMemberTools: vi.fn(),
  buildTieredAccess: vi.fn(),
}));

vi.mock('../../server/src/addie/thread-service.js', () => ({
  getThreadService: vi.fn(),
}));

vi.mock('../../server/src/addie/security.js', () => ({
  sanitizeInput: vi.fn().mockImplementation((input: string) => ({ sanitized: input, flagged: false })),
  validateOutput: vi.fn().mockImplementation((input: string) => ({ sanitized: input, flagged: false })),
}));

vi.mock('../../server/src/notifications/email.js', () => ({
  sendEmailReply: vi.fn(),
}));

vi.mock('../../server/src/utils/markdown.js', () => ({
  markdownToEmailHtml: vi.fn().mockImplementation((md: string) => `<p>${md}</p>`),
}));

vi.mock('../../server/src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

import { stripQuotedContent } from '../../server/src/addie/email-conversation-handler.js';

describe('email-conversation-handler', () => {
  describe('stripQuotedContent', () => {
    test('removes "On ... wrote:" quoted replies', () => {
      const text = `Thanks for the info!

On Mon, Jan 6, 2025 at 3:00 PM Brian wrote:
> Here's the pricing breakdown.
> Let me know if you have questions.`;

      expect(stripQuotedContent(text)).toBe('Thanks for the info!');
    });

    test('removes forwarded message markers', () => {
      const text = `Please review this.

---------- Forwarded message ----------
From: someone@example.com
Subject: Original topic`;

      expect(stripQuotedContent(text)).toBe('Please review this.');
    });

    test('removes signature dividers', () => {
      const text = `Sounds good, let's proceed.
--
Jane Smith
VP of Media`;

      expect(stripQuotedContent(text)).toBe("Sounds good, let's proceed.");
    });

    test('removes lines starting with >', () => {
      const text = `I agree.
> Previous message content
> More quoted text
My follow-up.`;

      expect(stripQuotedContent(text)).toBe('I agree.\nMy follow-up.');
    });

    test('returns empty string for empty input', () => {
      expect(stripQuotedContent('')).toBe('');
    });

    test('returns original text when no quotes present', () => {
      const text = 'Just a plain message with no quotes.';
      expect(stripQuotedContent(text)).toBe(text);
    });

    test('handles "Begin forwarded message:" marker', () => {
      const text = `FYI see below.

Begin forwarded message:
From: someone@example.com`;

      expect(stripQuotedContent(text)).toBe('FYI see below.');
    });

    test('handles "Original Message" marker', () => {
      const text = `Please handle this.

-----Original Message-----
From: someone@example.com`;

      expect(stripQuotedContent(text)).toBe('Please handle this.');
    });
  });
});
