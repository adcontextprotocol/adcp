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

  it('every module returns a tenant_ids field (non-null on seeded modules)', async () => {
    const modules = await getModules();
    expect(modules.length).toBeGreaterThanOrEqual(20);
    for (const m of modules) {
      // Field is present on the row even if it's null on a future module
      // we haven't classified — `tenant_ids` should be a string[] | null.
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

    // S5 (Sponsored Intelligence) is intrinsically cross-tenant.
    const s5 = await getModule('S5');
    expect(s5!.tenant_ids).toEqual(['brand', 'creative', 'governance']);
  });

  it('A3 tour module declares all five user-facing tenants', async () => {
    const a3 = await getModule('A3');
    expect(a3!.tenant_ids).toContain('sales');
    expect(a3!.tenant_ids).toContain('signals');
    expect(a3!.tenant_ids).toContain('governance');
    expect(a3!.tenant_ids).toContain('creative');
    expect(a3!.tenant_ids).toContain('brand');
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
