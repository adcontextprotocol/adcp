import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { closeDatabase, initializeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { ComplianceDatabase } from '../../src/db/compliance-db.js';

describe.skipIf(!process.env.DATABASE_URL)('compliance badge opt-out serialization', () => {
  let pool: Pool;
  const db = new ComplianceDatabase();
  const agentUrls: string[] = [];

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
  });

  afterAll(async () => {
    if (agentUrls.length > 0) {
      await pool.query('DELETE FROM agent_verification_badges WHERE agent_url = ANY($1::text[])', [agentUrls]);
      await pool.query('DELETE FROM agent_registry_metadata WHERE agent_url = ANY($1::text[])', [agentUrls]);
    }
    await closeDatabase();
  });

  it('cannot commit an active badge behind opt-out or expose it on re-enable', async () => {
    const agentUrl = `https://${randomUUID()}.badge-race.example/mcp`;
    agentUrls.push(agentUrl);
    await pool.query(
      `INSERT INTO agent_registry_metadata (
         agent_url, compliance_opt_out, badge_requalification_required
       ) VALUES ($1, FALSE, FALSE)`,
      [agentUrl],
    );

    // Hold the same lock used by both operations so they are definitely
    // concurrent before PostgreSQL chooses a serialized order.
    const fence = await pool.connect();
    await fence.query('BEGIN');
    await fence.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`verification-badge:${agentUrl}`],
    );

    const issuance = db.upsertBadge({
      agent_url: agentUrl,
      role: 'media-buy',
      adcp_version: '3.1',
      verified_specialisms: ['sales-broadcast-tv'],
    });
    const optOut = db.setComplianceOptOut(agentUrl, true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await fence.query('COMMIT');
    fence.release();

    await Promise.all([issuance, optOut]);

    const optedOut = await pool.query(
      `SELECT compliance_opt_out, badge_requalification_required
       FROM agent_registry_metadata WHERE agent_url = $1`,
      [agentUrl],
    );
    expect(optedOut.rows[0]).toMatchObject({
      compliance_opt_out: true,
      badge_requalification_required: true,
    });
    const activeAfterOptOut = await pool.query(
      `SELECT 1 FROM agent_verification_badges
       WHERE agent_url = $1 AND status IN ('active', 'degraded')`,
      [agentUrl],
    );
    expect(activeAfterOptOut.rowCount).toBe(0);

    const reenabled = await db.setComplianceOptOut(agentUrl, false);
    expect(reenabled.metadata).toMatchObject({
      compliance_opt_out: false,
      badge_requalification_required: true,
    });
    expect(await db.getBadgesForAgent(agentUrl)).toEqual([]);

    const transitionGeneration = reenabled.metadata.badge_requalification_generation;
    const attemptFence = await pool.connect();
    await attemptFence.query('BEGIN');
    await attemptFence.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`verification-badge:${agentUrl}`],
    );
    const firstAttempt = db.prepareBadgeRequalification(agentUrl, transitionGeneration);
    const secondAttempt = db.prepareBadgeRequalification(agentUrl, transitionGeneration);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await attemptFence.query('COMMIT');
    attemptFence.release();

    const attemptTokens = await Promise.all([firstAttempt, secondAttempt]);
    expect(attemptTokens.filter((token) => token !== null)).toHaveLength(1);
    expect(attemptTokens.filter((token) => token === null)).toHaveLength(1);
  });
});
