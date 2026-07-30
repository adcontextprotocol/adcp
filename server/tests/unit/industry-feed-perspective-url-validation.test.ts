import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../../src/db/client.js', () => ({ query: mocks.query }));
vi.mock('../../src/logger.js', () => ({ logger: { warn: mocks.warn } }));

import {
  createEmailPerspective,
  createRssPerspective,
} from '../../src/db/industry-feeds-db.js';

const SAFE_URL = 'https://publisher.example/articles/agentic-media';
const NON_CANONICAL_URL = 'https://Publisher.Example:443/articles/agentic media?q=(roundup)';
const CANONICAL_URL = 'https://publisher.example/articles/agentic%20media?q=(roundup)';
const UNSAFE_URLS = [
  'javascript:globalThis.__feedXss = true',
  'data:text/html,<script>globalThis.__feedXss = true</script>',
  'http://publisher.example/articles/insecure',
  'https://attacker:secret@publisher.example/articles/credentialed',
  '\thttps://publisher.example/articles/agentic-media',
  'https://publisher.example/articles/agentic-media\r\n- [Injected](https://attacker.example)',
  'https://publisher.example/articles/agentic-media\u007F',
];

function readPublicFile(relativePath: string): string {
  return readFileSync(join(process.cwd(), 'server/public', relativePath), 'utf8');
}

function section(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  if (startIndex < 0 || endIndex < 0) throw new Error(`Missing section: ${start} to ${end}`);
  return source.slice(startIndex, endIndex);
}

function loadPublicUrlValidators() {
  const source = readPublicFile('perspective-url.js');
  return new Function(
    `${source}\nreturn { getSafePerspectiveExternalUrl, getSafePerspectiveNavigationUrl };`,
  )() as {
    getSafePerspectiveExternalUrl: (value: unknown) => string | null;
    getSafePerspectiveNavigationUrl: (value: unknown) => string | null;
  };
}

describe('industry-feed perspective URL persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(UNSAFE_URLS)('skips RSS articles with an unsafe link before querying: %s', async (link) => {
    const result = await createRssPerspective({
      feed_id: 7,
      feed_name: 'Publisher feed',
      guid: 'article-1',
      title: 'Agentic media',
      link,
    });

    expect(result).toBeNull();
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalledOnce();
  });

  it('persists valid HTTPS RSS links unchanged', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ exists: false }] })
      .mockResolvedValueOnce({ rows: [{ id: 'perspective-rss' }] });

    await expect(createRssPerspective({
      feed_id: 7,
      feed_name: 'Publisher feed',
      guid: 'article-1',
      title: 'Agentic media',
      link: SAFE_URL,
    })).resolves.toBe('perspective-rss');

    const insert = mocks.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO perspectives'));
    expect(insert?.[1]).toContain(SAFE_URL);
  });

  it('deduplicates and persists RSS links by canonical href', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ exists: false }] })
      .mockResolvedValueOnce({ rows: [{ id: 'perspective-rss' }] });

    await createRssPerspective({
      feed_id: 7,
      feed_name: 'Publisher feed',
      guid: 'article-canonical',
      title: 'Agentic media',
      link: NON_CANONICAL_URL,
    });

    expect(mocks.query.mock.calls[0][1]?.[2]).toBe(CANONICAL_URL);
    const insert = mocks.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO perspectives'));
    expect(insert?.[1]?.[4]).toBe(CANONICAL_URL);
  });

  it.each(UNSAFE_URLS)('does not persist unsafe email links as external URLs: %s', async (url) => {
    mocks.query.mockResolvedValueOnce({ rows: [{ id: 'perspective-email' }] });

    await createEmailPerspective({
      feed_id: 9,
      feed_name: 'Publisher newsletter',
      message_id: 'message-1',
      subject: 'Newsletter',
      from_email: 'news@publisher.example',
      received_at: new Date('2026-07-29T12:00:00Z'),
      links: [{ url }],
    });

    const insertValues = mocks.query.mock.calls[0][1] as unknown[];
    expect(insertValues[1]).toBe('article');
    expect(insertValues[5]).toBeNull();
  });

  it('persists a valid HTTPS email link unchanged', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ id: 'perspective-email' }] });

    await createEmailPerspective({
      feed_id: 9,
      feed_name: 'Publisher newsletter',
      message_id: 'message-1',
      subject: 'Newsletter',
      from_email: 'news@publisher.example',
      received_at: new Date('2026-07-29T12:00:00Z'),
      links: [{ url: SAFE_URL }],
    });

    const insertValues = mocks.query.mock.calls[0][1] as unknown[];
    expect(insertValues[1]).toBe('link');
    expect(insertValues[5]).toBe(SAFE_URL);
  });

  it('persists the canonical href for email links', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ id: 'perspective-email' }] });

    await createEmailPerspective({
      feed_id: 9,
      feed_name: 'Publisher newsletter',
      message_id: 'message-canonical',
      subject: 'Newsletter',
      from_email: 'news@publisher.example',
      received_at: new Date('2026-07-29T12:00:00Z'),
      links: [{ url: NON_CANONICAL_URL }],
    });

    expect(mocks.query.mock.calls[0][1]?.[5]).toBe(CANONICAL_URL);
  });
});

describe('Latest perspective navigation', () => {
  it('exports the section navigation validator for classic-script consumers', () => {
    const browserGlobal: Record<string, unknown> = {};
    const source = readPublicFile('perspective-url.js');

    new Function('window', source)(browserGlobal);

    const validator = browserGlobal.getSafePerspectiveNavigationUrl as (value: unknown) => string | null;
    expect(validator('/perspectives/local-article')).toBe('/perspectives/local-article');
  });

  it.each(UNSAFE_URLS)('renders an unsafe section source URL as inert title text: %s', async (sourceUrl) => {
    const source = readPublicFile('latest/section.html');
    const loadArticlesSource = section(source, 'async function loadArticles()', 'async function loadMoreArticles()');
    const dom = new JSDOM(`
      <div id="articles"></div>
      <div id="loading"></div>
      <div id="loadMore"></div>
    `);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        articles: [{ title: 'Hostile article', source_url: sourceUrl, relevance_tags: [] }],
        pagination: { has_more: false },
      }),
    });
    const { getSafePerspectiveNavigationUrl } = loadPublicUrlValidators();
    const loadArticles = new Function(
      'document',
      'fetch',
      'getSafePerspectiveNavigationUrl',
      'escapeHtml',
      `const slug = 'perspectives'; let offset = 0; const limit = 20; let hasMore = true;
       ${loadArticlesSource}
       return loadArticles;`,
    )(
      dom.window.document,
      fetchMock,
      getSafePerspectiveNavigationUrl,
      (value: unknown) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    ) as () => Promise<void>;

    await loadArticles();

    expect(dom.window.document.querySelector('.article-title')?.textContent?.trim()).toBe('Hostile article');
    expect(dom.window.document.querySelector('.article-title a')).toBeNull();
  });

  it.each([
    [SAFE_URL, SAFE_URL],
    ['/perspectives/local-article', 'https://agenticadvertising.org/perspectives/local-article'],
  ])('keeps a safe section navigation target active: %s', async (sourceUrl, expectedUrl) => {
    const source = readPublicFile('latest/section.html');
    const loadArticlesSource = section(source, 'async function loadArticles()', 'async function loadMoreArticles()');
    const dom = new JSDOM(`
      <div id="articles"></div>
      <div id="loading"></div>
      <div id="loadMore"></div>
    `, { url: 'https://agenticadvertising.org/latest/perspectives' });
    const { getSafePerspectiveNavigationUrl } = loadPublicUrlValidators();
    const loadArticles = new Function(
      'document',
      'fetch',
      'getSafePerspectiveNavigationUrl',
      'escapeHtml',
      `const slug = 'perspectives'; let offset = 0; const limit = 20; let hasMore = true;
       ${loadArticlesSource}
       return loadArticles;`,
    )(
      dom.window.document,
      vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({
          articles: [{ title: 'Safe article', source_url: sourceUrl, relevance_tags: [] }],
          pagination: { has_more: false },
        }),
      }),
      getSafePerspectiveNavigationUrl,
      (value: unknown) => String(value ?? ''),
    ) as () => Promise<void>;

    await loadArticles();

    expect((dom.window.document.querySelector('.article-title a') as HTMLAnchorElement)?.href).toBe(expectedUrl);
  });

  it('routes all closely related feed-controlled sinks through the shared validator', () => {
    const sinks = [
      readPublicFile('latest/index.html'),
      readPublicFile('stories/index.html'),
      readPublicFile('admin-feeds.html'),
    ];

    for (const sink of sinks) {
      expect(sink).toContain('<script src="/perspective-url.js"></script>');
      expect(sink).toContain('getSafePerspectiveExternalUrl');
    }
    expect(sinks[0]).not.toContain('href="${escapeHtml(article.source_url)}"');
    expect(sinks[1]).not.toContain("link.href = item.source_url || '#'");
    expect(sinks[2]).not.toContain('href="${escapeHtml(article.external_url)}"');
  });
});
