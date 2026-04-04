import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';

/**
 * Integration test: display name persistence across login
 *
 * Replicates the bug reported by B. Masse: user sets display name via profile
 * settings, logs out, logs back in via Slack, and name reverts to the Slack
 * username format (e.g., "benjamin.masse" instead of "Benjamin Masse").
 *
 * Tests the actual SQL queries used by the auth callback, webhook handler,
 * and membership sync against a real Postgres database.
 */

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:58433/adcp_registry';

let pool: Pool;

beforeAll(async () => {
  pool = new Pool({ connectionString: DATABASE_URL });

  // Ensure required tables exist (create minimal versions for testing)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      workos_user_id VARCHAR(255) PRIMARY KEY,
      email VARCHAR(255) NOT NULL,
      first_name VARCHAR(255),
      last_name VARCHAR(255),
      email_verified BOOLEAN DEFAULT FALSE,
      workos_created_at TIMESTAMPTZ,
      workos_updated_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS organization_memberships (
      workos_user_id VARCHAR(255),
      workos_organization_id VARCHAR(255),
      workos_membership_id VARCHAR(255),
      email VARCHAR(255),
      first_name VARCHAR(255),
      last_name VARCHAR(255),
      role VARCHAR(50) DEFAULT 'member',
      seat_type VARCHAR(50),
      synced_at TIMESTAMPTZ,
      joined_at TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (workos_user_id, workos_organization_id)
    )
  `);
});

afterAll(async () => {
  // Clean up test data
  await pool.query(`DELETE FROM organization_memberships WHERE workos_user_id LIKE 'test-%'`);
  await pool.query(`DELETE FROM users WHERE workos_user_id LIKE 'test-%'`);
  await pool.end();
});

describe('auth callback: name preservation on login', () => {
  const userId = 'test-ben-masse';
  const email = 'benjamin.masse@tritondigital.com';

  afterAll(async () => {
    await pool.query('DELETE FROM users WHERE workos_user_id = $1', [userId]);
  });

  it('should set names on first login (INSERT)', async () => {
    // Simulate first login: WorkOS returns Slack-derived names
    await pool.query(
      `INSERT INTO users (workos_user_id, email, first_name, last_name, email_verified, workos_created_at, workos_updated_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
       ON CONFLICT (workos_user_id) DO UPDATE SET
         email = EXCLUDED.email,
         first_name = COALESCE(NULLIF(TRIM(users.first_name), ''), EXCLUDED.first_name),
         last_name = COALESCE(NULLIF(TRIM(users.last_name), ''), EXCLUDED.last_name),
         email_verified = EXCLUDED.email_verified,
         workos_updated_at = EXCLUDED.workos_updated_at,
         updated_at = NOW()`,
      [userId, email, 'benjamin.masse', null, true, new Date(), new Date()]
    );

    const result = await pool.query('SELECT first_name, last_name FROM users WHERE workos_user_id = $1', [userId]);
    expect(result.rows[0].first_name).toBe('benjamin.masse');
    expect(result.rows[0].last_name).toBeNull();
  });

  it('should preserve user-set names when login provides different values', async () => {
    // User edits their name via PUT /api/me/name
    await pool.query(
      'UPDATE users SET first_name = $1, last_name = $2, updated_at = NOW() WHERE workos_user_id = $3',
      ['Benjamin', 'Masse', userId]
    );

    // Verify the edit stuck
    let result = await pool.query('SELECT first_name, last_name FROM users WHERE workos_user_id = $1', [userId]);
    expect(result.rows[0].first_name).toBe('Benjamin');
    expect(result.rows[0].last_name).toBe('Masse');

    // Simulate re-login: WorkOS returns Slack-derived name again
    await pool.query(
      `INSERT INTO users (workos_user_id, email, first_name, last_name, email_verified, workos_created_at, workos_updated_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
       ON CONFLICT (workos_user_id) DO UPDATE SET
         email = EXCLUDED.email,
         first_name = COALESCE(NULLIF(TRIM(users.first_name), ''), EXCLUDED.first_name),
         last_name = COALESCE(NULLIF(TRIM(users.last_name), ''), EXCLUDED.last_name),
         email_verified = EXCLUDED.email_verified,
         workos_updated_at = EXCLUDED.workos_updated_at,
         updated_at = NOW()`,
      [userId, email, 'benjamin.masse', null, true, new Date(), new Date()]
    );

    // The user-set names should be preserved
    result = await pool.query('SELECT first_name, last_name FROM users WHERE workos_user_id = $1', [userId]);
    expect(result.rows[0].first_name).toBe('Benjamin');
    expect(result.rows[0].last_name).toBe('Masse');
  });

  it('should fill in names when DB has empty values', async () => {
    // Clear names to simulate a user who never set one
    await pool.query(
      'UPDATE users SET first_name = NULL, last_name = NULL WHERE workos_user_id = $1',
      [userId]
    );

    // Login provides names — should be used since DB is empty
    await pool.query(
      `INSERT INTO users (workos_user_id, email, first_name, last_name, email_verified, workos_created_at, workos_updated_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
       ON CONFLICT (workos_user_id) DO UPDATE SET
         email = EXCLUDED.email,
         first_name = COALESCE(NULLIF(TRIM(users.first_name), ''), EXCLUDED.first_name),
         last_name = COALESCE(NULLIF(TRIM(users.last_name), ''), EXCLUDED.last_name),
         email_verified = EXCLUDED.email_verified,
         workos_updated_at = EXCLUDED.workos_updated_at,
         updated_at = NOW()`,
      [userId, email, 'Ben', 'Masse', true, new Date(), new Date()]
    );

    const result = await pool.query('SELECT first_name, last_name FROM users WHERE workos_user_id = $1', [userId]);
    expect(result.rows[0].first_name).toBe('Ben');
    expect(result.rows[0].last_name).toBe('Masse');
  });

  it('should fill in names when DB has whitespace-only values', async () => {
    await pool.query(
      'UPDATE users SET first_name = $1, last_name = $2 WHERE workos_user_id = $3',
      ['  ', ' ', userId]
    );

    await pool.query(
      `INSERT INTO users (workos_user_id, email, first_name, last_name, email_verified, workos_created_at, workos_updated_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
       ON CONFLICT (workos_user_id) DO UPDATE SET
         email = EXCLUDED.email,
         first_name = COALESCE(NULLIF(TRIM(users.first_name), ''), EXCLUDED.first_name),
         last_name = COALESCE(NULLIF(TRIM(users.last_name), ''), EXCLUDED.last_name),
         email_verified = EXCLUDED.email_verified,
         workos_updated_at = EXCLUDED.workos_updated_at,
         updated_at = NOW()`,
      [userId, email, 'Ben', 'Masse', true, new Date(), new Date()]
    );

    const result = await pool.query('SELECT first_name, last_name FROM users WHERE workos_user_id = $1', [userId]);
    expect(result.rows[0].first_name).toBe('Ben');
    expect(result.rows[0].last_name).toBe('Masse');
  });
});

describe('webhook handler: name preservation', () => {
  const userId = 'test-webhook-user';
  const email = 'webhook-test@example.com';

  beforeAll(async () => {
    await pool.query(
      `INSERT INTO users (workos_user_id, email, first_name, last_name, email_verified)
       VALUES ($1, $2, $3, $4, TRUE)
       ON CONFLICT (workos_user_id) DO UPDATE SET first_name = $3, last_name = $4`,
      [userId, email, 'Alice', 'Smith']
    );
  });

  afterAll(async () => {
    await pool.query('DELETE FROM users WHERE workos_user_id = $1', [userId]);
  });

  it('should preserve user-set names when webhook sends empty names', async () => {
    // Webhook upsert with COALESCE (same pattern as workos-webhooks.ts)
    await pool.query(
      `INSERT INTO users (workos_user_id, email, first_name, last_name, email_verified, workos_created_at, workos_updated_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
       ON CONFLICT (workos_user_id) DO UPDATE SET
         email = EXCLUDED.email,
         first_name = COALESCE(NULLIF(TRIM(EXCLUDED.first_name), ''), users.first_name),
         last_name = COALESCE(NULLIF(TRIM(EXCLUDED.last_name), ''), users.last_name),
         email_verified = EXCLUDED.email_verified,
         workos_updated_at = EXCLUDED.workos_updated_at,
         updated_at = NOW()`,
      [userId, email, null, null, true, new Date(), new Date()]
    );

    const result = await pool.query('SELECT first_name, last_name FROM users WHERE workos_user_id = $1', [userId]);
    expect(result.rows[0].first_name).toBe('Alice');
    expect(result.rows[0].last_name).toBe('Smith');
  });
});

describe('organization_memberships: name preservation', () => {
  const userId = 'test-membership-user';
  const orgId = 'test-org-123';
  const email = 'membership-test@example.com';

  beforeAll(async () => {
    await pool.query(
      `INSERT INTO users (workos_user_id, email, first_name, last_name, email_verified)
       VALUES ($1, $2, $3, $4, TRUE)
       ON CONFLICT (workos_user_id) DO UPDATE SET first_name = $3, last_name = $4`,
      [userId, email, 'Carol', 'Jones']
    );
    await pool.query(
      `INSERT INTO organization_memberships (workos_user_id, workos_organization_id, email, first_name, last_name)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (workos_user_id, workos_organization_id)
       DO UPDATE SET first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name`,
      [userId, orgId, email, 'Carol', 'Jones']
    );
  });

  afterAll(async () => {
    await pool.query('DELETE FROM organization_memberships WHERE workos_user_id = $1', [userId]);
    await pool.query('DELETE FROM users WHERE workos_user_id = $1', [userId]);
  });

  it('should preserve membership names when sync provides different values (after fix)', async () => {
    // This is the FIXED version with COALESCE
    await pool.query(
      `INSERT INTO organization_memberships (workos_user_id, workos_organization_id, email, first_name, last_name)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (workos_user_id, workos_organization_id)
       DO UPDATE SET
         email = EXCLUDED.email,
         first_name = COALESCE(NULLIF(TRIM(organization_memberships.first_name), ''), EXCLUDED.first_name),
         last_name = COALESCE(NULLIF(TRIM(organization_memberships.last_name), ''), EXCLUDED.last_name),
         updated_at = NOW()`,
      [userId, orgId, email, 'carol.jones', null]
    );

    const result = await pool.query(
      'SELECT first_name, last_name FROM organization_memberships WHERE workos_user_id = $1 AND workos_organization_id = $2',
      [userId, orgId]
    );
    expect(result.rows[0].first_name).toBe('Carol');
    expect(result.rows[0].last_name).toBe('Jones');
  });
});
