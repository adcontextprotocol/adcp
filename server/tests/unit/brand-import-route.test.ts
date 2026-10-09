import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../src/middleware/rate-limit.js', () => ({
  brandImportHourlyRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  brandImportDailyRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import { BRAND_IMPORT_GLOBAL_SCOPE, createBrandImportRouter } from '../../src/routes/brand-import.js';
import { BrandBookImportError } from '../../src/services/brand-book-import.js';

const RESULT = {
  source: { type: 'pdf' as const },
  fragment: { names: [{ en: 'Acme' }] },
  logos: [],
  candidates: [],
  evidence: [],
  warnings: [],
  model: 'claude-sonnet-5-5',
  usage: { input_tokens: 10, output_tokens: 5 },
};

function makeApp(overrides: Parameters<typeof createBrandImportRouter>[0] = {}) {
  const deps = {
    importBrandBook: vi.fn().mockResolvedValue(RESULT),
    sourceFromUrl: vi.fn().mockResolvedValue({ type: 'html', text: 'brand page', url: 'https://acme.example/brand' }),
    checkCostCap: vi.fn().mockResolvedValue({ ok: true }),
    recordCost: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  const app = express();
  app.use(express.json());
  app.use('/api', createBrandImportRouter(deps));
  return { app, deps };
}

describe('POST /api/brands/import', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requires a brand domain', async () => {
    const { app, deps } = makeApp();
    const res = await request(app).post('/api/brands/import').send({ url: 'https://acme.example/brand' });
    expect(res.status).toBe(400);
    expect(deps.importBrandBook).not.toHaveBeenCalled();
  });

  it('imports from a URL, records cost for the IP and global scopes, and hides usage', async () => {
    const { app, deps } = makeApp();
    const res = await request(app).post('/api/brands/import').send({ domain: 'Acme.Example', url: 'https://acme.example/brand' });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({ fragment: { names: [{ en: 'Acme' }] } });
    expect(res.body).not.toHaveProperty('usage');
    expect(res.body).not.toHaveProperty('model');
    expect(deps.importBrandBook).toHaveBeenCalledWith(expect.objectContaining({ type: 'html' }), 'acme.example');
    const scopes = deps.recordCost.mock.calls.map((call) => call[0]);
    expect(scopes).toContain(BRAND_IMPORT_GLOBAL_SCOPE);
    expect(scopes.some((s: string) => /^brand-import:[0-9a-f]{16}$/.test(s))).toBe(true);
  });

  it('accepts a multipart PDF upload', async () => {
    const { app, deps } = makeApp();
    const res = await request(app)
      .post('/api/brands/import')
      .field('domain', 'acme.example')
      .attach('file', Buffer.from('%PDF-1.7\n%%EOF'), { filename: 'guide.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(200);
    expect(deps.importBrandBook).toHaveBeenCalledWith(expect.objectContaining({ type: 'pdf' }), 'acme.example');
  });

  it('rejects uploads that are not a PDF or PPTX', async () => {
    const { app, deps } = makeApp();
    const res = await request(app)
      .post('/api/brands/import')
      .field('domain', 'acme.example')
      .attach('file', Buffer.from('MZ not a document'), { filename: 'guide.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(400);
    expect(deps.importBrandBook).not.toHaveBeenCalled();
  });

  it('stops before any model call when a daily budget is spent', async () => {
    const { app, deps } = makeApp({
      checkCostCap: vi.fn().mockImplementation(async (scope: string) => ({ ok: scope !== BRAND_IMPORT_GLOBAL_SCOPE })),
    });
    const res = await request(app).post('/api/brands/import').send({ domain: 'acme.example', url: 'https://acme.example/brand' });
    expect(res.status).toBe(429);
    expect(deps.sourceFromUrl).not.toHaveBeenCalled();
    expect(deps.importBrandBook).not.toHaveBeenCalled();
  });

  it('returns user-facing import errors with their status', async () => {
    const { app } = makeApp({
      importBrandBook: vi.fn().mockRejectedValue(new BrandBookImportError('Could not read brand details from this document. Try a different file.', 422)),
    });
    const res = await request(app).post('/api/brands/import').send({ domain: 'acme.example', url: 'https://acme.example/brand' });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/Could not read brand details/);
  });

  it('hides unexpected failures behind a generic 502', async () => {
    const { app } = makeApp({ importBrandBook: vi.fn().mockRejectedValue(new Error('socket hang up at 10.0.0.5')) });
    const res = await request(app).post('/api/brands/import').send({ domain: 'acme.example', url: 'https://acme.example/brand' });
    expect(res.status).toBe(502);
    expect(res.body.error).not.toMatch(/10\.0\.0\.5/);
  });
});
