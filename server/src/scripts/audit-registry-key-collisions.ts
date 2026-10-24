/**
 * Exact, read-only collision gate for the #7830 registry-key migration.
 *
 * Replaces the coarse `lower(rtrim(url,'/'))` gate, which grouped by a key
 * that folds MORE than the real one and so reported every path-case variant
 * as a merge risk. This groups by the registry key itself
 * (`registry-agent-url-key-sql.ts`, held to the TypeScript helper by
 * `registry-agent-url-key-sql.test.ts`), per table, per unique index the key
 * participates in — the exact set of groups Postgres would reject and the
 * migration has to merge.
 *
 * It writes nothing: one REPEATABLE READ READ ONLY transaction, rolled back.
 * Safe to run against production, from a replica or the primary.
 *
 *   DATABASE_URL=… npx tsx server/src/scripts/audit-registry-key-collisions.ts
 *   DATABASE_URL=… npx tsx server/src/scripts/audit-registry-key-collisions.ts --variants
 *
 * `--variants` lists the colliding URLs themselves, which is what you need to
 * tell a real merge (`:443`, a fragment, a root-label dot) from two agents
 * that merely look similar.
 *
 * Every group is labelled with how the migration treats its table:
 *   rewritten  — the migration rewrites this store's keys; a collision here
 *                must be merged, under the table's policy in
 *                migrate-registry-agent-url-keys.ts, or it blocks.
 *   report-only — the migration does not touch this store (its readers match
 *                a raw URL, or it is append-only history), so a collision
 *                here is not a merge the migration will perform.
 */
import { pathToFileURL } from 'node:url';
import type { PoolClient } from 'pg';
import { initializeDatabase, getPool, closeDatabase } from '../db/client.js';
import { getDatabaseConfig } from '../config.js';
import {
  NOT_SQL_COMPUTABLE,
  REGISTRY_KEY,
  UNKEYABLE,
} from '../db/registry-agent-url-key-sql.js';
import {
  REPORT_ONLY_STORES,
  REWRITE_STORES,
  keyScopesFor,
  quoteIdentifier,
  type KeyScope,
} from './registry-key-stores.js';

interface CollisionGroup {
  table: string;
  treatment: 'rewritten' | 'report-only';
  index: string;
  key: string;
  scope: string[];
  storedKeys: string[];
  variants?: string[];
  rowCount: number;
}

interface TableReport {
  table: string;
  treatment: 'rewritten' | 'report-only';
  keyColumn: string;
  rowCount: number;
  unkeyableRows: number;
  notSqlComputableRows: number;
  collisionGroups: number;
}

async function auditTable(
  client: PoolClient,
  table: string,
  keyColumn: string,
  sourceColumn: string,
  treatment: 'rewritten' | 'report-only',
  scopes: KeyScope[],
  withVariants: boolean,
): Promise<{ report: TableReport; groups: CollisionGroup[] }> {
  const identifier = `public.${quoteIdentifier(table)}`;
  const source = quoteIdentifier(sourceColumn);
  const { rows: [counts] } = await client.query<{
    row_count: string; unkeyable: string; not_computable: string;
  }>(
    `SELECT count(*)::text AS row_count,
            count(*) FILTER (WHERE ${UNKEYABLE(source)})::text AS unkeyable,
            count(*) FILTER (WHERE ${NOT_SQL_COMPUTABLE(source)})::text AS not_computable
       FROM ${identifier}`,
  );

  const groups: CollisionGroup[] = [];
  for (const scope of scopes) {
    // Rows the twin cannot key are excluded rather than lumped into one NULL
    // group — a NULL group would be a false collision.
    const scopeSelect = scope.columns.length === 0
      ? `ARRAY[]::text[]`
      : `ARRAY[${scope.columns.map(c => `coalesce(${quoteIdentifier(c)}::text, '')`).join(', ')}]`;
    const where = [`${REGISTRY_KEY(source)} IS NOT NULL`];
    if (scope.predicate !== null) where.push(`(${scope.predicate})`);
    const { rows } = await client.query<{
      key: string; scope: string[]; stored_keys: string[]; variants: string[]; row_count: string;
    }>(
      `SELECT ${REGISTRY_KEY(source)} AS key,
              ${scopeSelect} AS scope,
              array_agg(DISTINCT ${quoteIdentifier(keyColumn)}) AS stored_keys,
              array_agg(DISTINCT ${source}) AS variants,
              count(*)::text AS row_count
         FROM ${identifier}
        WHERE ${where.join(' AND ')}
        GROUP BY 1, 2
       HAVING count(DISTINCT ${quoteIdentifier(keyColumn)}) > 1
        ORDER BY 1`,
    );
    for (const row of rows) {
      groups.push({
        table,
        treatment,
        index: scope.indexName,
        key: row.key,
        scope: row.scope,
        storedKeys: row.stored_keys,
        ...(withVariants ? { variants: row.variants } : {}),
        rowCount: Number(row.row_count),
      });
    }
  }

  return {
    report: {
      table,
      treatment,
      keyColumn,
      rowCount: Number(counts.row_count),
      unkeyableRows: Number(counts.unkeyable),
      notSqlComputableRows: Number(counts.not_computable),
      collisionGroups: groups.length,
    },
    groups,
  };
}

export async function runCollisionAudit(withVariants: boolean): Promise<{ clean: boolean }> {
  const client = await getPool().connect();
  const reports: TableReport[] = [];
  const groups: CollisionGroup[] = [];
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout = '600s'");
    const { rows: tables } = await client.query<{ table_name: string; has_canonical: boolean }>(`
      SELECT c.table_name, bool_or(c.column_name = 'agent_url_canonical') AS has_canonical
        FROM information_schema.columns c
        JOIN information_schema.tables t USING (table_schema, table_name)
       WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
         AND c.column_name IN ('agent_url', 'agent_url_canonical')
       GROUP BY c.table_name HAVING bool_or(c.column_name = 'agent_url')
       ORDER BY c.table_name
    `);
    for (const table of tables) {
      const keyColumn = table.has_canonical ? 'agent_url_canonical' : 'agent_url';
      const treatment = REWRITE_STORES.has(table.table_name) ? 'rewritten' as const : 'report-only' as const;
      if (treatment === 'report-only' && !REPORT_ONLY_STORES.has(table.table_name)) {
        throw new Error(
          `Unclassified agent_url table: ${table.table_name}. Classify it in `
          + 'server/src/scripts/registry-key-stores.ts before auditing.',
        );
      }
      // Collisions are measured against the key column, which is what the
      // unique index actually holds.
      const scopes = await keyScopesFor(client, table.table_name, keyColumn);
      const result = await auditTable(
        client, table.table_name, keyColumn, 'agent_url', treatment, scopes, withVariants);
      reports.push(result.report);
      groups.push(...result.groups);
    }
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }

  const blocking = groups.filter(group => group.treatment === 'rewritten');
  const unkeyable = reports.filter(report => report.unkeyableRows > 0);
  const notComputable = reports.filter(report => report.notSqlComputableRows > 0);
  console.log(JSON.stringify({
    issue: 7830,
    exact: notComputable.length === 0,
    clean: blocking.length === 0 && unkeyable.length === 0,
    tables: reports,
    collisionGroups: groups,
  }, null, 2));

  if (notComputable.length > 0) {
    console.log(
      '\nNOT EXACT: ' + notComputable.map(r => `${r.table}=${r.notSqlComputableRows}`).join(' ')
      + '\n  Those rows carry percent-encoding, a dot segment or a non-ASCII byte, which this'
      + '\n  SQL cannot key. Run the dry run from the branch for an exact answer on them.',
    );
  }
  for (const report of unkeyable) {
    console.log(`UNKEYABLE ${report.table}: ${report.unkeyableRows} row(s) produce no key at all.`);
  }
  for (const group of blocking) {
    console.log(
      `MERGE ${group.table} via ${group.index}: ${group.storedKeys.length} stored keys -> ${group.key}`
      + (group.variants ? `\n  variants: ${group.variants.join('  ')}` : ''),
    );
  }
  for (const group of groups.filter(g => g.treatment === 'report-only')) {
    console.log(
      `report-only ${group.table} via ${group.index}: ${group.storedKeys.length} stored keys -> `
      + `${group.key} (not rewritten by the migration; no merge will be performed)`,
    );
  }
  const clean = blocking.length === 0 && unkeyable.length === 0;
  console.log(clean
    ? '\nCLEAN: every rewritten store keys without collisions.'
    : `\n${blocking.length} collision group(s) in rewritten stores. Each needs a merge policy; `
      + 'the dry run reports the plan.');
  return { clean };
}

async function main(): Promise<void> {
  const config = getDatabaseConfig();
  if (!config) throw new Error('DATABASE_URL is required');
  initializeDatabase(config);
  try {
    const { clean } = await runCollisionAudit(process.argv.includes('--variants'));
    if (!clean) process.exitCode = 1;
  } finally {
    await closeDatabase();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error('Registry key collision audit failed:', error);
    process.exitCode = 1;
  });
}
