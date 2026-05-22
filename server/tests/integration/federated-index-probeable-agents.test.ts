/**
 * Integration test for FederatedIndexService.listAllProbeableAgents
 * (adcp#4849). The crawler's periodic probe loop iterates this set,
 * so agents missing from it never get health/capability refresh.
 *
 * Pre-#4849, the periodic probe only walked member-profile-registered
 * agents. Manager-file-only agents (like interchange.io, named only in
 * cafemedia.com's selector with no seed-set registration) were never
 * touched. This test pins the union behavior so a future regression
 * to listAllAgents-only is caught.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { FederatedIndexService } from '../../src/federated-index.js';

const RUN_SUFFIX = Math.random().toString(36).slice(2, 8);
const AGENT_ADAGENTS = `https://adagents-${RUN_SUFFIX}.probeable.example`;
const AGENT_CLAIM = `https://claim-${RUN_SUFFIX}.probeable.example`;
const AGENT_REGISTERED = `https://registered-${RUN_SUFFIX}.probeable.example`;
const ORG_ID = `org_test_probe_${RUN_SUFFIX}`;
const PROFILE_SLUG = `probe-${RUN_SUFFIX}`;

describe('FederatedIndexService.listAllProbeableAgents (adcp#4849)', () => {
  let pool: Pool;
  let svc: FederatedIndexService;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:53198/adcp_test',
    });
    await runMigrations();
    svc = new FederatedIndexService();
  });

  async function clearFixtures() {
    await pool.query(
      `DELETE FROM discovered_agents WHERE agent_url = ANY($1::text[])`,
      [[AGENT_ADAGENTS, AGENT_CLAIM, AGENT_REGISTERED]],
    );
    await pool.query(`DELETE FROM member_profiles WHERE workos_organization_id = $1`, [ORG_ID]);
    await pool.query(`DELETE FROM organizations WHERE workos_organization_id = $1`, [ORG_ID]);
  }

  afterAll(async () => {
    await clearFixtures();
    await closeDatabase();
  });

  beforeEach(async () => {
    await clearFixtures();
  });

  it('includes agents discovered via adagents_json (manager-file-only path)', async () => {
    await pool.query(
      `INSERT INTO discovered_agents (agent_url, source_type, source_domain, agent_type, protocol)
       VALUES ($1, 'adagents_json', $2, 'sales', 'mcp')`,
      [AGENT_ADAGENTS, 'manager.probeable.example'],
    );
    const probeable = await svc.listAllProbeableAgents();
    expect(probeable.map(a => a.url)).toContain(AGENT_ADAGENTS);
  });

  it('excludes agents discovered only via list_authorized_properties (agent_claim)', async () => {
    await pool.query(
      `INSERT INTO discovered_agents (agent_url, source_type, source_domain, agent_type, protocol)
       VALUES ($1, 'list_authorized_properties', $2, 'sales', 'mcp')`,
      [AGENT_CLAIM, 'claimer.probeable.example'],
    );
    const probeable = await svc.listAllProbeableAgents();
    expect(probeable.map(a => a.url)).not.toContain(AGENT_CLAIM);
  });

  it('member-profile registrations win on URL collision (richer metadata)', async () => {
    // Seed: same URL, in discovered_agents AND in a member profile.
    await pool.query(
      `INSERT INTO discovered_agents (agent_url, source_type, source_domain, agent_type, protocol, name)
       VALUES ($1, 'adagents_json', 'somepub.example', 'sales', 'mcp', 'old name from discovered')`,
      [AGENT_REGISTERED],
    );
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, created_at, updated_at)
       VALUES ($1, 'Probe Test Org', NOW(), NOW())
       ON CONFLICT (workos_organization_id) DO NOTHING`,
      [ORG_ID],
    );
    await pool.query(
      `INSERT INTO member_profiles (workos_organization_id, display_name, slug, agents, created_at, updated_at)
       VALUES ($1, 'Probe Test Org', $2, $3::jsonb, NOW(), NOW())
       ON CONFLICT (workos_organization_id) DO UPDATE SET agents = EXCLUDED.agents`,
      [
        ORG_ID,
        PROFILE_SLUG,
        JSON.stringify([{ url: AGENT_REGISTERED, name: 'registered name', type: 'sales', visibility: 'public' }]),
      ],
    );

    const probeable = await svc.listAllProbeableAgents();
    const found = probeable.find(a => a.url === AGENT_REGISTERED);
    expect(found).toBeDefined();
    expect(found!.name).toBe('registered name'); // member-profile metadata wins
  });
});
