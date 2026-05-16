/**
 * Reconcile the three orgs whose past brand.json edits live on `www.<domain>`
 * but whose `organization_domains.is_primary=true` is on `<domain>` (#4448,
 * Stage 2 drift from #4159). Audit findings via
 * `audit-brand-domain-www-mismatch.ts`:
 *
 *   - Affinity Answers — root has 0 agents in manifest; www has 1.
 *   - BidMachine        — root has 0 agents in manifest; www has 1.
 *                         (Their JSONB agent is `visibility: public`, so this
 *                         org is actively shipping an empty brand.json today.)
 *   - Scope3            — alias `www.scope3.com → scope3.com` already exists
 *                         and the www brand row is a stub. Only cleanup needed
 *                         is orphaning the stub row.
 *
 * Strategy (Affinity / BidMachine):
 *
 *   1. Copy `brand_manifest->'agents'` from the www brand row into the root
 *      brand row, deduped on `id`. Other manifest fields (brands/colors/etc.)
 *      are left alone — `agents` is the field the publish path writes and the
 *      only field whose drift causes user-visible regression. Cosmetic merge
 *      can happen later if anyone notices the root row is sparse.
 *   2. Mark the www brand row `manifest_orphaned = true`. The lookup helpers
 *      already skip orphaned rows (see `resolveBrand` in member-profiles.ts).
 *      We do not delete it — `brand_revisions` is a historical log; preserving
 *      the row keeps history coherent.
 *   3. Insert a `brand_domain_aliases` row (`www.<domain>` → `<domain>`) so
 *      domain-resolution call sites (admin tools, enrichment) follow the
 *      alias. The publish-path lookup does not consult aliases today, but the
 *      content has been moved so it no longer needs to.
 *
 * Strategy (Scope3):
 *
 *   - Alias already exists. Just orphan the www stub. No agent copy needed.
 *
 * Idempotent: re-running is a no-op (the www row's agents are gone after
 * orphaning, the alias INSERT is ON CONFLICT DO NOTHING, the manifest_orphaned
 * flip is a no-op once set).
 *
 * Usage:
 *   npx tsx server/src/scripts/reconcile-brand-domain-www-mismatch.ts             # dry-run
 *   npx tsx server/src/scripts/reconcile-brand-domain-www-mismatch.ts --apply     # write
 *
 *   fly ssh console -a adcp-docs -C 'node /app/dist/scripts/reconcile-brand-domain-www-mismatch.js'
 *   fly ssh console -a adcp-docs -C 'node /app/dist/scripts/reconcile-brand-domain-www-mismatch.js --apply'
 *
 * Prerequisites: DATABASE_URL set.
 */

import { initializeDatabase, getPool, closeDatabase } from '../db/client.js';
import { getDatabaseConfig } from '../config.js';

const apply = process.argv.includes('--apply');
const dryRun = !apply;

interface AffectedOrg {
  org_id: string;
  org_name: string;
  root_domain: string;
  www_domain: string;
  needs_agent_copy: boolean;
  needs_alias_insert: boolean;
}

// Locked-in audit results from 2026-05-12 (run via audit-brand-domain-www-mismatch.ts).
// Hardcoded rather than re-derived at runtime so an unexpected new mismatch
// fails loudly instead of silently expanding the script's blast radius.
const AFFECTED: AffectedOrg[] = [
  {
    org_id: 'org_01KKBDJPRJ7WDX4W4MASFN33Y0',
    org_name: 'Affinity Answers',
    root_domain: 'affinityanswers.com',
    www_domain: 'www.affinityanswers.com',
    needs_agent_copy: true,
    needs_alias_insert: true,
  },
  {
    org_id: 'org_01KN6QZ0ZWBPAAPAE0R89KGKDQ',
    org_name: 'BidMachine',
    root_domain: 'bidmachine.io',
    www_domain: 'www.bidmachine.io',
    needs_agent_copy: true,
    needs_alias_insert: true,
  },
  {
    org_id: 'org_01KC84E45378RJDDARFGR4E2WD',
    org_name: 'Scope3',
    root_domain: 'scope3.com',
    www_domain: 'www.scope3.com',
    needs_agent_copy: false, // www row is a stub with no agents
    needs_alias_insert: false, // alias already exists
  },
];

interface BrandRow {
  domain: string;
  brand_manifest: Record<string, unknown> | null;
  manifest_orphaned: boolean;
}

interface AgentEntry {
  id?: string;
  url?: string;
  [k: string]: unknown;
}

async function reconcileOrg(org: AffectedOrg): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const both = await client.query<BrandRow>(
      `SELECT domain, brand_manifest, manifest_orphaned
       FROM brands WHERE domain IN ($1, $2)
       ORDER BY domain
       FOR UPDATE`,
      [org.root_domain, org.www_domain],
    );
    const byDomain = new Map(both.rows.map((r) => [r.domain, r]));
    const root = byDomain.get(org.root_domain);
    const www = byDomain.get(org.www_domain);

    if (!root) {
      console.log(`[${org.org_name}] root brand row missing for ${org.root_domain} — skipping (run audit again, this is unexpected)`);
      await client.query('ROLLBACK');
      return;
    }
    if (!www) {
      console.log(`[${org.org_name}] www brand row missing for ${org.www_domain} — already reconciled or never created; skipping`);
      await client.query('ROLLBACK');
      return;
    }

    // Agent copy
    if (org.needs_agent_copy) {
      const rootAgents = (root.brand_manifest && Array.isArray((root.brand_manifest as { agents?: unknown }).agents)
        ? ((root.brand_manifest as { agents: AgentEntry[] }).agents)
        : []);
      const wwwAgents = (www.brand_manifest && Array.isArray((www.brand_manifest as { agents?: unknown }).agents)
        ? ((www.brand_manifest as { agents: AgentEntry[] }).agents)
        : []);
      const seen = new Set<string>(rootAgents.map((a) => (typeof a.url === 'string' ? a.url.toLowerCase() : (a.id ?? ''))).filter(Boolean) as string[]);
      const merged: AgentEntry[] = [...rootAgents];
      for (const a of wwwAgents) {
        const key = typeof a.url === 'string' ? a.url.toLowerCase() : (a.id ?? '');
        if (!key || seen.has(key)) continue;
        merged.push(a);
        seen.add(key);
      }
      if (merged.length !== rootAgents.length) {
        const newManifest = { ...(root.brand_manifest ?? {}), agents: merged };
        console.log(`[${org.org_name}] agent_copy: root had ${rootAgents.length}, www had ${wwwAgents.length}, merged → ${merged.length}`);
        if (!dryRun) {
          await client.query(
            `UPDATE brands SET brand_manifest = $1::jsonb, updated_at = NOW() WHERE domain = $2`,
            [JSON.stringify(newManifest), org.root_domain],
          );
        }
      } else {
        console.log(`[${org.org_name}] agent_copy: no-op (root already has ${rootAgents.length} agents, www had ${wwwAgents.length})`);
      }
    }

    // Orphan the www row
    if (!www.manifest_orphaned) {
      console.log(`[${org.org_name}] orphan_www: marking ${org.www_domain} manifest_orphaned=true`);
      if (!dryRun) {
        await client.query(
          `UPDATE brands SET manifest_orphaned = true, updated_at = NOW() WHERE domain = $1`,
          [org.www_domain],
        );
      }
    } else {
      console.log(`[${org.org_name}] orphan_www: no-op (${org.www_domain} already orphaned)`);
    }

    // Alias insert
    if (org.needs_alias_insert) {
      const existing = await client.query(
        `SELECT 1 FROM brand_domain_aliases WHERE alias_domain = $1`,
        [org.www_domain],
      );
      if (existing.rowCount === 0) {
        console.log(`[${org.org_name}] alias_insert: ${org.www_domain} → ${org.root_domain}`);
        if (!dryRun) {
          await client.query(
            `INSERT INTO brand_domain_aliases (alias_domain, brand_domain)
             VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [org.www_domain, org.root_domain],
          );
        }
      } else {
        console.log(`[${org.org_name}] alias_insert: no-op (alias for ${org.www_domain} exists)`);
      }
    }

    if (dryRun) {
      await client.query('ROLLBACK');
      console.log(`[${org.org_name}] DRY-RUN — rolled back`);
    } else {
      await client.query('COMMIT');
      console.log(`[${org.org_name}] COMMITTED`);
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`[${org.org_name}] FAILED — rolled back:`, err);
    throw err;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  const dbConfig = getDatabaseConfig();
  if (!dbConfig) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  initializeDatabase(dbConfig);

  console.log(`=== Reconcile www/no-www brand-row mismatch (#4448) ===`);
  console.log(`Mode: ${dryRun ? 'DRY-RUN (no writes; pass --apply to persist)' : 'APPLY'}\n`);

  for (const org of AFFECTED) {
    await reconcileOrg(org);
    console.log('');
  }

  await closeDatabase();
}

main().catch((err) => {
  console.error('reconcile failed:', err);
  process.exit(1);
});
