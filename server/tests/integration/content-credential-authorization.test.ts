import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

// Exercise real committee grants and content mutations, independently of the
// platform-admin bypass and external notification/analytics providers.
vi.mock('../../src/addie/admin-status-lookup.js', () => ({
  isAuthenticatedUserAAOAdmin: vi.fn(async () => false),
  isWebUserAAOAdmin: vi.fn(async () => false),
}));
vi.mock('../../src/addie/mcp/admin-tools.js', () => ({
  isWebUserAAOAdmin: vi.fn(async () => false),
}));
vi.mock('../../src/services/membership-tiers.js', () => ({
  checkContentSubmissionTier: vi.fn(async () => true),
}));
vi.mock('../../src/notifications/slack.js', () => ({
  notifyPublishedPost: vi.fn(async () => undefined),
  sendSocialAmplificationDM: vi.fn(async () => undefined),
}));
vi.mock('../../src/db/system-settings-db.js', () => ({
  getEditorialChannel: vi.fn(async () => null),
}));
vi.mock('../../src/db/community-db.js', () => ({
  CommunityDatabase: class {
    async awardPoints() {}
    async checkAndAwardBadges() {}
  },
}));
vi.mock('../../src/db/escalation-db.js', () => ({
  resolveEscalationsForPerspective: vi.fn(async () => []),
}));
vi.mock('../../src/services/posthog-query.js', () => ({
  fetchPathPageviewCounts: vi.fn(async () => new Map()),
}));

import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  approveContentForUser,
  listPendingContentForUser,
  proposeContentForUser,
  rejectContentForUser,
  requestRevisionsForUser,
  type ContentUser,
} from '../../src/routes/content.js';
import { listMyContent } from '../../src/services/my-content-service.js';

describe('Content committee authority belongs to the authenticated credential', () => {
  const leaderId = 'user_content_credential_leader';
  const nonLeaderId = 'user_content_credential_nonleader';
  const authorId = 'user_content_credential_author';
  const slug = 'content-credential-authorization';
  let pool: Pool;
  let committeeId: string;
  let contentId: string;

  beforeAll(async () => {
    pool = initializeDatabase({ connectionString: process.env.DATABASE_URL });
    await runMigrations();
    for (const userId of [leaderId, nonLeaderId, authorId]) {
      await pool.query(
        `INSERT INTO users (workos_user_id, email) VALUES ($1, $2)
         ON CONFLICT (workos_user_id) DO NOTHING`,
        [userId, `${userId}@example.com`],
      );
    }
    const group = await pool.query(
      `INSERT INTO working_groups (name, slug, accepts_public_submissions)
       VALUES ('Content credential test', $1, true) RETURNING id`, [slug],
    );
    committeeId = group.rows[0].id;
    await pool.query(
      `INSERT INTO working_group_leaders (working_group_id, user_id) VALUES ($1, $2)`,
      [committeeId, leaderId],
    );
  }, 30000);

  async function deleteContent() {
    await pool.query(
      `DELETE FROM content_authors WHERE perspective_id IN
       (SELECT id FROM perspectives WHERE working_group_id = $1)`, [committeeId],
    );
    await pool.query('DELETE FROM perspectives WHERE working_group_id = $1', [committeeId]);
  }

  beforeEach(async () => {
    await deleteContent();
    const row = await pool.query(
      `INSERT INTO perspectives (slug, title, content_type, status, working_group_id, proposer_user_id)
       VALUES ($1, 'Pending committee content', 'link', 'pending_review', $2, $3) RETURNING id`,
      [slug, committeeId, authorId],
    );
    contentId = row.rows[0].id;
  });

  afterAll(async () => {
    if (committeeId) {
      await deleteContent();
      await pool.query('DELETE FROM working_group_leaders WHERE working_group_id = $1', [committeeId]);
      await pool.query('DELETE FROM working_groups WHERE id = $1', [committeeId]);
    }
    await pool.query('DELETE FROM users WHERE workos_user_id = ANY($1)', [[leaderId, nonLeaderId, authorId]]);
    await closeDatabase();
  });

  const identities = [
    { label: 'authenticated leader linked to non-leader canonical', canonical: nonLeaderId, credential: leaderId, allowed: true },
    { label: 'authenticated non-leader linked to leader canonical', canonical: leaderId, credential: nonLeaderId, allowed: false },
    { label: 'person-only context with a leader canonical', canonical: leaderId, credential: null, allowed: false },
  ];

  describe.each(identities)('$label', ({ canonical, credential, allowed }) => {
    const user: ContentUser = {
      id: canonical,
      adminPrincipal: credential === null ? null : {
        id: canonical,
        authWorkosUserId: credential,
        email: `${credential}@example.com`,
      },
    };

    it('uses only credential leadership for pending review visibility', async () => {
      const result = await listPendingContentForUser(user, { committeeSlug: slug });
      expect(result.items.map(item => item.id)).toEqual(allowed ? [contentId] : []);
    });

    it('uses only credential leadership for committee owner content', async () => {
      const result = await listMyContent({
        userId: canonical,
        adminPrincipal: user.adminPrincipal,
        collection: slug,
        relationship: 'owner',
      });
      expect(result.items.map(item => item.id)).toEqual(allowed ? [contentId] : []);
    });

    it('requires credential leadership to publish a proposal directly', async () => {
      const result = await proposeContentForUser(user, {
        title: 'Credential proposal', content_type: 'link',
        external_url: 'https://example.com/article',
        collection: { committee_slug: slug }, status: 'published',
      });
      expect(result.success).toBe(true);
      expect(result.status).toBe(allowed ? 'published' : 'pending_review');
      const persisted = await pool.query('SELECT status, proposer_user_id FROM perspectives WHERE id = $1', [result.id]);
      expect(persisted.rows[0]).toEqual({ status: result.status, proposer_user_id: canonical });
    });

    const actions = [
      { name: 'approve', run: (u: ContentUser, id: string) => approveContentForUser(u, id, { publishImmediately: false }), status: 'draft' },
      { name: 'reject', run: (u: ContentUser, id: string) => rejectContentForUser(u, id, 'Requires revision'), status: 'rejected' },
      { name: 'request revisions', run: (u: ContentUser, id: string) => requestRevisionsForUser(u, id, 'Please revise'), status: 'needs_revisions' },
    ];
    it.each(actions)('requires credential leadership to $name', async ({ run, status }) => {
      const result = await run(user, contentId);
      expect(result.success).toBe(allowed);
      if (!allowed) expect(result.error).toBe('permission_denied');
      const persisted = await pool.query('SELECT status, reviewed_at FROM perspectives WHERE id = $1', [contentId]);
      expect(persisted.rows[0].status).toBe(allowed ? status : 'pending_review');
      expect(persisted.rows[0].reviewed_at !== null).toBe(allowed);
    });
  });
});
