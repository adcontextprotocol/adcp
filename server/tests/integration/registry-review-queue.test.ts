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
  claimRegistryReviewItem,
  getRegistryRecordModerationState,
  getRegistryReviewBacklog,
  listOpenRegistryEditItemsForRecord,
  listRegistryReviewQueue,
  recordRegistryReviewOutcome,
  releaseRegistryReviewItemClaim,
  resolveOpenRegistryReviewItemsForRecord,
  resolveRegistryReviewItem,
  resolveRegistryReviewItems,
} from '../../src/db/registry-review-queue-db.js';
import { registryReviewQueueDrainedInvariant } from '../../src/audit/integrity/invariants/registry-review-queue-drained.js';
import type { InvariantContext } from '../../src/audit/integrity/types.js';

const BRAND_DOMAIN = 'queue-pending.registry-review-8338.com';
const EDIT_DOMAIN = 'queue-edit.registry-review-8338.com';
const PROPERTY_DOMAIN = 'queue-property.registry-review-8338.com';
const CLAIM_DOMAIN = 'queue-claim.registry-review-8338.com';
const MODERATOR = { user_id: 'user_moderator', email: 'moderator@example.com' };
const CLAIMANT_ORG = 'org_registry_review_8338_claimant';

describe('registry review queue (Postgres)', () => {
  let pool: Pool;
  let brandDb: BrandDatabase;
  let propertyDb: PropertyDatabase;

  async function clearFixtures() {
    const domains = [BRAND_DOMAIN, EDIT_DOMAIN, PROPERTY_DOMAIN, CLAIM_DOMAIN];
    await pool.query('DELETE FROM registry_review_queue WHERE domain = ANY($1)', [domains]);
    await pool.query('DELETE FROM brand_revisions WHERE brand_domain = ANY($1)', [domains]);
    await pool.query('DELETE FROM brands WHERE domain = ANY($1)', [domains]);
    await pool.query('DELETE FROM discovered_properties WHERE publisher_domain = ANY($1)', [domains]);
    await pool.query('DELETE FROM property_revisions WHERE publisher_domain = ANY($1)', [domains]);
    await pool.query('DELETE FROM hosted_properties WHERE publisher_domain = ANY($1)', [domains]);
    await pool.query('DELETE FROM organizations WHERE workos_organization_id = $1', [CLAIMANT_ORG]);
  }

  /**
   * Only this test's fixtures. Paging the whole queue and filtering
   * afterwards would make "no fixtures returned" pass for the wrong
   * reason on a database that already holds 200 waiting rows, so the
   * fixtures are backdated to the front of the oldest-first ordering.
   */
  async function ourQueue() {
    const ourDomains = [BRAND_DOMAIN, EDIT_DOMAIN, PROPERTY_DOMAIN, CLAIM_DOMAIN];
    await pool.query(
      `UPDATE brands SET created_at = NOW() - INTERVAL '365 days' WHERE domain = ANY($1)`,
      [ourDomains],
    );
    await pool.query(
      `UPDATE hosted_properties SET created_at = NOW() - INTERVAL '365 days'
        WHERE publisher_domain = ANY($1)`,
      [ourDomains],
    );
    const items = await listRegistryReviewQueue({ limit: 200 });
    return items.filter((item) => ourDomains.includes(item.domain));
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

  it('refuses a revision number that names no revision', async () => {
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

    const resolved = await resolveRegistryReviewItem(item.id, 'reverted', MODERATOR, 'vandalism');
    expect(resolved).toMatchObject({
      resolution: 'reverted',
      resolved_by_user_id: 'user_moderator',
      resolved_by_email: 'moderator@example.com',
      resolution_note: 'vandalism',
    });

    // The second moderator loses the race rather than reverting twice.
    expect(await resolveRegistryReviewItem(item.id, 'reverted', MODERATOR)).toBeNull();
    expect(await ourQueue()).toHaveLength(0);
  });

  it('keeps a claimed item in the queue until an action completes', async () => {
    const item = await recordRegistryReviewOutcome({
      entity_type: 'brand',
      domain: EDIT_DOMAIN,
      submission_kind: 'edit',
      revision_number: 2,
      submitter_user_id: 'user_editor',
      verdict: 'needs_human_review',
    });

    const claimed = await claimRegistryReviewItem(item.id, MODERATOR);
    expect(claimed?.claimed_by_user_id).toBe('user_moderator');
    expect(claimed?.resolved_at).toBeNull();

    // A crash between claiming and acting must leave the work visible:
    // a row marked reverted by a revert that never ran is how live
    // vandalism gets closed as handled.
    const [stillQueued] = await ourQueue();
    expect(stillQueued.claimed_at).not.toBeNull();
    expect((await getRegistryReviewBacklog()).flagged_edits).toBeGreaterThanOrEqual(1);

    // A second moderator is held off while the claim is fresh...
    expect(await claimRegistryReviewItem(item.id, { user_id: 'user_other' })).toBeNull();
    // ...but the same moderator may retry, and a stale claim is reclaimable.
    expect(await claimRegistryReviewItem(item.id, MODERATOR)).not.toBeNull();
    await pool.query(
      `UPDATE registry_review_queue SET claimed_at = NOW() - INTERVAL '30 minutes' WHERE id = $1`,
      [item.id],
    );
    expect(await claimRegistryReviewItem(item.id, { user_id: 'user_other' })).not.toBeNull();

    await releaseRegistryReviewItemClaim(item.id);
    const [released] = await ourQueue();
    expect(released.claimed_at).toBeNull();
  });

  it('closes every stacked edit a single revert covers', async () => {
    const ids: string[] = [];
    for (const revision of [5, 6, 7]) {
      const row = await recordRegistryReviewOutcome({
        entity_type: 'brand',
        domain: EDIT_DOMAIN,
        submission_kind: 'edit',
        revision_number: revision,
        submitter_user_id: 'user_editor',
        verdict: 'needs_human_review',
      });
      ids.push(row.id);
    }

    const open = await listOpenRegistryEditItemsForRecord('brand', EDIT_DOMAIN);
    // Oldest revision first: restoring revision 5 undoes 6 and 7 too,
    // and "reverting" 7 afterwards would put 5 and 6 straight back.
    expect(open.map((row) => row.revision_number)).toEqual([5, 6, 7]);

    const closed = await resolveRegistryReviewItems(ids, 'reverted', MODERATOR);
    expect(closed).toBe(3);
    expect(await listOpenRegistryEditItemsForRecord('brand', EDIT_DOMAIN)).toHaveLength(0);
    expect(await ourQueue()).toHaveLength(0);
  });

  it('queues an edit with no revision to restore, and offers no revert', async () => {
    await recordRegistryReviewOutcome({
      entity_type: 'brand',
      domain: EDIT_DOMAIN,
      submission_kind: 'edit',
      revision_number: null,
      submitter_user_id: 'user_editor',
      verdict: 'malicious',
      reason: 'vandalism',
    });

    const [entry] = await ourQueue();
    expect(entry.revision_number).toBeNull();
    expect(entry.available_actions).toEqual(['approve']);
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


  it('leaves an in-flight domain claim out of the queue and out of the backlog', async () => {
    // `issueDomainClaim` parks a bare hosted_properties row — empty
    // adagents.json, a claim token, no creator and no revision — at
    // review_status = 'pending' while the publisher proves origin
    // control. Approving it would publish an empty document as the
    // publisher's own; rejecting it would strand the claim token.
    const before = await getRegistryReviewBacklog();
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name) VALUES ($1, 'Claimant Co')
       ON CONFLICT (workos_organization_id) DO NOTHING`,
      [CLAIMANT_ORG],
    );
    const { token } = await propertyDb.issueDomainClaim(CLAIM_DOMAIN, CLAIMANT_ORG);
    expect(token).toBeTruthy();

    const claimed = await propertyDb.getHostedPropertyByDomain(CLAIM_DOMAIN);
    expect(claimed?.review_status).toBe('pending');

    expect(await ourQueue()).toHaveLength(0);
    const after = await getRegistryReviewBacklog();
    expect(after.pending_properties).toBe(before.pending_properties);

    // And the action guard reads the same rule, so the endpoints cannot
    // reach a row the listing would not show.
    const state = await getRegistryRecordModerationState('property', CLAIM_DOMAIN);
    expect(state).toMatchObject({ exists: true, review_status: 'pending', has_submitter: false });
  });

  it('keeps an Addie-submitted property in the queue even though it has no revision', async () => {
    // `enhanceProperty` writes no revision but does set created_by_user_id.
    await propertyDb.createHostedProperty({
      publisher_domain: PROPERTY_DOMAIN,
      adagents_json: { authorized_agents: [] },
      source_type: 'community',
      is_public: false,
      review_status: 'pending',
      created_by_user_id: 'system:addie',
      created_by_email: 'addie@agenticadvertising.org',
    });

    const [entry] = await ourQueue();

    expect(entry).toMatchObject({
      kind: 'pending_record',
      entity_type: 'property',
      domain: PROPERTY_DOMAIN,
      submitter_user_id: 'system:addie',
    });
    expect(await getRegistryRecordModerationState('property', PROPERTY_DOMAIN))
      .toMatchObject({ exists: true, review_status: 'pending', has_submitter: true });
  });

  it('reports a missing record as absent rather than pending', async () => {
    expect(await getRegistryRecordModerationState('brand', BRAND_DOMAIN))
      .toEqual({ exists: false, review_status: null, has_submitter: false });
  });


it('only approves or deletes a record that is still pending', async () => {
    await brandDb.createDiscoveredBrand(
      { domain: BRAND_DOMAIN, brand_name: 'Acme Corp', source_type: 'community' },
      { user_id: 'user_submitter', email: 'submitter@example.com' },
    );
    await brandDb.approveBrand(BRAND_DOMAIN);

    // The review can finish between the queue's read and its write, so
    // the pending predicate has to live inside the statement.
    expect(await brandDb.approveBrand(BRAND_DOMAIN, { onlyIfPending: true })).toBe(false);
    expect(await brandDb.deleteDiscoveredBrand(
      BRAND_DOMAIN,
      { actor_user_id: 'user_moderator', source: 'admin_registry_review_reject' },
      { onlyIfPending: true },
    )).toBe(false);
    expect(await brandDb.getDiscoveredBrandByDomain(BRAND_DOMAIN)).not.toBeNull();

    await propertyDb.createCommunityProperty(
      { publisher_domain: PROPERTY_DOMAIN, adagents_json: { authorized_agents: [] }, source_type: 'community' },
      { user_id: 'user_submitter', email: 'submitter@example.com' },
    );
    await propertyDb.approveProperty(PROPERTY_DOMAIN);
    expect(await propertyDb.approveProperty(PROPERTY_DOMAIN, { onlyIfPending: true })).toBe(false);
    expect(await propertyDb.deleteHostedPropertyByDomain(PROPERTY_DOMAIN, { onlyIfPending: true })).toBe(false);
    expect(await propertyDb.getHostedPropertyByDomain(PROPERTY_DOMAIN)).not.toBeNull();
  });

  it('renders the submitted record so a moderator is not approving blind', async () => {
    // A pending community brand is hidden from the public viewer, so
    // the queue is the only place its content appears.
    await brandDb.createDiscoveredBrand(
      {
        domain: BRAND_DOMAIN,
        brand_name: 'Acme Corp',
        source_type: 'community',
        brand_manifest: { description: 'Maker of anvils' },
        has_brand_manifest: true,
      },
      { user_id: 'user_submitter', email: 'submitter@example.com' },
    );

    const [entry] = await ourQueue();

    expect(entry.submitted_content).toContain('Acme Corp');
    expect(entry.submitted_content).toContain('Maker of anvils');
    expect(entry.submitted_content_truncated).toBe(false);
  });

  it('does not put a property claim or verification token in the queue payload', async () => {
    await propertyDb.createCommunityProperty(
      {
        publisher_domain: PROPERTY_DOMAIN,
        adagents_json: { authorized_agents: [], properties: [{ name: 'News' }] },
        source_type: 'community',
      },
      { user_id: 'user_submitter', email: 'submitter@example.com' },
    );
    await pool.query(
      `UPDATE hosted_properties SET claim_token = 'secret-claim-token',
         verification_token = 'secret-verification-token'
       WHERE publisher_domain = $1`,
      [PROPERTY_DOMAIN],
    );

    const [entry] = await ourQueue();

    // The content comes from adagents_json, not from a revision
    // snapshot — a property revision snapshot is the whole row.
    expect(entry.submitted_content).toContain('News');
    expect(JSON.stringify(entry)).not.toContain('secret-claim-token');
    expect(JSON.stringify(entry)).not.toContain('secret-verification-token');
  });

it('refuses to roll a property back once the real publisher owns it', async () => {
    // A flagged edit can sit in the queue for weeks. If the publisher
    // claims the domain and publishes their own adagents.json in the
    // meantime, the stale community revision is not a state to restore.
    await propertyDb.createCommunityProperty(
      { publisher_domain: PROPERTY_DOMAIN, adagents_json: { authorized_agents: [] }, source_type: 'community' },
      { user_id: 'user_submitter', email: 'submitter@example.com' },
    );
    await propertyDb.approveProperty(PROPERTY_DOMAIN);
    await pool.query(
      `INSERT INTO discovered_properties (publisher_domain, property_type, name)
       VALUES ($1, 'website', 'Publisher site')
       ON CONFLICT DO NOTHING`,
      [PROPERTY_DOMAIN],
    );

    await expect(propertyDb.rollbackProperty(PROPERTY_DOMAIN, 1, { user_id: 'user_moderator' }))
      .rejects.toThrow(/authoritative/i);
  });

  it('runs the operational diagnostic against the real schema', async () => {
    // The unit test mocks the pool, so this is where the invariant's SQL
    // — the shared backlog aggregate, including the submitter predicate
    // — is actually executed.
    const edit = await recordRegistryReviewOutcome({
      entity_type: 'brand',
      domain: EDIT_DOMAIN,
      submission_kind: 'edit',
      revision_number: 5,
      submitter_user_id: 'user_editor',
      verdict: 'needs_human_review',
      reason: 'could not decide',
    });
    await pool.query(
      `UPDATE registry_review_queue SET created_at = NOW() - INTERVAL '100 hours' WHERE id = $1`,
      [edit.id],
    );

    const ctx = {
      pool,
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    } as unknown as InvariantContext;

    const result = await registryReviewQueueDrainedInvariant.check(ctx);

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].subject_id).toBe('registry-review-queue');
    expect(result.violations[0].severity).toBe('warning');
    expect((result.violations[0].details as { oldest_age_hours: number }).oldest_age_hours)
      .toBeGreaterThanOrEqual(99);
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
