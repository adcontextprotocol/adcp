/**
 * The moderation queue's SQL, against Postgres (adcp#8338).
 *
 * The queue is the durable answer to #8337's fail-safe posture, so the
 * parts that only Postgres can prove are pinned here: the partial unique
 * index that keeps one open item per outstanding decision (and keeps the
 * age clock running across a re-review), the `review_status`-driven
 * listing that still surfaces a record whose review never ran at all, the
 * atomic claim two moderators race on, and the backlog aggregate the
 * digest and the diagnostic both read.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { Pool } from 'pg';

vi.hoisted(() => {
  process.env.WORKOS_API_KEY = process.env.WORKOS_API_KEY ?? 'test';
  process.env.WORKOS_CLIENT_ID = process.env.WORKOS_CLIENT_ID ?? 'client_test';
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://adcp:localdev@localhost:5432/adcp_test';
});

import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { BrandDatabase } from '../../src/db/brand-db.js';
import { PropertyDatabase } from '../../src/db/property-db.js';
import {
  getOpenRegistryReviewItem,
  getRegistryReviewBacklog,
  listRegistryReviewQueue,
  recordRegistryReviewOutcome,
  reopenRegistryReviewItem,
  resolveOpenRegistryReviewItemsForRecord,
  resolveRegistryReviewItem,
} from '../../src/db/registry-review-queue-db.js';

const BRAND_DOMAIN = 'queue-pending.registry-review-8338.com';
const EDIT_DOMAIN = 'queue-edit.registry-review-8338.com';
const PROPERTY_DOMAIN = 'queue-property.registry-review-8338.com';
const MODERATOR = { user_id: 'user_moderator', email: 'moderator@example.com' };

describe('registry review queue (Postgres)', () => {
  let pool: Pool;
  let brandDb: BrandDatabase;
  let propertyDb: PropertyDatabase;

  async function clearFixtures() {
    const domains = [BRAND_DOMAIN, EDIT_DOMAIN, PROPERTY_DOMAIN];
    await pool.query('DELETE FROM registry_review_queue WHERE domain = ANY($1)', [domains]);
    await pool.query('DELETE FROM brand_revisions WHERE brand_domain = ANY($1)', [domains]);
    await pool.query('DELETE FROM brands WHERE domain = ANY($1)', [domains]);
    await pool.query('DELETE FROM property_revisions WHERE publisher_domain = ANY($1)', [domains]);
    await pool.query('DELETE FROM hosted_properties WHERE publisher_domain = ANY($1)', [domains]);
  }

  /** Only this test's fixtures — the table is shared with real data. */
  async function ourQueue() {
    const items = await listRegistryReviewQueue({ limit: 200 });
    return items.filter((item) => [BRAND_DOMAIN, EDIT_DOMAIN, PROPERTY_DOMAIN].includes(item.domain));
  }

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
    brandDb = new BrandDatabase();
    propertyDb = new PropertyDatabase();
  }, 60000);

  afterAll(async () => {
    await clearFixtures();
    await closeDatabase();
  }, 30000);

  beforeEach(async () => {
    await clearFixtures();
  });

  it('lists a pending record whose review never ran, with no verdict', async () => {
    // The #8337 fail-safe can also be a review that never fired at all —
    // the listing reads `review_status`, so the record is still visible.
    await brandDb.createDiscoveredBrand(
      { domain: BRAND_DOMAIN, brand_name: 'Acme Corp', source_type: 'community' },
      { user_id: 'user_submitter', email: 'submitter@example.com' },
    );

    const [entry] = await ourQueue();

    expect(entry).toMatchObject({
      kind: 'pending_record',
      entity_type: 'brand',
      domain: BRAND_DOMAIN,
      record_name: 'Acme Corp',
      submitter_user_id: 'user_submitter',
      submitter_email: 'submitter@example.com',
      verdict: null,
      review_item_id: null,
      available_actions: ['approve', 'reject'],
    });
    expect(entry.revision_count).toBe(1);
    expect(entry.age_hours).toBeGreaterThanOrEqual(0);
  });

  it('attaches the recorded verdict and reason to a pending record', async () => {
    await brandDb.createDiscoveredBrand(
      { domain: BRAND_DOMAIN, brand_name: 'Acme Corp', source_type: 'community' },
      { user_id: 'user_submitter', email: 'submitter@example.com' },
    );
    await recordRegistryReviewOutcome({
      entity_type: 'brand',
      domain: BRAND_DOMAIN,
      submission_kind: 'new_record',
      submitter_user_id: 'user_submitter',
      submitter_email: 'submitter@example.com',
      verdict: 'needs_human_review',
      reason: 'Automated review could not run. Left for a human to decide.',
      action_taken: 'Left pending for human review',
    });

    const [entry] = await ourQueue();

    expect(entry.verdict).toBe('needs_human_review');
    expect(entry.reason).toContain('could not run');
    expect(entry.review_item_id).not.toBeNull();
  });

  it('keeps one open item per submission and does not reset the age on a re-review', async () => {
    const first = await recordRegistryReviewOutcome({
      entity_type: 'brand',
      domain: EDIT_DOMAIN,
      submission_kind: 'edit',
      revision_number: 4,
      submitter_user_id: 'user_editor',
      verdict: 'needs_human_review',
      reason: 'first pass',
    });
    // Backdate so a reset of the age clock would be visible.
    await pool.query(
      `UPDATE registry_review_queue SET created_at = NOW() - INTERVAL '30 hours' WHERE id = $1`,
      [first.id],
    );

    const second = await recordRegistryReviewOutcome({
      entity_type: 'brand',
      domain: EDIT_DOMAIN,
      submission_kind: 'edit',
      revision_number: 4,
      submitter_user_id: 'user_editor',
      verdict: 'malicious',
      reason: 'second pass',
      action_taken: 'Edit reverted FAILED, needs a human',
    });

    expect(second.id).toBe(first.id);
    expect(second.verdict).toBe('malicious');
    expect(second.reason).toBe('second pass');

    const open = await pool.query(
      'SELECT COUNT(*)::int AS n FROM registry_review_queue WHERE domain = $1 AND resolved_at IS NULL',
      [EDIT_DOMAIN],
    );
    expect(open.rows[0].n).toBe(1);

    const [entry] = await ourQueue();
    // The queue measures how long the member has waited, not how long
    // since the last re-review.
    expect(entry.age_hours).toBeGreaterThanOrEqual(29);
  });

  it('separates a flagged edit from a pending record on the same domain shape', async () => {
    await recordRegistryReviewOutcome({
      entity_type: 'brand',
      domain: EDIT_DOMAIN,
      submission_kind: 'edit',
      revision_number: 9,
      submitter_user_id: 'user_editor',
      submitter_email: 'editor@example.com',
      edit_summary: 'rewrite the description',
      verdict: 'needs_human_review',
      reason: 'cannot tell a correction from a replacement',
    });

    const [entry] = await ourQueue();

    expect(entry).toMatchObject({
      kind: 'flagged_edit',
      domain: EDIT_DOMAIN,
      // Revision N restores the state before edit N (adcp#8337).
      revision_number: 9,
      edit_summary: 'rewrite the description',
      available_actions: ['approve', 'revert'],
    });
  });

  it('refuses an edit item with no revision to restore', async () => {
    await expect(recordRegistryReviewOutcome({
      entity_type: 'brand',
      domain: EDIT_DOMAIN,
      submission_kind: 'edit',
      revision_number: 0,
      submitter_user_id: 'user_editor',
      verdict: 'needs_human_review',
    })).rejects.toThrow(/revision_number/);

    // And the constraint holds even if the guard above is bypassed.
    await expect(pool.query(
      `INSERT INTO registry_review_queue
         (entity_type, domain, submission_kind, revision_number, submitter_user_id, verdict)
       VALUES ('brand', $1, 'edit', 0, 'user_editor', 'needs_human_review')`,
      [EDIT_DOMAIN],
    )).rejects.toThrow();
  });

  it('resolves an item exactly once, recording the moderator', async () => {
    const item = await recordRegistryReviewOutcome({
      entity_type: 'brand',
      domain: EDIT_DOMAIN,
      submission_kind: 'edit',
      revision_number: 2,
      submitter_user_id: 'user_editor',
      verdict: 'needs_human_review',
    });

    const claimed = await resolveRegistryReviewItem(item.id, 'reverted', MODERATOR, 'vandalism');
    expect(claimed).not.toBeNull();
    expect(claimed).toMatchObject({
      resolution: 'reverted',
      resolved_by_user_id: 'user_moderator',
      resolved_by_email: 'moderator@example.com',
      resolution_note: 'vandalism',
    });

    // The second moderator loses the race rather than reverting twice.
    expect(await resolveRegistryReviewItem(item.id, 'reverted', MODERATOR)).toBeNull();
    expect(await getOpenRegistryReviewItem(item.id)).toBeNull();
    expect(await ourQueue()).toHaveLength(0);

    await reopenRegistryReviewItem(item.id);
    const reopened = await getOpenRegistryReviewItem(item.id);
    expect(reopened).not.toBeNull();
    expect(reopened?.resolution).toBeNull();
    expect(reopened?.resolved_by_user_id).toBeNull();
  });

  it('drops a record from the queue once it is approved, and closes its items', async () => {
    await brandDb.createDiscoveredBrand(
      { domain: BRAND_DOMAIN, brand_name: 'Acme Corp', source_type: 'community' },
      { user_id: 'user_submitter', email: 'submitter@example.com' },
    );
    await recordRegistryReviewOutcome({
      entity_type: 'brand',
      domain: BRAND_DOMAIN,
      submission_kind: 'new_record',
      submitter_user_id: 'user_submitter',
      verdict: 'needs_human_review',
    });

    await brandDb.approveBrand(BRAND_DOMAIN);
    const closed = await resolveOpenRegistryReviewItemsForRecord(
      'brand', BRAND_DOMAIN, 'approved', MODERATOR,
    );

    expect(closed).toBe(1);
    expect(await ourQueue()).toHaveLength(0);
  });

  it('counts pending brands, pending properties and flagged edits, and the oldest wait', async () => {
    const before = await getRegistryReviewBacklog();

    await brandDb.createDiscoveredBrand(
      { domain: BRAND_DOMAIN, brand_name: 'Acme Corp', source_type: 'community' },
      { user_id: 'user_submitter', email: 'submitter@example.com' },
    );
    await propertyDb.createCommunityProperty(
      { publisher_domain: PROPERTY_DOMAIN, adagents_json: { authorized_agents: [] }, source_type: 'community' },
      { user_id: 'user_submitter', email: 'submitter@example.com' },
    );
    const edit = await recordRegistryReviewOutcome({
      entity_type: 'brand',
      domain: EDIT_DOMAIN,
      submission_kind: 'edit',
      revision_number: 1,
      submitter_user_id: 'user_editor',
      verdict: 'needs_human_review',
    });
    await pool.query(
      `UPDATE registry_review_queue SET created_at = NOW() - INTERVAL '72 hours' WHERE id = $1`,
      [edit.id],
    );

    const after = await getRegistryReviewBacklog();

    expect(after.pending_brands).toBe(before.pending_brands + 1);
    expect(after.pending_properties).toBe(before.pending_properties + 1);
    expect(after.flagged_edits).toBe(before.flagged_edits + 1);
    expect(after.pending_records).toBe(after.pending_brands + after.pending_properties);
    expect(after.total).toBe(after.pending_records + after.flagged_edits);
    // The oldest wait is what makes an outage-driven backlog obvious.
    expect(after.oldest_age_hours).toBeGreaterThanOrEqual(72);
  });
});
