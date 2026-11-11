import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import sharp from 'sharp';

const mocks = vi.hoisted(() => ({
  getLogo: vi.fn(),
  getLogoRedirect: vi.fn(),
  renderDelayMs: 0,
}));

vi.mock('../../src/services/logo-cdn.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/logo-cdn.js')>();
  return { ...actual, getLogo: mocks.getLogo };
});

vi.mock('../../src/db/brand-logo-db.js', () => ({
  BrandLogoDatabase: class {
    getLogoRedirect = mocks.getLogoRedirect;
  },
}));

// Wrap the real renderer so a test can make renders slow.
vi.mock('../../src/services/logo-rendition.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/logo-rendition.js')>();
  return {
    ...actual,
    renderLogoPng: vi.fn(async (...args: Parameters<typeof actual.renderLogoPng>) => {
      if (mocks.renderDelayMs) await new Promise((r) => setTimeout(r, mocks.renderDelayMs));
      return actual.renderLogoPng(...args);
    }),
  };
});

import { createBrandLogoAssetRouter, type BrandLogoAssetRouterOptions } from '../../src/routes/brand-logo-assets.js';
import { renderLogoPng } from '../../src/services/logo-rendition.js';

const DOMAIN = 'acme.example';
const ID = '11111111-1111-1111-1111-111111111111';
const ID2 = '22222222-2222-2222-2222-222222222222';

const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="100" viewBox="0 0 300 100"><rect width="300" height="100" fill="#e61d2b"/></svg>',
);
const ICO = Buffer.from([0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0]);

function makeApp(options: BrandLogoAssetRouterOptions = {}) {
  const app = express();
  app.use(createBrandLogoAssetRouter(options));
  return app;
}

function binary(res: request.Response): Buffer {
  return res.body as Buffer;
}

const bufferParser = (res: request.Response, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

const get = (app: express.Express, url: string) => request(app).get(url).buffer(true).parse(bufferParser);

beforeEach(() => {
  mocks.renderDelayMs = 0;
  mocks.getLogo.mockReset();
  mocks.getLogoRedirect.mockReset();
  vi.mocked(renderLogoPng).mockClear();
  mocks.getLogo.mockImplementation(async (domain: string, id: string) => {
    if (domain === DOMAIN && id === ID) return { content_type: 'image/svg+xml', data: SVG };
    if (domain === DOMAIN && id === ID2) return { content_type: 'image/x-icon', data: ICO };
    return null;
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('original bytes', () => {
  it('returns the stored bytes and content type when there is no query', async () => {
    const res = await get(makeApp(), `/assets/brands/${DOMAIN}/${ID}.svg`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^image\/svg\+xml/);
    expect(binary(res).equals(SVG)).toBe(true);
    expect(res.headers['cache-control']).toBe('public, max-age=2592000');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe("default-src 'none'");
  });

  it('serves the legacy /logos/brands/:domain/:id route with no extension', async () => {
    const res = await get(makeApp(), `/logos/brands/${DOMAIN}/${ID}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^image\/svg\+xml/);
    expect(binary(res).equals(SVG)).toBe(true);
  });

  it('lower-cases the domain', async () => {
    const res = await get(makeApp(), `/assets/brands/ACME.Example/${ID}.svg`);
    expect(res.status).toBe(200);
    expect(mocks.getLogo).toHaveBeenCalledWith(DOMAIN, ID);
  });

  it('serves an ICO original even though it cannot be rasterised', async () => {
    const res = await get(makeApp(), `/assets/brands/${DOMAIN}/${ID2}.ico`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^image\/(x-icon|vnd\.microsoft\.icon)/);
  });
});

describe('PNG renditions', () => {
  it('returns image/png at the requested width with long-lived cache headers', async () => {
    const res = await get(makeApp(), `/assets/brands/${DOMAIN}/${ID}.svg?format=png&w=256`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toBe('public, max-age=2592000');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe("default-src 'none'");
    const meta = await sharp(binary(res)).metadata();
    expect(meta.format).toBe('png');
    expect(meta.width).toBe(256);
  });

  it('defaults to 512 wide for format=png alone', async () => {
    const res = await get(makeApp(), `/assets/brands/${DOMAIN}/${ID}.svg?format=png`);
    expect(res.status).toBe(200);
    expect((await sharp(binary(res)).metadata()).width).toBe(512);
  });

  it('works on the legacy /logos route', async () => {
    const res = await get(makeApp(), `/logos/brands/${DOMAIN}/${ID}?format=png&w=128`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect((await sharp(binary(res)).metadata()).width).toBe(128);
  });

  it.each([
    ['format=webp', 'format=webp'],
    ['unallowed width', 'format=png&w=100'],
    ['non-numeric width', 'format=png&w=abc'],
    ['repeated w', 'format=png&w=1&w=2'],
    ['repeated format', 'format=png&format=png'],
    ['w without format', 'w=256'],
  ])('rejects %s with 400', async (_label, qs) => {
    const res = await request(makeApp()).get(`/assets/brands/${DOMAIN}/${ID}.svg?${qs}`);
    expect(res.status).toBe(400);
    expect(mocks.getLogo).not.toHaveBeenCalled();
  });

  it('returns 415 for a logo that cannot be rasterised', async () => {
    const res = await request(makeApp()).get(`/assets/brands/${DOMAIN}/${ID2}.ico?format=png&w=64`);
    expect(res.status).toBe(415);
  });

  it('returns 422 when the stored bytes cannot be rendered', async () => {
    mocks.getLogo.mockResolvedValueOnce({ content_type: 'image/png', data: Buffer.from('not a png') });
    const res = await request(makeApp()).get(`/assets/brands/${DOMAIN}/${ID}.png?format=png&w=64`);
    expect(res.status).toBe(422);
  });

  it('301s a wrong extension to the canonical asset URL, keeping the rendition query', async () => {
    const res = await request(makeApp()).get(`/assets/brands/${DOMAIN}/${ID}.png?format=png&w=128`).redirects(0);
    expect(res.status).toBe(301);
    expect(res.headers.location).toMatch(new RegExp(`/assets/brands/${DOMAIN}/${ID}\\.svg\\?format=png&w=128$`));
  });

  it('301s a wrong extension without a rendition query too', async () => {
    const res = await request(makeApp()).get(`/assets/brands/${DOMAIN}/${ID}.png`).redirects(0);
    expect(res.status).toBe(301);
    expect(res.headers.location).toMatch(new RegExp(`${ID}\\.svg$`));
  });
});

describe('not found and validation', () => {
  it('404s an unknown or unapproved logo', async () => {
    const res = await request(makeApp()).get(`/assets/brands/${DOMAIN}/33333333-3333-3333-3333-333333333333.svg`);
    expect(res.status).toBe(404);
  });

  it('404s an unknown logo for a rendition request', async () => {
    const res = await request(makeApp()).get(
      `/assets/brands/${DOMAIN}/33333333-3333-3333-3333-333333333333.svg?format=png&w=64`,
    );
    expect(res.status).toBe(404);
  });

  it('400s an invalid domain', async () => {
    const res = await request(makeApp()).get(`/assets/brands/-bad_domain/${ID}.svg`);
    expect(res.status).toBe(400);
    expect(mocks.getLogo).not.toHaveBeenCalled();
  });

  it('400s an invalid logo id on the legacy route', async () => {
    const res = await request(makeApp()).get(`/logos/brands/${DOMAIN}/not-a-uuid`);
    expect(res.status).toBe(400);
  });

  it('400s a malformed asset segment', async () => {
    const res = await request(makeApp()).get(`/assets/brands/${DOMAIN}/not-a-uuid.svg`);
    expect(res.status).toBe(400);
  });

  it('500s a stored logo with a disallowed content type', async () => {
    mocks.getLogo.mockResolvedValueOnce({ content_type: 'text/html', data: Buffer.from('<script>') });
    const res = await request(makeApp()).get(`/logos/brands/${DOMAIN}/${ID}`);
    expect(res.status).toBe(500);
  });
});

describe('legacy integer ids', () => {
  it('redirects /logos/brands/:domain/:idx to the UUID, carrying the rendition query', async () => {
    mocks.getLogoRedirect.mockResolvedValue(ID);
    const res = await request(makeApp()).get(`/logos/brands/${DOMAIN}/0?format=png&w=128`).redirects(0);
    expect(res.status).toBe(301);
    expect(res.headers.location).toBe(`/logos/brands/${DOMAIN}/${ID}?format=png&w=128`);
  });

  it('404s an unknown integer id', async () => {
    mocks.getLogoRedirect.mockResolvedValue(null);
    const res = await request(makeApp()).get(`/logos/brands/${DOMAIN}/7`);
    expect(res.status).toBe(404);
  });
});

describe('cache', () => {
  it('serves the second request from cache: one getLogo call per key', async () => {
    const app = makeApp();
    const url = `/assets/brands/${DOMAIN}/${ID}.svg?format=png&w=128`;
    const first = await get(app, url);
    const second = await get(app, url);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(binary(second).equals(binary(first))).toBe(true);
    expect(mocks.getLogo).toHaveBeenCalledTimes(1);
    expect(renderLogoPng).toHaveBeenCalledTimes(1);
  });

  it('caches the original and each rendition width separately', async () => {
    const app = makeApp();
    const original = await get(app, `/assets/brands/${DOMAIN}/${ID}.svg`);
    const png128 = await get(app, `/assets/brands/${DOMAIN}/${ID}.svg?format=png&w=128`);
    const png256 = await get(app, `/assets/brands/${DOMAIN}/${ID}.svg?format=png&w=256`);
    expect(mocks.getLogo).toHaveBeenCalledTimes(3);

    // Each is now served from its own cache entry with its own content.
    const original2 = await get(app, `/assets/brands/${DOMAIN}/${ID}.svg`);
    const png128b = await get(app, `/assets/brands/${DOMAIN}/${ID}.svg?format=png&w=128`);
    const png256b = await get(app, `/assets/brands/${DOMAIN}/${ID}.svg?format=png&w=256`);
    expect(mocks.getLogo).toHaveBeenCalledTimes(3);
    expect(original2.headers['content-type']).toMatch(/svg/);
    expect(binary(original2).equals(binary(original))).toBe(true);
    expect((await sharp(binary(png128b)).metadata()).width).toBe(128);
    expect((await sharp(binary(png256b)).metadata()).width).toBe(256);
    expect(binary(png128b).equals(binary(png128))).toBe(true);
  });

  it('keeps redirecting a wrong extension when the logo is cached', async () => {
    const app = makeApp();
    await get(app, `/assets/brands/${DOMAIN}/${ID}.svg?format=png&w=128`);
    const res = await request(app).get(`/assets/brands/${DOMAIN}/${ID}.png?format=png&w=128`).redirects(0);
    expect(res.status).toBe(301);
    expect(res.headers.location).toMatch(/\.svg\?format=png&w=128$/);
    expect(mocks.getLogo).toHaveBeenCalledTimes(1);
  });

  it('expires entries after the TTL', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const app = makeApp({ cacheTtlMs: 1000 });
    const url = `/assets/brands/${DOMAIN}/${ID}.svg`;
    await get(app, url);
    vi.setSystemTime(new Date('2026-01-01T00:00:00.900Z'));
    await get(app, url);
    expect(mocks.getLogo).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date('2026-01-01T00:00:02Z'));
    await get(app, url);
    expect(mocks.getLogo).toHaveBeenCalledTimes(2);
  });

  it('evicts the oldest entries when over the byte budget, keeping the newest', async () => {
    const u = (w: number) => `/assets/brands/${DOMAIN}/${ID}.svg?format=png&w=${w}`;
    const size512 = binary(await get(makeApp(), u(512))).length;
    const size256 = binary(await get(makeApp(), u(256))).length;
    // Room for the larger rendition plus a sliver, but not both.
    const app = makeApp({ cacheMaxBytes: size512 + Math.floor(size256 / 2) });
    await get(app, u(512));
    await get(app, u(256));
    mocks.getLogo.mockClear();

    await get(app, u(256)); // newest survives
    expect(mocks.getLogo).not.toHaveBeenCalled();
    await get(app, u(512)); // oldest was evicted
    expect(mocks.getLogo).toHaveBeenCalledTimes(1);
  });

  it('does not cache a 404', async () => {
    const app = makeApp();
    const url = `/assets/brands/${DOMAIN}/33333333-3333-3333-3333-333333333333.svg`;
    await request(app).get(url);
    await request(app).get(url);
    expect(mocks.getLogo).toHaveBeenCalledTimes(2);
  });
});

describe('render overload', () => {
  it('sheds load with 503 and Retry-After when the render queue is full', async () => {
    mocks.renderDelayMs = 300;
    const app = makeApp({ renderConcurrency: 1, renderMaxQueued: 0 });
    const slow = get(app, `/assets/brands/${DOMAIN}/${ID}.svg?format=png&w=64`).then((r) => r);
    // Let the first request take the only slot.
    await new Promise((r) => setTimeout(r, 100));
    const shed = await request(app).get(`/assets/brands/${DOMAIN}/${ID}.svg?format=png&w=128`);
    expect(shed.status).toBe(503);
    expect(shed.headers['retry-after']).toBeDefined();
    expect((await slow).status).toBe(200);
  });

  it('does not shed original-bytes requests while renders are saturated', async () => {
    mocks.renderDelayMs = 300;
    const app = makeApp({ renderConcurrency: 1, renderMaxQueued: 0 });
    const slow = get(app, `/assets/brands/${DOMAIN}/${ID}.svg?format=png&w=64`);
    await new Promise((r) => setTimeout(r, 100));
    const original = await request(app).get(`/assets/brands/${DOMAIN}/${ID}.svg`);
    expect(original.status).toBe(200);
    await slow;
  });

  it('serves a cached rendition even when the render queue is full', async () => {
    const app = makeApp({ renderConcurrency: 1, renderMaxQueued: 0 });
    await get(app, `/assets/brands/${DOMAIN}/${ID}.svg?format=png&w=64`);
    mocks.renderDelayMs = 300;
    const slow = get(app, `/assets/brands/${DOMAIN}/${ID}.svg?format=png&w=128`);
    await new Promise((r) => setTimeout(r, 100));
    const cached = await request(app).get(`/assets/brands/${DOMAIN}/${ID}.svg?format=png&w=64`);
    expect(cached.status).toBe(200);
    await slow;
  });
});
