import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, initializeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createAdminToolHandlers } from '../../src/addie/mcp/admin-tools.js';
import type { Pool } from 'pg';

describe.skipIf(!process.env.DATABASE_URL)('admin membership analytics with PostgreSQL', () => {
  let pool: Pool;
  const handlers = createAdminToolHandlers();
  const stats = async () => {
    const result = await handlers.get('query_admin_analytics')!({ view: 'platform_stats' });
    const json = result.split('```json\n')[1]?.split('\n```')[0];
    expect(json, result).toBeDefined();
    return JSON.parse(json!);
  };

  beforeAll(async () => {
    initializeDatabase({ connectionString: process.env.DATABASE_URL! });
    await runMigrations();
    await closeDatabase();
    pool = initializeDatabase({ connectionString: process.env.DATABASE_URL!, maxPoolSize: 1, minPoolSize: 0 });
    // Session-local copies isolate the population without deleting shared test
    // data. A one-connection pool keeps the real handler on this session.
    for (const table of ['organizations', 'users', 'identity_workos_users', 'organization_memberships', 'slack_user_mappings', 'organization_domains', 'community_points']) {
      await pool.query(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING DEFAULTS)`);
    }
  }, 120_000);

  afterAll(async () => { await closeDatabase(); });

  beforeEach(async () => {
    await pool.query('TRUNCATE pg_temp.organizations');
    await pool.query(`
      INSERT INTO organizations (workos_organization_id, name, subscription_status, is_personal, membership_tier)
      SELECT 'test_active_' || i, 'Test member ' || i, 'active', i <= 113,
        CASE WHEN i <= 113 THEN 'individual' ELSE 'company' END
      FROM generate_series(1, 212) i
    `);
    await pool.query(`
      INSERT INTO organizations (workos_organization_id, name, subscription_status, is_personal, membership_tier, subscription_canceled_at)
      VALUES
        ('test_canceled', 'Canceled', 'canceled', false, 'company', NOW()),
        ('test_canceling', 'Canceling', 'active', true, 'individual', NOW()),
        ('test_trial', 'Trial', 'trialing', true, 'individual', NULL),
        ('test_past_due', 'Past due', 'past_due', false, 'company', NULL),
        ('test_unpaid', 'Unpaid', 'unpaid', true, 'individual', NULL),
        ('test_prospect', 'Prospect', NULL, false, 'company', NULL)
    `);
  });

  it('counts only active uncanceled memberships and returns matching type and tier breakdowns', async () => {
    const snapshot = await stats();
    expect(snapshot.memberships.active).toBe(212);
    expect(snapshot.memberships.active_by_type).toEqual({ individual: 113, organization: 99, unclassified: 0 });
    expect(snapshot.memberships.active_by_membership_tier).toEqual({ individual: 113, company: 99 });
    expect(snapshot.organizations.total).toBe(218);
    expect(snapshot.organizations.by_membership_tier).toEqual({ individual: 116, company: 102 });
    expect(snapshot.organizations.population).toContain('non-paying');
  });

  it('includes unknown types and tiers without losing memberships from the breakdown', async () => {
    await pool.query("UPDATE organizations SET is_personal = NULL, membership_tier = NULL WHERE workos_organization_id = 'test_active_1'");
    const snapshot = await stats();
    expect(snapshot.memberships.active).toBe(212);
    expect(snapshot.memberships.active_by_type).toEqual({ individual: 112, organization: 99, unclassified: 1 });
    expect(snapshot.memberships.active_by_membership_tier).toEqual({ individual: 112, company: 99, none: 1 });
  });

  it('reports the exact total when the member list hits its default 200-row cap', async () => {
    const result = await handlers.get('list_paying_members')!({});
    expect(result).toContain('**212 matching memberships**');
    expect(result).toContain('Showing 200 of 212 matching memberships');
    expect(result.match(/^- \*\*/gm)).toHaveLength(200);
  });

  it('counts payment-issue statuses across all matching rows before a small limit', async () => {
    const result = await handlers.get('list_paying_members')!({ limit: 1, include_payment_issues: true });
    expect(result).toContain('**214 matching memberships**');
    expect(result).toContain('212 active, 1 past due, 1 unpaid');
    expect(result).toContain('Showing 1 of 214');
  });

  it('respects organization-only filtering and does not label an exact-size page truncated', async () => {
    const result = await handlers.get('list_paying_members')!({ include_individual: false, limit: 99 });
    expect(result).toContain('**99 matching memberships** (corporate only)');
    expect(result).not.toContain('truncated');
  });

  it('returns zero totals and an empty tier breakdown when no memberships are active', async () => {
    await pool.query("UPDATE organizations SET subscription_status = 'canceled'");
    const snapshot = await stats();
    expect(snapshot.memberships.active).toBe(0);
    expect(snapshot.memberships.active_by_type).toEqual({ individual: 0, organization: 0, unclassified: 0 });
    expect(snapshot.memberships.active_by_membership_tier).toEqual({});
    await expect(handlers.get('list_paying_members')!({})).resolves.toContain('No paying members found');
  });
});
