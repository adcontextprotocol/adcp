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

    const res = await request(app()).get('/llms.txt').set('Host', 'agenticadvertising.org');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(res.text).toContain('# AgenticAdvertising.org');
    expect(res.text).toContain('## Perspectives');
    expect(res.text).toContain('[Agentic crawlability & discovery](https://agenticadvertising.org/perspectives/agentic-crawlability)');
    expect(res.text).toContain('[Partner \\[view\\] \\(field notes\\)](https://partner.example/field-notes): External \\(but curated\\) perspective with \\[brackets\\].');
    expect(res.text).toContain('[Perspectives RSS feed](https://agenticadvertising.org/perspectives/feed.xml)');
    expect(res.text).not.toContain('# AdCP - Ad Context Protocol');
    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining("p.status = 'published'"), [200]);
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
