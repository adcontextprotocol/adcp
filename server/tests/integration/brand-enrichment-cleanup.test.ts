/**
 * Admin cleanup of junk enrichment records, against a real database
 * (adcp#9024).
 *
 * The properties that matter:
 *  - a dry run deletes nothing;
 *  - only `source_type = 'enriched'` records nobody owns or curated are ever
 *    removed, in criteria mode and in explicit-list mode alike;
 *  - the hosted parent of the junk (the issue's `wonderstruck.org`) is never
 *    selected;
 *  - each removal writes an audit entry naming the admin;
 *  - a second run removes nothing.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { Pool } from 'pg';

let currentUser: Record<string, unknown> | null = { id: 'user_cleanup_admin', email: 'admin@test.example' };
let isStaticAdminApiKey = false;

vi.mock('../../src/middleware/auth.js', () => ({
  requireGlobalAdmin: [
    (req: any, res: any, next: () => void) => {
      if (!currentUser) return res.status(401).json({ error: 'Authentication required' });
      req.user = currentUser;
      if (isStaticAdminApiKey) req.isStaticAdminApiKey = true;
      next();
    },
  ],
}));

import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { setupBrandRegistryCleanupRoutes } from '../../src/routes/admin/brand-registry-cleanup.js';

const SUFFIX = `${process.pid}-${Date.now()}`;
const PARENT = `novabrands-${SUFFIX}.com`;
const ORG_ID = `org_enrichment_cleanup_${SUFFIX}`;

// The record the issue says must survive: the real, hosted brand whose name
// the junk records copied.
const HOSTED_PARENT = 'wonderstruck.org';

const JUNK_SUBDOMAIN = `e2e-1787388722440-${SUFFIX}.${PARENT}`;
const JUNK_SUBDOMAIN_2 = `sandbox-${SUFFIX}.${PARENT}`;
const JUNK_RESERVED = `novabrands-ai-${SUFFIX}.example.org`;
const JUNK_UNDER_HOSTED = `e2e-${SUFFIX}.${HOSTED_PARENT}`;
// Registrable, so only the explicit list can select it.
const JUNK_REGISTRABLE = `novabrands-${SUFFIX}.net`;

const CLAIMED_SUBDOMAIN = `claimed-${SUFFIX}.${PARENT}`;
const CURATED_SUBDOMAIN = `curated-${SUFFIX}.${PARENT}`;
const COMMUNITY_SUBDOMAIN = `community-${SUFFIX}.${PARENT}`;
const LEGIT_ENRICHED = `legit-${SUFFIX}.com`;
const ADMIN_ALIASED_SUBDOMAIN = `aliased-${SUFFIX}.${PARENT}`;
const CLASSIFIER_ALIAS = `alias-${SUFFIX}.com`;
const ADMIN_ALIAS = `admin-alias-${SUFFIX}.com`;

const ALL_DOMAINS = [
  HOSTED_PARENT,
  JUNK_SUBDOMAIN,
  JUNK_SUBDOMAIN_2,
  JUNK_RESERVED,
  JUNK_UNDER_HOSTED,
  JUNK_REGISTRABLE,
  CLAIMED_SUBDOMAIN,
  CURATED_SUBDOMAIN,
  COMMUNITY_SUBDOMAIN,
  LEGIT_ENRICHED,
  ADMIN_ALIASED_SUBDOMAIN,
];
const CRITERIA_JUNK = [JUNK_SUBDOMAIN, JUNK_SUBDOMAIN_2, JUNK_RESERVED, JUNK_UNDER_HOSTED].sort();

function makeApp() {
  const app = express();
  app.use(express.json());
  const apiRouter = express.Router();
  setupBrandRegistryCleanupRoutes(apiRouter);
  app.use('/api/admin', apiRouter);
  return app;
}

describe('POST /api/admin/brand-registry/enrichment-cleanup', () => {
  let pool: Pool;
  let app: express.Express;

  async function insertBrand(row: {
    domain: string;
    source_type: string;
    brand_name?: string;
    workos_organization_id?: string | null;
    domain_verified?: boolean;
  }) {
    await pool.query(
      `INSERT INTO brands (domain, brand_name, source_type, has_brand_manifest, brand_manifest,
                           enrichment_provider, workos_organization_id, domain_verified, review_status, is_public)
       VALUES ($1, $2, $3, TRUE, $4, $5, $6, $7, 'approved', TRUE)
       ON CONFLICT (domain) DO UPDATE SET
         brand_name = EXCLUDED.brand_name,
         source_type = EXCLUDED.source_type,
         enrichment_provider = EXCLUDED.enrichment_provider,
         workos_organization_id = EXCLUDED.workos_organization_id,
         domain_verified = EXCLUDED.domain_verified`,
      [
        row.domain,
        row.brand_name ?? 'Nova Brands',
        row.source_type,
        JSON.stringify({ name: row.brand_name ?? 'Nova Brands' }),
        row.source_type === 'enriched' ? 'brandfetch' : null,
        row.workos_organization_id ?? null,
        row.domain_verified ?? false,
      ],
    );
  }

  async function existing(): Promise<string[]> {
    const result = await pool.query<{ domain: string }>(
      'SELECT domain FROM brands WHERE domain = ANY($1::text[]) ORDER BY domain',
      [ALL_DOMAINS],
    );
    return result.rows.map((r) => r.domain);
  }

  async function cleanup() {
    await pool.query('DELETE FROM brands WHERE domain = ANY($1::text[])', [ALL_DOMAINS]);
    await pool.query('DELETE FROM brand_revisions WHERE brand_domain = ANY($1::text[])', [ALL_DOMAINS]);
    await pool.query('DELETE FROM brand_logos WHERE domain = ANY($1::text[])', [ALL_DOMAINS]);
    await pool.query('DELETE FROM brand_domain_aliases WHERE alias_domain = ANY($1::text[])', [[CLASSIFIER_ALIAS, ADMIN_ALIAS]]);
    await pool.query(
      "DELETE FROM registry_audit_log WHERE action = 'brand_deleted' AND resource_id = ANY($1::text[])",
      [ALL_DOMAINS],
    );
  }

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, created_at, updated_at)
       VALUES ($1, 'Enrichment Cleanup Test Org', NOW(), NOW())
       ON CONFLICT (workos_organization_id) DO NOTHING`,
      [ORG_ID],
    );
    app = makeApp();
  }, 60_000);

  afterAll(async () => {
    await cleanup();
    await pool.query('DELETE FROM organizations WHERE workos_organization_id = $1', [ORG_ID]);
    await closeDatabase();
  });

  beforeEach(async () => {
    currentUser = { id: 'user_cleanup_admin', email: 'admin@test.example' };
    isStaticAdminApiKey = false;
    await cleanup();

    await insertBrand({
      domain: HOSTED_PARENT,
      source_type: 'community',
      brand_name: 'Hosted Parent',
      workos_organization_id: ORG_ID,
      domain_verified: true,
    });
    await insertBrand({ domain: JUNK_SUBDOMAIN, source_type: 'enriched' });
    await insertBrand({ domain: JUNK_SUBDOMAIN_2, source_type: 'enriched' });
    await insertBrand({ domain: JUNK_RESERVED, source_type: 'enriched' });
    await insertBrand({ domain: JUNK_UNDER_HOSTED, source_type: 'enriched' });
    await insertBrand({ domain: JUNK_REGISTRABLE, source_type: 'enriched' });
    await insertBrand({ domain: CLAIMED_SUBDOMAIN, source_type: 'enriched', workos_organization_id: ORG_ID });
    await insertBrand({ domain: CURATED_SUBDOMAIN, source_type: 'enriched' });
    await pool.query(
      `INSERT INTO brand_revisions (brand_domain, revision_number, snapshot, editor_user_id, edit_summary)
       VALUES ($1, 1, '{}'::jsonb, 'user_editor', 'Fixed the name')`,
      [CURATED_SUBDOMAIN],
    );
    await insertBrand({ domain: COMMUNITY_SUBDOMAIN, source_type: 'community' });
    await insertBrand({ domain: LEGIT_ENRICHED, source_type: 'enriched' });
    await insertBrand({ domain: ADMIN_ALIASED_SUBDOMAIN, source_type: 'enriched' });
    await pool.query(
      `INSERT INTO brand_domain_aliases (alias_domain, brand_domain, source) VALUES ($1, $2, 'admin')`,
      [ADMIN_ALIAS, ADMIN_ALIASED_SUBDOMAIN],
    );
    // Artifacts that should leave with the junk record they belong to.
    await pool.query(
      `INSERT INTO brand_domain_aliases (alias_domain, brand_domain, source) VALUES ($1, $2, 'classifier')`,
      [CLASSIFIER_ALIAS, JUNK_SUBDOMAIN],
    );
    await pool.query(
      `INSERT INTO brand_logos (domain, content_type, data, sha256, tags, source, review_status)
       VALUES ($1, 'image/png', '\\x00'::bytea, 'sha-test', ARRAY['icon'], 'brandfetch', 'approved')`,
      [JUNK_SUBDOMAIN],
    );
  });

  async function previewCriteriaDomains(): Promise<string[]> {
    const res = await request(app).post('/api/admin/brand-registry/enrichment-cleanup').send({});
    expect(res.status).toBe(200);
    return mine(res.body.candidates as Array<{ domain: string }>).map((c) => c.domain).sort();
  }

  function mine<T extends { domain: string }>(rows: T[]): T[] {
    return rows.filter((row) => ALL_DOMAINS.includes(row.domain));
  }

  it('lists reserved names and subdomains on a dry run, and deletes nothing', async () => {
    const res = await request(app).post('/api/admin/brand-registry/enrichment-cleanup').send({});

    expect(res.status).toBe(200);
    expect(res.body.dry_run).toBe(true);
    expect(res.body.mode).toBe('criteria');
    const candidates = mine(res.body.candidates as Array<{ domain: string; reason: string; brand_name: string }>);
    expect(candidates.map((c) => c.domain).sort()).toEqual(CRITERIA_JUNK);
    expect(candidates.find((c) => c.domain === JUNK_RESERVED)).toMatchObject({
      reason: 'reserved_name',
      brand_name: 'Nova Brands',
    });
    expect(candidates.find((c) => c.domain === JUNK_UNDER_HOSTED)).toMatchObject({
      reason: 'not_registrable_domain',
      registrable_domain: HOSTED_PARENT,
    });

    const skipped = mine(res.body.skipped as Array<{ domain: string; reason: string }>);
    expect(skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ domain: CLAIMED_SUBDOMAIN, reason: 'owned_by_organization' }),
      expect.objectContaining({ domain: CURATED_SUBDOMAIN, reason: 'edited_or_curated' }),
      expect.objectContaining({ domain: ADMIN_ALIASED_SUBDOMAIN, reason: 'edited_or_curated' }),
    ]));
    const listed = [...candidates, ...skipped].map((row) => row.domain);
    expect(listed).not.toContain(HOSTED_PARENT);
    expect(listed).not.toContain(COMMUNITY_SUBDOMAIN);
    expect(listed).not.toContain(LEGIT_ENRICHED);

    expect(await existing()).toHaveLength(ALL_DOMAINS.length);
  });

  it('requires an explicit confirm to delete', async () => {
    const res = await request(app)
      .post('/api/admin/brand-registry/enrichment-cleanup')
      .send({ dry_run: false, domains: [JUNK_SUBDOMAIN] });

    expect(res.status).toBe(400);
    expect(await existing()).toHaveLength(ALL_DOMAINS.length);
  });

  it('refuses to delete with an API key, since removals are audited against a person', async () => {
    isStaticAdminApiKey = true;
    const res = await request(app)
      .post('/api/admin/brand-registry/enrichment-cleanup')
      .send({ dry_run: false, confirm: true, domains: [JUNK_SUBDOMAIN] });

    expect(res.status).toBe(403);
    expect(await existing()).toHaveLength(ALL_DOMAINS.length);
  });

  it('refuses a delete without the previewed list', async () => {
    const res = await request(app)
      .post('/api/admin/brand-registry/enrichment-cleanup')
      .send({ dry_run: false, confirm: true });

    expect(res.status).toBe(400);
    expect(await existing()).toHaveLength(ALL_DOMAINS.length);
  });

  it('deletes exactly the previewed junk, keeps everything else, audits each removal, and is idempotent', async () => {
    const previewed = await previewCriteriaDomains();
    expect(previewed).toEqual(CRITERIA_JUNK);

    // A registrable domain slipped into a criteria-mode list is refused.
    const res = await request(app)
      .post('/api/admin/brand-registry/enrichment-cleanup')
      .send({ dry_run: false, confirm: true, mode: 'criteria', domains: [...previewed, LEGIT_ENRICHED] });

    expect(res.status).toBe(200);
    expect(res.body.dry_run).toBe(false);
    expect((res.body.deleted as Array<{ domain: string }>).map((d) => d.domain).sort()).toEqual(CRITERIA_JUNK);
    expect(res.body.skipped).toEqual([
      expect.objectContaining({ domain: LEGIT_ENRICHED, reason: 'registrable_domain' }),
    ]);

    expect(await existing()).toEqual([
      HOSTED_PARENT,
      CLAIMED_SUBDOMAIN,
      COMMUNITY_SUBDOMAIN,
      CURATED_SUBDOMAIN,
      LEGIT_ENRICHED,
      JUNK_REGISTRABLE,
      ADMIN_ALIASED_SUBDOMAIN,
    ].sort());

    const logos = await pool.query('SELECT 1 FROM brand_logos WHERE domain = $1', [JUNK_SUBDOMAIN]);
    expect(logos.rowCount).toBe(0);
    const aliases = await pool.query<{ alias_domain: string }>(
      'SELECT alias_domain FROM brand_domain_aliases WHERE alias_domain = ANY($1::text[])',
      [[CLASSIFIER_ALIAS, ADMIN_ALIAS]],
    );
    expect(aliases.rows.map((r) => r.alias_domain)).toEqual([ADMIN_ALIAS]);

    const audit = await pool.query<{ workos_user_id: string; resource_id: string; details: Record<string, unknown> }>(
      `SELECT workos_user_id, resource_id, details FROM registry_audit_log
       WHERE action = 'brand_deleted' AND resource_id = ANY($1::text[])`,
      [ALL_DOMAINS],
    );
    expect(audit.rows.map((r) => r.resource_id).sort()).toEqual(CRITERIA_JUNK);
    for (const row of audit.rows) {
      expect(row.workos_user_id).toBe('user_cleanup_admin');
      expect(row.details).toMatchObject({
        source: 'cleanup_test_enrichment',
        source_type: 'enriched',
        snapshot: { domain: row.resource_id, brand_manifest: { name: 'Nova Brands' } },
      });
    }
    const junkAudit = audit.rows.find((r) => r.resource_id === JUNK_SUBDOMAIN)!;
    expect(junkAudit.details).toMatchObject({
      deleted_logos: [expect.objectContaining({ sha256: 'sha-test', storage_type: 'inline' })],
      deleted_aliases: [{ alias_domain: CLASSIFIER_ALIAS, source: 'classifier' }],
    });

    const again = await request(app)
      .post('/api/admin/brand-registry/enrichment-cleanup')
      .send({ dry_run: false, confirm: true, mode: 'criteria', domains: previewed });
    expect(again.status).toBe(200);
    expect(again.body.deleted).toEqual([]);
    expect((again.body.skipped as Array<{ reason: string }>).every((s) => s.reason === 'not_found')).toBe(true);
  });

  it('removes only enriched, unowned records from an explicit list', async () => {
    const domains = [
      JUNK_REGISTRABLE,
      JUNK_SUBDOMAIN,
      HOSTED_PARENT,
      CLAIMED_SUBDOMAIN,
      CURATED_SUBDOMAIN,
      COMMUNITY_SUBDOMAIN,
      `missing-${SUFFIX}.com`,
    ];

    const preview = await request(app)
      .post('/api/admin/brand-registry/enrichment-cleanup')
      .send({ domains });
    expect(preview.status).toBe(200);
    expect(preview.body.mode).toBe('explicit_list');
    expect(preview.body.candidates.map((c: { domain: string }) => c.domain).sort()).toEqual(
      [JUNK_REGISTRABLE, JUNK_SUBDOMAIN].sort(),
    );
    expect(preview.body.candidates.find((c: { domain: string }) => c.domain === JUNK_REGISTRABLE).reason)
      .toBe('explicit_list');
    expect(preview.body.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ domain: HOSTED_PARENT, reason: 'not_enriched' }),
      expect.objectContaining({ domain: CLAIMED_SUBDOMAIN, reason: 'owned_by_organization' }),
      expect.objectContaining({ domain: CURATED_SUBDOMAIN, reason: 'edited_or_curated' }),
      expect.objectContaining({ domain: COMMUNITY_SUBDOMAIN, reason: 'not_enriched' }),
      expect.objectContaining({ domain: `missing-${SUFFIX}.com`, reason: 'not_found' }),
    ]));

    const apply = await request(app)
      .post('/api/admin/brand-registry/enrichment-cleanup')
      .send({ domains, dry_run: false, confirm: true });
    expect(apply.status).toBe(200);
    expect(apply.body.deleted.map((d: { domain: string }) => d.domain).sort()).toEqual(
      [JUNK_REGISTRABLE, JUNK_SUBDOMAIN].sort(),
    );
    const remaining = await existing();
    expect(remaining).toContain(HOSTED_PARENT);
    expect(remaining).toContain(CLAIMED_SUBDOMAIN);
    expect(remaining).toContain(CURATED_SUBDOMAIN);
    expect(remaining).toContain(COMMUNITY_SUBDOMAIN);
    expect(remaining).not.toContain(JUNK_REGISTRABLE);
    expect(remaining).not.toContain(JUNK_SUBDOMAIN);
  });

  it('does not delete a record that was claimed after the preview', async () => {
    await pool.query('UPDATE brands SET workos_organization_id = $1 WHERE domain = $2', [ORG_ID, JUNK_SUBDOMAIN]);

    const { brandDb } = await import('../../src/db/brand-db.js');
    const removed = await brandDb.deleteDiscoveredBrand(
      JUNK_SUBDOMAIN,
      { actor_user_id: 'user_cleanup_admin', source: 'cleanup_test_enrichment' },
      { onlyIfRemovableEnrichment: true, recordDeletion: { reason: 'not_registrable_domain' } },
    );

    expect(removed).toBe(false);
    expect(await existing()).toContain(JUNK_SUBDOMAIN);
  });

  it('caps the explicit list', async () => {
    const domains = Array.from({ length: 201 }, (_, i) => `junk-${i}-${SUFFIX}.${PARENT}`);
    const res = await request(app)
      .post('/api/admin/brand-registry/enrichment-cleanup')
      .send({ domains });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/At most 200 domains/);
  });
});
