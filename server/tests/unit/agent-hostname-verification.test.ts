/**
 * Unit tests for the agent-hostname verification helper.
 *
 * Catches the escalation-#340 failure mode: an org registering an agent
 * on a domain it does not own. Helper compares the agent URL's hostname
 * against `organization_domains` rows marked `verified = true` for the
 * caller's org. Exact-or-subdomain match passes; no-claim orgs return a
 * distinct status so the caller can decide whether to enforce.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from 'vitest';
import type { Pool } from 'pg';
import { initializeDatabase, closeDatabase, getPool } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  verifyAgentHostname,
  buildUnverifiedHostnameMessage,
} from '../../src/services/agent-hostname-verification.js';

const TEST_PREFIX = 'org_agent_hostname_verify';

describe('verifyAgentHostname', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString:
        process.env.DATABASE_URL ||
        'postgresql://adcp:localdev@localhost:5432/adcp_registry',
      max: 5,
    });
    await runMigrations();
  });

  afterAll(async () => {
    await pool.query(
      `DELETE FROM organization_domains WHERE workos_organization_id LIKE $1`,
      [`${TEST_PREFIX}%`],
    );
    await pool.query(
      `DELETE FROM organizations WHERE workos_organization_id LIKE $1`,
      [`${TEST_PREFIX}%`],
    );
    await closeDatabase();
  });

  beforeEach(async () => {
    await pool.query(
      `DELETE FROM organization_domains WHERE workos_organization_id LIKE $1`,
      [`${TEST_PREFIX}%`],
    );
    await pool.query(
      `DELETE FROM organizations WHERE workos_organization_id LIKE $1`,
      [`${TEST_PREFIX}%`],
    );
  });

  async function seedOrg(orgId: string, domains: Array<{ domain: string; verified: boolean }>) {
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, is_personal, created_at, updated_at)
       VALUES ($1, $2, true, NOW(), NOW())
       ON CONFLICT (workos_organization_id) DO NOTHING`,
      [orgId, `Test ${orgId}`],
    );
    for (const d of domains) {
      await pool.query(
        `INSERT INTO organization_domains
           (workos_organization_id, domain, verified, source, created_at, updated_at)
         VALUES ($1, $2, $3, 'test', NOW(), NOW())
         ON CONFLICT (domain) DO UPDATE SET
           workos_organization_id = EXCLUDED.workos_organization_id,
           verified = EXCLUDED.verified`,
        [orgId, d.domain, d.verified],
      );
    }
  }

  it('accepts when hostname exactly matches a verified domain', async () => {
    const orgId = `${TEST_PREFIX}_exact`;
    await seedOrg(orgId, [{ domain: 'foo.example.com', verified: true }]);

    const res = await verifyAgentHostname(orgId, 'https://foo.example.com/mcp');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.verified_domain).toBe('foo.example.com');
      expect(res.agent_hostname).toBe('foo.example.com');
    }
  });

  it('accepts when hostname is a subdomain of a verified domain', async () => {
    const orgId = `${TEST_PREFIX}_subdomain`;
    await seedOrg(orgId, [{ domain: 'example.com', verified: true }]);

    const res = await verifyAgentHostname(
      orgId,
      'https://apx.sales-agent.example.com/mcp',
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.verified_domain).toBe('example.com');
  });

  it('rejects when hostname is on a totally different domain', async () => {
    const orgId = `${TEST_PREFIX}_other_domain`;
    await seedOrg(orgId, [{ domain: 'adzymic.co', verified: true }]);

    const res = await verifyAgentHostname(
      orgId,
      'https://adcp-mcp.celtra.com/mcp',
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('hostname_not_in_verified_domains');
      expect(res.agent_hostname).toBe('adcp-mcp.celtra.com');
      expect(res.verified_domains).toEqual(['adzymic.co']);
    }
  });

  it('rejects sibling-domain attack (example.org vs example.com)', async () => {
    // suffix-match defense: hostname.endsWith('.' + d) must use the dot
    // prefix; without it, "evilexample.com" would match "example.com".
    const orgId = `${TEST_PREFIX}_sibling`;
    await seedOrg(orgId, [{ domain: 'example.com', verified: true }]);

    const res = await verifyAgentHostname(orgId, 'https://evilexample.com/mcp');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('hostname_not_in_verified_domains');
  });

  // Hard-reject when no verified domains exist. The earlier MVP fell
  // back to `organizations.email_domain`, but the security review on
  // #4648 surfaced that `email_domain` can be written from an
  // unverified WorkOS domain (via `/api/me/brand-claim/issue` →
  // `organization.updated` webhook) — an attacker could claim someone
  // else's domain and pass the soft-pass. Fallback removed; only
  // `organization_domains.verified = true` rows count.
  it('rejects when org has no verified domains (even if email_domain is set)', async () => {
    const orgId = `${TEST_PREFIX}_no_claim`;
    await seedOrg(orgId, []);
    // Set email_domain to a corporate-looking domain — must STILL be
    // rejected because email_domain isn't a trustworthy claim.
    await pool.query(
      `UPDATE organizations SET email_domain = $1 WHERE workos_organization_id = $2`,
      ['acme.example', orgId],
    );

    const res = await verifyAgentHostname(orgId, 'https://mcp.acme.example/agent');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('no_verified_domains');
      expect(res.verified_domains).toEqual([]);
    }
  });

  it('ignores unverified organization_domains rows', async () => {
    // Unverified domains are claims-in-progress, not yet trustworthy;
    // they must NOT match the agent hostname for verification purposes.
    const orgId = `${TEST_PREFIX}_unverified`;
    await seedOrg(orgId, [{ domain: 'example.com', verified: false }]);

    const res = await verifyAgentHostname(orgId, 'https://x.example.com/mcp');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('no_verified_domains');
  });

  it('returns invalid_url for an unparseable URL', async () => {
    const orgId = `${TEST_PREFIX}_bad_url`;
    await seedOrg(orgId, [{ domain: 'example.com', verified: true }]);

    const res = await verifyAgentHostname(orgId, 'not a url');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('invalid_url');
  });

  it('is case-insensitive on both hostname and verified domain', async () => {
    const orgId = `${TEST_PREFIX}_case`;
    await seedOrg(orgId, [{ domain: 'Example.COM', verified: true }]);

    const res = await verifyAgentHostname(orgId, 'https://API.example.com/mcp');
    expect(res.ok).toBe(true);
    // Result must be lowercased — callers build user-facing copy from
    // these fields, and mixed-case leaks the raw DB casing.
    if (res.ok) {
      expect(res.verified_domain).toBe('example.com');
      expect(res.agent_hostname).toBe('api.example.com');
    }
  });
});

describe('buildUnverifiedHostnameMessage', () => {
  it('produces a helpful message for the common mismatch case', () => {
    const msg = buildUnverifiedHostnameMessage({
      ok: false,
      reason: 'hostname_not_in_verified_domains',
      agent_hostname: 'rogue.example.com',
      verified_domains: ['foo.com', 'bar.com'],
    });
    expect(msg).toContain('rogue.example.com');
    expect(msg).toContain('foo.com, bar.com');
    expect(msg.toLowerCase()).toContain('linked domains');
  });

  it('produces a distinct message for orgs with no verified domains', () => {
    const msg = buildUnverifiedHostnameMessage({
      ok: false,
      reason: 'no_verified_domains',
      agent_hostname: 'x.example.com',
      verified_domains: [],
    });
    expect(msg).toContain('no verified domains');
    expect(msg).toContain('Linked Domains');
  });

  it('produces a distinct message for invalid URLs', () => {
    const msg = buildUnverifiedHostnameMessage({
      ok: false,
      reason: 'invalid_url',
      agent_hostname: '',
      verified_domains: [],
    });
    expect(msg).toContain('Invalid');
  });
});
