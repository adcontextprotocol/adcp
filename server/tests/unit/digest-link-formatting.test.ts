import { describe, it, expect, vi } from 'vitest';

// Mock dependencies before importing
vi.mock('../../src/notifications/email.js', () => ({
  trackedUrl: (id: string, tag: string, url: string) => `tracked:${id}:${tag}:${url}`,
}));

vi.mock('../../src/utils/markdown.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/markdown.js')>();
  return {
    ...actual,
    markdownToEmailHtmlInline: (text: string) => text,
  };
});

import { renderDigestEmail, renderDigestSlack } from '../../src/addie/templates/weekly-digest.js';
import { renderBuildEmail } from '../../src/newsletters/the-build/template.js';
import { thePromptConfig } from '../../src/newsletters/the-prompt/index.js';
import type { DigestContent } from '../../src/db/digest-db.js';
import type { BuildContent } from '../../src/db/build-db.js';

function makeContent(overrides: Partial<DigestContent> = {}): DigestContent {
  return {
    contentVersion: 2,
    openingTake: 'Test opening take.',
    whatToWatch: [],
    fromTheInside: [],
    voices: [],
    newMembers: [],
    generatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeBuildContent(overrides: Partial<BuildContent> = {}): BuildContent {
  return {
    contentVersion: 1,
    statusLine: 'Test status line.',
    decisions: [],
    whatShipped: [],
    deepDive: null,
    helpNeeded: [],
    contributorSpotlight: [],
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

      expect(blockText).toContain('Revenue &gt; $1M &amp; growing');
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

  describe('The Prompt branding', () => {
    it('renders The Prompt header in email HTML', () => {
      const content = makeContent();
      const { html } = renderDigestEmail(content, 'preview', '2026-04-01', 'both');

      expect(html).toContain('The Prompt');
      expect(html).toContain('from Addie');
      expect(html).toContain('Addie');
    });

    it('renders The Prompt header in Slack', () => {
      const content = makeContent();
      const message = renderDigestSlack(content, '2026-04-01');

      expect(message.text).toContain('The Prompt');
      const headerBlock = message.blocks?.find((b) => b.type === 'header');
      expect(headerBlock).toBeTruthy();
      expect((headerBlock!.text as { text: string }).text).toContain('The Prompt');
    });
  });

  describe('pasted content mode', () => {
    it('renders pasted markdown and custom sections in email with tracked links', () => {
      const content = makeContent({
        pastedContent: '## Lead\n\nRead [the brief](https://example.com/brief).',
        customSections: [{ id: 'custom-1', title: 'Extra note', body: 'See [more](https://example.com/more)', position: 0 }],
      });
      const { html, text } = renderDigestEmail(content, 'recipient-1', '2026-04-01', 'both');

      expect(html).toContain('Lead');
      expect(html).toContain('tracked:recipient-1:pasted_body_1:https://example.com/brief');
      expect(html).toContain('Extra note');
      expect(html).toContain('tracked:recipient-1:custom_1_1:https://example.com/more');
      expect(html).not.toContain('<body');
      expect(text).toContain('Lead');
      expect(text).toContain('Extra note');
      expect(text).toContain('more (https://example.com/more)');
    });

    it('tracks markdown links with query-string ampersands once', () => {
      const content = makeContent({
        pastedContent: 'Read [the brief](https://example.com/brief?utm=a&src=b).',
      });
      const { html } = renderDigestEmail(content, 'recipient-1', '2026-04-01', 'both');

      expect(html).toContain('tracked:recipient-1:pasted_body_1:https://example.com/brief?utm=a&amp;src=b');
      expect(html).not.toContain('&amp;amp;');
    });

    it('renders pasted content in Slack instead of generated sections', () => {
      const content = makeContent({
        pastedContent: 'Pasted **body** with [brief](https://example.com/brief).',
        customSections: [{ id: 'custom-1', title: 'Extra note', body: 'Custom body', position: 0 }],
        whatToWatch: [{
          title: 'Generated article',
          url: 'https://example.com/generated',
          summary: 'Generated summary',
          whyItMatters: 'Generated rationale',
        }],
      });
      const message = renderDigestSlack(content, '2026-04-01');
      const rendered = JSON.stringify(message.blocks);
      const markdown = thePromptConfig.buildMarkdown(content);

      expect(rendered).toContain('Pasted');
      expect(rendered).toContain('https://example.com/brief');
      expect(rendered).toContain('Extra note');
      expect(rendered).toContain('Custom body');
      expect(rendered).not.toContain('Generated article');
      expect(markdown).toContain('Pasted **body**');
      expect(markdown).toContain('Extra note');
      expect(markdown).toContain('Custom body');
      expect(markdown).not.toContain('Generated article');
    });
  });

  describe('custom sections', () => {
    const customSections = [
      { id: 'custom-before', title: 'Before generated', body: 'See [before](https://example.com/before)', position: 0 },
      { id: 'custom-after', title: 'After generated', body: 'See [after](https://example.com/after)', position: 2 },
    ];

    it('renders positioned sections in generated email HTML and plain text', () => {
      const content = makeContent({
        customSections,
        whatToWatch: [{
          title: 'Generated article',
          url: 'https://example.com/generated',
          summary: 'Generated summary',
          whyItMatters: 'Generated rationale',
          tags: ['official'],
        }],
      });
      const { html, text } = renderDigestEmail(content, 'recipient-1', '2026-04-01', 'both');

      expect(html).toContain('tracked:recipient-1:custom_1_1:https://example.com/before');
      expect(html).toContain('tracked:recipient-1:custom_2_1:https://example.com/after');
      expect(html.indexOf('Before generated')).toBeLessThan(html.indexOf('Generated article'));
      expect(html.indexOf('After generated')).toBeGreaterThan(html.indexOf('Generated article'));
      expect(text.indexOf('Before generated')).toBeLessThan(text.indexOf('Generated article'));
      expect(text.indexOf('After generated')).toBeGreaterThan(text.indexOf('Generated article'));
    });

    it('renders positioned sections in Slack and published markdown', () => {
      const content = makeContent({
        customSections,
        whatToWatch: [{
          title: 'Generated article',
          url: 'https://example.com/generated',
          summary: 'Generated summary',
          whyItMatters: 'Generated rationale',
          tags: ['official'],
        }],
      });
      const slack = JSON.stringify(renderDigestSlack(content, '2026-04-01').blocks);
      const markdown = thePromptConfig.buildMarkdown(content);

      expect(slack).toContain('Before generated');
      expect(slack).toContain('Generated article');
      expect(slack).toContain('After generated');
      expect(slack.indexOf('Before generated')).toBeLessThan(slack.indexOf('Generated article'));
      expect(slack.indexOf('After generated')).toBeGreaterThan(slack.indexOf('Generated article'));
      expect(markdown).toContain('Before generated');
      expect(markdown).toContain('Generated article');
      expect(markdown).toContain('After generated');
      expect(markdown.indexOf('Before generated')).toBeLessThan(markdown.indexOf('Generated article'));
      expect(markdown.indexOf('After generated')).toBeGreaterThan(markdown.indexOf('Generated article'));
    });
  });
});

describe('Build pasted content mode', () => {
  it('renders pasted markdown and custom sections in email with tracked links', () => {
    const content = makeBuildContent({
      pastedContent: '## Lead\n\nPasted **body** with [brief](https://example.com/brief).',
      customSections: [{ id: 'custom-1', title: 'Extra note', body: 'See [more](https://example.com/more)', position: 0 }],
    });
    const { html, text } = renderBuildEmail(content, 'recipient-1', '2026-04-01', 'both');

    expect(html).toContain('Lead');
    expect(html).toContain('<strong>body</strong>');
    expect(html).toContain('tracked:recipient-1:pasted_body_1:https://example.com/brief');
    expect(html).toContain('Extra note');
    expect(html).toContain('tracked:recipient-1:custom_1_1:https://example.com/more');
    expect(text).toContain('Extra note');
    expect(text).toContain('more (https://example.com/more)');
  });

  it('keeps custom section tracking tags unique before and after generated content', () => {
    const content = makeBuildContent({
      customSections: [
        { id: 'custom-1', title: 'Before', body: 'See [before](https://example.com/before)', position: 0 },
        { id: 'custom-2', title: 'After', body: 'See [after](https://example.com/after)', position: 2 },
      ],
    });
    const { html } = renderBuildEmail(content, 'recipient-1', '2026-04-01', 'both');

    expect(html).toContain('tracked:recipient-1:custom_1_1:https://example.com/before');
    expect(html).toContain('tracked:recipient-1:custom_2_1:https://example.com/after');
  });
});
