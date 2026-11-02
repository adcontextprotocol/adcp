/**
 * #8321 — the notification owner lookup, against real Postgres.
 *
 * The unit test for this (tests/unit/compliance-notification-owner-spelling.ts)
 * mocks `query`, so it pins which spellings are asked for but cannot catch a
 * placeholder-count slip, a bad `::text[]` cast, or an `ORDER BY`/`DISTINCT`
 * that Postgres rejects — and both notifier queries swallow every error and
 * return "no owner", which is indistinguishable from a correct silence. This
 * runs the real SQL against real rows so that class of failure is caught.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

vi.hoisted(() => {
  process.env.REGISTRY_EDITS_CHANNEL_ID = 'C_REGISTRY_EDITS_IT';
});

vi.mock('../../src/notifications/notification-service.js', () => ({
  notifyUser: vi.fn(async () => undefined),
}));
vi.mock('../../src/slack/client.js', () => ({
  sendChannelMessage: vi.fn(async () => undefined),
  isSlackConfigured: () => true,
}));

import { closeDatabase, initializeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  notifyComplianceChange,
  notifyComplianceTimeout,
  notifyVerificationChange,
} from '../../src/notifications/compliance.js';
import { notifyUser } from '../../src/notifications/notification-service.js';
import { sendChannelMessage } from '../../src/slack/client.js';

const mockedNotifyUser = vi.mocked(notifyUser);
const mockedSendChannelMessage = vi.mocked(sendChannelMessage);

const PREFIX = 'owner_url_key_8321';
const SLASH_ORG = `org_${PREFIX}_slash`;
const KEY_ORG = `org_${PREFIX}_key`;
const OTHER_ORG = `org_${PREFIX}_other`;
const SLASH_USER = `user_${PREFIX}_slash`;
const KEY_USER = `user_${PREFIX}_key`;
const OTHER_USER = `user_${PREFIX}_other`;

/** The folded registry identity key the heartbeat reports (#7830). */
const FOLDED_URL = 'https://owner-url-key.example.com/mcp';
/** The other spelling of the same agent, as a legacy profile row holds it. */
const STORED_SPELLING = 'https://owner-url-key.example.com/mcp/';
/** A different agent that merely shares a prefix — must never be reached. */
const NEIGHBOUR_URL = 'https://owner-url-key.example.com/mcp-two';

describe('resolveAgentOwnerUserIds against Postgres (#8321)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
  }, 120_000);

  afterAll(async () => {
    await cleanup();
    await closeDatabase();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await cleanup();
  });

  async function cleanup() {
    if (!pool) return;
    const orgs = [SLASH_ORG, KEY_ORG, OTHER_ORG];
    await pool.query('DELETE FROM member_profiles WHERE workos_organization_id = ANY($1)', [orgs]);
    await pool.query('DELETE FROM organization_memberships WHERE workos_organization_id = ANY($1)', [orgs]);
    await pool.query('DELETE FROM users WHERE workos_user_id = ANY($1)', [[SLASH_USER, KEY_USER, OTHER_USER]]);
    await pool.query('DELETE FROM organizations WHERE workos_organization_id = ANY($1)', [orgs]);
    await pool.query('DELETE FROM notifications WHERE recipient_user_id = ANY($1)', [[SLASH_USER, KEY_USER, OTHER_USER]]);
  }

  async function seedOwner(
    orgId: string,
    userId: string,
    agents: Array<{ url: string; visibility?: string }>,
  ) {
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, is_personal, created_at, updated_at)
       VALUES ($1, $2, false, NOW(), NOW())
       ON CONFLICT (workos_organization_id) DO NOTHING`,
      [orgId, `Owner ${orgId}`],
    );
    await pool.query(
      `INSERT INTO users (workos_user_id, email, primary_organization_id)
       VALUES ($1, $2, $3) ON CONFLICT (workos_user_id) DO NOTHING`,
      [userId, `${userId}@owner-url-key.test`, orgId],
    );
    await pool.query(
      `INSERT INTO organization_memberships
         (workos_user_id, workos_organization_id, role, email, created_at, updated_at)
       VALUES ($1, $2, 'admin', $3, NOW(), NOW())`,
      [userId, orgId, `${userId}@owner-url-key.test`],
    );
    await pool.query(
      `INSERT INTO member_profiles
         (workos_organization_id, display_name, slug, is_public, agents, created_at, updated_at)
       VALUES ($1, $2, $3, false, $4::jsonb, NOW(), NOW())`,
      [
        orgId,
        `Owner ${orgId}`,
        `slug-${orgId}`,
        JSON.stringify(agents.map((a) => ({ visibility: 'private', ...a }))),
      ],
    );
  }

  function recipients(): string[] {
    return mockedNotifyUser.mock.calls
      .map((call) => (call[0] as { recipientUserId: string }).recipientUserId)
      .sort();
  }

  it('reaches a profile holding the trailing-slash spelling of the folded agent', async () => {
    await seedOwner(SLASH_ORG, SLASH_USER, [{ url: STORED_SPELLING }]);

    await notifyComplianceTimeout({ agentUrl: FOLDED_URL, summary: 'timed out' });

    expect(recipients()).toEqual([SLASH_USER]);
  });

  it('reaches a profile holding the folded key when the caller has the other spelling', async () => {
    await seedOwner(KEY_ORG, KEY_USER, [{ url: FOLDED_URL }]);

    await notifyComplianceTimeout({ agentUrl: STORED_SPELLING, summary: 'timed out' });

    expect(recipients()).toEqual([KEY_USER]);
  });

  it('reaches both orgs when each registered a different spelling of one agent', async () => {
    await seedOwner(SLASH_ORG, SLASH_USER, [{ url: STORED_SPELLING }]);
    await seedOwner(KEY_ORG, KEY_USER, [{ url: FOLDED_URL }]);

    await notifyComplianceChange({
      agentUrl: FOLDED_URL,
      previousStatus: 'passing',
      currentStatus: 'failing',
      headline: 'Two storyboards failing.',
      tracksJson: [{ track: 'media-buy', status: 'fail' }],
    });

    expect(recipients()).toEqual([KEY_USER, SLASH_USER].sort());
  });

  it('never reaches an org that registered a different agent sharing the prefix', async () => {
    await seedOwner(OTHER_ORG, OTHER_USER, [{ url: NEIGHBOUR_URL }]);

    await notifyComplianceTimeout({ agentUrl: FOLDED_URL, summary: 'timed out' });

    expect(recipients()).toEqual([]);
  });

  it('treats the trailing-slash spelling as public for the shared-channel post', async () => {
    await seedOwner(SLASH_ORG, SLASH_USER, [{ url: STORED_SPELLING, visibility: 'public' }]);

    await notifyVerificationChange({
      agentUrl: FOLDED_URL,
      issued: [{ role: 'sales', specialisms: ['media-buy'] }],
      revoked: [],
      emitFeedEvents: false,
    });

    expect(mockedSendChannelMessage).toHaveBeenCalledTimes(1);
    expect(recipients()).toEqual([SLASH_USER]);
  });

  it('keeps a private agent out of the shared channel', async () => {
    await seedOwner(SLASH_ORG, SLASH_USER, [{ url: STORED_SPELLING, visibility: 'private' }]);

    await notifyVerificationChange({
      agentUrl: FOLDED_URL,
      issued: [{ role: 'sales', specialisms: ['media-buy'] }],
      revoked: [],
      emitFeedEvents: false,
    });

    expect(mockedSendChannelMessage).not.toHaveBeenCalled();
    expect(recipients()).toEqual([SLASH_USER]);
  });
});
