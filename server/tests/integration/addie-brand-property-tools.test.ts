/**
 * Integration tests for the Addie brand-property tool path.
 *
 * PR #3610 added parse_brand_properties / import_brand_properties as Addie
 * tools that call brand-property-parse.ts via createBrandPropertyToolHandlers.
 * The unit tests at tests/unit/addie/brand-property-tools.test.ts mock the
 * service; these tests call the handler directly against a real Postgres DB.
 *
 * What this suite covers that the unit + route integration tests don't:
 *
 *   1. Ownership enforcement through the Addie path (ownership DB check fires
 *      through the tool handler, not through Express middleware).
 *   2. Domain normalization at the Addie wrapper boundary — normalizeDomain
 *      in brand-property-tools.ts vs req.params.domain.toLowerCase() in the
 *      route. Drift here passes unit tests but breaks mixed-case callers.
 *   3. The full preview→commit chain: parse response feeds import args, and
 *      the brand_manifest is verifiably written in Postgres.
 *   4. Import is stateless — no session token or prior-parse nonce required.
 *
 * What this suite deliberately does NOT cover (already covered elsewhere):
 *   - URL fetch path (route integration test, brand-properties-parse.test.ts)
 *   - Input validation (unit tests)
 *   - LLM output filtering, DNS cap, MAX_PROPERTIES (route integration test)
 *   - Schema enum shape (unit tests + route integration test)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { Pool } from 'pg';

process.env.WORKOS_API_KEY = process.env.WORKOS_API_KEY ?? 'test';
process.env.WORKOS_CLIENT_ID = process.env.WORKOS_CLIENT_ID ?? 'client_test';

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

import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createBrandPropertyToolHandlers } from '../../src/addie/mcp/brand-property-tools.js';
import type { MemberContext } from '../../src/addie/member-context.js';

// PID + timestamp suffix prevents FK collisions when suites run in parallel.
// Hyphen separator: keeps `TEST_DOMAIN` valid per RFC 1035 in case any future
// code path validates the test domain against a regex.
const SUFFIX = `${process.pid}-${Date.now()}`;
const TEST_DOMAIN = `addie-prop-${SUFFIX}.example.com`;
const OWNER_ORG = `org_addie_owner_${SUFFIX}`;
const OUTSIDER_ORG = `org_addie_outsider_${SUFFIX}`;
const OWNER_USER = `user_addie_owner_${SUFFIX}`;
const OUTSIDER_USER = `user_addie_outsider_${SUFFIX}`;

function memberCtx(userId: string): MemberContext {
  return {
    is_mapped: true,
    is_member: true,
    slack_linked: false,
    workos_user: { workos_user_id: userId, email: `${userId}@test.example` },
  } as unknown as MemberContext;
}

function toolUseResponse(input: unknown) {
  return {
    content: [{ type: 'tool_use', name: 'extract_properties', id: 'toolu_test', input }],
  };
}

describe('Addie brand-property tools — integration', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
  }, 60_000);

  async function clearFixtures() {
    await pool.query('DELETE FROM brands WHERE domain = $1', [TEST_DOMAIN]);
    await pool.query(
      'DELETE FROM organization_domains WHERE workos_organization_id IN ($1, $2)',
      [OWNER_ORG, OUTSIDER_ORG],
    );
    await pool.query(
      'DELETE FROM users WHERE workos_user_id IN ($1, $2)',
      [OWNER_USER, OUTSIDER_USER],
    );
    await pool.query(
      'DELETE FROM organizations WHERE workos_organization_id IN ($1, $2)',
      [OWNER_ORG, OUTSIDER_ORG],
    );
  }

  afterAll(async () => {
    await clearFixtures();
    await closeDatabase();
  });

  beforeEach(async () => {
    await clearFixtures();

    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, is_personal)
       VALUES ($1, 'Owner Inc', false), ($2, 'Outsider Inc', false)`,
      [OWNER_ORG, OUTSIDER_ORG],
    );
    await pool.query(
      `INSERT INTO users (workos_user_id, email, primary_organization_id)
       VALUES ($1, $2, $3), ($4, $5, $6)`,
      [OWNER_USER, 'owner@addie.test', OWNER_ORG, OUTSIDER_USER, 'outsider@addie.test', OUTSIDER_ORG],
    );
    await pool.query(
      `INSERT INTO organization_domains (workos_organization_id, domain, verified)
       VALUES ($1, $2, true)`,
      [OWNER_ORG, TEST_DOMAIN],
    );
    await pool.query(
      `INSERT INTO brands (domain, workos_organization_id, source_type, review_status,
         is_public, has_brand_manifest, domain_verified)
       VALUES ($1, $2, 'community', 'approved', TRUE, FALSE, TRUE)`,
      [TEST_DOMAIN, OWNER_ORG],
    );

    mocks.anthropicCreate.mockReset();
    mocks.anthropicCreate.mockRejectedValue(
      new Error('anthropic.messages.create was not stubbed for this test'),
    );
  });

  // ─── Ownership enforcement ────────────────────────────────────────────

  it('parse: cross-org call returns 403 without invoking the LLM', async () => {
    const handlers = createBrandPropertyToolHandlers(memberCtx(OUTSIDER_USER));
    const result = JSON.parse(
      await handlers.get('parse_brand_properties')!({
        domain: TEST_DOMAIN,
        input: 'cnn.com\nbbc.co.uk',
        input_type: 'text',
      }),
    );
    expect(result.status).toBe(403);
    expect(result.error).toMatch(/do not own/i);
    expect(mocks.anthropicCreate).not.toHaveBeenCalled();
  });

  it('import: cross-org call returns 403 and leaves brand_manifest empty', async () => {
    const handlers = createBrandPropertyToolHandlers(memberCtx(OUTSIDER_USER));
    const result = JSON.parse(
      await handlers.get('import_brand_properties')!({
        domain: TEST_DOMAIN,
        properties: [{ identifier: 'cnn.com', type: 'website' }],
      }),
    );
    expect(result.status).toBe(403);
    expect(result.error).toMatch(/do not own/i);

    const { rows } = await pool.query<{ brand_manifest: unknown }>(
      'SELECT brand_manifest FROM brands WHERE domain = $1',
      [TEST_DOMAIN],
    );
    expect(rows[0].brand_manifest).toBeNull();
  });

  // ─── Domain normalization at the Addie wrapper boundary ──────────────

  it('parse: mixed-case domain is normalized — response domain field is lowercase', async () => {
    mocks.anthropicCreate.mockResolvedValueOnce(
      toolUseResponse({ properties: [{ identifier: 'cnn.com', type: 'website' }] }),
    );
    const handlers = createBrandPropertyToolHandlers(memberCtx(OWNER_USER));
    const result = JSON.parse(
      await handlers.get('parse_brand_properties')!({
        domain: TEST_DOMAIN.toUpperCase(),
        input: 'cnn.com',
        input_type: 'text',
      }),
    );
    // If normalizeDomain were absent the ownership check would 403 on the
    // uppercase domain. The explicit not-403 check surfaces that failure
    // clearly before the domain assertion fires.
    expect(result.status).not.toBe(403);
    expect(result.preview).toBe(true);
    expect(result.domain).toBe(TEST_DOMAIN.toLowerCase());
  });

  // ─── Full preview → commit chain ────────────────────────────────────

  it('preview→commit chain writes properties to brand_manifest in the DB', async () => {
    mocks.anthropicCreate.mockResolvedValueOnce(
      toolUseResponse({
        properties: [
          { identifier: 'CNN.com', type: 'website' },     // uppercase — filter lowercases
          { identifier: 'com.example.app', type: 'mobile_app' },
        ],
      }),
    );

    const handlers = createBrandPropertyToolHandlers(memberCtx(OWNER_USER));

    const preview = JSON.parse(
      await handlers.get('parse_brand_properties')!({
        domain: TEST_DOMAIN,
        input: 'CNN.com\ncom.example.app',
        input_type: 'text',
      }),
    );
    expect(preview.preview).toBe(true);
    expect(preview.count).toBe(2);
    expect(preview.next_step).toMatch(/import_brand_properties/);

    const commit = JSON.parse(
      await handlers.get('import_brand_properties')!({
        domain: TEST_DOMAIN,
        properties: preview.properties,
      }),
    );
    expect(commit.added).toBe(2);
    expect(commit.updated).toBe(0);

    const { rows } = await pool.query<{
      brand_manifest: { properties: Array<{ identifier: string; type: string }> };
    }>('SELECT brand_manifest FROM brands WHERE domain = $1', [TEST_DOMAIN]);

    const stored = rows[0].brand_manifest?.properties ?? [];
    expect(stored).toHaveLength(2);
    expect(stored.map((p) => p.identifier)).toEqual(
      expect.arrayContaining(['cnn.com', 'com.example.app']),
    );
  });

  // ─── Import is stateless (no prior parse required) ───────────────────

  it('import succeeds when called directly without a preceding parse call', async () => {
    // Documents that import_brand_properties is stateless — the confirmation
    // flow is enforced by Addie's prompt, not by a server-side nonce. If a
    // session token or parse ID is ever introduced, this test will fail loudly.
    const handlers = createBrandPropertyToolHandlers(memberCtx(OWNER_USER));
    const result = JSON.parse(
      await handlers.get('import_brand_properties')!({
        domain: TEST_DOMAIN,
        properties: [
          { identifier: 'direct.example', type: 'website', relationship: 'owned' },
        ],
      }),
    );
    expect(result.added).toBe(1);
    expect(result.updated).toBe(0);
    expect(mocks.anthropicCreate).not.toHaveBeenCalled();
  });

  // ─── Idempotent merge against a pre-populated manifest ───────────────

  it('import on pre-populated manifest: updated entries merged in-place, new entries appended', async () => {
    await pool.query(
      `UPDATE brands
         SET brand_manifest = '{"properties":[{"identifier":"cnn.com","type":"website"},{"identifier":"bbc.co.uk","type":"website"}]}'::jsonb
       WHERE domain = $1`,
      [TEST_DOMAIN],
    );

    const handlers = createBrandPropertyToolHandlers(memberCtx(OWNER_USER));
    const result = JSON.parse(
      await handlers.get('import_brand_properties')!({
        domain: TEST_DOMAIN,
        properties: [
          { identifier: 'cnn.com', type: 'website', relationship: 'owned' },   // update
          { identifier: 'bbc.co.uk', type: 'website', relationship: 'owned' }, // update
          { identifier: 'reuters.com', type: 'website' },                       // add
        ],
      }),
    );
    expect(result.added).toBe(1);
    expect(result.updated).toBe(2);
    expect(result.skipped).toBe(0);

    const { rows } = await pool.query<{
      brand_manifest: { properties: Array<{ identifier: string; relationship?: string }> };
    }>('SELECT brand_manifest FROM brands WHERE domain = $1', [TEST_DOMAIN]);

    const stored = rows[0].brand_manifest?.properties ?? [];
    expect(stored).toHaveLength(3);
    const cnn = stored.find((p) => p.identifier === 'cnn.com');
    expect(cnn?.relationship).toBe('owned');
  });
});
