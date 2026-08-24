/**
 * Integration test for the dedup_key behavior added in migration 459.
 *
 * Operational escalations (e.g. "Slack bot is not in channel X") need to
 * collapse repeat occurrences into a single open escalation rather than
 * filling the queue with a new row per Slack call. Same dedup_key + open
 * status returns the existing row; once that escalation is resolved the
 * key is re-usable.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import { initializeDatabase, closeDatabase, query } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  claimEscalationNotification,
  createEscalation,
  getEscalation,
  markNotificationSent,
  releaseEscalationNotificationClaim,
} from '../../src/db/escalation-db.js';

const SUFFIX = `${process.pid}-${Date.now()}`;
const DEDUP_KEY = `test:slack:not_in_channel:C-${SUFFIX}`;

describe('createEscalation dedup_key behavior', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString:
        process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
  }, 60_000);

  afterAll(async () => {
    await pool.query('DELETE FROM addie_escalations WHERE dedup_key LIKE $1', [
      `test:%${SUFFIX}`,
    ]);
    await closeDatabase();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM addie_escalations WHERE dedup_key LIKE $1', [
      `test:%${SUFFIX}`,
    ]);
  });

  it('first call with a fresh dedup_key creates a new escalation', async () => {
    const e = await createEscalation({
      category: 'needs_human_action',
      summary: `Slack bot needs invite to channel ${SUFFIX}`,
      dedup_key: DEDUP_KEY,
    });
    expect(e.id).toBeGreaterThan(0);
    expect(e.dedup_key).toBe(DEDUP_KEY);
    expect(e.status).toBe('open');
  });

  it('second call with the same dedup_key returns the existing open escalation', async () => {
    const first = await createEscalation({
      category: 'needs_human_action',
      summary: 'first summary',
      dedup_key: DEDUP_KEY,
    });

    const second = await createEscalation({
      category: 'needs_human_action',
      summary: 'second summary (should be ignored)',
      dedup_key: DEDUP_KEY,
    });

    expect(second.id).toBe(first.id);
    // Existing summary preserved — repeat callers don't get to overwrite.
    expect(second.summary).toBe('first summary');

    const rows = await query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM addie_escalations WHERE dedup_key = $1',
      [DEDUP_KEY],
    );
    expect(rows.rows[0].count).toBe('1');
  });

  it('reuses dedup_key once the prior escalation is resolved', async () => {
    const first = await createEscalation({
      category: 'needs_human_action',
      summary: 'first',
      dedup_key: DEDUP_KEY,
    });

    await pool.query(
      `UPDATE addie_escalations SET status = 'resolved', resolved_at = NOW() WHERE id = $1`,
      [first.id],
    );

    const second = await createEscalation({
      category: 'needs_human_action',
      summary: 'second after resolution',
      dedup_key: DEDUP_KEY,
    });

    expect(second.id).not.toBe(first.id);
    expect(second.summary).toBe('second after resolution');
    expect(second.status).toBe('open');
  });

  it('inserts without dedup_key behave normally — multiple rows allowed', async () => {
    const a = await createEscalation({
      category: 'needs_human_action',
      summary: `no-dedup test A ${SUFFIX}`,
    });
    const b = await createEscalation({
      category: 'needs_human_action',
      summary: `no-dedup test B ${SUFFIX}`,
    });
    expect(a.id).not.toBe(b.id);
    expect(a.dedup_key).toBeNull();
    expect(b.dedup_key).toBeNull();

    // Cleanup these rows since they don't match the SUFFIX dedup_key cleanup
    await pool.query('DELETE FROM addie_escalations WHERE id IN ($1, $2)', [
      a.id,
      b.id,
    ]);
  });

  it('atomically grants only one initial-notification claim', async () => {
    const escalation = await createEscalation({
      category: 'needs_human_action',
      summary: 'notification claim race',
      dedup_key: DEDUP_KEY,
    });

    const claims = await Promise.all([
      claimEscalationNotification(escalation.id),
      claimEscalationNotification(escalation.id),
    ]);

    expect(claims.sort()).toEqual([false, true]);
    const claimed = await getEscalation(escalation.id);
    expect(claimed?.notification_claimed_at).not.toBeNull();
    expect(claimed?.notification_sent_at).toBeNull();

    await releaseEscalationNotificationClaim(escalation.id);
    expect((await getEscalation(escalation.id))?.notification_claimed_at).toBeNull();
  });

  it('does not release a claim after a Slack message timestamp is recorded', async () => {
    const escalation = await createEscalation({
      category: 'needs_human_action',
      summary: 'completed notification claim',
      dedup_key: DEDUP_KEY,
    });
    expect(await claimEscalationNotification(escalation.id)).toBe(true);
    await markNotificationSent(escalation.id, 'C_TEST', '123.456');

    await releaseEscalationNotificationClaim(escalation.id);

    const persisted = await getEscalation(escalation.id);
    expect(persisted?.notification_claimed_at).toBeNull();
    expect(persisted?.notification_sent_at).not.toBeNull();
    expect(persisted?.notification_message_ts).toBe('123.456');
  });

  it('reclaims an initial-notification claim after the worker-crash timeout', async () => {
    const escalation = await createEscalation({
      category: 'needs_human_action',
      summary: 'stale notification claim',
      dedup_key: DEDUP_KEY,
    });
    expect(await claimEscalationNotification(escalation.id)).toBe(true);
    await pool.query(
      `UPDATE addie_escalations
       SET notification_claimed_at = NOW() - INTERVAL '16 minutes'
       WHERE id = $1`,
      [escalation.id],
    );

    expect(await claimEscalationNotification(escalation.id)).toBe(true);
    expect((await getEscalation(escalation.id))?.notification_claimed_at).not.toBeNull();
  });
});
