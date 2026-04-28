/**
 * Integration tests for POST /api/brands/:domain/properties/parse — the
 * smart-paste preview endpoint added in #3396 (issue #2180).
 *
 * The PR description explicitly calls this out as an untested gap. The two
 * fixup commits on the branch addressed three reviewer blockers; these tests
 * pin the behaviour those fixes are supposed to guarantee:
 *
 *   1. Auth gate runs **before** any outbound fetch or LLM spend. A caller
 *      whose org doesn't own the brand must never trigger safeFetch /
 *      Anthropic.
 *   2. Input validation rejects bad input_type / relationship / empty input
 *      with 400 (no fetch, no LLM).
 *   3. SSRF protection: validateFetchUrl rejection returns the fixed string
 *      `URL not allowed for security reasons` (no internal DNS leak).
 *   4. LLM output filter: identifiers > 253 chars (DNS max) and types not in
 *      VALID_PROPERTY_TYPES are dropped; identifiers are lowercased; the
 *      MAX_PROPERTIES = 500 cap is enforced.
 *   5. Char truncation: input > 50_000 chars sets `truncated: true`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { Pool } from 'pg';

// Shared mocks accessed by both vi.mock factories and assertion blocks.
const mocks = vi.hoisted(() => ({
  currentUserId: 'user_parse_owner',
  anthropicCreate: vi.fn(),
  validateFetchUrl: vi.fn(),
  safeFetch: vi.fn(),
}));

vi.mock('../../src/middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/middleware/auth.js')>()),
  requireAuth: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    (req as { user: unknown }).user = { id: mocks.currentUserId, email: 'parse@test.example' };
    next();
  },
}));

vi.mock('@anthropic-ai/sdk', () => {
  // Several modules under src/ instantiate `new Anthropic()` at import time
  // (e.g. addie/services/engagement-planner.ts), so the mock has to be a
  // real constructor. Every instance shares the hoisted `anthropicCreate`
  // spy, which is what the route under test actually invokes.
  class FakeAnthropic {
    messages = { create: mocks.anthropicCreate };
  }
  class APIError extends Error {}
  class APIConnectionError extends Error {}
  return { default: FakeAnthropic, APIError, APIConnectionError };
});

vi.mock('../../src/utils/url-security.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/url-security.js')>()),
  validateFetchUrl: mocks.validateFetchUrl,
  safeFetch: mocks.safeFetch,
}));

import { initializeDatabase, closeDatabase, query } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { BrandDatabase } from '../../src/db/brand-db.js';
import { createBrandFeedsRouter } from '../../src/routes/brand-feeds.js';

const TEST_DOMAIN = 'parse-test.example.com';
const OWNER_ORG = 'org_parse_owner_001';
const OUTSIDER_ORG = 'org_parse_outsider_002';
const OWNER_USER = 'user_parse_owner';
const OUTSIDER_USER = 'user_parse_outsider';

describe('POST /api/brands/:domain/properties/parse', () => {
  let pool: Pool;
  let app: express.Application;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();

    const brandDb = new BrandDatabase();
    app = express();
    app.use(express.json({ limit: '5mb' }));
    app.use('/api', createBrandFeedsRouter({ brandDb }));
  }, 60_000);

  async function clearFixtures() {
    await pool.query('DELETE FROM brands WHERE domain = $1', [TEST_DOMAIN]);
    await pool.query('DELETE FROM organization_domains WHERE workos_organization_id IN ($1, $2)', [OWNER_ORG, OUTSIDER_ORG]);
    await pool.query('DELETE FROM users WHERE workos_user_id IN ($1, $2)', [OWNER_USER, OUTSIDER_USER]);
    await pool.query('DELETE FROM organizations WHERE workos_organization_id IN ($1, $2)', [OWNER_ORG, OUTSIDER_ORG]);
  }

  afterAll(async () => {
    await clearFixtures();
    await closeDatabase();
  });

  beforeEach(async () => {
    await clearFixtures();

    // Two orgs, two users, one brand owned by OWNER_ORG via organization_domains.
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, is_personal)
       VALUES ($1, 'Owner Inc', false), ($2, 'Outsider Inc', false)`,
      [OWNER_ORG, OUTSIDER_ORG]
    );
    await pool.query(
      `INSERT INTO users (workos_user_id, email, primary_organization_id)
       VALUES ($1, $2, $3), ($4, $5, $6)`,
      [OWNER_USER, 'owner@test.example', OWNER_ORG, OUTSIDER_USER, 'outsider@test.example', OUTSIDER_ORG]
    );
    await pool.query(
      `INSERT INTO organization_domains (workos_organization_id, domain, verified)
       VALUES ($1, $2, true)`,
      [OWNER_ORG, TEST_DOMAIN]
    );
    await pool.query(
      `INSERT INTO brands (domain, workos_organization_id, source_type, review_status, is_public, has_brand_manifest, domain_verified)
       VALUES ($1, $2, 'community', 'approved', TRUE, FALSE, TRUE)`,
      [TEST_DOMAIN, OWNER_ORG]
    );

    mocks.currentUserId = OWNER_USER;
    mocks.anthropicCreate.mockReset();
    mocks.validateFetchUrl.mockReset();
    mocks.safeFetch.mockReset();
    // Fail-fast defaults: any test that didn't explicitly arm one of these
    // mocks should error immediately rather than hang on a real network
    // dependency. Per-test `mockResolvedValueOnce` / `mockRejectedValueOnce`
    // takes precedence over these defaults.
    mocks.validateFetchUrl.mockRejectedValue(new Error('validateFetchUrl was not stubbed for this test'));
    mocks.safeFetch.mockRejectedValue(new Error('safeFetch was not stubbed for this test'));
    mocks.anthropicCreate.mockRejectedValue(new Error('anthropic.messages.create was not stubbed for this test'));
  });

  // ─── Input validation (pre-DB) ───────────────────────────────────────

  it('400s on missing input', async () => {
    const res = await request(app)
      .post(`/api/brands/${TEST_DOMAIN}/properties/parse`)
      .send({ input_type: 'text' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('input required');
    expect(mocks.anthropicCreate).not.toHaveBeenCalled();
    expect(mocks.safeFetch).not.toHaveBeenCalled();
  });

  it('400s on whitespace-only input', async () => {
    const res = await request(app)
      .post(`/api/brands/${TEST_DOMAIN}/properties/parse`)
      .send({ input: '   \n\t ', input_type: 'text' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('input required');
    expect(mocks.anthropicCreate).not.toHaveBeenCalled();
  });

  it('400s on bad input_type', async () => {
    const res = await request(app)
      .post(`/api/brands/${TEST_DOMAIN}/properties/parse`)
      .send({ input: 'example.com', input_type: 'binary' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/input_type/);
  });

  it('400s on bad relationship value', async () => {
    const res = await request(app)
      .post(`/api/brands/${TEST_DOMAIN}/properties/parse`)
      .send({ input: 'example.com', input_type: 'text', relationship: 'spousal' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/relationship/);
  });

  // ─── Auth gate must fire before any outbound work ────────────────────

  it('403s an outsider trying URL parse — never invokes safeFetch or Anthropic', async () => {
    mocks.currentUserId = OUTSIDER_USER;

    const res = await request(app)
      .post(`/api/brands/${TEST_DOMAIN}/properties/parse`)
      .send({ input: 'https://attacker.example/list.csv', input_type: 'url' });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/do not own/i);
    expect(mocks.validateFetchUrl).not.toHaveBeenCalled();
    expect(mocks.safeFetch).not.toHaveBeenCalled();
    expect(mocks.anthropicCreate).not.toHaveBeenCalled();
  });

  it('403s an outsider trying text parse — never invokes Anthropic', async () => {
    mocks.currentUserId = OUTSIDER_USER;

    const res = await request(app)
      .post(`/api/brands/${TEST_DOMAIN}/properties/parse`)
      .send({ input: 'example.com\nexample.org', input_type: 'text' });

    expect(res.status).toBe(403);
    expect(mocks.anthropicCreate).not.toHaveBeenCalled();
  });

  it('404s a missing brand without invoking the LLM', async () => {
    const res = await request(app)
      .post(`/api/brands/does-not-exist.example/properties/parse`)
      .send({ input: 'example.com', input_type: 'text' });

    expect(res.status).toBe(404);
    expect(mocks.anthropicCreate).not.toHaveBeenCalled();
  });

  // ─── SSRF leakage ───────────────────────────────────────────────────

  it('returns the fixed SSRF error string when validateFetchUrl rejects', async () => {
    mocks.validateFetchUrl.mockRejectedValueOnce(
      new Error('URL resolved to a private or internal IP address')
    );

    const res = await request(app)
      .post(`/api/brands/${TEST_DOMAIN}/properties/parse`)
      .send({ input: 'https://internal.example/x', input_type: 'url' });

    expect(res.status).toBe(400);
    // Fixed string — must not leak DNS internals.
    expect(res.body.error).toBe('URL not allowed for security reasons');
    expect(res.body.error).not.toMatch(/private|internal|DNS|resolved/i);
    expect(mocks.safeFetch).not.toHaveBeenCalled();
    expect(mocks.anthropicCreate).not.toHaveBeenCalled();
  });

  it('400s an invalid URL string before any DNS work', async () => {
    const res = await request(app)
      .post(`/api/brands/${TEST_DOMAIN}/properties/parse`)
      .send({ input: 'not a url', input_type: 'url' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid URL');
    expect(mocks.validateFetchUrl).not.toHaveBeenCalled();
    expect(mocks.safeFetch).not.toHaveBeenCalled();
  });

  // ─── Happy path ─────────────────────────────────────────────────────

  it('returns parsed properties from a text paste', async () => {
    mocks.anthropicCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            properties: [
              { identifier: 'Example.com', type: 'website' },
              { identifier: 'com.example.app', type: 'mobile_app' },
            ],
          }),
        },
      ],
    });

    const res = await request(app)
      .post(`/api/brands/${TEST_DOMAIN}/properties/parse`)
      .send({ input: 'Example.com\ncom.example.app', input_type: 'text' });

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    // Identifiers lowercased.
    expect(res.body.properties).toEqual([
      { identifier: 'example.com', type: 'website', relationship: 'delegated' },
      { identifier: 'com.example.app', type: 'mobile_app', relationship: 'delegated' },
    ]);
    expect(res.body.truncated).toBeUndefined();
  });

  it('honours an explicit relationship override', async () => {
    mocks.anthropicCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"properties":[{"identifier":"x.example","type":"website"}]}' }],
    });

    const res = await request(app)
      .post(`/api/brands/${TEST_DOMAIN}/properties/parse`)
      .send({ input: 'x.example', input_type: 'text', relationship: 'owned' });

    expect(res.status).toBe(200);
    expect(res.body.properties[0].relationship).toBe('owned');
  });

  // ─── LLM output filtering ───────────────────────────────────────────

  it('filters identifiers exceeding the DNS 253-char cap', async () => {
    const tooLong = 'a'.repeat(254) + '.example';
    mocks.anthropicCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            properties: [
              { identifier: tooLong, type: 'website' },
              { identifier: 'ok.example', type: 'website' },
            ],
          }),
        },
      ],
    });

    const res = await request(app)
      .post(`/api/brands/${TEST_DOMAIN}/properties/parse`)
      .send({ input: 'list', input_type: 'text' });

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.properties[0].identifier).toBe('ok.example');
  });

  it('filters property types not in the allowlist', async () => {
    mocks.anthropicCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            properties: [
              { identifier: 'a.example', type: 'website' },
              { identifier: 'b.example', type: 'crystal_ball' }, // bogus
              { identifier: 'c.example', type: 'podcast' },
            ],
          }),
        },
      ],
    });

    const res = await request(app)
      .post(`/api/brands/${TEST_DOMAIN}/properties/parse`)
      .send({ input: 'list', input_type: 'text' });

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.properties.map((p: { type: string }) => p.type)).toEqual(['website', 'podcast']);
  });

  it('caps results at MAX_PROPERTIES (500)', async () => {
    const props = Array.from({ length: 600 }, (_, i) => ({
      identifier: `host${i}.example`,
      type: 'website',
    }));
    mocks.anthropicCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: JSON.stringify({ properties: props }) }],
    });

    const res = await request(app)
      .post(`/api/brands/${TEST_DOMAIN}/properties/parse`)
      .send({ input: 'list', input_type: 'text' });

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(500);
    expect(res.body.properties).toHaveLength(500);
  });

  it('returns warning + empty list when the LLM emits non-JSON', async () => {
    mocks.anthropicCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'sorry, no domains here' }],
    });

    const res = await request(app)
      .post(`/api/brands/${TEST_DOMAIN}/properties/parse`)
      .send({ input: 'gibberish input', input_type: 'text' });

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
    expect(res.body.warning).toMatch(/Could not parse/i);
  });

  // ─── Truncation flag ────────────────────────────────────────────────

  it('flags truncation when input exceeds 50_000 chars', async () => {
    mocks.anthropicCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"properties":[{"identifier":"a.example","type":"website"}]}' }],
    });

    const huge = 'a.example\n'.repeat(6_000); // 60_000 chars
    const res = await request(app)
      .post(`/api/brands/${TEST_DOMAIN}/properties/parse`)
      .send({ input: huge, input_type: 'text' });

    expect(res.status).toBe(200);
    expect(res.body.truncated).toBe(true);

    // The LLM call should have received exactly 50_000 chars of content.
    const llmCall = mocks.anthropicCreate.mock.calls[0][0];
    const userContent = llmCall.messages[0].content as string;
    const fenceMatch = userContent.match(/<content>\n([\s\S]*)\n<\/content>/);
    expect(fenceMatch).not.toBeNull();
    expect(fenceMatch![1].length).toBe(50_000);
  });
});
