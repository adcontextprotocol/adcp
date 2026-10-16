/**
 * Rewrite every stored registry agent-URL key to AdCP URL canonicalization
 * (#7830). This is the data half of migration 625, which relaxes the CHECK
 * constraints but deliberately rewrites nothing.
 *
 * Dry-run by default — it reports what would change and every collision class
 * without writing. `--apply` writes, and refuses to write while anything
 * needs a human decision about authorization scope, ownership, credentials or
 * history: a merge that would destroy a row, a chain that would abort the
 * UPDATE halfway, a URL that no longer produces a key, a unique index whose
 * scope cannot be modelled, or a suppression that would stop matching.
 *
 * Tables are discovered from `information_schema`, then matched against two
 * hand-maintained lists: REWRITE_STORES (identity stores, where a stale key
 * makes the row unreachable) and REPORT_ONLY_STORES (append-only history and
 * tables whose readers match a raw URL). A table with an `agent_url` column
 * in neither list makes the script refuse to run, so a new store cannot be
 * silently rewritten OR silently left behind — someone has to classify it.
 *
 *   - a table with BOTH `agent_url` and `agent_url_canonical` has a derived
 *     key, recomputed from the raw column;
 *   - any other rewritten table is self-keyed — the column already holds the
 *     key, so it is rewritten in place, by value;
 *   - `member_profiles.agents[].url` is the one key that lives inside JSONB.
 *
 * Uniqueness scopes come from the table's own unique indexes, so the report
 * says "these two rows would collide" for exactly the cases Postgres would
 * reject. An index whose key columns include an expression cannot be modelled
 * generically; the two derived-key tables carry their scope explicitly below,
 * and for anything else an unmodelled index blocks the store rather than
 * leaving merge detection quietly blind.
 *
 * Run the read-only audit first:
 *   DATABASE_URL=… npx tsx \
 *     server/src/scripts/audit-agent-url-canonicalization-collisions.ts
 *
 * Then:
 *   DATABASE_URL=… npx tsx \
 *     server/src/scripts/migrate-registry-agent-url-keys.ts            # dry run
 *   DATABASE_URL=… npx tsx \
 *     server/src/scripts/migrate-registry-agent-url-keys.ts --apply
 *
 * In production:
 *   fly ssh console -a adcp-docs -C \
 *     'node /app/dist/scripts/migrate-registry-agent-url-keys.js'
 *   fly ssh console -a adcp-docs -C \
 *     'node /app/dist/scripts/migrate-registry-agent-url-keys.js --apply'
 *
 * Every table is rewritten in ONE transaction. Per-store transactions would
 * be the wrong granularity: `compliance-db.ts` alone joins
 * agent_registry_metadata to agent_compliance_status to
 * agent_verification_badges on `agent_url`, so between two store commits
 * those joins return nothing for every rewritten agent. One transaction
 * turns a partial failure into "nothing happened". The member_profiles JSONB
 * pass runs separately so it can re-read each profile FOR UPDATE.
 *
 * `--apply` finishes by VALIDATEing the two constraints migration 625 added
 * NOT VALID. That proves no row in those tables carries a shape the key can
 * never take — a fragment, userinfo, a backslash, a bare root slash. It does
 * NOT prove the rewrite is complete: an old key like
 * `https://x.example/mcp` satisfies the new predicate perfectly. Completeness
 * is the dry run reporting zero rewrites.
 *
 * `--only=<store>` narrows the run to one store. The default — and the only
 * way to finish the migration — is all of them: readers and writers switch
 * together, so a store left on the old key is a store whose rows no reader
 * can find. Use it for staged remediation of a blocked store, not as the
 * normal path.
 */
import { pathToFileURL } from 'node:url';
import type { PoolClient } from 'pg';
import { initializeDatabase, getPool, closeDatabase } from '../db/client.js';
import { getDatabaseConfig } from '../config.js';
import {
  legacyRegistryAgentUrlKey,
  registryAgentUrlKey,
  registryAgentUrlLookupKey,
} from '../db/registry-agent-url-key.js';
import {
  planIsBlocked,
  planStoreRewrite,
  type KeyedRow,
  type StorePlan,
} from './registry-agent-url-key-rewrite-plan.js';

export const PROFILE_AGENTS_STORE = 'member_profiles.agents';

/**
 * Identity stores: `agent_url` (or `agent_url_canonical`) is how a reader
 * finds the row, so a key left in the old form makes the row unreachable and
 * the next write creates a duplicate alongside it.
 */
const REWRITE_STORES = new Set([
  'adagents_authorization_overrides',
  'agent_capabilities_snapshot',
  'agent_compliance_refresh_requests',
  'agent_compliance_status',
  'agent_contexts',
  'agent_grading_profile_projection_jobs',
  'agent_grading_profiles',
  'agent_health_snapshot',
  'agent_inventory_profiles',
  'agent_registry_metadata',
  'agent_storyboard_status',
  'agent_verification_badges',
  'catalog_agent_authorizations',
  'discovered_agents',
]);

/**
 * Tables that hold an `agent_url` but must NOT be rewritten, each with the
 * reason, because "why was this skipped" is the first question an operator
 * reading the report will have.
 *
 * Two shapes. Append-only history records the key that was in use when the
 * event happened — rewriting it would falsify the record, and three of these
 * tables enforce that with an append-only trigger (migration 598), so a blind
 * UPDATE would abort the run. The other shape is a reader that matches
 * `agent_url` against the caller's raw input rather than against a key.
 *
 * Not a store, but worth knowing: for `evidence='agent_claim'` rows,
 * `catalog_agent_authorizations.created_by` holds the asserting agent's URL
 * (migration 440), and it has never been canonicalized. After the rewrite it
 * and `agent_url_canonical` on the same row are in different key forms. The
 * documented revocation path matches `created_by` against a raw URL, so it
 * stays self-consistent; tracked separately rather than changed here.
 */
const REPORT_ONLY_STORES = new Map<string, string>([
  ['agent_publisher_authorizations',
    'readers match agent_url against the caller raw input, not a key (#3177 dual-read)'],
  ['agent_property_authorizations',
    'readers match agent_url against the caller raw input, not a key (#3177 dual-read)'],
  ['agent_compliance_runs',
    'append-only run history; append-only trigger (migration 598)'],
  ['agent_compliance_step_diagnostics',
    'per-run diagnostics; child of agent_compliance_runs'],
  ['agent_grading_profile_audit',
    'append-only audit trail; append-only trigger (migration 598)'],
  ['verification_profile_role_assessments',
    'append-only assessment history; append-only trigger (migration 598)'],
  ['verification_profile_shadow_assessments',
    'shadow-mode assessment history'],
  ['addie_agent_quality_evaluations',
    'evaluation history; records the key in use at the time'],
  ['agent_outbound_requests',
    'request telemetry; high volume, no identity role'],
  ['manifest_references',
    'community manifest contributions; agent_url is a reference, not a key'],
  ['type_reclassification_log',
    'append-only reclassification log'],
]);

/**
 * Active-set uniqueness for the two derived-key tables, whose unique indexes
 * are partial AND expression-based (COALESCE over nullable scope columns), so
 * the generic pg_index walk below cannot model them. Kept next to the index
 * definitions they mirror: idx_caa_unique_active (migration 440) and
 * idx_aao_unique_active (migration 432).
 *
 * The CASE yields NULL outside the active set, which takes tombstoned and
 * superseded rows out of collision detection without taking them out of the
 * rewrite. They still have to move: their key is a change-feed payload field,
 * and leaving them behind would make the VALIDATE at the end — which scans
 * every row, not just the active ones — fail after every write has committed.
 */
const DERIVED_KEY_SCOPES: Record<string, { scopeExpr: string }> = {
  catalog_agent_authorizations: {
    scopeExpr: `CASE WHEN deleted_at IS NULL THEN
                  COALESCE(property_rid::text, '') || E'\\n'
                  || COALESCE(publisher_domain, '') || E'\\n' || evidence END`,
  },
  adagents_authorization_overrides: {
    scopeExpr: `CASE WHEN superseded_at IS NULL THEN
                  host_domain || E'\\n' || COALESCE(property_id, '')
                  || E'\\n' || override_type END`,
  },
};

interface UniqueScope {
  indexName: string;
  /** Scope columns, excluding the key column itself. May be empty. */
  columns: string[];
  /** Partial-index predicate, or null. */
  predicate: string | null;
}

interface TableStore {
  table: string;
  /** Column the key is written to. */
  keyColumn: string;
  /** Column the key is computed from. Equal to keyColumn when self-keyed. */
  sourceColumn: string;
  scopes: UniqueScope[];
  /**
   * Unique indexes on the key column this code cannot model, by name. Any
   * entry blocks the store: merge detection would be blind to it.
   */
  unmodelledIndexes: string[];
  /** Explicit scope expression for the derived-key tables. */
  scopeExpr: string | null;
}

interface ProfileAgents {
  id: string;
  slug: string;
  agents: Array<Record<string, unknown>>;
}

/** Quote an identifier that came from pg_catalog, never from an operator. */
function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function discoverStores(client: PoolClient): Promise<TableStore[]> {
  const { rows: tables } = await client.query<{ table_name: string; has_canonical: boolean }>(`
    SELECT c.table_name, bool_or(c.column_name = 'agent_url_canonical') AS has_canonical
      FROM information_schema.columns c
      JOIN information_schema.tables t USING (table_schema, table_name)
     WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
       AND c.column_name IN ('agent_url', 'agent_url_canonical')
     GROUP BY c.table_name HAVING bool_or(c.column_name = 'agent_url')
     ORDER BY c.table_name
  `);
  // Unique indexes, with the expression-column case detectable: an index key
  // column that is an expression has attnum 0 and no pg_attribute row, so the
  // aggregated name array comes back shorter than indnkeyatts.
  const { rows: indexes } = await client.query<{
    table_name: string; index_name: string; key_columns: string[] | null;
    key_count: number; predicate: string | null;
  }>(`
    SELECT c.relname AS table_name,
           ic.relname AS index_name,
           i.indnkeyatts AS key_count,
           -- ::text matters: array_agg over the name type yields name[],
           -- which the pg driver hands back as the string '{agent_url}'.
           (SELECT array_agg(a.attname::text ORDER BY k.ord)
              FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
              JOIN pg_attribute a
                ON a.attrelid = i.indrelid AND a.attnum = k.attnum
             WHERE k.ord <= i.indnkeyatts) AS key_columns,
           pg_get_expr(i.indpred, i.indrelid) AS predicate
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indrelid
      JOIN pg_class ic ON ic.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
     WHERE i.indisunique AND i.indisvalid AND i.indislive
  `);

  const unclassified = tables
    .map(table => table.table_name)
    .filter(table => !REWRITE_STORES.has(table) && !REPORT_ONLY_STORES.has(table));
  if (unclassified.length > 0) {
    throw new Error(
      `Unclassified agent_url table(s): ${unclassified.join(', ')}. Add each to `
      + 'REWRITE_STORES (an identity store a reader looks rows up in) or to '
      + 'REPORT_ONLY_STORES with a reason, in '
      + 'server/src/scripts/migrate-registry-agent-url-keys.ts. Refusing to run: '
      + 'rewriting an unclassified store, or silently leaving one on the old '
      + 'key, are both ways to lose data.',
    );
  }

  const stores: TableStore[] = [];
  for (const table of tables) {
    if (!REWRITE_STORES.has(table.table_name)) continue;
    const keyColumn = table.has_canonical ? 'agent_url_canonical' : 'agent_url';
    const explicit = DERIVED_KEY_SCOPES[table.table_name];
    const onKey = indexes
      .filter(index => index.table_name === table.table_name)
      .filter(index => Array.isArray(index.key_columns) && index.key_columns.includes(keyColumn));
    // An index whose key list is shorter than indnkeyatts contains an
    // expression. Modelling it as if it did not would under-report merges —
    // the one failure the whole script exists to prevent — so name it and
    // let it block the store instead.
    const unmodelled = explicit
      ? []
      : onKey.filter(index => (index.key_columns?.length ?? 0) !== index.key_count)
        .map(index => index.index_name);
    const scopes = explicit ? [] : onKey
      .filter(index => (index.key_columns?.length ?? 0) === index.key_count)
      .map(index => ({
        indexName: index.index_name,
        columns: (index.key_columns as string[]).filter(column => column !== keyColumn),
        predicate: index.predicate,
      }));
    stores.push({
      table: table.table_name,
      keyColumn,
      sourceColumn: 'agent_url',
      scopes,
      unmodelledIndexes: unmodelled,
      scopeExpr: explicit?.scopeExpr ?? null,
    });
  }
  return stores;
}

/**
 * Rows for one table. A derived-key table is planned per row (the raw URL
 * differs row by row); a self-keyed table is planned per distinct URL,
 * because the rewrite is by value and every row holding that value moves
 * together.
 */
async function readTable(client: PoolClient, store: TableStore): Promise<KeyedRow[]> {
  const scopeSelects = store.scopeExpr !== null
    ? [`(${store.scopeExpr}) AS scope_0`]
    : store.scopes.map((scope, index) => {
      const tuple = scope.columns.length === 0
        ? `''`
        : scope.columns.map(column => `COALESCE(${quote(column)}::text, '')`).join(` || E'\\n' || `);
      // Outside a partial index's predicate the row is not constrained by it.
      const guarded = scope.predicate === null ? tuple : `CASE WHEN ${scope.predicate} THEN ${tuple} END`;
      return `(${guarded}) AS scope_${index}`;
    });
  const scopeCount = scopeSelects.length;
  const derived = store.keyColumn !== store.sourceColumn;

  const sql = derived
    ? `SELECT id::text AS row_id, ${quote(store.sourceColumn)} AS raw_url,
              ${quote(store.keyColumn)} AS stored_key${scopeSelects.map(s => `, ${s}`).join('')}
         FROM public.${quote(store.table)}`
    // Self-keyed tables are rewritten by value, so only the distinct
    // (url, scope…) tuples matter — a history table with a million rows per
    // agent is planned from a handful. Positional GROUP BY avoids repeating
    // the partial-index CASE expressions.
    : `SELECT ${quote(store.keyColumn)} AS row_id, ${quote(store.keyColumn)} AS raw_url,
              ${quote(store.keyColumn)} AS stored_key${scopeSelects.map(s => `, ${s}`).join('')}
         FROM public.${quote(store.table)}
        GROUP BY ${Array.from({ length: scopeCount + 3 }, (_, index) => index + 1).join(', ')}`;

  const { rows } = await client.query<Record<string, string | null>>(sql);
  // One KeyedRow per rowId. A self-keyed table is grouped by (key, scopes…),
  // so one key held under several scopes — the same agent in three member
  // organizations, say — comes back as several rows that all move together.
  // Merge their scopes: the planner needs every scope a rowId participates
  // in to see a chain, and would otherwise report the row once per scope.
  const merged = new Map<string, KeyedRow & { scopes: string[] }>();
  for (const row of rows) {
    if (row.raw_url === null || row.stored_key === null) continue;
    const rowId = row.row_id as string;
    // Label with the index's own ordinal BEFORE dropping the nulls. A row
    // outside a partial index's predicate contributes no scope for that
    // index, and renumbering the survivors would alias one index's scope
    // onto another's and miss the merge.
    const scopes = Array.from({ length: scopeCount }, (_, index) => {
      const scope = row[`scope_${index}`];
      return scope === null ? null : `${index}\u0000${scope}`;
    }).filter((scope): scope is string => scope !== null);
    const existing = merged.get(rowId);
    if (existing === undefined) {
      merged.set(rowId, {
        rowId,
        rawUrl: row.raw_url as string,
        storedKey: row.stored_key as string,
        scopes,
      });
      continue;
    }
    for (const scope of scopes) {
      if (!existing.scopes.includes(scope)) existing.scopes.push(scope);
    }
  }
  return [...merged.values()];
}

async function readProfiles(client: PoolClient): Promise<ProfileAgents[]> {
  const { rows } = await client.query<ProfileAgents>(`
    SELECT id::text AS id, slug, agents
      FROM member_profiles
     WHERE jsonb_typeof(agents) = 'array' AND jsonb_array_length(agents) > 0
  `);
  return rows;
}

/**
 * `member_profiles.agents[].url` is the key; uniqueness is per profile.
 *
 * Row ids are `<profile uuid>#<array index>`. The uuid, not the slug: a slug
 * is member-chosen text and could contain the delimiter, which would silently
 * drop that profile from the rewrite. `#` cannot appear in a uuid.
 */
export function profileAgentRows(profiles: ProfileAgents[]): KeyedRow[] {
  const rows: KeyedRow[] = [];
  for (const profile of profiles) {
    profile.agents.forEach((agent, index) => {
      if (typeof agent?.url !== 'string') return;
      rows.push({
        rowId: `${profile.id}#${index}`,
        rawUrl: agent.url,
        storedKey: agent.url,
        scopes: [profile.id],
      });
    });
  }
  return rows;
}

function profileIdOf(rowId: string): string {
  return rowId.slice(0, rowId.lastIndexOf('#'));
}

async function applyTableRewrite(
  client: PoolClient,
  store: TableStore,
  plan: StorePlan,
): Promise<{ updated: number; skipped: number }> {
  if (plan.rewrites.length === 0) return { updated: 0, skipped: 0 };
  // `AND raw_url = r.raw_url` is the guard that makes this safe to run
  // against a live registry. Planning happens in a snapshot that is rolled
  // back before any write, so a crawler re-upsert in between would leave a
  // row whose raw URL no longer matches the key this plan computed — writing
  // it anyway would point the row at a different agent, which is the exact
  // mis-attachment #7830 exists to fix. A moved row is skipped instead, and
  // the row-count delta surfaces it.
  const match = store.keyColumn !== store.sourceColumn
    ? `t.id::text = r.row_id AND t.${quote(store.sourceColumn)} = r.raw_url`
    : `t.${quote(store.keyColumn)} = r.row_id AND t.${quote(store.sourceColumn)} = r.raw_url`;
  const { rowCount } = await client.query(
    `UPDATE public.${quote(store.table)} AS t
        SET ${quote(store.keyColumn)} = r.new_key
       FROM unnest($1::text[], $2::text[], $3::text[]) AS r(row_id, new_key, raw_url)
      WHERE ${match}`,
    [
      plan.rewrites.map(rewrite => rewrite.rowId),
      plan.rewrites.map(rewrite => rewrite.toKey),
      plan.rewrites.map(rewrite => rewrite.rawUrl),
    ],
  );
  const updated = rowCount ?? 0;
  // Self-keyed stores rewrite by value, so one plan entry can move many
  // rows; only a derived-key store can report a meaningful shortfall.
  const skipped = store.keyColumn === store.sourceColumn
    ? 0
    : Math.max(0, plan.rewrites.length - updated);
  return { updated, skipped };
}

/**
 * Rewrite profile agent URLs. Each profile is re-read FOR UPDATE inside the
 * write transaction and re-keyed from what is actually stored, so a profile
 * edited between planning and applying is not clobbered with a stale array.
 */
async function applyProfileRewrite(client: PoolClient, plan: StorePlan): Promise<number> {
  const profileIds = [...new Set(plan.rewrites.map(rewrite => profileIdOf(rewrite.rowId)))];
  if (profileIds.length === 0) return 0;
  const { rows } = await client.query<ProfileAgents>(
    `SELECT id::text AS id, slug, agents FROM member_profiles
      WHERE id = ANY($1::uuid[]) FOR UPDATE`,
    [profileIds],
  );
  let updated = 0;
  for (const profile of rows) {
    if (!Array.isArray(profile.agents)) continue;
    let touched = false;
    const next = profile.agents.map(agent => {
      if (typeof agent?.url !== 'string') return agent;
      const key = registryAgentUrlKey(agent.url);
      if (key === null || key === agent.url) return agent;
      touched = true;
      return { ...agent, url: key };
    });
    if (!touched) continue;
    await client.query(
      `UPDATE member_profiles SET agents = $1::jsonb, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(next), profile.id],
    );
    updated += 1;
  }
  return updated;
}

/**
 * Raw publisher-declared URLs, keyed by their pre-migration key.
 *
 * `publishers.adagents_json` and `member_profiles.agents[].url` are the only
 * places the registry still holds an agent URL as its author wrote it. For a
 * self-keyed store — a badge, a compliance status, a grading profile — the
 * row's own URL went through the old canonicalizer, so its path case is gone
 * and the recomputed key is a guess. These sources can answer that guess.
 */
async function readRawUrlSources(client: PoolClient): Promise<Map<string, Set<string>>> {
  const byLegacyKey = new Map<string, Set<string>>();
  const add = (rawUrl: string) => {
    const legacy = legacyRegistryAgentUrlKey(rawUrl);
    const current = registryAgentUrlKey(rawUrl);
    if (legacy === null || current === null) return;
    const keys = byLegacyKey.get(legacy) ?? new Set<string>();
    keys.add(current);
    byLegacyKey.set(legacy, keys);
  };
  const { rows: manifests } = await client.query<{ raw_url: string }>(`
    SELECT a.elem->>'url' AS raw_url
      FROM publishers p CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(p.adagents_json->'authorized_agents') = 'array'
             THEN p.adagents_json->'authorized_agents' ELSE '[]'::jsonb END
      ) AS a(elem)
     WHERE jsonb_typeof(a.elem->'url') = 'string'
  `);
  for (const row of manifests) add(row.raw_url);
  const { rows: profiles } = await client.query<{ raw_url: string }>(`
    SELECT a.elem->>'url' AS raw_url
      FROM member_profiles mp CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(mp.agents) = 'array' THEN mp.agents ELSE '[]'::jsonb END
      ) AS a(elem)
     WHERE jsonb_typeof(a.elem->'url') = 'string'
  `);
  for (const row of profiles) add(row.raw_url);
  return byLegacyKey;
}

function summarize(plan: StorePlan, rawSources: Map<string, Set<string>>) {
  return {
    store: plan.store,
    rowCount: plan.rowCount,
    rewriteCount: plan.rewrites.length,
    blocked: planIsBlocked(plan),
    rewrites: plan.rewrites,
    unkeyable: plan.unkeyable,
    merges: plan.merges,
    chains: plan.chains,
    splits: plan.splits,
    lossyRowCount: plan.lossyRows.length,
    // The full list, not a sample. The consequence of leaving one of these
    // unreconciled is an agent silently losing its badge and its compliance
    // history, so an operator has to be able to work the whole thing.
    // `manifestKey` is what the publisher actually declared, where exactly
    // one declaration maps to this row and disagrees with the recomputed
    // key: a proposal for a human, never applied automatically — the source
    // of truth for it is a different store.
    lossyRows: plan.lossyRows.map(row => {
      const candidates = [...(rawSources.get(row.rawUrl) ?? [])];
      const manifestKey = candidates.length === 1 && candidates[0] !== row.newKey
        ? candidates[0]
        : undefined;
      return { ...row, ...(manifestKey === undefined ? {} : { manifestKey }) };
    }),
  };
}

/** Stores the migration deliberately leaves alone, reported so the gap is visible. */
async function readReportOnlyGap(client: PoolClient) {
  const gaps: Array<{ table: string; reason: string; changedUrls: string[] }> = [];
  for (const [table, reason] of REPORT_ONLY_STORES) {
    const { rows } = await client.query<{ agent_url: string }>(
      `SELECT DISTINCT agent_url FROM public.${quote(table)} WHERE agent_url IS NOT NULL`);
    const changedUrls = rows
      .map(row => row.agent_url)
      .filter(agentUrl => (registryAgentUrlKey(agentUrl) ?? agentUrl) !== agentUrl);
    if (changedUrls.length > 0) gaps.push({ table, reason, changedUrls });
  }
  return gaps;
}

/**
 * Rows whose stored key the relaxed CHECK rejects.
 *
 * Migration 625 adds both constraints NOT VALID, so these rows survive the
 * deploy — but a NOT VALID constraint is still enforced on every UPDATE, and
 * the old canonicalizer allowed a fragment and userinfo through. Until the
 * rewrite fixes them, any write that touches such a row fails: the crawler
 * soft-deleting a stale authorization, for instance, which would abort the
 * whole manifest transaction. A non-zero count means the rewrite belongs in
 * the same maintenance window as the deploy, with the crawler paused.
 */
async function readKeysRejectedByConstraint(client: PoolClient) {
  const rejected: Array<{ table: string; constraint: string; rowCount: number }> = [];
  for (const [table, constraint] of [
    ['catalog_agent_authorizations', 'chk_caa_agent_url_canonical'],
    ['adagents_authorization_overrides', 'chk_aao_agent_url_canonical'],
  ] as const) {
    const { rows } = await client.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1`,
      [constraint],
    );
    if (rows.length === 0) continue;
    // Server-rendered SQL, not operator input. Strip the CHECK wrapper so
    // the predicate can be negated.
    const predicate = rows[0].def.replace(/^CHECK\s*/, '').replace(/\s*NOT VALID$/, '');
    const { rows: counted } = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM public.${quote(table)} WHERE NOT ${predicate}`,
    );
    const rowCount = Number(counted[0].count);
    if (rowCount > 0) rejected.push({ table, constraint, rowCount });
  }
  return rejected;
}

export interface StrandedSuppression {
  overrideId: string;
  hostDomain: string;
  overrideReason: string;
  propertyId: string | null;
  fromKey: string;
  toKey: string;
}

/**
 * Active `suppress` overrides that would stop matching their base rows.
 *
 * The suppress join in `v_effective_agent_authorizations` is exact key
 * equality, and the two sides are keyed from different raw strings: the base
 * row from the publisher's manifest, the override from the moderator's typed
 * URL. The old key folded their differences away. If an override's key moves
 * and no base row lands on the same key, the suppression silently stops
 * applying — a suppressed agent reappears in the registry with the override
 * row still showing as active, so the audit trail says it is still banned.
 *
 * Migration 625 keeps `bad_actor` suppressions matching on the folded form so
 * a ban cannot be lifted this way, but a `correction` or `file_broken`
 * suppression is exact by design. This blocks on any of them rather than
 * letting the rewrite decide.
 */
async function readStrandedSuppressions(client: PoolClient): Promise<StrandedSuppression[]> {
  const { rows } = await client.query<{
    id: string; host_domain: string; override_reason: string;
    property_id: string | null; agent_url: string; agent_url_canonical: string;
  }>(`
    SELECT id::text AS id, host_domain, override_reason, property_id,
           agent_url, agent_url_canonical
      FROM adagents_authorization_overrides
     WHERE superseded_at IS NULL AND override_type = 'suppress'
  `);
  if (rows.length === 0) return [];
  const { rows: baseRows } = await client.query<{
    publisher_domain: string; agent_url: string; agent_url_canonical: string;
  }>(`
    SELECT COALESCE(caa.publisher_domain,
                    regexp_replace(cp.created_by, '^[^:]+:', '')) AS publisher_domain,
           caa.agent_url, caa.agent_url_canonical
      FROM catalog_agent_authorizations caa
      LEFT JOIN catalog_properties cp ON cp.property_rid = caa.property_rid
     WHERE caa.deleted_at IS NULL AND caa.evidence = 'adagents_json'
  `);
  const live = baseRows.filter(row => row.publisher_domain !== null);
  // What the suppression matches today, and what it will match once every
  // base row has been rekeyed.
  const currentBaseKeys = new Set(live
    .map(row => `${row.publisher_domain}\u0000${row.agent_url_canonical}`));
  const futureBaseKeys = new Set(live
    .map(row => `${row.publisher_domain}\u0000${registryAgentUrlLookupKey(row.agent_url)}`));
  const stranded: StrandedSuppression[] = [];
  for (const row of rows) {
    const toKey = registryAgentUrlKey(row.agent_url) ?? row.agent_url_canonical;
    if (futureBaseKeys.has(`${row.host_domain}\u0000${toKey}`)) continue;
    // Only a suppression that currently matches something can be stranded.
    if (!currentBaseKeys.has(`${row.host_domain}\u0000${row.agent_url_canonical}`)) continue;
    stranded.push({
      overrideId: row.id,
      hostDomain: row.host_domain,
      overrideReason: row.override_reason,
      propertyId: row.property_id,
      fromKey: row.agent_url_canonical,
      toKey,
    });
  }
  return stranded;
}

export interface MigrationOptions {
  apply: boolean;
  /** Restrict the run to these stores. Defaults to every store. */
  stores?: readonly string[];
}

export async function runMigration(
  options: boolean | MigrationOptions,
): Promise<{ blocked: boolean }> {
  const { apply, stores } =
    typeof options === 'boolean' ? { apply: options, stores: undefined } : options;
  const selected = (store: string) => stores === undefined || stores.includes(store);
  const pool = getPool();
  const client = await pool.connect();
  const planned: Array<{ store: TableStore | null; plan: StorePlan }> = [];
  let reportOnlyGap: Array<{ table: string; reason: string; changedUrls: string[] }> = [];
  let strandedSuppressions: StrandedSuppression[] = [];
  let rawSources = new Map<string, Set<string>>();
  let keysRejectedByConstraint: Array<{ table: string; constraint: string; rowCount: number }> = [];
  try {
    // One repeatable-read snapshot for planning, so every store is planned
    // against the same instant and a concurrent write cannot make the report
    // internally inconsistent.
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout = '300s'");
    for (const store of await discoverStores(client)) {
      if (!selected(store.table)) continue;
      // A self-keyed table has no independent raw URL: whatever the old
      // algorithm destroyed is not recoverable from the row.
      const rawIsDerived = store.keyColumn === store.sourceColumn;
      planned.push({
        store,
        plan: planStoreRewrite(store.table, await readTable(client, store), rawIsDerived),
      });
    }
    if (selected(PROFILE_AGENTS_STORE)) {
      planned.push({
        store: null,
        plan: planStoreRewrite(
          PROFILE_AGENTS_STORE, profileAgentRows(await readProfiles(client)), true),
      });
    }
    reportOnlyGap = await readReportOnlyGap(client);
    strandedSuppressions = await readStrandedSuppressions(client);
    rawSources = await readRawUrlSources(client);
    keysRejectedByConstraint = await readKeysRejectedByConstraint(client);
  } finally {
    // Always roll back, including on the way out of a throw: the connection
    // goes back to the pool, and one left inside an aborted READ ONLY
    // transaction fails every later caller with a misleading error.
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }

  const unmodelled = planned.flatMap(entry =>
    (entry.store?.unmodelledIndexes ?? []).map(index => ({ store: entry.store!.table, index })));
  const blocked = planned.some(entry => planIsBlocked(entry.plan))
    || unmodelled.length > 0
    || strandedSuppressions.length > 0;
  console.log(JSON.stringify({
    issue: 7830,
    mode: apply ? 'apply' : 'dry-run',
    ...(stores === undefined ? {} : { onlyStores: stores }),
    blocked,
    stores: planned.map(entry => summarize(entry.plan, rawSources)),
    // Unique indexes on a key column whose scope this script cannot model.
    // Merge detection would be blind to them, so they block.
    unmodelledUniqueIndexes: unmodelled,
    // Active suppressions that would stop matching a base row. Blocks: a
    // suppression that silently stops applying is a ban that silently lifts.
    strandedSuppressions,
    // Rows no write can touch until the rewrite fixes them — see
    // readKeysRejectedByConstraint. Not blocking: the rewrite is the fix.
    keysRejectedByConstraint,
    // Not rewritten by design — see REPORT_ONLY_STORES.
    reportOnlyStoresNotRewritten: reportOnlyGap,
  }, null, 2));

  if (!apply) {
    console.log(blocked
      ? '\nBlocked. Resolve the items above, then re-run. Nothing was written.'
      : '\nDry run complete. Nothing was written. Pass --apply to rewrite.');
    return { blocked };
  }
  if (blocked) {
    throw new Error(
      'Refusing to apply: a store has a merge or chain collision, a row whose URL no '
      + 'longer produces a key, a unique index whose scope cannot be modelled, or an '
      + 'active suppression that would stop matching. Resolve them by hand — the '
      + 'rewrite must not pick a winner.',
    );
  }

  // One transaction for every table. Per-store transactions would be the
  // wrong granularity: compliance-db.ts joins agent_registry_metadata to
  // agent_compliance_status to agent_verification_badges on agent_url, so
  // between two store commits those joins return nothing for every rewritten
  // agent. Here a failure means nothing happened.
  const writer = await pool.connect();
  try {
    await writer.query('BEGIN');
    await writer.query("SET LOCAL statement_timeout = '600s'");
    for (const { store, plan } of planned) {
      if (store === null) continue;
      const { updated, skipped } = await applyTableRewrite(writer, store, plan);
      console.log(`${plan.store}: rewrote ${updated} row(s)`
        + (skipped > 0 ? `, skipped ${skipped} that changed under the plan` : ''));
    }
    await writer.query('COMMIT');
  } catch (error) {
    await writer.query('ROLLBACK');
    throw error;
  } finally {
    writer.release();
  }

  // Separate pass so each profile can be re-read FOR UPDATE and re-keyed
  // from what is actually stored.
  const profileEntry = planned.find(entry => entry.store === null);
  if (profileEntry) {
    const profileWriter = await pool.connect();
    try {
      await profileWriter.query('BEGIN');
      await profileWriter.query("SET LOCAL statement_timeout = '600s'");
      const updated = await applyProfileRewrite(profileWriter, profileEntry.plan);
      await profileWriter.query('COMMIT');
      console.log(`${PROFILE_AGENTS_STORE}: rewrote ${updated} profile(s)`);
    } catch (error) {
      await profileWriter.query('ROLLBACK');
      throw error;
    } finally {
      profileWriter.release();
    }
  }

  // Turn migration 625's "enforced from here on" into "proven for every row".
  // A scoped run only proves the store it touched.
  const validator = await pool.connect();
  try {
    if (selected('catalog_agent_authorizations')) {
      await validator.query(
        'ALTER TABLE catalog_agent_authorizations VALIDATE CONSTRAINT chk_caa_agent_url_canonical');
      console.log('Validated chk_caa_agent_url_canonical.');
    }
    if (selected('adagents_authorization_overrides')) {
      await validator.query(
        'ALTER TABLE adagents_authorization_overrides VALIDATE CONSTRAINT chk_aao_agent_url_canonical');
      console.log('Validated chk_aao_agent_url_canonical.');
    }
  } finally {
    validator.release();
  }
  return { blocked: false };
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const only = process.argv
    .filter(arg => arg.startsWith('--only='))
    .map(arg => arg.slice('--only='.length));
  const config = getDatabaseConfig();
  if (!config) throw new Error('DATABASE_URL is required');
  initializeDatabase(config);
  try {
    const known = new Set([...REWRITE_STORES, PROFILE_AGENTS_STORE]);
    for (const store of only) {
      if (!known.has(store)) {
        throw new Error(`Unknown store ${store}. Rewritable stores: ${[...known].sort().join(', ')}`);
      }
    }
    const { blocked } = await runMigration({
      apply,
      ...(only.length > 0 ? { stores: only } : {}),
    });
    if (blocked) process.exitCode = 1;
  } finally {
    await closeDatabase();
  }
}

// Only run when invoked directly, so tests can import runMigration without
// opening a pool or writing anything.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error('Registry agent-URL key migration failed:', error);
    process.exitCode = 1;
  });
}
