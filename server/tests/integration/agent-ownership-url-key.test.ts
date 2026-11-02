/**
 * #8322 — the ownership and badge predicates against real Postgres.
 *
 * After #8249/#7830 folded registry identity, `/mcp` and `/mcp/` are one
 * agent and every per-agent surface addresses it by the folded key — but an
 * owner's member profile may hold either spelling, and until this change the
 * admin profile writer kept minting the unfolded one. Matching the stored
 * `agents[].url` exactly then denied owners their own agent: no dashboard,
 * no compliance refresh, and badge fan-out revoking everything because the
 * membership org "did not exist".
 *
 * The unit tests pin which spellings each predicate asks for, but they mock
 * `query`, so they cannot catch a placeholder-count slip in a filter that is
 * spliced into a query which already binds an org id — and several of these
 * predicates swallow errors and return "not the owner", which is
 * indistinguishable from a correct denial. This runs the real SQL.
 *
 * The negative half matters as much as the positive one: the fold must widen
 * only which SPELLING of one agent a profile may hold, never which profile a
 * user may reach, and `declared_url` (the spec-exact AUTHORIZATION spelling,
 * #7829) must never decide identity.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

import { closeDatabase, initializeDatabase, query } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  canManageAgentForOrg,
  findOwnedAgentVisibility,
  findOwnerOrgForUser,
  findSoleOwnerOrgForUser,
  isOrgOwnerOfAgent,
} from '../../src/services/agent-ownership.js';
import { AgentContextDatabase } from '../../src/db/agent-context-db.js';
import { ComplianceDatabase } from '../../src/db/compliance-db.js';
import { runBadgeFanOut } from '../../src/services/badge-issuance.js';

const PREFIX = 'ownership_url_key_8322';
/** Owns the agent, profile holds the trailing-slash spelling. */
const SLASH_ORG = `org_${PREFIX}_slash`;
const SLASH_USER = `user_${PREFIX}_slash`;
/** Owns the agent, profile holds the folded key. */
const KEY_ORG = `org_${PREFIX}_key`;
const KEY_USER = `user_${PREFIX}_key`;
/** Registers a different agent entirely. */
const OTHER_ORG = `org_${PREFIX}_other`;
const OTHER_USER = `user_${PREFIX}_other`;

/** The folded registry identity key every per-agent surface uses (#7830). */
const FOLDED_URL = 'https://ownership-url-key.example.com/mcp';
/** The other spelling of the same agent, as a legacy profile row holds it. */
const STORED_SPELLING = 'https://ownership-url-key.example.com/mcp/';
/** A different agent that merely shares a prefix — must never be reached. */
const NEIGHBOUR_URL = 'https://ownership-url-key.example.com/mcp-two';

const ALL_ORGS = [SLASH_ORG, KEY_ORG, OTHER_ORG];
const ALL_USERS = [SLASH_USER, KEY_USER, OTHER_USER];

describe('agent ownership through the registry identity key (#8322)', () => {
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
    await pool.query('DELETE FROM member_profiles WHERE workos_organization_id = ANY($1)', [ALL_ORGS]);
    await pool.query('DELETE FROM organization_memberships WHERE workos_organization_id = ANY($1)', [ALL_ORGS]);
    await pool.query('DELETE FROM agent_contexts WHERE organization_id = ANY($1)', [ALL_ORGS]);
    await pool.query('DELETE FROM users WHERE workos_user_id = ANY($1)', [ALL_USERS]);
    await pool.query('DELETE FROM organizations WHERE workos_organization_id = ANY($1)', [ALL_ORGS]);
    await pool.query(
      'DELETE FROM agent_verification_badges WHERE agent_url = ANY($1)',
      [[FOLDED_URL, STORED_SPELLING, NEIGHBOUR_URL]],
    );
    await pool.query(
      'DELETE FROM agent_registry_metadata WHERE agent_url = ANY($1)',
      [[FOLDED_URL, STORED_SPELLING, NEIGHBOUR_URL]],
    );
    await pool.query(
      'DELETE FROM catalog_events WHERE entity_id = ANY($1)',
      [[FOLDED_URL, STORED_SPELLING, NEIGHBOUR_URL]],
    );
  }

  async function seedOwner(
    orgId: string,
    userId: string,
    agents: Array<Record<string, unknown>>,
    options: { role?: string; tier?: string; status?: string } = {},
  ) {
    await pool.query(
      `INSERT INTO organizations
         (workos_organization_id, name, is_personal, membership_tier, subscription_status, created_at, updated_at)
       VALUES ($1, $2, false, $3, $4, NOW(), NOW())
       ON CONFLICT (workos_organization_id) DO UPDATE
         SET membership_tier = EXCLUDED.membership_tier,
             subscription_status = EXCLUDED.subscription_status`,
      [orgId, `Owner ${orgId}`, options.tier ?? 'company_standard', options.status ?? 'active'],
    );
    await pool.query(
      `INSERT INTO users (workos_user_id, email, primary_organization_id)
       VALUES ($1, $2, $3) ON CONFLICT (workos_user_id) DO NOTHING`,
      [userId, `${userId}@ownership-url-key.test`, orgId],
    );
    await pool.query(
      `INSERT INTO organization_memberships
         (workos_user_id, workos_organization_id, role, email, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())`,
      [userId, orgId, options.role ?? 'admin', `${userId}@ownership-url-key.test`],
    );
    await pool.query(
      `INSERT INTO member_profiles
         (workos_organization_id, display_name, slug, is_public, agents, created_at, updated_at)
       VALUES ($1, $2, $3, false, $4::jsonb, NOW(), NOW())`,
      [orgId, `Owner ${orgId}`, `slug-${orgId}`, JSON.stringify(agents)],
    );
  }

  describe('an owner registered under the other spelling', () => {
    it('passes every ownership predicate for the folded agent', async () => {
      await seedOwner(SLASH_ORG, SLASH_USER, [
        { url: STORED_SPELLING, visibility: 'public', type: 'sales' },
      ]);

      await expect(findOwnerOrgForUser(SLASH_USER, FOLDED_URL)).resolves.toBe(SLASH_ORG);
      await expect(findSoleOwnerOrgForUser(SLASH_USER, FOLDED_URL)).resolves.toBe(SLASH_ORG);
      await expect(isOrgOwnerOfAgent(SLASH_ORG, SLASH_USER, FOLDED_URL)).resolves.toBe(true);
      await expect(canManageAgentForOrg(SLASH_ORG, SLASH_USER, FOLDED_URL)).resolves.toBe(true);
      await expect(findOwnedAgentVisibility(SLASH_USER, FOLDED_URL)).resolves.toBe('public');
    });

    it('passes them in the mirror direction too', async () => {
      // The profile holds the key; the caller arrives with the slash
      // spelling, which is what a publisher's adagents.json or an older
      // bookmark still says.
      await seedOwner(KEY_ORG, KEY_USER, [
        { url: FOLDED_URL, visibility: 'members_only', type: 'sales' },
      ]);

      await expect(findOwnerOrgForUser(KEY_USER, STORED_SPELLING)).resolves.toBe(KEY_ORG);
      await expect(isOrgOwnerOfAgent(KEY_ORG, KEY_USER, STORED_SPELLING)).resolves.toBe(true);
      await expect(canManageAgentForOrg(KEY_ORG, KEY_USER, STORED_SPELLING)).resolves.toBe(true);
      await expect(findOwnedAgentVisibility(KEY_USER, STORED_SPELLING)).resolves.toBe('members_only');
    });

    it('stays a sole owner when its profile holds both spellings', async () => {
      await seedOwner(SLASH_ORG, SLASH_USER, [
        { url: FOLDED_URL, visibility: 'private', type: 'sales' },
        { url: STORED_SPELLING, visibility: 'public', type: 'sales' },
      ]);

      // DISTINCT collapses the two rows; the fold must not turn one owner
      // into the ambiguous multi-org case that fails closed.
      await expect(findSoleOwnerOrgForUser(SLASH_USER, FOLDED_URL)).resolves.toBe(SLASH_ORG);
      // The most permissive listing wins, deterministically, so the caller's
      // public-event decision does not flip between runs.
      await expect(findOwnedAgentVisibility(SLASH_USER, FOLDED_URL)).resolves.toBe('public');
    });
  });

  describe('the fold does not widen who reaches whose agent', () => {
    it('gives a different org nothing over the org that owns the agent', async () => {
      await seedOwner(KEY_ORG, KEY_USER, [{ url: FOLDED_URL, visibility: 'public' }]);
      // A second org registers the OTHER spelling of the same agent. That is
      // a co-claim, exactly as if it had registered the identical spelling —
      // it must not hand its member any authority inside KEY_ORG.
      await seedOwner(SLASH_ORG, SLASH_USER, [{ url: STORED_SPELLING, visibility: 'public' }]);

      await expect(isOrgOwnerOfAgent(KEY_ORG, SLASH_USER, FOLDED_URL)).resolves.toBe(false);
      await expect(canManageAgentForOrg(KEY_ORG, SLASH_USER, FOLDED_URL)).resolves.toBe(false);
      await expect(isOrgOwnerOfAgent(SLASH_ORG, KEY_USER, FOLDED_URL)).resolves.toBe(false);
    });

    it('fails closed when one user belongs to both co-claiming orgs', async () => {
      await seedOwner(KEY_ORG, KEY_USER, [{ url: FOLDED_URL, visibility: 'public' }]);
      await seedOwner(SLASH_ORG, SLASH_USER, [{ url: STORED_SPELLING, visibility: 'public' }]);
      // The two orgs hold DIFFERENT spellings, so only the fold makes this
      // user's lookup ambiguous at all. It must fail closed rather than pick
      // one tenant — choosing either would select the wrong encryption
      // context for a credential-bearing route.
      await pool.query(
        `INSERT INTO organization_memberships
           (workos_user_id, workos_organization_id, role, email, created_at, updated_at)
         VALUES ($1, $2, 'admin', $3, NOW(), NOW())`,
        [SLASH_USER, KEY_ORG, `${SLASH_USER}@ownership-url-key.test`],
      );

      await expect(findSoleOwnerOrgForUser(SLASH_USER, FOLDED_URL)).resolves.toBeNull();
      // The explicit-org path still answers, scoped to the org that was named.
      await expect(isOrgOwnerOfAgent(SLASH_ORG, SLASH_USER, FOLDED_URL)).resolves.toBe(true);
      await expect(isOrgOwnerOfAgent(KEY_ORG, SLASH_USER, FOLDED_URL)).resolves.toBe(true);
      await expect(isOrgOwnerOfAgent(OTHER_ORG, SLASH_USER, FOLDED_URL)).resolves.toBe(false);
    });

    it('gives a user with no owning org nothing', async () => {
      await seedOwner(SLASH_ORG, SLASH_USER, [{ url: STORED_SPELLING, visibility: 'public' }]);
      await seedOwner(OTHER_ORG, OTHER_USER, [{ url: NEIGHBOUR_URL, visibility: 'public' }]);

      await expect(findOwnerOrgForUser(OTHER_USER, FOLDED_URL)).resolves.toBeNull();
      await expect(findOwnedAgentVisibility(OTHER_USER, FOLDED_URL)).resolves.toBeNull();
      await expect(canManageAgentForOrg(OTHER_ORG, OTHER_USER, FOLDED_URL)).resolves.toBe(false);
    });

    it('never reaches a different agent that shares the URL prefix', async () => {
      await seedOwner(OTHER_ORG, OTHER_USER, [{ url: NEIGHBOUR_URL, visibility: 'public' }]);

      await expect(findOwnerOrgForUser(OTHER_USER, FOLDED_URL)).resolves.toBeNull();
      await expect(isOrgOwnerOfAgent(OTHER_ORG, OTHER_USER, FOLDED_URL)).resolves.toBe(false);
    });

    it('never resolves ownership through declared_url', async () => {
      // `declared_url` is the spec-exact AUTHORIZATION spelling (#7829). If
      // identity could be read from it, a member could claim their own agent
      // under `url` and someone else's under `declared_url`.
      await seedOwner(OTHER_ORG, OTHER_USER, [
        { url: NEIGHBOUR_URL, declared_url: FOLDED_URL, visibility: 'public' },
      ]);

      await expect(findOwnerOrgForUser(OTHER_USER, FOLDED_URL)).resolves.toBeNull();
      await expect(findOwnedAgentVisibility(OTHER_USER, FOLDED_URL)).resolves.toBeNull();
      await expect(isOrgOwnerOfAgent(OTHER_ORG, OTHER_USER, FOLDED_URL)).resolves.toBe(false);
    });

    it('keeps the organization-role requirement on the mutation-grade check', async () => {
      await seedOwner(SLASH_ORG, SLASH_USER, [{ url: STORED_SPELLING }], { role: 'member' });

      await expect(isOrgOwnerOfAgent(SLASH_ORG, SLASH_USER, FOLDED_URL)).resolves.toBe(true);
      await expect(canManageAgentForOrg(SLASH_ORG, SLASH_USER, FOLDED_URL)).resolves.toBe(false);
    });
  });

  describe('badge issuance and owner credentials', () => {
    function stubComplianceDb() {
      const upserts: any[] = [];
      return {
        db: {
          getRegistryMetadata: vi.fn().mockResolvedValue(null),
          getBadgesForAgent: vi.fn().mockResolvedValue([]),
          getStoryboardStatuses: vi.fn().mockResolvedValue([{
            storyboard_id: 'sales_broadcast_tv',
            status: 'passing',
            steps_passed: 5,
            steps_total: 5,
          }]),
          upsertBadge: vi.fn().mockImplementation((b: any) => {
            upserts.push(b);
            return Promise.resolve({ ...b, status: 'active' });
          }),
          degradeBadge: vi.fn().mockResolvedValue(true),
          revokeBadge: vi.fn().mockResolvedValue(true),
          revokeAllBadges: vi.fn().mockResolvedValue([]),
          revokeAllBadgesIfOptedOut: vi.fn().mockResolvedValue([]),
        } as any,
        upserts,
      };
    }

    it('resolves the membership org for an owner holding the other spelling', async () => {
      await seedOwner(SLASH_ORG, SLASH_USER, [{ url: STORED_SPELLING, visibility: 'public' }]);
      const { db, upserts } = stubComplianceDb();

      const result = await runBadgeFanOut({
        complianceDb: db,
        agentUrl: FOLDED_URL,
        declaredSpecialisms: ['sales-broadcast-tv'],
        adcpVersions: ['3.0'],
      });

      expect(result.issued.length).toBeGreaterThan(0);
      expect(upserts[0].membership_org_id).toBe(SLASH_ORG);
    });

    it('keeps the badge membership org on the profile that holds the key', async () => {
      // Two orgs co-claim. `membership_org_id` is stamped on every badge
      // this issues, so the fold must not move it: the profile holding the
      // folded key wins even when a sibling-spelling profile is older.
      await seedOwner(SLASH_ORG, SLASH_USER, [{ url: STORED_SPELLING, visibility: 'public' }]);
      await pool.query(
        `UPDATE member_profiles SET created_at = NOW() - INTERVAL '10 years'
         WHERE workos_organization_id = $1`,
        [SLASH_ORG],
      );
      await seedOwner(KEY_ORG, KEY_USER, [{ url: FOLDED_URL, visibility: 'public' }]);
      const { db, upserts } = stubComplianceDb();

      await runBadgeFanOut({
        complianceDb: db,
        agentUrl: FOLDED_URL,
        declaredSpecialisms: ['sales-broadcast-tv'],
        adcpVersions: ['3.0'],
      });

      expect(upserts[0].membership_org_id).toBe(KEY_ORG);
    });

    it('still finds no membership org for an agent nobody registered', async () => {
      await seedOwner(OTHER_ORG, OTHER_USER, [{ url: NEIGHBOUR_URL, visibility: 'public' }]);
      const { db, upserts } = stubComplianceDb();

      await runBadgeFanOut({
        complianceDb: db,
        agentUrl: FOLDED_URL,
        declaredSpecialisms: ['sales-broadcast-tv'],
        adcpVersions: ['3.0'],
      });

      expect(upserts).toHaveLength(0);
    });

    it('resolves owner auth saved by the org holding the other spelling', async () => {
      await seedOwner(SLASH_ORG, SLASH_USER, [{ url: STORED_SPELLING, visibility: 'public' }]);
      await pool.query(
        `INSERT INTO agent_contexts (organization_id, agent_url, auth_token_encrypted, auth_token_iv)
         VALUES ($1, $2, 'ciphertext', 'iv')`,
        [SLASH_ORG, FOLDED_URL],
      );

      await expect(new ComplianceDatabase().hasOwnerAuth(FOLDED_URL)).resolves.toBe(true);
    });

    it('resolves owner auth when the caller arrives with the other spelling', async () => {
      // The heartbeat is fed agent URLs straight out of
      // `member_profiles.agents` (`getAgentsDueForCheck`), so it can call
      // with `/mcp/` while `agent_contexts` holds the keyed `/mcp`. Binding
      // one spelling to `ac.agent_url` dropped the owner's credential and
      // the probe went out anonymous — the same owner-denied outcome this
      // change exists to close, on the one half that was left exact.
      await seedOwner(SLASH_ORG, SLASH_USER, [{ url: STORED_SPELLING, visibility: 'public' }]);
      await pool.query(
        `INSERT INTO agent_contexts (organization_id, agent_url, auth_token_encrypted, auth_token_iv)
         VALUES ($1, $2, 'ciphertext', 'iv')`,
        [SLASH_ORG, FOLDED_URL],
      );

      await expect(new ComplianceDatabase().hasOwnerAuth(STORED_SPELLING)).resolves.toBe(true);
    });

    it('lets the crawler find owner credentials for the other spelling', async () => {
      await seedOwner(SLASH_ORG, SLASH_USER, [{ url: STORED_SPELLING, visibility: 'public' }]);
      await pool.query(
        `INSERT INTO agent_contexts (organization_id, agent_url, auth_token_encrypted, auth_token_iv)
         VALUES ($1, $2, 'ciphertext', 'iv')`,
        [SLASH_ORG, FOLDED_URL],
      );

      await expect(new AgentContextDatabase().findOwnerOrgWithSavedAuth(FOLDED_URL))
        .resolves.toBe(SLASH_ORG);
    });

    it('does not lend crawler credentials across organizations', async () => {
      await seedOwner(OTHER_ORG, OTHER_USER, [{ url: NEIGHBOUR_URL, visibility: 'public' }]);
      await pool.query(
        `INSERT INTO agent_contexts (organization_id, agent_url, auth_token_encrypted, auth_token_iv)
         VALUES ($1, $2, 'ciphertext', 'iv')`,
        [OTHER_ORG, FOLDED_URL],
      );

      await expect(new AgentContextDatabase().findOwnerOrgWithSavedAuth(FOLDED_URL))
        .resolves.toBeNull();
    });

    it('does not lend owner auth across organizations', async () => {
      // The credential belongs to OTHER_ORG, which registered a different
      // agent. Folding the ownership half must not detach the credential
      // from the organization that saved it.
      await seedOwner(OTHER_ORG, OTHER_USER, [{ url: NEIGHBOUR_URL, visibility: 'public' }]);
      await pool.query(
        `INSERT INTO agent_contexts (organization_id, agent_url, auth_token_encrypted, auth_token_iv)
         VALUES ($1, $2, 'ciphertext', 'iv')`,
        [OTHER_ORG, FOLDED_URL],
      );

      await expect(new ComplianceDatabase().hasOwnerAuth(FOLDED_URL)).resolves.toBe(false);
    });
  });

  describe('the public-effect gates fold the same way', () => {
    it('emits the public verification-lost event for an agent listed under the other spelling', async () => {
      await seedOwner(SLASH_ORG, SLASH_USER, [{ url: STORED_SPELLING, visibility: 'public' }]);
      await pool.query(
        `INSERT INTO agent_verification_badges (agent_url, role, adcp_version, status, membership_org_id)
         VALUES ($1, 'media-buy', '3.0', 'active', $2)`,
        [FOLDED_URL, SLASH_ORG],
      );

      const transition = await new ComplianceDatabase().setComplianceOptOut(
        FOLDED_URL,
        true,
        `user:${SLASH_USER}`,
        true,
      );

      expect(transition.revoked).toHaveLength(1);
      const events = await query(
        `SELECT event_type FROM catalog_events WHERE entity_id = $1`,
        [FOLDED_URL],
      );
      expect(events.rows.map((r: any) => r.event_type)).toEqual(['agent.verification_lost']);
    });

    it('stays silent for an agent no owner listed publicly', async () => {
      await seedOwner(SLASH_ORG, SLASH_USER, [{ url: STORED_SPELLING, visibility: 'private' }]);
      await pool.query(
        `INSERT INTO agent_verification_badges (agent_url, role, adcp_version, status, membership_org_id)
         VALUES ($1, 'media-buy', '3.0', 'active', $2)`,
        [FOLDED_URL, SLASH_ORG],
      );

      await new ComplianceDatabase().setComplianceOptOut(FOLDED_URL, true, `user:${SLASH_USER}`, true);

      const events = await query(
        `SELECT event_type FROM catalog_events WHERE entity_id = $1`,
        [FOLDED_URL],
      );
      expect(events.rows).toHaveLength(0);
    });
  });
});
