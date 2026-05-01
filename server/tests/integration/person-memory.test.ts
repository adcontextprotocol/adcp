/**
 * Integration tests for the new fields on RelationshipContext (#3582 PR1):
 *   - identity flags (account_linked, has_slack, has_email)
 *   - preferences (contact_preference, opted_out, marketing_opt_in)
 *   - invites (pending + expired by email)
 *   - recentThreads (top 5 by last_message_at)
 *
 * The base of loadRelationshipContext (relationship + recentMessages + journey)
 * is exercised in other tests; these focus on the additions.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initializeDatabase, closeDatabase, query } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { resolvePersonId } from '../../src/db/relationship-db.js';
import { loadRelationshipContext } from '../../src/addie/services/relationship-context.js';
import { createMembershipInvite } from '../../src/db/membership-invites-db.js';

const TEST_DOMAIN = 'person-memory-test.example.com';
const ORG_PUBX = 'org_person_memory_test_pubx';
const ADMIN_ID = 'user_person_memory_test_admin';

async function cleanup() {
  await query(
    `DELETE FROM person_events
     WHERE person_id IN (SELECT id FROM person_relationships WHERE email LIKE $1)`,
    [`%@${TEST_DOMAIN}`]
  );
  await query('DELETE FROM addie_thread_messages WHERE thread_id IN (SELECT thread_id FROM addie_threads WHERE person_id IN (SELECT id FROM person_relationships WHERE email LIKE $1))', [`%@${TEST_DOMAIN}`]);
  await query('DELETE FROM addie_threads WHERE person_id IN (SELECT id FROM person_relationships WHERE email LIKE $1)', [`%@${TEST_DOMAIN}`]);
  await query('DELETE FROM membership_invites WHERE workos_organization_id = $1', [ORG_PUBX]);
  // Multi-org fixture rows (used by the orgMemberships test) — clean here
  // so a mid-test failure self-heals on the next run.
  await query(`DELETE FROM organization_memberships WHERE workos_user_id LIKE 'user_pm_%'`);
  await query('DELETE FROM person_relationships WHERE email LIKE $1', [`%@${TEST_DOMAIN}`]);
  await query(`DELETE FROM organizations WHERE workos_organization_id IN ($1, 'org_pm_multi_a', 'org_pm_multi_b')`, [ORG_PUBX]);
}

describe('person memory (loadRelationshipContext additions)', () => {
  beforeAll(async () => {
    initializeDatabase({
      connectionString:
        process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
    await cleanup();
  }, 60000);

  afterAll(async () => {
    await cleanup();
    await closeDatabase();
  });

  beforeEach(cleanup);

  it('identity flags reflect what identifiers are present', async () => {
    const personId = await resolvePersonId({ email: `tej@${TEST_DOMAIN}` });
    let ctx = await loadRelationshipContext(personId);
    expect(ctx.identity.account_linked).toBe(false);
    expect(ctx.identity.has_email).toBe(true);
    expect(ctx.identity.has_slack).toBe(false);

    // Now link a workos user + slack id
    await query(
      `UPDATE person_relationships SET workos_user_id = $1, slack_user_id = $2 WHERE id = $3`,
      ['user_pm_test_workos', 'U0PMTEST01', personId]
    );

    ctx = await loadRelationshipContext(personId);
    expect(ctx.identity.account_linked).toBe(true);
    expect(ctx.identity.has_slack).toBe(true);
    expect(ctx.identity.has_email).toBe(true);
  });

  it('preferences reflect relationship row + email_preferences row', async () => {
    const personId = await resolvePersonId({ email: `pref@${TEST_DOMAIN}` });
    await query(
      `UPDATE person_relationships
       SET workos_user_id = $1, contact_preference = 'slack', opted_out = false
       WHERE id = $2`,
      ['user_pm_test_pref', personId]
    );
    await query(
      `INSERT INTO user_email_preferences (workos_user_id, email, unsubscribe_token, marketing_opt_in)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (workos_user_id) DO UPDATE SET marketing_opt_in = EXCLUDED.marketing_opt_in`,
      ['user_pm_test_pref', `pref@${TEST_DOMAIN}`, 'pm_test_token']
    );

    const ctx = await loadRelationshipContext(personId);
    expect(ctx.preferences.contact_preference).toBe('slack');
    expect(ctx.preferences.opted_out).toBe(false);
    expect(ctx.preferences.marketing_opt_in).toBe(true);

    // cleanup the user_email_preferences row we created
    await query(`DELETE FROM user_email_preferences WHERE workos_user_id = $1`, ['user_pm_test_pref']);
  });

  it('invites surfaces pending and expired (not accepted/revoked) for the email', async () => {
    const email = `invitee@${TEST_DOMAIN}`;
    const personId = await resolvePersonId({ email });
    await query(
      `INSERT INTO organizations (workos_organization_id, name, email_domain, created_at, updated_at)
       VALUES ($1, $2, $3, NOW(), NOW())`,
      [ORG_PUBX, 'Pubx Memory Test', TEST_DOMAIN]
    );

    const pending = await createMembershipInvite({
      workos_organization_id: ORG_PUBX,
      lookup_key: 'aao_membership_professional',
      contact_email: email,
      invited_by_user_id: ADMIN_ID,
    });
    const expired = await createMembershipInvite({
      workos_organization_id: ORG_PUBX,
      lookup_key: 'aao_membership_professional',
      contact_email: email,
      invited_by_user_id: ADMIN_ID,
    });
    await query(
      `UPDATE membership_invites SET expires_at = NOW() - INTERVAL '2 days' WHERE id = $1`,
      [expired.id]
    );
    const accepted = await createMembershipInvite({
      workos_organization_id: ORG_PUBX,
      lookup_key: 'aao_membership_professional',
      contact_email: email,
      invited_by_user_id: ADMIN_ID,
    });
    await query(
      `UPDATE membership_invites SET accepted_at = NOW(), accepted_by_user_id = $1, invoice_id = 'in_t' WHERE id = $2`,
      [ADMIN_ID, accepted.id]
    );

    const ctx = await loadRelationshipContext(personId);
    expect(ctx.invites).toHaveLength(2); // pending + expired only
    const statuses = ctx.invites.map((i) => i.status).sort();
    expect(statuses).toEqual(['expired', 'pending']);
    expect(ctx.invites[0].org_name).toBe('Pubx Memory Test');

    // Sanity: pending and expired ids are present, accepted is not
    const ids = ctx.invites.map((i) => i.expires_at.getTime()).sort();
    expect(ids).toHaveLength(2);
    // The pending invite we created should be one of the two surfaced
    expect(ctx.invites.some((i) => i.expires_at.getTime() === pending.expires_at.getTime())).toBe(true);
  });

  it('recentThreads returns the most recent threads for the person', async () => {
    const personId = await resolvePersonId({ email: `thr@${TEST_DOMAIN}` });
    await query(
      `INSERT INTO addie_threads (channel, external_id, user_type, person_id, title, message_count, last_message_at, started_at)
       VALUES
         ('slack', 'thr_pm_first',  'slack', $1, 'first thread',  3, NOW() - INTERVAL '5 days', NOW() - INTERVAL '5 days'),
         ('web',   'thr_pm_second', 'web',   $1, 'second thread', 1, NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days'),
         ('slack', 'thr_pm_third',  'slack', $1, NULL,            2, NOW() - INTERVAL '1 day',  NOW() - INTERVAL '1 day')`,
      [personId]
    );

    const ctx = await loadRelationshipContext(personId);
    expect(ctx.recentThreads).toHaveLength(3);
    // Sorted by last_message_at desc
    expect(ctx.recentThreads[0].title).toBeNull(); // most recent (no title set)
    expect(ctx.recentThreads[1].title).toBe('second thread');
    expect(ctx.recentThreads[2].title).toBe('first thread');
  });

  it('returns empty arrays for sparse persons (no invites, no threads, no orgs)', async () => {
    const personId = await resolvePersonId({ email: `sparse@${TEST_DOMAIN}` });
    const ctx = await loadRelationshipContext(personId);
    expect(ctx.invites).toEqual([]);
    expect(ctx.recentThreads).toEqual([]);
    expect(ctx.orgMemberships).toEqual([]);
    expect(ctx.preferences.marketing_opt_in).toBeNull();
  });

  it('orgMemberships returns empty for persons with no workos_user_id', async () => {
    const personId = await resolvePersonId({ email: `slack-only@${TEST_DOMAIN}` });
    await query(
      `UPDATE person_relationships SET slack_user_id = $1 WHERE id = $2`,
      ['U0SLACKONLY', personId]
    );
    const ctx = await loadRelationshipContext(personId);
    expect(ctx.orgMemberships).toEqual([]);
  });

  it('is_paying_member is false for a canceled-but-still-in-period subscription', async () => {
    // A subscription that is `active` (Stripe still serving the period) but
    // `subscription_canceled_at` is set has signaled they're leaving. The
    // canonical MEMBER_FILTER excludes these — both loadCompanyInfo and
    // loadOrgMemberships should agree.
    const personId = await resolvePersonId({ email: `canceled@${TEST_DOMAIN}` });
    const workosUserId = 'user_pm_canceled';
    await query(
      `UPDATE person_relationships SET workos_user_id = $1 WHERE id = $2`,
      [workosUserId, personId]
    );
    await query(
      `INSERT INTO organizations
         (workos_organization_id, name, email_domain,
          subscription_status, subscription_canceled_at, created_at, updated_at)
       VALUES ($1, $2, $3, 'active', NOW() - INTERVAL '2 days', NOW(), NOW())
       ON CONFLICT (workos_organization_id) DO UPDATE SET
         subscription_status = EXCLUDED.subscription_status,
         subscription_canceled_at = EXCLUDED.subscription_canceled_at`,
      ['org_pm_multi_a', 'Canceling Co', TEST_DOMAIN]
    );
    await query(
      `INSERT INTO organization_memberships
         (workos_user_id, workos_organization_id, email, role, seat_type, created_at)
       VALUES ($1, 'org_pm_multi_a', $2, 'member', 'contributor', NOW() - INTERVAL '90 days')
       ON CONFLICT (workos_user_id, workos_organization_id) DO NOTHING`,
      [workosUserId, `canceled@${TEST_DOMAIN}`]
    );

    const ctx = await loadRelationshipContext(personId);

    // profile.company answers "what company is this person at?" with the
    // strict member predicate
    expect(ctx.profile.company?.name).toBe('Canceling Co');
    expect(ctx.profile.company?.is_member).toBe(false);

    // orgMemberships agrees: same predicate, same answer
    expect(ctx.orgMemberships).toHaveLength(1);
    expect(ctx.orgMemberships[0].is_paying_member).toBe(false);
  });

  it('orgMemberships surfaces every WorkOS org with role + seat_type + provisioning_source', async () => {
    const personId = await resolvePersonId({ email: `multi-org@${TEST_DOMAIN}` });
    const workosUserId = 'user_pm_multi_org';
    await query(
      `UPDATE person_relationships SET workos_user_id = $1 WHERE id = $2`,
      [workosUserId, personId]
    );
    await query(
      `INSERT INTO organizations (workos_organization_id, name, email_domain, subscription_status, created_at, updated_at)
       VALUES ($1, $2, $3, 'active', NOW(), NOW()), ($4, $5, $3, NULL, NOW(), NOW())
       ON CONFLICT (workos_organization_id) DO UPDATE SET subscription_status = EXCLUDED.subscription_status`,
      [
        'org_pm_multi_a',
        'Acme',
        TEST_DOMAIN,
        'org_pm_multi_b',
        'Other Co',
      ]
    );
    await query(
      `INSERT INTO organization_memberships
         (workos_user_id, workos_organization_id, email, role, seat_type, provisioning_source, created_at)
       VALUES
         ($1, 'org_pm_multi_a', $2, 'admin',  'contributor',     'verified_domain', NOW() - INTERVAL '90 days'),
         ($1, 'org_pm_multi_b', $2, 'member', 'community_only',  'invited',         NOW() - INTERVAL '7 days')
       ON CONFLICT (workos_user_id, workos_organization_id) DO NOTHING`,
      [workosUserId, `multi-org@${TEST_DOMAIN}`]
    );

    const ctx = await loadRelationshipContext(personId);
    expect(ctx.orgMemberships).toHaveLength(2);

    // Sorted by joined_at desc — Other Co (7 days) before Acme (90 days)
    expect(ctx.orgMemberships[0].org_name).toBe('Other Co');
    expect(ctx.orgMemberships[0].role).toBe('member');
    expect(ctx.orgMemberships[0].seat_type).toBe('community_only');
    expect(ctx.orgMemberships[0].provisioning_source).toBe('invited');
    expect(ctx.orgMemberships[0].is_paying_member).toBe(false);

    expect(ctx.orgMemberships[1].org_name).toBe('Acme');
    expect(ctx.orgMemberships[1].role).toBe('admin');
    expect(ctx.orgMemberships[1].seat_type).toBe('contributor');
    expect(ctx.orgMemberships[1].provisioning_source).toBe('verified_domain');
    expect(ctx.orgMemberships[1].is_paying_member).toBe(true);
    // Cleanup is handled by the file-level cleanup() helper (which knows
    // about the user_pm_% / org_pm_multi_% fixtures) so a mid-test failure
    // self-heals on the next run.
  });
});
