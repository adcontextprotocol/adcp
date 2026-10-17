/**
 * Migration 625 + the registry-key rewrite, against a real database (#7830).
 *
 * Two things have to hold together for the key change to be safe:
 *   1. the relaxed CHECK constraints accept a spec-conformant key and still
 *      reject every shape a key must never take; and
 *   2. the rewrite script reports each collision class in a dry run without
 *      writing, refuses to apply while a destructive one is unresolved, and
 *      produces keys the constraints then VALIDATE against the whole table.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { initializeDatabase, closeDatabase, getPool } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { runMigration } from '../../src/scripts/migrate-registry-agent-url-keys.js';
import { registryAgentUrlKey } from '../../src/db/registry-agent-url-key.js';

const PUB = 'key-migration.example';
const OTHER_PUB = `other.${PUB}`;
const CATALOG_STORE = 'catalog_agent_authorizations';
// Other suites in this shard leave rows in the member-profile, agent-context
// and registry-metadata stores, and an unrelated collision there would decide
// this suite's verdict. Scope every run that asserts a verdict to the store
// under test; the unscoped enumeration is asserted once, in dry-run mode.
const catalogOnly = (apply: boolean) => runMigration({ apply, stores: [CATALOG_STORE] });

describe('registry agent_url key migration (#7830)', () => {
  let pool: Pool;
  const logged: string[] = [];
  let restoreLog: (() => void) | undefined;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString:
        process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
  });

  async function clearFixtures() {
    // LIKE, not IN: several tests scope rows to a per-case publisher such as
    // `3.key-migration.example` so that one case cannot collide with another.
    await pool.query(
      `DELETE FROM catalog_agent_authorizations WHERE publisher_domain LIKE $1`,
      [`%${PUB}`],
    );
    await pool.query(
      `DELETE FROM adagents_authorization_overrides WHERE host_domain LIKE $1`,
      [`%${PUB}`],
    );
    // Self-keyed fixtures live in other tables; an aborted run would
    // otherwise leave rows that block every later case in this file.
    await pool.query(
      `DELETE FROM agent_registry_metadata WHERE agent_url LIKE $1`, [`%${PUB}%`]);
    await pool.query(`DROP TABLE IF EXISTS key_migration_unclassified`);
  }

  beforeEach(async () => {
    await clearFixtures();
    logged.length = 0;
    const original = console.log;
    console.log = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    restoreLog = () => { console.log = original; };
  });

  afterAll(async () => {
    restoreLog?.();
    await clearFixtures();
    await closeDatabase();
  });

  /** Insert a catalog authorization with an explicitly chosen stored key. */
  async function insertAuth(agentUrl: string, storedKey: string, publisher = PUB): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO catalog_agent_authorizations
         (agent_url, agent_url_canonical, publisher_domain, evidence)
       VALUES ($1, $2, $3, 'adagents_json')
       RETURNING id::text AS id`,
      [agentUrl, storedKey, publisher],
    );
    return rows[0].id;
  }

  /**
   * Insert a row holding a pre-migration key the relaxed CHECK would reject
   * (an un-stripped fragment, a U-label host). Production holds rows like
   * this today, which is exactly why migration 625 adds the constraint NOT
   * VALID: it governs new writes without scanning rows the rewrite has not
   * reached yet. Dropping and re-adding by the constraint's own definition
   * keeps the predicate in one place — this test never restates it.
   */
  async function insertPreMigrationAuth(
    agentUrl: string, storedKey: string, publisher: string, tombstone = false,
  ): Promise<string> {
    const { rows: [{ def }] } = await pool.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'chk_caa_agent_url_canonical'`);
    // Re-add NOT VALID whatever the current state: the row just inserted is
    // precisely the kind the predicate rejects, and re-validating here would
    // defeat the point of the fixture.
    const notValidDef = `${def.replace(/ NOT VALID$/, '')} NOT VALID`;
    await pool.query(
      `ALTER TABLE catalog_agent_authorizations DROP CONSTRAINT chk_caa_agent_url_canonical`);
    try {
      const id = await insertAuth(agentUrl, storedKey, publisher);
      // Tombstone while the constraint is off: a NOT VALID constraint is
      // still enforced on UPDATE, so a legacy key the new shape rejects
      // cannot be soft-deleted until the rewrite has fixed it. That is
      // exactly what keysRejectedByConstraint reports.
      if (tombstone) {
        await pool.query(
          `UPDATE catalog_agent_authorizations SET deleted_at = NOW() WHERE id = $1`, [id]);
      }
      return id;
    } finally {
      await pool.query(
        `ALTER TABLE catalog_agent_authorizations
           ADD CONSTRAINT chk_caa_agent_url_canonical ${notValidDef}`);
    }
  }

  function report() {
    const parsed = JSON.parse(logged.find(line => line.trimStart().startsWith('{')) as string);
    return parsed as {
      blocked: boolean;
      stores: Array<{
        store: string; rewriteCount: number; blocked: boolean;
        rewrites: Array<{ rowId: string; fromKey: string; toKey: string }>;
        merges: unknown[]; splits: unknown[]; unkeyable: unknown[];
        lossyRowCount: number; lossyRowSample: unknown[];
      }>;
    };
  }
  const storeReport = (name: string) =>
    report().stores.find(store => store.store === name)!;

  describe('relaxed CHECK constraints', () => {
    it('accepts the key shapes the old constraint rejected', async () => {
      for (const key of [
        'https://agent.key-migration.example/tenants/Acme/mcp',
        'https://agent.key-migration.example/mcp?token=A',
        'https://xn--bcher-kva.key-migration.example/mcp',
        'https://agent.key-migration.example/?',
        '*',
      ]) {
        await expect(insertAuth(`raw:${key}`, key)).resolves.toBeTruthy();
      }
    });

    it('still rejects every shape a registry key must never take', async () => {
      const rejected = [
        'https://Agent.key-migration.example/mcp',          // uncanonicalized host
        'https://user:pw@agent.key-migration.example/mcp',  // userinfo
        'https://agent.key-migration.example/mcp#frag',     // fragment
        'https://agent.key-migration.example/',             // root slash
        'https://agent.key-migration.example/mcp/',         // any trailing slash
        'https://agent.key-migration.example/a*b',          // embedded wildcard
        'https://agent.key-migration.example/a\\b',         // backslash
        'https://agent.key-migration.example/a b',          // whitespace
        'agent.key-migration.example/mcp',                  // not a URL
        'ftp://agent.key-migration.example/mcp',            // not http(s)
      ];
      for (const key of rejected) {
        await expect(insertAuth(`raw:${key}`, key), key)
          .rejects.toThrow(/chk_caa_agent_url_canonical/);
      }
    });

    it('accepts every key the helper can produce, for any printable host byte', async () => {
      // The helper and the CHECK are two spellings of one rule, and
      // agent_url comes straight from a publisher's adagents.json. A key the
      // helper emits but the constraint rejects is a publisher-triggerable
      // write failure that aborts the whole manifest projection — WHATWG
      // host parsing lets `"`, backtick, `{` and `}` through where the
      // spec's UseSTD3ASCIIRules pin does not.
      const hostile: string[] = [];
      for (let code = 0x20; code < 0x7f; code += 1) {
        hostile.push(`https://a${String.fromCharCode(code)}b.key-migration.example/mcp`);
      }
      hostile.push(
        'https://bücher.key-migration.example/mcp',
        'https://[2001:DB8::1]:8443/mcp',
        'https://agent.key-migration.example:443/a/./b/../%7Ec/',
        'https://agent.key-migration.example/mcp?t=%7e&u=~',
        'https://agent.key-migration.example?',
        '*',
      );
      let accepted = 0;
      for (const raw of hostile) {
        const key = registryAgentUrlKey(raw);
        if (key === null) continue;
        accepted += 1;
        // Distinct publisher per row: several of these inputs key to the
        // same string, and idx_caa_unique_active would reject the duplicate
        // for a reason that has nothing to do with the CHECK under test.
        await expect(
          insertAuth(`raw:${accepted}:${raw}`, key, `${accepted}.${PUB}`), raw,
        ).resolves.toBeTruthy();
      }
      expect(accepted).toBeGreaterThan(10);
    });

    it('applies the same shape to the override layer, without the wildcard', async () => {
      const insertOverride = (key: string) => pool.query(
        `INSERT INTO adagents_authorization_overrides
           (host_domain, agent_url, agent_url_canonical, override_type, override_reason,
            justification, approved_by_user_id)
         VALUES ($1, $2, $3, 'suppress', 'bad_actor', 'test', 'user_test')`,
        [PUB, `raw:${key}`, key],
      );
      await expect(insertOverride('https://agent.key-migration.example/Mcp')).resolves.toBeTruthy();
      await expect(insertOverride('*')).rejects.toThrow(/chk_aao_agent_url_canonical/);
    });
  });

  describe('blocking preflights', () => {
    it('refuses to run at all when a table with agent_url is unclassified', async () => {
      await pool.query(
        `CREATE TABLE IF NOT EXISTS key_migration_unclassified (
           id uuid PRIMARY KEY DEFAULT gen_random_uuid(), agent_url text NOT NULL)`);
      try {
        // Discovery is from information_schema, so a new store cannot be
        // silently rewritten OR silently left on the old key — someone has
        // to classify it first.
        await expect(runMigration({ apply: false }))
          .rejects.toThrow(/Unclassified agent_url table\(s\): key_migration_unclassified/);
      } finally {
        await pool.query(`DROP TABLE IF EXISTS key_migration_unclassified`);
      }
    });

    it('blocks when an active suppression would stop matching its base row', async () => {
      await insertAuth('https://suppressed.key-migration.example/Mcp',
        'https://suppressed.key-migration.example/mcp');
      await pool.query(
        `INSERT INTO adagents_authorization_overrides
           (host_domain, agent_url, agent_url_canonical, override_type, override_reason,
            justification, approved_by_user_id)
         VALUES ($1, $2, $3, 'suppress', 'correction', 'test', 'user_test')`,
        [PUB, 'https://suppressed.key-migration.example/Other',
          'https://suppressed.key-migration.example/mcp'],
      );

      await runMigration({ apply: false, stores: [CATALOG_STORE] });

      const stranded = (report() as unknown as {
        strandedSuppressions: Array<{ hostDomain: string; fromKey: string; toKey: string }>;
      }).strandedSuppressions;
      expect(stranded).toHaveLength(1);
      expect(stranded[0].fromKey).toBe('https://suppressed.key-migration.example/mcp');
      await expect(runMigration({ apply: true, stores: [CATALOG_STORE] }))
        .rejects.toThrow(/Refusing to apply/);
    });

    it('keeps a bad_actor ban matching a base row whose path spelling changed', async () => {
      // Exact key equality would let the publisher lift the ban by editing
      // one character of path case. Migration 625 folds both sides for
      // bad_actor only.
      await insertAuth('https://banned.key-migration.example/MCP',
        'https://banned.key-migration.example/MCP');
      await pool.query(
        `INSERT INTO adagents_authorization_overrides
           (host_domain, agent_url, agent_url_canonical, override_type, override_reason,
            justification, approved_by_user_id)
         VALUES ($1, $2, $3, 'suppress', 'bad_actor', 'test', 'user_test')`,
        [PUB, 'https://banned.key-migration.example/mcp',
          'https://banned.key-migration.example/mcp'],
      );

      const { rows } = await pool.query(
        `SELECT 1 FROM v_effective_agent_authorizations
          WHERE publisher_domain = $1 AND agent_url_canonical = $2`,
        [PUB, 'https://banned.key-migration.example/MCP'],
      );
      expect(rows).toHaveLength(0);
    });

    it('does not let a correction suppression hide a differently-cased agent', async () => {
      await insertAuth('https://corrected.key-migration.example/MCP',
        'https://corrected.key-migration.example/MCP');
      await pool.query(
        `INSERT INTO adagents_authorization_overrides
           (host_domain, agent_url, agent_url_canonical, override_type, override_reason,
            justification, approved_by_user_id)
         VALUES ($1, $2, $3, 'suppress', 'correction', 'test', 'user_test')`,
        [PUB, 'https://corrected.key-migration.example/mcp',
          'https://corrected.key-migration.example/mcp'],
      );

      const { rows } = await pool.query(
        `SELECT 1 FROM v_effective_agent_authorizations
          WHERE publisher_domain = $1 AND agent_url_canonical = $2`,
        [PUB, 'https://corrected.key-migration.example/MCP'],
      );
      expect(rows).toHaveLength(1);
    });
  });

  describe('dry run', () => {
    it('reports the rewrite without writing anything', async () => {
      const raw = 'https://agent.key-migration.example/tenants/Acme/mcp';
      const id = await insertAuth(raw, 'https://agent.key-migration.example/tenants/acme/mcp');

      const { blocked } = await catalogOnly(false);

      expect(blocked).toBe(false);
      const store = storeReport('catalog_agent_authorizations');
      expect(store.rewrites).toContainEqual({
        rowId: id,
        rawUrl: raw,
        fromKey: 'https://agent.key-migration.example/tenants/acme/mcp',
        toKey: raw,
      });
      const { rows } = await pool.query(
        `SELECT agent_url_canonical FROM catalog_agent_authorizations WHERE id = $1`, [id]);
      expect(rows[0].agent_url_canonical)
        .toBe('https://agent.key-migration.example/tenants/acme/mcp');
    });

    it('reports a merge collision and refuses to apply it', async () => {
      // Both rows are the same publisher-wide adagents_json authorization,
      // so they share idx_caa_unique_active's scope once the trailing slash
      // folds — the collision shape production actually has.
      await insertPreMigrationAuth('https://agent.key-migration.example/mcp/',
        'https://agent.key-migration.example/mcp/', PUB);
      await insertAuth('https://agent.key-migration.example/mcp',
        'https://agent.key-migration.example/mcp', OTHER_PUB);
      await pool.query(
        `UPDATE catalog_agent_authorizations SET publisher_domain = $1 WHERE publisher_domain = $2`,
        [PUB, OTHER_PUB]);

      const { blocked } = await catalogOnly(false);

      // catalog_agent_authorizations HAS a merge policy, so the collision is
      // resolved rather than blocking — the plan says exactly how.
      expect(blocked).toBe(false);
      const store = storeReport('catalog_agent_authorizations');
      expect(store.mergeCollisions).toHaveLength(1);
      expect(store.merges).toHaveLength(1);
      expect(store.merges[0].toKey).toBe('https://agent.key-migration.example/mcp');
    });

    it('reports a split without blocking', async () => {
      await insertAuth('https://agent.key-migration.example/Mcp',
        'https://agent.key-migration.example/mcp');
      await insertAuth('https://agent.key-migration.example/mcp',
        'https://agent.key-migration.example/mcp', OTHER_PUB);

      const { blocked } = await catalogOnly(false);

      expect(blocked).toBe(false);
      expect(storeReport('catalog_agent_authorizations').splits).toHaveLength(1);
    });

    it('blocks on a row whose URL no longer produces a key', async () => {
      await insertAuth('agent.key-migration.example/mcp',
        'https://agent.key-migration.example/placeholder');

      const { blocked } = await catalogOnly(false);

      expect(blocked).toBe(true);
      expect(storeReport('catalog_agent_authorizations').unkeyable).toHaveLength(1);
      await expect(catalogOnly(true)).rejects.toThrow(/Refusing to apply/);
    });
  });

  it('discovers every store that keys on an agent URL, and skips the raw-matched ones', async () => {
    await runMigration({ apply: false });
    const planned = report().stores.map(store => store.store);
    // Discovered from information_schema, so a new agent_url table is
    // covered without touching this script.
    for (const store of [
      'catalog_agent_authorizations',
      'adagents_authorization_overrides',
      'agent_registry_metadata',
      'agent_contexts',
      'agent_verification_badges',
      'agent_compliance_status',
      'member_profiles.agents',
    ]) {
      expect(planned, store).toContain(store);
    }
    // The #3177 dual-read tables are matched raw by their readers.
    expect(planned).not.toContain('agent_publisher_authorizations');
    expect(planned).not.toContain('agent_property_authorizations');
  });

  describe('apply', () => {
    it('rewrites every changed class, folding every trailing slash', async () => {
      // [raw agent_url, pre-migration stored key, expected key after rewrite]
      const cases: Array<[string, string, string]> = [
        ['https://agent.key-migration.example/tenants/Acme/mcp',
          'https://agent.key-migration.example/tenants/acme/mcp',
          'https://agent.key-migration.example/tenants/Acme/mcp'],
        ['https://agent.key-migration.example/mcp/',
          'https://agent.key-migration.example/mcp/',
          'https://agent.key-migration.example/mcp'],
        ['https://agent.key-migration.example:443/mcp',
          'https://agent.key-migration.example:443/mcp',
          'https://agent.key-migration.example/mcp'],
        ['https://agent.key-migration.example/a/./b/../c',
          'https://agent.key-migration.example/a/./b/../c',
          'https://agent.key-migration.example/a/c'],
        ['https://agent.key-migration.example/%7Euser',
          'https://agent.key-migration.example/%7euser',
          'https://agent.key-migration.example/~user'],
        // The IDN and fragment keys violate the relaxed CHECK, which is why
        // migration 625 adds it NOT VALID — see insertPreMigrationAuth.
        ['https://bücher.key-migration.example/mcp',
          'https://bücher.key-migration.example/mcp',
          'https://xn--bcher-kva.key-migration.example/mcp'],
        ['https://agent.key-migration.example/mcp#frag',
          'https://agent.key-migration.example/mcp#frag',
          'https://agent.key-migration.example/mcp'],
        ['HTTPS://Agent.key-migration.example/',
          'https://agent.key-migration.example',
          'https://agent.key-migration.example'],
      ];
      const ids: string[] = [];
      for (const [raw, storedKey] of cases) {
        // Each row is scoped to its own publisher so none of them collide.
        ids.push(await insertPreMigrationAuth(raw, storedKey, `${ids.length}.${PUB}`));
      }

      await catalogOnly(true);

      for (const [index, [raw, , expected]] of cases.entries()) {
        const { rows } = await pool.query(
          `SELECT agent_url_canonical FROM catalog_agent_authorizations WHERE id = $1`,
          [ids[index]]);
        expect(rows[0].agent_url_canonical, raw).toBe(expected);
        expect(rows[0].agent_url_canonical, raw).toBe(registryAgentUrlKey(raw));
      }
      await pool.query(`DELETE FROM catalog_agent_authorizations WHERE id = ANY($1::uuid[])`, [ids]);
    });

    it('leaves the constraint validated, so no pre-migration key survives', async () => {
      await insertPreMigrationAuth('https://agent.key-migration.example/Mcp#frag',
        'https://agent.key-migration.example/mcp#frag', PUB);
      const before = await getPool().query<{ convalidated: boolean }>(
        `SELECT convalidated FROM pg_constraint WHERE conname = 'chk_caa_agent_url_canonical'`);
      expect(before.rows[0].convalidated, 'migration 625 adds it NOT VALID').toBe(false);

      await catalogOnly(true);

      const { rows } = await getPool().query<{ convalidated: boolean }>(
        `SELECT convalidated FROM pg_constraint WHERE conname = 'chk_caa_agent_url_canonical'`);
      expect(rows[0].convalidated).toBe(true);
    });

    it('rewrites a self-keyed store in place, by value', async () => {
      // agent_registry_metadata's agent_url IS the key: there is no raw
      // column to recompute from, so the rewrite is value → value and every
      // row holding that value moves together.
      const stale = 'https://self-keyed.key-migration.example:443/mcp';
      const expected = 'https://self-keyed.key-migration.example/mcp';
      await pool.query(`DELETE FROM agent_registry_metadata WHERE agent_url IN ($1, $2)`,
        [stale, expected]);
      await pool.query(`INSERT INTO agent_registry_metadata (agent_url) VALUES ($1)`, [stale]);
      try {
        await runMigration({ apply: true, stores: ['agent_registry_metadata'] });

        const { rows } = await pool.query(
          `SELECT agent_url FROM agent_registry_metadata WHERE agent_url IN ($1, $2)`,
          [stale, expected]);
        expect(rows).toEqual([{ agent_url: expected }]);
      } finally {
        await pool.query(`DELETE FROM agent_registry_metadata WHERE agent_url IN ($1, $2)`,
          [stale, expected]);
      }
    });

    it('folds a self-keyed trailing-slash collision under the table policy', async () => {
      const stale = 'https://collide.key-migration.example/mcp/';
      const existing = 'https://collide.key-migration.example/mcp';
      await pool.query(
        `INSERT INTO agent_registry_metadata (agent_url, updated_at, compliance_opt_out)
         VALUES ($1, now() - interval '1 day', true), ($2, now(), false)`, [stale, existing]);
      try {
        const { blocked } = await runMigration({
          apply: false, stores: ['agent_registry_metadata'] });
        // Resolved by the table's policy, not blocked.
        expect(blocked).toBe(false);
        const report = storeReport('agent_registry_metadata');
        expect(report.mergeCollisions).toHaveLength(1);
        const [merge] = report.merges;
        expect(merge.winnerKey).toBe(existing);
        expect(merge.loserKeys).toEqual([stale]);
        // The conservative flag survives from the losing row, and the fact
        // that it moved is in the report rather than silent.
        expect(merge.merged.compliance_opt_out).toBe(true);

        await runMigration({ apply: true, stores: ['agent_registry_metadata'] });

        const { rows } = await pool.query<{ agent_url: string; compliance_opt_out: boolean }>(
          `SELECT agent_url, compliance_opt_out FROM agent_registry_metadata
            WHERE agent_url IN ($1, $2)`, [stale, existing]);
        expect(rows).toEqual([{ agent_url: existing, compliance_opt_out: true }]);
      } finally {
        await pool.query(`DELETE FROM agent_registry_metadata WHERE agent_url IN ($1, $2)`,
          [stale, existing]);
      }
    });

    it('rewrites a tombstoned row too, so VALIDATE can scan the whole table', async () => {
      // The row is outside idx_caa_unique_active, so it never collides — but
      // VALIDATE scans every row, and its key is a change-feed payload field.
      const id = await insertPreMigrationAuth(
        'https://tombstone.key-migration.example/Mcp#frag',
        'https://tombstone.key-migration.example/mcp#frag', PUB, true);
      // Reported so an operator knows no write can touch this row yet.
      await catalogOnly(false);
      expect((report() as unknown as {
        keysRejectedByConstraint: Array<{ table: string; rowCount: number }>;
      }).keysRejectedByConstraint).toContainEqual(
        expect.objectContaining({ table: 'catalog_agent_authorizations' }));

      await catalogOnly(true);

      const { rows } = await pool.query(
        `SELECT agent_url_canonical FROM catalog_agent_authorizations WHERE id = $1`, [id]);
      expect(rows[0].agent_url_canonical).toBe('https://tombstone.key-migration.example/Mcp');
    });

    it('skips a row whose raw URL changed under the plan instead of mis-keying it', async () => {
      const id = await insertAuth('https://racer.key-migration.example/Mcp',
        'https://racer.key-migration.example/mcp');
      // Simulate a crawler re-upsert landing between planning and applying.
      const { rows: planned } = await pool.query<{ agent_url_canonical: string }>(
        `SELECT agent_url_canonical FROM catalog_agent_authorizations WHERE id = $1`, [id]);
      expect(planned[0].agent_url_canonical).toBe('https://racer.key-migration.example/mcp');
      await runMigration({ apply: false, stores: [CATALOG_STORE] });
      await pool.query(
        `UPDATE catalog_agent_authorizations
            SET agent_url = $2, agent_url_canonical = $2 WHERE id = $1`,
        [id, 'https://racer.key-migration.example/other']);

      // The plan still holds the old raw URL, so this row must not be touched.
      await pool.query(`DELETE FROM catalog_agent_authorizations WHERE id <> $1
                          AND publisher_domain IN ($2, $3)`, [id, PUB, OTHER_PUB]);
      const { rows } = await pool.query(
        `SELECT agent_url_canonical FROM catalog_agent_authorizations WHERE id = $1`, [id]);
      expect(rows[0].agent_url_canonical).toBe('https://racer.key-migration.example/other');
    });

    it('is idempotent — a second apply rewrites nothing', async () => {
      await insertAuth('https://agent.key-migration.example/Mcp',
        'https://agent.key-migration.example/mcp');

      await catalogOnly(true);
      logged.length = 0;
      await catalogOnly(true);

      expect(storeReport('catalog_agent_authorizations').rewriteCount).toBe(0);
    });
  });
});
