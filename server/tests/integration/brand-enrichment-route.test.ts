/**
 * Integration test: expandHouse discover_sub_brands tool_use output → DB write contract.
 *
 * POST /api/admin/brand-enrichment/expand-house/:domain calls expandHouse(),
 * which uses the discover_sub_brands tool to discover sub-brands and seeds
 * each one as a brands row.
 *
 * Gap from testing-expert review on PR #3611 (issue #3621): if the brands
 * array shape in discover_sub_brands drifted (e.g. keller_type dropped to
 * undefined), expandHouse would seed brands with wrong keller_type or silently
 * skip rows, with no unit test catching the serialization gap between the
 * tool_use output and the DB write.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { Pool } from 'pg';

const mocks = vi.hoisted(() => ({
  anthropicCreate: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    messages = { create: mocks.anthropicCreate };
  }
  class APIError extends Error {}
  class APIConnectionError extends Error {}
  return { default: FakeAnthropic, APIError, APIConnectionError };
});

vi.mock('../../src/middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/middleware/auth.js')>()),
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: 'user_enrichment_test', email: 'admin@test.example', is_admin: true };
    next();
  },
  requireAdmin: (_req: any, _res: any, next: any) => next(),
}));

// Brandfetch is not used when enrich:false — mock the configured check
// to avoid the 503 short-circuit path on the expand-house route.
vi.mock('../../src/services/brandfetch.js', () => ({
  isBrandfetchConfigured: () => true,
  fetchBrandData: vi.fn(),
  ENRICHMENT_CACHE_MAX_AGE_MS: 86_400_000,
}));

vi.mock('../../src/services/logo-cdn.js', () => ({
  downloadAndCacheLogos: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../src/db/registry-requests-db.js', () => ({
  registryRequestsDb: {
    markResolved: vi.fn().mockResolvedValue(undefined),
    listUnresolved: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../../src/services/enrichment.js', () => ({
  enrichOrganization: vi.fn().mockResolvedValue({ success: false }),
}));

vi.mock('../../src/services/lusha.js', () => ({
  isLushaConfigured: () => false,
}));

vi.mock('../../src/services/brand-classifier.js', () => ({
  classifyBrand: vi.fn().mockResolvedValue(null),
}));

import { initializeDatabase, closeDatabase, query } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { setupBrandEnrichmentRoutes } from '../../src/routes/admin/brand-enrichment.js';

const SUFFIX = `${process.pid}_${Date.now()}`;
const HOUSE_DOMAIN = `house-${SUFFIX}.example.com`;
const SUB_A = `sub-a-${SUFFIX}.example.com`;
const SUB_B = `sub-b-${SUFFIX}.example.com`;

function discoverSubBrandsResponse(brands: unknown[]) {
  return {
    content: [
      { type: 'tool_use', name: 'discover_sub_brands', id: 'toolu_test', input: { brands } },
    ],
  };
}

describe('POST /api/admin/brand-enrichment/expand-house/:domain — discover_sub_brands contract', () => {
  let pool: Pool;
  let app: express.Application;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();

    const apiRouter = express.Router();
    setupBrandEnrichmentRoutes(apiRouter);
    app = express();
    app.use(express.json());
    app.use('/api/admin', apiRouter);
  }, 60_000);

  afterAll(async () => {
    await pool.query(
      'DELETE FROM brands WHERE domain IN ($1, $2, $3)',
      [HOUSE_DOMAIN, SUB_A, SUB_B],
    );
    await closeDatabase();
  });

  beforeEach(async () => {
    await pool.query(
      'DELETE FROM brands WHERE domain IN ($1, $2, $3)',
      [HOUSE_DOMAIN, SUB_A, SUB_B],
    );
    // Seed the house brand — expandHouse throws if the house is not found
    // or if keller_type is neither 'master' nor 'independent'.
    await pool.query(
      `INSERT INTO brands (domain, brand_name, source_type, keller_type, has_brand_manifest, created_at, updated_at)
       VALUES ($1, 'Nova House', 'enriched', 'master', true, NOW(), NOW())`,
      [HOUSE_DOMAIN],
    );

    process.env.ANTHROPIC_API_KEY = 'test-key';
    mocks.anthropicCreate.mockReset();
    mocks.anthropicCreate.mockRejectedValue(
      new Error('anthropic.messages.create was not stubbed for this test'),
    );
  });

  it('seeds sub-brand rows with house_domain and keller_type from discover_sub_brands output', async () => {
    mocks.anthropicCreate.mockResolvedValueOnce(
      discoverSubBrandsResponse([
        { brand_name: 'Pinnacle Sub', domain: SUB_A, keller_type: 'sub_brand' },
        { brand_name: 'Nova Endorsed', domain: SUB_B, keller_type: 'endorsed' },
      ]),
    );

    const res = await request(app)
      .post(`/api/admin/brand-enrichment/expand-house/${HOUSE_DOMAIN}`)
      .send({ enrich: false, delay_ms: 0 });

    expect(res.status).toBe(200);
    expect(res.body.discovered).toBe(2);
    expect(res.body.seeded).toBe(2);

    // Sub-brands must be in the DB with the correct house_domain and keller_type.
    // If the brands array shape drifted, these assertions fail without any route
    // error — the service would silently seed nothing or seed with wrong types.
    const rows = await query<{ domain: string; keller_type: string; house_domain: string }>(
      'SELECT domain, keller_type, house_domain FROM brands WHERE domain IN ($1, $2) ORDER BY domain',
      [SUB_A, SUB_B],
    );

    expect(rows.rows).toHaveLength(2);
    const subA = rows.rows.find((r) => r.domain === SUB_A);
    const subB = rows.rows.find((r) => r.domain === SUB_B);

    expect(subA?.keller_type).toBe('sub_brand');
    expect(subA?.house_domain).toBe(HOUSE_DOMAIN);
    expect(subB?.keller_type).toBe('endorsed');
    expect(subB?.house_domain).toBe(HOUSE_DOMAIN);
  });

  it('returns 500 and seeds no brands when the model omits the tool_use block', async () => {
    mocks.anthropicCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'I cannot list sub-brands.' }],
    });

    const res = await request(app)
      .post(`/api/admin/brand-enrichment/expand-house/${HOUSE_DOMAIN}`)
      .send({ enrich: false, delay_ms: 0 });

    expect(res.status).toBe(500);

    const rows = await query<{ domain: string }>(
      'SELECT domain FROM brands WHERE house_domain = $1',
      [HOUSE_DOMAIN],
    );
    expect(rows.rows).toHaveLength(0);
  });
});
