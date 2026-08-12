import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  getAssetData: vi.fn(),
  getPerspectiveWithIllustration: vi.fn(),
  generatePerspectiveCard: vi.fn(),
  isWebUserAAOAdmin: vi.fn(),
}));

vi.hoisted(() => {
  process.env.WORKOS_API_KEY ||= 'sk_test_perspective_asset_cache';
  process.env.WORKOS_CLIENT_ID ||= 'client_test_perspective_asset_cache';
});

vi.mock('../../src/config.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/config.js')>('../../src/config.js');
  return {
    ...actual,
    getDatabaseConfig: vi.fn().mockReturnValue({
      connectionString: 'postgresql://localhost/test',
    }),
  };
});

vi.mock('../../src/db/client.js', () => ({
  initializeDatabase: vi.fn(),
  getPool: vi.fn().mockReturnValue({ query: mocks.query }),
  query: (...args: unknown[]) => mocks.query(...args),
  isDatabaseInitialized: vi.fn().mockReturnValue(true),
  closeDatabase: vi.fn(),
  healthCheck: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/db/migrate.js', () => ({
  runMigrations: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/db/perspective-asset-db.js', () => ({
  getAssetData: (...args: unknown[]) => mocks.getAssetData(...args),
}));

vi.mock('../../src/db/illustration-db.js', () => ({
  getPerspectiveWithIllustration: (...args: unknown[]) => mocks.getPerspectiveWithIllustration(...args),
  getIllustrationData: vi.fn(),
}));

vi.mock('../../src/services/perspective-cards.js', () => ({
  generatePerspectiveCard: (...args: unknown[]) => mocks.generatePerspectiveCard(...args),
  compositePerspectiveCard: vi.fn(),
}));

vi.mock('../../src/addie/mcp/admin-tools.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    isWebUserAAOAdmin: (...args: unknown[]) => mocks.isWebUserAAOAdmin(...args),
  };
});

vi.mock('../../src/middleware/auth.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/middleware/auth.js')>(
    '../../src/middleware/auth.js',
  );
  return {
    ...actual,
    optionalAuth: (req: Express.Request, _res: Express.Response, next: () => void) => {
      const userId = req.header('x-test-user');
      if (userId) {
        req.user = { id: userId, email: `${userId}@example.test` } as Express.Request['user'];
      }
      next();
    },
  };
});

import { HTTPServer } from '../../src/http.js';

describe('perspective asset cache privacy', () => {
  let server: HTTPServer | undefined;

  beforeEach(() => {
    mocks.query.mockReset();
    mocks.getAssetData.mockReset();
    mocks.getPerspectiveWithIllustration.mockReset();
    mocks.generatePerspectiveCard.mockReset();
    mocks.isWebUserAAOAdmin.mockReset().mockResolvedValue(false);
  });

  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  function app() {
    server = new HTTPServer();
    return (server as unknown as { app: unknown }).app;
  }

  it.each([
    [true, undefined, 'public, max-age=0, must-revalidate'],
    [false, 'draft-author', 'private, no-store'],
  ])('sets visibility-aware asset caching when is_public=%s', async (isPublic, userId, expected) => {
    mocks.query.mockResolvedValueOnce({ rows: [{ id: 'perspective-1', is_public: isPublic }] });
    mocks.getAssetData.mockResolvedValueOnce({
      file_data: Buffer.from('asset bytes'),
      file_mime_type: 'image/png',
      file_name: 'cover.png',
    });

    let req = request(app()).get('/api/perspectives/example/assets/cover.png');
    if (userId) req = req.set('x-test-user', userId);
    const res = await req;

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe(expected);
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining('AS is_public'),
      ['example', userId ?? null, false],
    );
    expect(mocks.getAssetData).toHaveBeenCalledWith('perspective-1', 'cover.png');
  });

  it('requires shared caches to revalidate generated and in-process cached cards', async () => {
    mocks.getPerspectiveWithIllustration.mockResolvedValue({
      title: 'Public perspective',
      category: 'Research',
      author_name: 'Avery Writer',
      author_title: 'Editor',
      illustration_id: null,
    });
    mocks.generatePerspectiveCard.mockResolvedValue(Buffer.from('png bytes'));

    const httpApp = app();
    const first = await request(httpApp).get('/api/perspectives/example/card.png');
    const cached = await request(httpApp).get('/api/perspectives/example/card.png');

    expect(first.status).toBe(200);
    expect(cached.status).toBe(200);
    expect(first.headers['cache-control']).toBe('public, max-age=0, must-revalidate');
    expect(cached.headers['cache-control']).toBe('public, max-age=0, must-revalidate');
    expect(mocks.getPerspectiveWithIllustration).toHaveBeenCalledTimes(2);
    expect(mocks.generatePerspectiveCard).toHaveBeenCalledTimes(1);
  });
});
