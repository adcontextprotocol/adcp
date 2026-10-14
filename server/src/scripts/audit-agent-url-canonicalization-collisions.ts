/**
 * Read-only preflight for #7830. Compares legacy keys with proposed keys,
 * including source manifests so old merges that now require splits are visible.
 *
 * DATABASE_URL=… npx tsx server/src/scripts/audit-agent-url-canonicalization-collisions.ts
 * fly ssh console -a adcp-docs -C 'node /app/dist/scripts/audit-agent-url-canonicalization-collisions.js'
 *
 * Split/merge groups are candidates across stores, not a row deletion plan.
 * Authorization scope, ownership, credentials and history need review.
 */
import { initializeDatabase, getPool, closeDatabase } from '../db/client.js';
import { getDatabaseConfig } from '../config.js';
import { auditAgentUrlKeyMigration, type AgentUrlAuditRow } from './agent-url-key-migration-audit.js';

async function main(): Promise<void> {
  if (process.argv.includes('--apply')) throw new Error('This audit is read-only; --apply is not supported.');
  const config = getDatabaseConfig();
  if (!config) throw new Error('DATABASE_URL is required');
  initializeDatabase(config);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout = '30s'");
    const tables = await client.query<{ table_name: string; has_canonical: boolean }>(`
      SELECT c.table_name, bool_or(c.column_name = 'agent_url_canonical') AS has_canonical
      FROM information_schema.columns c
      JOIN information_schema.tables t USING (table_schema, table_name)
      WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
        AND c.column_name IN ('agent_url', 'agent_url_canonical')
      GROUP BY c.table_name HAVING bool_or(c.column_name = 'agent_url')
      ORDER BY c.table_name
    `);
    const rows: AgentUrlAuditRow[] = [];
    for (const table of tables.rows) {
      // Identifiers come from information_schema and are quoted, never inputs.
      const identifier = '"' + table.table_name.replaceAll('"', '""') + '"';
      const result = await client.query<{ row_id: string; raw_url: string; stored_key: string | null }>(`
        SELECT COALESCE(to_jsonb(t)->>'id', to_jsonb(t)->>'organization_id', agent_url) AS row_id,
               agent_url AS raw_url, ${table.has_canonical ? 'agent_url_canonical' : 'NULL::text'} AS stored_key
        FROM public.${identifier} t WHERE agent_url IS NOT NULL
      `);
      for (const row of result.rows) rows.push({
        store: table.table_name, rowId: row.row_id, rawUrl: row.raw_url,
        ...(row.stored_key !== null && { storedKey: row.stored_key }),
      });
    }
    const profiles = await client.query<{ row_id: string; raw_url: string }>(`
      SELECT mp.id::text || ':' || a.ordinality::text AS row_id, a.elem->>'url' AS raw_url
      FROM member_profiles mp CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(mp.agents) = 'array' THEN mp.agents ELSE '[]'::jsonb END
      ) WITH ORDINALITY AS a(elem, ordinality)
      WHERE jsonb_typeof(a.elem->'url') = 'string'
    `);
    rows.push(...profiles.rows.map(row => ({ store: 'member_profiles.agents', rowId: row.row_id, rawUrl: row.raw_url })));
    const manifests = await client.query<{ row_id: string; raw_url: string }>(`
      SELECT p.domain || ':' || a.ordinality::text AS row_id, a.elem->>'url' AS raw_url
      FROM publishers p CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(p.adagents_json->'authorized_agents') = 'array'
          THEN p.adagents_json->'authorized_agents' ELSE '[]'::jsonb END
      ) WITH ORDINALITY AS a(elem, ordinality)
      WHERE jsonb_typeof(a.elem->'url') = 'string'
    `);
    rows.push(...manifests.rows.map(row => ({ store: 'publishers.adagents_json', rowId: row.row_id, rawUrl: row.raw_url })));
    console.log(JSON.stringify({
      issue: 7830,
      liveKeysChanged: false,
      surveyedTables: tables.rows.map(row => row.table_name),
      ...auditAgentUrlKeyMigration(rows),
    }, null, 2));
    await client.query('ROLLBACK');
  } finally {
    client.release();
    await closeDatabase();
  }
}

main().catch(error => {
  console.error('Agent URL migration audit failed:', error);
  process.exitCode = 1;
});
