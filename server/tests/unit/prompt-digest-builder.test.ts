import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  getLastSentEditionBuiltAt: vi.fn(),
  getRecentArticlesForDigest: vi.fn(),
  getRecentMemberPerspectivesForDigest: vi.fn(),
  getRecentOfficialPerspectives: vi.fn(),
  getNewOrganizations: vi.fn(),
}));

vi.mock('../../src/db/client.js', () => ({ query: mocks.query }));
vi.mock('../../src/utils/llm.js', () => ({
  isLLMConfigured: () => false,
  complete: vi.fn(),
}));
vi.mock('../../src/db/digest-db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/db/digest-db.js')>();
  return {
    ...actual,
    getLastSentEditionBuiltAt: mocks.getLastSentEditionBuiltAt,
    getRecentArticlesForDigest: mocks.getRecentArticlesForDigest,
    getRecentMemberPerspectivesForDigest: mocks.getRecentMemberPerspectivesForDigest,
    getRecentOfficialPerspectives: mocks.getRecentOfficialPerspectives,
    getNewOrganizations: mocks.getNewOrganizations,
  };
});
vi.mock('../../src/db/newsletter-suggestions-db.js', () => ({ getPendingSuggestions: vi.fn(async () => []) }));
vi.mock('../../src/addie/services/wg-digest-builder.js', () => ({
  getDigestEligibleGroups: vi.fn(async () => []),
  buildWgDigestContent: vi.fn(async () => null),
}));
vi.mock('../../src/newsletters/cover.js', () => ({ generateDateFlavor: vi.fn(async () => null) }));

import {
  buildDigestContent,
  computeDigestWindows,
  eventRecapExcerpt,
  matchSelectionsToArticles,
} from '../../src/addie/services/digest-builder.js';
import type { DigestArticle } from '../../src/db/digest-db.js';

function article(id: number, title: string): DigestArticle {
  return {
    id,
    title,
    source_url: `https://news.example/${id}`,
    summary: `${title} summary`,
    addie_notes: '',
    quality_score: 4,
    relevance_tags: ['agents'],
    published_at: null,
  };
}

describe('matchSelectionsToArticles (comment belongs to its article)', () => {
  const articles = [article(11, 'Alpha'), article(22, 'Bravo'), article(33, 'Charlie')];

  it('attaches each take to the article whose id the model returned', () => {
    const items = matchSelectionsToArticles([
      { id: 33, whyItMatters: 'Take on Charlie.' },
      { id: '11', whyItMatters: 'Take on Alpha.' },
    ], articles);
    expect(items.map((i) => [i.title, i.whyItMatters])).toEqual([
      ['Charlie', 'Take on Charlie.'],
      ['Alpha', 'Take on Alpha.'],
    ]);
    expect(items[0].knowledgeId).toBe(33);
  });

  it('discards a take whose id is unknown instead of guessing', () => {
    const items = matchSelectionsToArticles([{ id: 99, whyItMatters: 'Orphan take.' }], articles);
    expect(items).toEqual([]);
  });

  it('never trusts a list position', () => {
    const items = matchSelectionsToArticles([{ index: 2, whyItMatters: 'Positional take.' }], articles);
    expect(items).toEqual([]);
  });

  it('uses an article at most once and ignores malformed entries', () => {
    const items = matchSelectionsToArticles([
      { id: 22, whyItMatters: 'First.' },
      { id: 22, whyItMatters: 'Duplicate.' },
      null,
      { id: 11 },
      'nonsense',
    ], articles);
    expect(items).toHaveLength(1);
    expect(items[0].whyItMatters).toBe('First.');
  });

  it('returns nothing for a non-array response', () => {
    expect(matchSelectionsToArticles({ id: 11, whyItMatters: 'x' }, articles)).toEqual([]);
  });
});

describe('eventRecapExcerpt', () => {
  it('strips HTML and cuts once on a word boundary with an ellipsis', () => {
    const html = `<p>${'The panel covered agentic buying in depth. '.repeat(10)}</p>`;
    const excerpt = eventRecapExcerpt(html);
    expect(excerpt.length).toBeLessThanOrEqual(201);
    expect(excerpt.endsWith('…')).toBe(true);
    expect(excerpt).not.toContain('<p>');
    expect(excerpt).toMatch(/\b(in|depth|The|panel|covered|agentic|buying)…$/);
  });

  it('keeps a short recap whole', () => {
    expect(eventRecapExcerpt('<p>Short <strong>recap</strong>.</p>')).toBe('Short recap.');
  });
});

describe('look-back windows', () => {
  const now = new Date('2026-11-17T12:00:00Z');

  it('run from when the last sent edition was built, for every section', () => {
    const lastSentAt = new Date('2026-10-20T14:00:00Z');
    const windows = computeDigestWindows(lastSentAt, now);
    expect(windows.whatToWatch).toEqual(lastSentAt);
    expect(windows.voices).toEqual(lastSentAt);
    expect(windows.newMembers).toEqual(lastSentAt);
    expect(windows.whatShipped).toEqual(lastSentAt);
  });

  it('fall back to the fixed windows when nothing was sent', () => {
    const windows = computeDigestWindows(null, now);
    const days = (d: Date) => (now.getTime() - d.getTime()) / 86_400_000;
    expect(days(windows.whatToWatch)).toBe(14);
    expect(days(windows.voices)).toBe(14);
    expect(days(windows.newMembers)).toBe(14);
    expect(days(windows.whatShipped)).toBe(7);
  });
});

describe('buildDigestContent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.query.mockResolvedValue({ rows: [] });
    mocks.getRecentArticlesForDigest.mockResolvedValue([]);
    mocks.getRecentMemberPerspectivesForDigest.mockResolvedValue([]);
    mocks.getNewOrganizations.mockResolvedValue([]);
    mocks.getRecentOfficialPerspectives.mockResolvedValue([{
      slug: 'town-hall-recap',
      title: 'Town Hall recap',
      excerpt: 'What we covered.',
      author_name: 'AAO',
      published_at: new Date('2026-11-10T00:00:00Z'),
      body: null,
    }]);
  });

  it('queries every section from when the last sent edition was built', async () => {
    const lastSentAt = new Date(Date.now() - 20 * 86_400_000);
    mocks.getLastSentEditionBuiltAt.mockResolvedValue(lastSentAt);

    await buildDigestContent();

    expect(mocks.getRecentArticlesForDigest).toHaveBeenCalledWith(lastSentAt, 15);
    expect(mocks.getRecentOfficialPerspectives).toHaveBeenCalledWith(lastSentAt, 5);
    expect(mocks.getRecentMemberPerspectivesForDigest).toHaveBeenCalledWith(lastSentAt, 5);
    expect(mocks.getNewOrganizations).toHaveBeenCalledWith(lastSentAt);
    const shippedCall = mocks.query.mock.calls.find(([sql]) => String(sql).includes("source_type IN ('changelog', 'release')"));
    expect(shippedCall?.[1]).toEqual([lastSentAt]);
    expect(String(shippedCall?.[0])).not.toMatch(/LIMIT 3\b/);
  });

  it('does not repeat an official item as a Take action', async () => {
    mocks.getLastSentEditionBuiltAt.mockResolvedValue(null);
    const content = await buildDigestContent();
    expect(content.whatToWatch.map((i) => i.title)).toContain('Town Hall recap');
    expect(content.takeActions).toBeUndefined();
  });

  it('groups patch releases and keeps more than three', async () => {
    mocks.getLastSentEditionBuiltAt.mockResolvedValue(null);
    mocks.query.mockImplementation(async (sql: string) => {
      if (!sql.includes("source_type IN ('changelog', 'release')")) return { rows: [] };
      return {
        rows: [
          { title: 'AdCP v3.2.2', source_url: 'https://gh.example/322', summary: '' },
          { title: 'AdCP v3.2.1', source_url: 'https://gh.example/321', summary: '' },
          { title: 'Python SDK 1.4.0', source_url: 'https://gh.example/py', summary: '' },
          { title: 'JS SDK 2.1.0', source_url: 'https://gh.example/js', summary: '' },
          { title: 'Go SDK 0.9.0', source_url: 'https://gh.example/go', summary: '' },
        ],
      };
    });
    const content = await buildDigestContent();
    expect(content.whatShipped?.map((s) => s.title)).toEqual([
      'AdCP v3.2.x', 'Python SDK 1.4.0', 'JS SDK 2.1.0', 'Go SDK 0.9.0',
    ]);
  });
});
