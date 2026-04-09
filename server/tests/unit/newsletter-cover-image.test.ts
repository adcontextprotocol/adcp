import { describe, it, expect, vi } from 'vitest';

// Mock dependencies before importing
vi.mock('../../src/notifications/email.js', () => ({
  trackedUrl: (_id: string, _tag: string, url: string) => url,
}));

vi.mock('../../src/utils/markdown.js', () => ({
  markdownToEmailHtmlInline: (text: string) => text,
}));

import { renderDigestEmail, renderDigestSlack } from '../../src/addie/templates/weekly-digest.js';
import { renderBuildEmail, renderBuildSlack } from '../../src/newsletters/the-build/template.js';
import { dateContext } from '../../src/services/illustration-generator.js';
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

describe('dateContext', () => {
  it('formats a date without seasonal or cultural assumptions', () => {
    const result = dateContext('2026-03-15');
    expect(result).toContain('March 15, 2026');
    expect(result).not.toContain('spring');
    expect(result).not.toContain('autumn');
    expect(result).not.toContain('winter');
    expect(result).not.toContain('summer');
  });

  it('formats different dates correctly', () => {
    expect(dateContext('2026-07-04')).toContain('July 4, 2026');
    expect(dateContext('2026-12-25')).toContain('December 25, 2026');
    expect(dateContext('2026-01-10')).toContain('January 10, 2026');
  });
});

describe('email header with cover image', () => {
  it('renders cover image when coverImageUrl is set', () => {
    const content = makeContent({
      coverImageUrl: 'https://agenticadvertising.org/digest/2026-04-08/cover.png',
    });
    const { html } = renderDigestEmail(content, 'preview', '2026-04-08', 'both');

    expect(html).toContain('<img src="https://agenticadvertising.org/digest/2026-04-08/cover.png"');
    expect(html).toContain('alt="The Prompt');
    expect(html).toContain('width: 100%');
  });

  it('renders text-only header when no coverImageUrl', () => {
    const content = makeContent();
    const { html } = renderDigestEmail(content, 'preview', '2026-04-08', 'both');

    expect(html).not.toContain('<img');
    expect(html).toContain('The Prompt');
    expect(html).toContain('from Addie');
  });
});

describe('Slack message with cover image', () => {
  it('includes image block when coverImageUrl is set', () => {
    const content = makeContent({
      coverImageUrl: 'https://agenticadvertising.org/digest/2026-04-08/cover.png',
    });
    const message = renderDigestSlack(content, '2026-04-08');

    const imageBlock = message.blocks?.find((b) => b.type === 'image');
    expect(imageBlock).toBeDefined();
    expect(imageBlock?.image_url).toBe('https://agenticadvertising.org/digest/2026-04-08/cover.png');
    expect(imageBlock?.alt_text).toContain('The Prompt cover');
  });

  it('omits image block when no coverImageUrl', () => {
    const content = makeContent();
    const message = renderDigestSlack(content, '2026-04-08');

    const imageBlock = message.blocks?.find((b) => b.type === 'image');
    expect(imageBlock).toBeUndefined();
  });
});

// ─── The Build (uses shared email shell) ──────────────────────────────

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

describe('Build email header with cover image (shared shell)', () => {
  it('renders cover image when coverImageUrl is set', () => {
    const content = makeBuildContent({
      coverImageUrl: 'https://agenticadvertising.org/build/2026-04-08/cover.png',
    });
    const { html } = renderBuildEmail(content, 'preview', '2026-04-08', 'both');

    expect(html).toContain('<img src="https://agenticadvertising.org/build/2026-04-08/cover.png"');
    expect(html).toContain('alt="The Build');
    expect(html).toContain('width: 100%');
  });

  it('renders text-only header when no coverImageUrl', () => {
    const content = makeBuildContent();
    const { html } = renderBuildEmail(content, 'preview', '2026-04-08', 'both');

    expect(html).not.toContain('<img');
    expect(html).toContain('The Build');
    expect(html).toContain('from Sage');
  });
});

describe('Build Slack message with cover image', () => {
  it('includes image block when coverImageUrl is set', () => {
    const content = makeBuildContent({
      coverImageUrl: 'https://agenticadvertising.org/build/2026-04-08/cover.png',
    });
    const message = renderBuildSlack(content, '2026-04-08');

    const imageBlock = (message.blocks as Array<Record<string, unknown>>)?.find((b) => b.type === 'image');
    expect(imageBlock).toBeDefined();
    expect(imageBlock?.image_url).toBe('https://agenticadvertising.org/build/2026-04-08/cover.png');
  });

  it('omits image block when no coverImageUrl', () => {
    const content = makeBuildContent();
    const message = renderBuildSlack(content, '2026-04-08');

    const imageBlock = (message.blocks as Array<Record<string, unknown>>)?.find((b) => b.type === 'image');
    expect(imageBlock).toBeUndefined();
  });
});
