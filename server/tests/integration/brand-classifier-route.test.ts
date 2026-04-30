/**
 * Integration test: classifyBrand tool_use output → DB write contract.
 *
 * POST /api/admin/brand-enrichment/domain/:domain calls enrichBrand() which
 * calls classifyBrand(). This test pins that the route correctly propagates
 * the classify_brand tool_use output (keller_type, house_domain, confidence,
 * related_domains) into the brands DB row.
 *
 * Gap from testing-expert review on PR #3611 (issue #3621): if the return
 * shape of classifyBrand drifted (e.g. dropping related_domains or collapsing
 * confidence to an unexpected value), the unit tests would pass but
 * autoLinkByVerifiedDomain — which reads keller_type + confidence to gate
 * brand-hierarchy membership inheritance — would silently receive bad data.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { Pool } from 'pg';

const mocks = vi.hoisted(() => ({
  anthropicCreate: vi.fn(),
  isBrandfetchConfigured: vi.fn<[], boolean>(),
  fetchBrandData: vi.fn(),
  downloadAndCacheLogos: vi.fn(),
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
    req.user = { id: 'user_classifier_test', email: 'admin@test.example', is_admin: true };
    next();
  },
  requireAdmin: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../src/services/brandfetch.js', () => ({
  isBrandfetchConfigured: mocks.isBrandfetchConfigured,
  fetchBrandData: mocks.fetchBrandData,
  ENRICHMENT_CACHE_MAX_AGE_MS: 86_400_000,
}));

vi.mock('../../src/services/logo-cdn.js', () => ({
  downloadAndCacheLogos: mocks.downloadAndCacheLogos,
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

import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { setupBrandEnrichmentRoutes } from '../../src/routes/admin/brand-enrichment.js';

// Hyphen separator — underscores are invalid in domain names (RFC 1035) and
// `enrichBrand` rejects them with `Invalid domain format`.
const SUFFIX = `${process.pid}-${Date.now()}`;
const TEST_DOMAIN = `classifier-route-${SUFFIX}.example.com`;

function classifyBrandResponse(input: unknown) {
  return {
    content: [{ type: 'tool_use', name: 'classify_brand', id: 'toolu_test', input }],
  };
}

// Minimal Brandfetch response with enough fields to pass enrichBrand's guards
const BRANDFETCH_RESULT = {
  success: true,
  highQuality: true,
  manifest: {
    name: 'Acme Corp',
    description: 'A fictional test brand',
    url: `https://${TEST_DOMAIN}`,
    logos: [],
    colors: [],
    fonts: [],
  },
  company: { industries: ['technology'] },
  raw: { links: [] },
};

describe('POST /api/admin/brand-enrichment/domain/:domain — classifyBrand contract', () => {
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
    await pool.query('DELETE FROM brands WHERE domain = $1', [TEST_DOMAIN]);
    await closeDatabase();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM brands WHERE domain = $1', [TEST_DOMAIN]);
    process.env.ANTHROPIC_API_KEY = 'test-key';
    mocks.anthropicCreate.mockReset();
    mocks.isBrandfetchConfigured.mockReturnValue(true);
    mocks.fetchBrandData.mockResolvedValue(BRANDFETCH_RESULT);
    mocks.downloadAndCacheLogos.mockResolvedValue([]);
    // Fail fast: any test that arms a specific resolve will override this
    mocks.anthropicCreate.mockRejectedValue(
      new Error('anthropic.messages.create was not stubbed for this test'),
    );
  });

  it('writes keller_type, house_domain, confidence, and related_domains to the brands row', async () => {
    mocks.anthropicCreate.mockResolvedValueOnce(
      classifyBrandResponse({
        keller_type: 'sub_brand',
        house_domain: 'pinnacle.example.com',
        parent_brand: 'Pinnacle Corp',
        canonical_domain: TEST_DOMAIN,
        related_domains: ['acme-sub.example.com', 'acme-other.example.com'],
        confidence: 'high',
        reasoning: 'Sub-brand of Pinnacle under a fictional corporate parent.',
      }),
    );

    const res = await request(app).post(
      `/api/admin/brand-enrichment/domain/${TEST_DOMAIN}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('enriched');

    const row = await pool.query<{
      keller_type: string;
      house_domain: string;
      brand_manifest: Record<string, unknown>;
    }>(
      'SELECT keller_type, house_domain, brand_manifest FROM brands WHERE domain = $1',
      [TEST_DOMAIN],
    );

    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].keller_type).toBe('sub_brand');
    expect(row.rows[0].house_domain).toBe('pinnacle.example.com');

    // brand_manifest.classification is written by enrichBrand from the classifier
    // output. related_domains here is the canary: if the return shape dropped it,
    // the manifest would have an empty array or undefined instead.
    const classification = row.rows[0].brand_manifest
      ?.classification as Record<string, unknown> | undefined;
    expect(classification?.confidence).toBe('high');
    expect(classification?.related_domains).toEqual([
      'acme-sub.example.com',
      'acme-other.example.com',
    ]);
  });

  it('succeeds and saves the brand without a classification when ANTHROPIC_API_KEY is absent', async () => {
    delete process.env.ANTHROPIC_API_KEY;

    const res = await request(app).post(
      `/api/admin/brand-enrichment/domain/${TEST_DOMAIN}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('enriched');
    expect(res.body.classification).toBeUndefined();

    const row = await pool.query<{ keller_type: string | null }>(
      'SELECT keller_type FROM brands WHERE domain = $1',
      [TEST_DOMAIN],
    );
    expect(row.rows[0].keller_type).toBeNull();
    expect(mocks.anthropicCreate).not.toHaveBeenCalled();
  });
});
