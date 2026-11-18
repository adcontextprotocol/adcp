import { describe, expect, it } from 'vitest';
import { truncateAtWord, collapseWhitespace } from '../../src/utils/truncate.js';
import {
  computeLookbackStart,
  dedupeEditionItems,
  getVisiblePromptContent,
  groupPatchReleases,
  isSectionVisible,
  normalizeEditionUrl,
  splitParagraphs,
} from '../../src/newsletters/the-prompt/edition-rules.js';
import { editionDisplayDate, etDateString, plannedSendDate } from '../../src/newsletters/send-date.js';
import type { DigestContent } from '../../src/db/digest-db.js';

function makeContent(overrides: Partial<DigestContent> = {}): DigestContent {
  return {
    contentVersion: 2,
    openingTake: 'Opening.',
    whatToWatch: [],
    fromTheInside: [],
    voices: [],
    newMembers: [],
    generatedAt: '2026-11-01T00:00:00Z',
    ...overrides,
  };
}

describe('truncateAtWord', () => {
  it('returns text that fits unchanged', () => {
    expect(truncateAtWord('Short text', 50)).toBe('Short text');
  });

  it('cuts on a word boundary and adds a single ellipsis', () => {
    const out = truncateAtWord('Agents are rebuilding the infrastructure of advertising activity', 35);
    expect(out).toBe('Agents are rebuilding the…');
    expect(out).not.toMatch(/infrastr…$/);
  });

  it('keeps a word that ends exactly at the limit', () => {
    expect(truncateAtWord('Agents are rebuilding the infrastructure of advertising', 40))
      .toBe('Agents are rebuilding the infrastructure…');
  });

  it('drops trailing punctuation before the ellipsis', () => {
    expect(truncateAtWord('Buyers, sellers, agents, and everyone else', 17)).toBe('Buyers, sellers…');
  });

  it('is idempotent: shortening twice never stacks ellipses', () => {
    const once = truncateAtWord('one two three four five six seven eight nine ten', 20);
    expect(truncateAtWord(once, 25)).toBe(once);
    expect(truncateAtWord(once, 15).match(/…/g)).toHaveLength(1);
  });

  it('falls back to a hard cut for one very long token', () => {
    const out = truncateAtWord(`see https://example.com/${'a'.repeat(80)}`, 30);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBe(31);
  });

  it('collapseWhitespace flattens newlines and runs', () => {
    expect(collapseWhitespace('  a\n\n b\t c ')).toBe('a b c');
  });
});

describe('section visibility', () => {
  it('treats every section as visible unless listed in hiddenSections', () => {
    const content = makeContent({ hiddenSections: ['voices'] });
    expect(isSectionVisible(content, 'voices')).toBe(false);
    expect(isSectionVisible(content, 'whatToWatch')).toBe(true);
  });

  it('getVisiblePromptContent empties every hidden section', () => {
    const content = makeContent({
      hiddenSections: ['whatToWatch', 'fromTheInside', 'specInsight', 'voices', 'newMembers', 'whatShipped'],
      whatToWatch: [{ title: 'A', url: 'https://a.example/1', summary: '', whyItMatters: '', tags: [] }],
      fromTheInside: [{ name: 'WG', groupId: 'g', summary: 's', meetingRecaps: [], activeThreads: [] }],
      specInsight: { id: 'x', title: 'T', body: 'B', relatedSpecSections: [] },
      voices: [{ slug: 'v', title: 'V', url: 'https://a.example/v', excerpt: '', authorName: 'N', publishedAt: null }],
      newMembers: [{ name: 'Org' }],
      whatShipped: [{ title: 'Release', url: 'https://a.example/r', summary: '' }],
    });
    const visible = getVisiblePromptContent(content);
    expect(visible.whatToWatch).toEqual([]);
    expect(visible.fromTheInside).toEqual([]);
    expect(visible.specInsight).toBeUndefined();
    expect(visible.voices).toEqual([]);
    expect(visible.newMembers).toEqual([]);
    expect(visible.whatShipped).toBeUndefined();
  });
});

describe('dedupe across an edition', () => {
  it('normalizes scheme, www, tracking params, fragments and trailing slashes', () => {
    expect(normalizeEditionUrl('https://www.Example.com/a/?utm_source=x#top'))
      .toBe(normalizeEditionUrl('http://example.com/a'));
    expect(normalizeEditionUrl('https://example.com/a?id=1')).not.toBe(normalizeEditionUrl('https://example.com/a?id=2'));
  });

  it('drops a Take action that repeats an item already shown', () => {
    const content = dedupeEditionItems(makeContent({
      whatToWatch: [{ title: 'Town Hall recap', url: 'https://aao.example/p/town-hall', summary: '', whyItMatters: '', tags: ['official'] }],
      takeActions: [
        { text: 'Town Hall recap', ctaLabel: 'Watch now', ctaUrl: 'https://aao.example/p/town-hall/' },
        { text: 'Something else', ctaLabel: 'Go', ctaUrl: 'https://aao.example/other' },
      ],
    }));
    expect(content.takeActions).toEqual([{ text: 'Something else', ctaLabel: 'Go', ctaUrl: 'https://aao.example/other' }]);
  });

  it('removes Take action entirely when every action repeats', () => {
    const content = dedupeEditionItems(makeContent({
      whatToWatch: [{ title: 'Report', url: 'https://aao.example/r', summary: '', whyItMatters: '', tags: ['official'] }],
      takeActions: [{ text: 'Report', ctaLabel: 'Read the report', ctaUrl: 'https://aao.example/r' }],
    }));
    expect(content.takeActions).toBeUndefined();
  });

  it('keeps one copy of a story repeated inside and across sections', () => {
    const story = { title: 'Story', url: 'https://news.example/s', summary: '', whyItMatters: '', tags: [] };
    const content = dedupeEditionItems(makeContent({
      whatToWatch: [story, { ...story, url: 'https://news.example/s?utm_medium=email' }],
      voices: [{ slug: 's', title: 'Story', url: 'https://news.example/s', excerpt: '', authorName: 'A', publishedAt: null }],
    }));
    expect(content.whatToWatch).toHaveLength(1);
    expect(content.voices).toHaveLength(0);
  });

  it('a Take action pointing at a hidden section item is not a repeat', () => {
    const visible = getVisiblePromptContent(makeContent({
      hiddenSections: ['whatToWatch'],
      whatToWatch: [{ title: 'Report', url: 'https://aao.example/r', summary: '', whyItMatters: '', tags: ['official'] }],
      takeActions: [{ text: 'Report', ctaLabel: 'Read', ctaUrl: 'https://aao.example/r' }],
    }));
    expect(visible.takeActions).toHaveLength(1);
  });
});

describe('splitParagraphs', () => {
  it('splits on blank lines and keeps single line breaks inside a paragraph', () => {
    expect(splitParagraphs('First line\nstill first.\n\n  \nSecond.\r\n\r\nThird.')).toEqual([
      'First line\nstill first.',
      'Second.',
      'Third.',
    ]);
  });

  it('returns nothing for empty input', () => {
    expect(splitParagraphs('')).toEqual([]);
    expect(splitParagraphs(undefined)).toEqual([]);
  });
});

describe('computeLookbackStart', () => {
  const now = new Date('2026-11-17T12:00:00Z');
  const daysBefore = (d: Date) => (now.getTime() - d.getTime()) / 86_400_000;

  it('uses the fixed window when nothing has been sent', () => {
    expect(daysBefore(computeLookbackStart({ lastSentAt: null, fallbackDays: 14, now }))).toBe(14);
  });

  it('runs from the last sent edition', () => {
    const lastSentAt = new Date('2026-10-28T15:00:00Z'); // 19.875 days earlier
    expect(computeLookbackStart({ lastSentAt, fallbackDays: 7, now })).toEqual(lastSentAt);
  });

  it('never looks back less than 7 days or more than 45', () => {
    expect(daysBefore(computeLookbackStart({ lastSentAt: new Date('2026-11-16T12:00:00Z'), fallbackDays: 14, now }))).toBe(7);
    expect(daysBefore(computeLookbackStart({ lastSentAt: new Date('2026-06-01T12:00:00Z'), fallbackDays: 14, now }))).toBe(45);
  });
});

describe('groupPatchReleases', () => {
  it('groups patch releases of the same minor and keeps other releases', () => {
    const grouped = groupPatchReleases([
      { title: 'AdCP v3.2.3', url: 'https://gh.example/3.2.3', summary: 'Fixes.' },
      { title: 'AdCP v3.2.2', url: 'https://gh.example/3.2.2', summary: '' },
      { title: 'Python SDK 1.4.0', url: 'https://gh.example/py', summary: 'New client.' },
      { title: 'AdCP v3.2.1', url: 'https://gh.example/3.2.1', summary: '' },
      { title: 'AdCP v3.3.0-rc.1', url: 'https://gh.example/rc', summary: '' },
      { title: 'Docs refresh', url: 'https://gh.example/docs', summary: '' },
    ]);
    expect(grouped).toHaveLength(4);
    expect(grouped[0]).toEqual({
      title: 'AdCP v3.2.x',
      url: 'https://gh.example/3.2.3',
      summary: '3.2.3, 3.2.2, 3.2.1. Latest: Fixes.',
    });
    expect(grouped.map((g) => g.title)).toEqual(['AdCP v3.2.x', 'Python SDK 1.4.0', 'AdCP v3.3.0-rc.1', 'Docs refresh']);
  });
});

describe('send date', () => {
  it('etDateString uses Eastern time', () => {
    expect(etDateString(new Date('2026-11-18T03:00:00Z'))).toBe('2026-11-17');
  });

  it('plans an overdue edition for today and a future one for its date', () => {
    const now = new Date('2026-11-17T15:00:00Z');
    expect(plannedSendDate('2026-11-08', now)).toBe('2026-11-17');
    expect(plannedSendDate('2026-11-24', now)).toBe('2026-11-24');
  });

  it('shows the actual send date once sent', () => {
    expect(editionDisplayDate({
      edition_date: new Date('2026-09-01T00:00:00Z'),
      sent_at: new Date('2026-09-10T14:00:00Z'),
    })).toBe('2026-09-10');
  });
});
