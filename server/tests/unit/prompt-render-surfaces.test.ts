import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/notifications/email.js', () => ({
  trackedUrl: (id: string, tag: string, url: string) => `tracked:${id}:${tag}:${url}`,
}));

import { renderDigestEmail, renderDigestSlack, renderDigestReview, renderDigestWebPage } from '../../src/addie/templates/weekly-digest.js';
import { thePromptConfig } from '../../src/newsletters/the-prompt/index.js';
import type { DigestContent } from '../../src/db/digest-db.js';
import { PROMPT_HIDEABLE_SECTIONS } from '../../src/newsletters/the-prompt/edition-rules.js';

/**
 * One sample edition with every hideable section, each carrying a marker
 * string that only that section renders.
 */
function sampleEdition(overrides: Partial<DigestContent> = {}): DigestContent {
  return {
    contentVersion: 2,
    openingTake: 'Opening paragraph one.\n\nOpening paragraph two.',
    whatToWatch: [
      { title: 'MARK-WATCH official', url: 'https://aao.example/p/watch', summary: 'Official summary.', whyItMatters: 'Why.', tags: ['official'] },
      { title: 'MARK-WATCH intel', url: 'https://news.example/intel', summary: 'Intel summary.', whyItMatters: 'Intel why.', tags: [] },
    ],
    fromTheInside: [{
      name: 'MARK-INSIDE group',
      groupId: 'wg1',
      summary: 'Group summary.',
      meetingRecaps: [],
      activeThreads: [],
    }],
    voices: [{ slug: 'v', title: 'MARK-VOICES post', url: 'https://aao.example/p/voice', excerpt: 'Excerpt.', authorName: 'Writer', publishedAt: null }],
    newMembers: [{ name: 'MARK-MEMBERS Org' }],
    specInsight: { id: 's', title: 'MARK-SPEC insight', body: 'Body.', relatedSpecSections: [] },
    whatShipped: [{ title: 'MARK-SHIPPED release', url: 'https://gh.example/r', summary: 'Notes.' }],
    generatedAt: '2026-11-01T00:00:00Z',
    ...overrides,
  };
}

const MARKERS: Record<string, string> = {
  whatToWatch: 'MARK-WATCH',
  fromTheInside: 'MARK-INSIDE',
  voices: 'MARK-VOICES',
  newMembers: 'MARK-MEMBERS',
  specInsight: 'MARK-SPEC',
  whatShipped: 'MARK-SHIPPED',
};

/** Sections each surface renders at all (Slack has never shown new members or releases). */
const SLACK_SECTIONS = new Set(['whatToWatch', 'fromTheInside', 'voices', 'specInsight']);
const TEXT_SECTIONS = new Set(['whatToWatch', 'fromTheInside', 'voices', 'newMembers', 'specInsight']);

function surfaces(content: DigestContent) {
  const email = renderDigestEmail(content, 'preview', '2026-11-03', 'both');
  return {
    html: email.html,
    text: email.text,
    slack: JSON.stringify(renderDigestSlack(content, '2026-11-03')),
    web: thePromptConfig.buildMarkdown(content),
  };
}

describe('The Prompt: hidden sections are hidden on every surface', () => {
  it('renders every section marker when nothing is hidden (control)', () => {
    const out = surfaces(sampleEdition());
    for (const [key, marker] of Object.entries(MARKERS)) {
      expect(out.html, `html ${key}`).toContain(marker);
      expect(out.web, `web ${key}`).toContain(marker);
      if (TEXT_SECTIONS.has(key)) expect(out.text, `text ${key}`).toContain(marker);
      if (SLACK_SECTIONS.has(key)) expect(out.slack, `slack ${key}`).toContain(marker);
    }
  });

  for (const key of PROMPT_HIDEABLE_SECTIONS) {
    it(`drops ${key} from email HTML, plain text, Slack and the web page`, () => {
      const out = surfaces(sampleEdition({ hiddenSections: [key] }));
      const marker = MARKERS[key];
      expect(out.html).not.toContain(marker);
      expect(out.text).not.toContain(marker);
      expect(out.slack).not.toContain(marker);
      expect(out.web).not.toContain(marker);
      // Other sections are unaffected.
      for (const [otherKey, otherMarker] of Object.entries(MARKERS)) {
        if (otherKey !== key) expect(out.html).toContain(otherMarker);
      }
    });
  }

  it('does not build the subject line from a hidden section', () => {
    const subject = thePromptConfig.generateSubject(sampleEdition({ hiddenSections: ['whatToWatch'] }));
    expect(subject).not.toContain('MARK-WATCH');
  });
});

describe('The Prompt: Opening Take paragraphs', () => {
  it('renders each paragraph as its own <p> in email and the web page', () => {
    const out = surfaces(sampleEdition());
    expect(out.html).toMatch(/<p [^>]*>Opening paragraph one\.<\/p>\s*<p [^>]*>Opening paragraph two\.<\/p>/);
    expect(out.web).toContain('Opening paragraph one.\n\nOpening paragraph two.');
    expect(out.text).toContain('Opening paragraph one.\n\nOpening paragraph two.');
  });

  it('escapes each paragraph and keeps single line breaks as <br>', () => {
    const { html } = renderDigestEmail(
      sampleEdition({ openingTake: 'Line <b>one</b>\nline two.\n\nNext.' }),
      'preview', '2026-11-03', 'both',
    );
    expect(html).toContain('Line &lt;b&gt;one&lt;/b&gt;<br>line two.</p>');
    expect(html).not.toContain('<b>one</b>');
  });

  it('gives each paragraph its own Slack section, each flattened to one line', () => {
    const msg = renderDigestSlack(sampleEdition(), '2026-11-03');
    const texts = (msg.blocks || [])
      .filter((b) => b.type === 'section')
      .map((b) => (b as { text?: { text: string } }).text?.text);
    expect(texts).toContain('Opening paragraph one.');
    expect(texts).toContain('Opening paragraph two.');
  });
});

describe('The Prompt: Slack block budget', () => {
  it('folds a many-paragraph Opening Take into at most 5 Slack sections', () => {
    const take = Array.from({ length: 30 }, (_, i) => `Paragraph ${i + 1}.`).join('\n\n');
    const msg = renderDigestSlack(sampleEdition({ openingTake: take }), '2026-11-03');
    const takeSections = (msg.blocks || []).filter((b) =>
      b.type === 'section' && /Paragraph \d+\./.test((b as { text?: { text: string } }).text?.text || ''));
    expect(takeSections).toHaveLength(5);
    expect(JSON.stringify(msg)).toContain('Paragraph 30.');
    expect((msg.blocks || []).length).toBeLessThanOrEqual(50);
  });
});

describe('The Prompt: text is shortened once, by the builder', () => {
  it('renders builder-shortened summaries whole instead of cutting them mid-word again', () => {
    const summary = 'Working group discussed signal routing for agentic infrastructure and the next steps for activation…';
    const content = sampleEdition({
      fromTheInside: [{
        name: 'Signals',
        groupId: 'wg1',
        summary,
        meetingRecaps: [{ title: 'Call', date: 'Nov 1', summary: 'Recap text that is long enough to have been cut before at one hundred characters by the template…', meetingUrl: 'https://x.example' }],
        activeThreads: [{ summary: 'Thread text that used to be cut at eighty characters in the plain text render…', replyCount: 3, threadUrl: 'https://slack.example/t' }],
      }],
    });
    const { html, text } = renderDigestEmail(content, 'preview', '2026-11-03', 'both', undefined, ['Signals']);
    const slack = JSON.stringify(renderDigestSlack(content, '2026-11-03'));
    expect(html).toContain(summary);
    expect(text).toContain(summary);
    expect(slack).toContain('activation…');
    expect(text).toContain('one hundred characters by the template…');
    expect(text).toContain('in the plain text render…');
  });
});

describe('The Prompt: header shows the send date', () => {
  it('prints displayDate in every header while URLs keep the edition date', () => {
    const content = sampleEdition({ coverImageUrl: 'https://aao.example/digest/2026-11-03/cover.png?v=abc' });
    const { html, text } = renderDigestEmail(content, 'preview', '2026-11-03', 'both', undefined, undefined, undefined, undefined, { displayDate: '2026-11-12' });
    expect(html).toContain('Thursday, November 12, 2026');
    expect(html).not.toContain('Tuesday, November 3, 2026');
    expect(html).toContain('/perspectives/the-prompt-2026-11-03');
    expect(text).toContain('Thursday, November 12, 2026');

    const slack = renderDigestSlack(content, '2026-11-03', '2026-11-12');
    expect(JSON.stringify(slack)).toContain('The Prompt — Thursday, November 12, 2026');
    expect(JSON.stringify(slack)).toContain('the-prompt-2026-11-03');

    const review = renderDigestReview(content, '2026-11-03', '2026-11-12');
    expect(review.text).toContain('Thursday, November 12, 2026');

    const page = renderDigestWebPage(content, '2026-11-03', '2026-11-12');
    expect(page).toContain('<title>The Prompt — Thursday, November 12, 2026');
  });

  it('falls back to the edition date when no send date is given', () => {
    const { html } = renderDigestEmail(sampleEdition(), 'preview', '2026-11-03', 'both');
    expect(html).toContain('Tuesday, November 3, 2026');
  });
});

describe('The Prompt: no repeated story', () => {
  it('does not render a Take action for an item shown above it', () => {
    const content = sampleEdition({
      takeActions: [{ text: 'MARK-WATCH official', ctaLabel: 'Read more', ctaUrl: 'https://aao.example/p/watch' }],
    });
    const out = surfaces(content);
    expect(out.html).not.toContain('Take action');
    expect(out.text).not.toContain('TAKE ACTION');
    expect(out.slack).not.toContain('Take action');
    expect(out.web).not.toContain('## Take action');
  });

  it('says new members joined since the last edition, not this week', () => {
    const out = surfaces(sampleEdition());
    expect(out.html).toContain('joined since the last edition');
    expect(out.html).not.toContain('joined this week');
  });
});
