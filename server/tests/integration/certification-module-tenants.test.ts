import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { getModule, getModules } from '../../src/db/certification-db.js';
import { tenantUrlsForModule } from '../../src/training-agent/config.js';

// Spot-checks against the per-module pinning seeded by migration 464. The
// curriculum can shift over time — these assertions cover modules where the
// pinning is unambiguous (specialist deep dives, single-tenant capstones)
// or load-bearing for downstream behavior (multi-tenant modules whose
// primary anchors what Sage hands the learner first).
describe('certification_modules.tenant_ids (migration 464)', () => {
  beforeAll(async () => {
    initializeDatabase({
      connectionString:
        process.env.DATABASE_URL ||
        'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it('every module has the tenant_ids column on its row', async () => {
    const modules = await getModules();
    expect(modules.length).toBeGreaterThanOrEqual(20);
    for (const m of modules) {
      expect(m).toHaveProperty('tenant_ids');
      if (m.tenant_ids !== null) {
        expect(Array.isArray(m.tenant_ids)).toBe(true);
        expect(m.tenant_ids.length).toBeGreaterThan(0);
      }
    }
  });

  it('S-track specialist deep dives map to their canonical tenant', async () => {
    const cases: Array<{ id: string; primary: string }> = [
      { id: 'S1', primary: 'sales' },
      { id: 'S3', primary: 'signals' },
      { id: 'S4', primary: 'governance' },
    ];
    for (const c of cases) {
      const m = await getModule(c.id);
      expect(m).not.toBeNull();
      expect(m!.tenant_ids?.[0]).toBe(c.primary);
    }
  });

  it('multi-tenant modules preserve primary order', async () => {
    // C2 (brand identity + compliance) leads with brand, governance second.
    const c2 = await getModule('C2');
    expect(c2!.tenant_ids).toEqual(['brand', 'governance']);

    // S2 (creative mastery) covers both creative tenants.
    const s2 = await getModule('S2');
    expect(s2!.tenant_ids).toEqual(['creative', 'creative-builder']);
  });

  it('SI-dependent modules are intentionally NULL until an si tenant exists', async () => {
    // A3 (tour), C3 (creative + SI), S5 (SI capstone) all teach `si_*`
    // tools that no per-specialism tenant currently serves. Pinning them
    // to a sibling would ship a confidently-wrong URL into Sage's prompt;
    // staying NULL makes them fall back to the legacy `/mcp` alias, which
    // also lacks SI but matches today's behavior. Tracked as follow-up.
    for (const id of ['A3', 'C3', 'S5']) {
      const m = await getModule(id);
      expect(m).not.toBeNull();
      expect(m!.tenant_ids).toBeNull();
    }
  });

  it('B3 (publisher track) does not point at the buy-side signals tenant', async () => {
    // B3 trains a publisher to build a sales agent. Signals is a buy-side
    // discovery surface — publishers consume signal activations on their
    // sales agent, they don't operate /signals/mcp.
    const b3 = await getModule('B3');
    expect(b3!.tenant_ids).toEqual(['sales']);
  });

  it('C1 does not pin governance — that is C2 territory', async () => {
    // Governance is taught in C2 (per migration 288). C1 only covers
    // multi-agent buying + media planning; pinning governance there
    // adds a third URL with no matching lesson content.
    const c1 = await getModule('C1');
    expect(c1!.tenant_ids).not.toContain('governance');
  });

  it('tenantUrlsForModule resolves a real module to per-tenant URLs', async () => {
    const s4 = await getModule('S4');
    const urls = tenantUrlsForModule(
      s4!.tenant_ids,
      'https://test-agent.adcontextprotocol.org',
    );
    expect(urls.primary).toBe('https://test-agent.adcontextprotocol.org/governance/mcp');
  });
});
