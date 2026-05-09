/**
 * Integration tests for the Stage 0 domain-cleanup script
 * (server/src/scripts/stage0-domain-cleanup.ts).
 *
 * Exercises the canonicalize-www phase and the guards around per-case-fixes
 * against a synthetic org. The actual per-case fixes are exercised manually
 * via dry-run on prod before --apply, so those aren't unit-asserted here —
 * the value of integration tests for them would be low (the data is the
 * test).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initializeDatabase, getPool, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import type { Pool } from 'pg';

const TEST_ORG = 'org_stage0_test';

async function cleanup(pool: Pool) {
  await pool.query('DELETE FROM organization_domains WHERE workos_organization_id = $1', [TEST_ORG]);
  await pool.query('DELETE FROM member_profiles WHERE workos_organization_id = $1', [TEST_ORG]);
  await pool.query('DELETE FROM organizations WHERE workos_organization_id = $1', [TEST_ORG]);
}

async function seedOrg(pool: Pool) {
  await pool.query(
    `INSERT INTO organizations (workos_organization_id, name, is_personal, created_at, updated_at)
     VALUES ($1, $2, false, NOW(), NOW())
     ON CONFLICT (workos_organization_id) DO NOTHING`,
    [TEST_ORG, 'Stage 0 Test Co'],
  );
}

async function seedDomains(pool: Pool, rows: Array<{ domain: string; verified: boolean; is_primary: boolean; source?: string }>) {
  for (const r of rows) {
    await pool.query(
      `INSERT INTO organization_domains (workos_organization_id, domain, verified, is_primary, source, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
       ON CONFLICT (domain) DO UPDATE SET verified = EXCLUDED.verified, is_primary = EXCLUDED.is_primary, source = EXCLUDED.source`,
      [TEST_ORG, r.domain, r.verified, r.is_primary, r.source ?? 'workos'],
    );
  }
}

async function seedProfile(pool: Pool, primary: string | null) {
  await pool.query(
    `INSERT INTO member_profiles (workos_organization_id, slug, display_name, primary_brand_domain, created_at, updated_at)
     VALUES ($1, $2, $3, $4, NOW(), NOW())
     ON CONFLICT (workos_organization_id) DO UPDATE
       SET primary_brand_domain = EXCLUDED.primary_brand_domain, updated_at = NOW()`,
    [TEST_ORG, 'stage0-test', 'Stage 0 Test Co', primary],
  );
}

describe('Stage 0 domain-cleanup: canonicalize-www phase (SQL behavior)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
  }, 60000);

  afterAll(async () => {
    await cleanup(pool);
    await closeDatabase();
  });

  beforeEach(async () => {
    await cleanup(pool);
    await seedOrg(pool);
  });

  // The canonicalize-www phase is one SQL query + a per-row UPDATE. We
  // assert the candidate-discovery query and the UPDATE together.
  it('updates www.foo.com → foo.com when the apex exists in organization_domains', async () => {
    await seedDomains(pool, [
      { domain: 'foo.com', verified: true, is_primary: true },
    ]);
    await seedProfile(pool, 'www.foo.com');

    // Replicate the discovery query from the script.
    const candidates = await pool.query(`
      WITH profile_www AS (
        SELECT
          mp.workos_organization_id,
          mp.primary_brand_domain AS current,
          SUBSTRING(mp.primary_brand_domain FROM 5) AS apex
        FROM member_profiles mp
        WHERE LOWER(mp.primary_brand_domain) LIKE 'www.%'
      )
      SELECT
        pw.workos_organization_id, pw.current, pw.apex,
        EXISTS (
          SELECT 1 FROM organization_domains od
          WHERE od.workos_organization_id = pw.workos_organization_id
            AND LOWER(od.domain) = LOWER(pw.apex)
        ) AS apex_in_org_domains
      FROM profile_www pw
      WHERE pw.workos_organization_id = $1
    `, [TEST_ORG]);

    expect(candidates.rowCount).toBe(1);
    expect(candidates.rows[0].apex).toBe('foo.com');
    expect(candidates.rows[0].apex_in_org_domains).toBe(true);

    // Apply the UPDATE.
    await pool.query(
      `UPDATE member_profiles
          SET primary_brand_domain = $1, updated_at = NOW()
        WHERE workos_organization_id = $2 AND primary_brand_domain = $3`,
      ['foo.com', TEST_ORG, 'www.foo.com'],
    );

    const after = await pool.query<{ primary_brand_domain: string }>(
      `SELECT primary_brand_domain FROM member_profiles WHERE workos_organization_id = $1`,
      [TEST_ORG],
    );
    expect(after.rows[0].primary_brand_domain).toBe('foo.com');
  });

  it('skips when the apex is NOT in organization_domains', async () => {
    // Only the www-prefixed form is in organization_domains; apex absent.
    await seedDomains(pool, [
      { domain: 'www.bar.com', verified: true, is_primary: true },
    ]);
    await seedProfile(pool, 'www.bar.com');

    const candidates = await pool.query(`
      WITH profile_www AS (
        SELECT mp.workos_organization_id, mp.primary_brand_domain AS current,
               SUBSTRING(mp.primary_brand_domain FROM 5) AS apex
        FROM member_profiles mp
        WHERE LOWER(mp.primary_brand_domain) LIKE 'www.%'
      )
      SELECT pw.apex,
        EXISTS (
          SELECT 1 FROM organization_domains od
          WHERE od.workos_organization_id = pw.workos_organization_id
            AND LOWER(od.domain) = LOWER(pw.apex)
        ) AS apex_in_org_domains
      FROM profile_www pw
      WHERE pw.workos_organization_id = $1
    `, [TEST_ORG]);

    expect(candidates.rows[0].apex).toBe('bar.com');
    expect(candidates.rows[0].apex_in_org_domains).toBe(false);
    // Phase would skip — no UPDATE asserted.
  });

  it('does not match profiles whose primary_brand_domain has no www prefix', async () => {
    await seedDomains(pool, [
      { domain: 'baz.com', verified: true, is_primary: true },
    ]);
    await seedProfile(pool, 'baz.com');

    const candidates = await pool.query(`
      SELECT 1 FROM member_profiles
      WHERE workos_organization_id = $1
        AND LOWER(primary_brand_domain) LIKE 'www.%'
    `, [TEST_ORG]);
    expect(candidates.rowCount).toBe(0);
  });
});

describe('Stage 0 domain-cleanup: insert-missing-rows phase (SQL behavior)', () => {
  let pool: Pool;
  const OTHER_ORG = 'org_stage0_other_test';

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
  }, 60000);

  afterAll(async () => {
    await cleanup(pool);
    await pool.query('DELETE FROM organization_domains WHERE workos_organization_id = $1', [OTHER_ORG]);
    await pool.query('DELETE FROM organizations WHERE workos_organization_id = $1', [OTHER_ORG]);
    await closeDatabase();
  });

  beforeEach(async () => {
    await cleanup(pool);
    await pool.query('DELETE FROM organization_domains WHERE workos_organization_id = $1', [OTHER_ORG]);
    await pool.query('DELETE FROM organizations WHERE workos_organization_id = $1', [OTHER_ORG]);
    await seedOrg(pool);
  });

  // The candidate-discovery query is what determines what gets inserted vs
  // surfaced as a collision. Assert both paths.
  const CANDIDATE_QUERY = `
    SELECT
      mp.workos_organization_id AS org_id,
      mp.primary_brand_domain,
      other_od.workos_organization_id AS other_org_owns
    FROM member_profiles mp
    LEFT JOIN organization_domains same_od
      ON same_od.workos_organization_id = mp.workos_organization_id
     AND LOWER(same_od.domain) = LOWER(mp.primary_brand_domain)
    LEFT JOIN organization_domains other_od
      ON LOWER(other_od.domain) = LOWER(mp.primary_brand_domain)
     AND other_od.workos_organization_id != mp.workos_organization_id
    WHERE mp.primary_brand_domain IS NOT NULL
      AND same_od.domain IS NULL
      AND mp.workos_organization_id = $1
  `;

  it('lists a profile as a candidate when primary_brand_domain has no matching org_domains row', async () => {
    await seedProfile(pool, 'qux-stage0test.example');
    // No organization_domains rows for this org.

    const candidates = await pool.query(CANDIDATE_QUERY, [TEST_ORG]);
    expect(candidates.rowCount).toBe(1);
    expect(candidates.rows[0].primary_brand_domain).toBe('qux-stage0test.example');
    expect(candidates.rows[0].other_org_owns).toBeNull();
  });

  it('flags a candidate as a collision when another org already owns the domain', async () => {
    // Seed the OTHER org with the domain claimed.
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, is_personal, created_at, updated_at)
       VALUES ($1, $2, false, NOW(), NOW()) ON CONFLICT DO NOTHING`,
      [OTHER_ORG, 'Other Org'],
    );
    await pool.query(
      `INSERT INTO organization_domains (workos_organization_id, domain, verified, is_primary, source, created_at, updated_at)
       VALUES ($1, $2, true, true, 'workos', NOW(), NOW())
       ON CONFLICT (domain) DO UPDATE SET workos_organization_id = $1`,
      [OTHER_ORG, 'collision-stage0test.example'],
    );

    // TEST_ORG's profile claims the same domain.
    await seedProfile(pool, 'collision-stage0test.example');

    const candidates = await pool.query(CANDIDATE_QUERY, [TEST_ORG]);
    expect(candidates.rowCount).toBe(1);
    expect(candidates.rows[0].other_org_owns).toBe(OTHER_ORG);
  });

  it('does NOT list as candidate when this org already owns the domain (idempotent re-run)', async () => {
    await seedProfile(pool, 'already-stage0test.example');
    await seedDomains(pool, [
      { domain: 'already-stage0test.example', verified: true, is_primary: true, source: 'manual' },
    ]);

    const candidates = await pool.query(CANDIDATE_QUERY, [TEST_ORG]);
    expect(candidates.rowCount).toBe(0);
  });

  it('does NOT list as candidate when primary_brand_domain is NULL', async () => {
    await seedProfile(pool, null);
    const candidates = await pool.query(CANDIDATE_QUERY, [TEST_ORG]);
    expect(candidates.rowCount).toBe(0);
  });

  it('demote-then-insert-then-rollback leaves the existing primary intact on a race loss', async () => {
    // Pre-existing is_primary=true row on TEST_ORG. We're going to simulate
    // the script wanting to insert a new primary, then losing the ON CONFLICT
    // race. The existing primary must survive.
    await seedDomains(pool, [
      { domain: 'existing-primary.example', verified: true, is_primary: true },
    ]);
    await seedProfile(pool, 'wanted-primary.example');

    // Seed the conflict on OTHER_ORG so our INSERT race-loses.
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, is_personal, created_at, updated_at)
       VALUES ($1, $2, false, NOW(), NOW()) ON CONFLICT DO NOTHING`,
      [OTHER_ORG, 'Other Org'],
    );
    await pool.query(
      `INSERT INTO organization_domains (workos_organization_id, domain, verified, is_primary, source, created_at, updated_at)
       VALUES ($1, $2, true, true, 'workos', NOW(), NOW())
       ON CONFLICT (domain) DO UPDATE SET workos_organization_id = $1`,
      [OTHER_ORG, 'wanted-primary.example'],
    );

    // Replicate the phase's transaction. Demote → INSERT race-loses → ROLLBACK.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'SELECT 1 FROM organizations WHERE workos_organization_id = $1 FOR UPDATE',
        [TEST_ORG],
      );
      await client.query(
        `UPDATE organization_domains SET is_primary = false WHERE workos_organization_id = $1 AND is_primary = true`,
        [TEST_ORG],
      );
      const ins = await client.query(
        `INSERT INTO organization_domains (workos_organization_id, domain, verified, is_primary, source, created_at, updated_at)
         VALUES ($1, LOWER($2), true, true, 'manual', NOW(), NOW())
         ON CONFLICT (domain) DO NOTHING
         RETURNING domain`,
        [TEST_ORG, 'wanted-primary.example'],
      );
      expect(ins.rowCount).toBe(0); // race-lost
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    // The pre-existing primary must still be marked is_primary=true.
    const after = await pool.query<{ is_primary: boolean }>(
      `SELECT is_primary FROM organization_domains WHERE workos_organization_id = $1 AND domain = $2`,
      [TEST_ORG, 'existing-primary.example'],
    );
    expect(after.rows[0].is_primary).toBe(true);
  });

  it('insert with ON CONFLICT (domain) DO NOTHING is a no-op when another org owns the row', async () => {
    // Seed the conflict.
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, is_personal, created_at, updated_at)
       VALUES ($1, $2, false, NOW(), NOW()) ON CONFLICT DO NOTHING`,
      [OTHER_ORG, 'Other Org'],
    );
    await pool.query(
      `INSERT INTO organization_domains (workos_organization_id, domain, verified, is_primary, source, created_at, updated_at)
       VALUES ($1, $2, true, true, 'workos', NOW(), NOW())
       ON CONFLICT (domain) DO UPDATE SET workos_organization_id = $1`,
      [OTHER_ORG, 'racewinner-stage0test.example'],
    );

    // Try the insert that would fire from phase code.
    const result = await pool.query(
      `INSERT INTO organization_domains (workos_organization_id, domain, verified, is_primary, source, created_at, updated_at)
       VALUES ($1, $2, true, true, 'manual', NOW(), NOW())
       ON CONFLICT (domain) DO NOTHING
       RETURNING domain`,
      [TEST_ORG, 'racewinner-stage0test.example'],
    );
    expect(result.rowCount).toBe(0);

    // OTHER org still owns it.
    const owner = await pool.query<{ workos_organization_id: string }>(
      `SELECT workos_organization_id FROM organization_domains WHERE LOWER(domain) = $1`,
      ['racewinner-stage0test.example'],
    );
    expect(owner.rows[0].workos_organization_id).toBe(OTHER_ORG);
  });
});
