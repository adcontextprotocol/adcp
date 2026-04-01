import { describe, it, expect, vi } from 'vitest';

// Mock dependencies before importing
vi.mock('../../src/notifications/email.js', () => ({
  trackedUrl: (_id: string, _tag: string, url: string) => url,
}));

vi.mock('../../src/utils/markdown.js', () => ({
  markdownToEmailHtmlInline: (text: string) => text,
}));

vi.mock('../../src/addie/founding-deadline.js', () => ({
  FOUNDING_DEADLINE: new Date('2025-01-01'),
}));

import { renderDigestEmail, renderDigestSlack } from '../../src/addie/templates/weekly-digest.js';
import type { DigestContent } from '../../src/db/digest-db.js';

function makeContent(overrides: Partial<DigestContent> = {}): DigestContent {
  return {
    intro: 'Test intro.',
    news: [],
    newMembers: [],
    conversations: [],
    workingGroups: [],
    generatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('digest editor note link formatting', () => {
  const noteWithLinks =
    'The Future of Marketing is Here\n' +
    '<https://drive.google.com/file/d/abc123|Read the Roadmap>: Our 60-page report.\n' +
    '<https://agenticadvertising.org/membership|Become a Member>: Join 1,300+ professionals.';

  describe('email HTML', () => {
    it('converts Slack links to HTML anchor tags', () => {
      const content = makeContent({ editorsNote: noteWithLinks });
      const { html } = renderDigestEmail(content, 'preview', '2026-04-01', 'both');

      expect(html).toContain(
        '<a href="https://drive.google.com/file/d/abc123" style="color: #2563eb;">Read the Roadmap</a>',
      );
      expect(html).toContain(
        '<a href="https://agenticadvertising.org/membership" style="color: #2563eb;">Become a Member</a>',
      );
      // Should not contain raw Slack link syntax
      expect(html).not.toContain('&lt;https://');
    });

    it('escapes non-link HTML in editor note', () => {
      const content = makeContent({ editorsNote: 'Check <script>alert(1)</script> and <https://example.com|click here>' });
      const { html } = renderDigestEmail(content, 'preview', '2026-04-01', 'both');

      expect(html).toContain('&lt;script&gt;');
      expect(html).toContain('<a href="https://example.com" style="color: #2563eb;">click here</a>');
    });
  });

  describe('email plain text', () => {
    it('converts Slack links to readable text with URLs', () => {
      const content = makeContent({ editorsNote: noteWithLinks });
      const { text } = renderDigestEmail(content, 'preview', '2026-04-01', 'both');

      expect(text).toContain('Read the Roadmap (https://drive.google.com/file/d/abc123)');
      expect(text).toContain('Become a Member (https://agenticadvertising.org/membership)');
    });
  });

  describe('Slack mrkdwn', () => {
    it('preserves Slack link format in editor note', () => {
      const content = makeContent({ editorsNote: noteWithLinks });
      const message = renderDigestSlack(content, '2026-04-01');
      const noteBlock = message.blocks?.find(
        (b) => b.type === 'section' && typeof b.text === 'object' && (b.text as { text: string }).text.includes('Roadmap'),
      );
      expect(noteBlock).toBeTruthy();
      const blockText = (noteBlock!.text as { text: string }).text;

      expect(blockText).toContain('<https://drive.google.com/file/d/abc123|Read the Roadmap>');
      expect(blockText).toContain('<https://agenticadvertising.org/membership|Become a Member>');
      // Should not be escaped
      expect(blockText).not.toContain('&lt;https://');
    });
  });

  describe('bare URLs', () => {
    it('handles bare Slack URLs without labels in email', () => {
      const content = makeContent({ editorsNote: 'Visit <https://example.com> for details.' });
      const { html } = renderDigestEmail(content, 'preview', '2026-04-01', 'both');

      expect(html).toContain('<a href="https://example.com" style="color: #2563eb;">https://example.com</a>');
    });
  });

  describe('mixed special characters and links', () => {
    it('escapes special chars while preserving links in Slack mrkdwn', () => {
      const note = 'Revenue > $1M & growing. Details: <https://example.com|read more>';
      const content = makeContent({ editorsNote: note });
      const message = renderDigestSlack(content, '2026-04-01');
      const noteBlock = message.blocks?.find(
        (b) => b.type === 'section' && typeof b.text === 'object' && (b.text as { text: string }).text.includes('Revenue'),
      );
      expect(noteBlock).toBeTruthy();
      const blockText = (noteBlock!.text as { text: string }).text;

      // Special chars outside links should be escaped
      expect(blockText).toContain('Revenue &gt; $1M &amp; growing');
      // Link should be preserved as-is
      expect(blockText).toContain('<https://example.com|read more>');
    });

    it('escapes special chars while converting links in email HTML', () => {
      const note = 'Revenue > $1M & growing. Details: <https://example.com|read more>';
      const content = makeContent({ editorsNote: note });
      const { html } = renderDigestEmail(content, 'preview', '2026-04-01', 'both');

      expect(html).toContain('Revenue &gt; $1M &amp; growing');
      expect(html).toContain('<a href="https://example.com" style="color: #2563eb;">read more</a>');
    });
  });
});
