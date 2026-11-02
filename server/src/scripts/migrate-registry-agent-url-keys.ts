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
 * PAUSING THE WORKERS DOES NOT SURVIVE THE DEPLOY. Observed in the #7830
 * production run on 2026-10-18: `flyctl deploy --process-groups worker`
 * recreated the worker group with 2 machines (HA) even though it had been
 * scaled to 0 beforehand. The crawler and compliance runner were therefore
 * live again before the rewrite started. Re-apply the pause AFTER the worker
 * rollout finishes — or stop the workers by some means a deploy cannot undo —
 * and re-run the dry run before `--apply`, because writes landing in that
 * window create collisions that were not in the reviewed plan.
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
import {
  DERIVED_KEY_SCOPES,
  MERGE_POLICIES,
  PROFILE_AGENTS_STORE,
  REPORT_ONLY_STORES,
  REWRITE_STORES,
  keyScopesFor,
  quoteIdentifier,
  type CombineRule,
  type KeyScope,
  type MergePolicy,
} from './registry-key-stores.js';

export { PROFILE_AGENTS_STORE };

interface TableStore {
  table: string;
  /** Column the key is written to. */
  keyColumn: string;
  /** Column the key is computed from. Equal to keyColumn when self-keyed. */
  sourceColumn: string;
  scopes: KeyScope[];
  /** True when the scope came from DERIVED_KEY_SCOPES rather than pg_index. */
  derivedScope: boolean;
}

interface ProfileAgents {
  id: string;
  slug: string;
  agents: Array<Record<string, unknown>>;
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

  const unclassified = tables
    .map(table => table.table_name)
    .filter(table => !REWRITE_STORES.has(table) && !REPORT_ONLY_STORES.has(table));
  if (unclassified.length > 0) {
    throw new Error(
      `Unclassified agent_url table(s): ${unclassified.join(', ')}. Add each to `
      + 'REWRITE_STORES (an identity store a reader looks rows up in) or to '
      + 'REPORT_ONLY_STORES with a reason, in '
      + 'server/src/scripts/registry-key-stores.ts. Refusing to run: rewriting '
      + 'an unclassified store, or silently leaving one on the old key, are '
      + 'both ways to lose data.',
    );
  }

  const stores: TableStore[] = [];
  for (const table of tables) {
    if (!REWRITE_STORES.has(table.table_name)) continue;
    const keyColumn = table.has_canonical ? 'agent_url_canonical' : 'agent_url';
    // keyScopesFor throws on a unique index it cannot model, rather than
    // leaving merge detection blind to it.
    const scopes = await keyScopesFor(client, table.table_name, keyColumn);
    stores.push({
      table: table.table_name,
      keyColumn,
      sourceColumn: 'agent_url',
      scopes,
      derivedScope: DERIVED_KEY_SCOPES[table.table_name] !== undefined,
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
  const scopeSelects = store.scopes.map((scope, index) => {
    const tuple = scope.columns.length === 0
      ? `''`
      : scope.columns.map(column => `COALESCE(${quoteIdentifier(column)}::text, '')`).join(` || E'\\n' || `);
    // Outside a partial index's predicate the row is not constrained by it,
    // which takes a tombstoned or superseded row out of collision detection
    // without taking it out of the rewrite.
    const guarded = scope.predicate === null ? tuple : `CASE WHEN ${scope.predicate} THEN ${tuple} END`;
    return `(${guarded}) AS scope_${index}`;
  });
  const scopeCount = scopeSelects.length;
  const derived = store.keyColumn !== store.sourceColumn;

  const sql = derived
    ? `SELECT id::text AS row_id, ${quoteIdentifier(store.sourceColumn)} AS raw_url,
              ${quoteIdentifier(store.keyColumn)} AS stored_key${scopeSelects.map(s => `, ${s}`).join('')}
         FROM public.${quoteIdentifier(store.table)}`
    // Self-keyed tables are rewritten by value, so only the distinct
    // (url, scope…) tuples matter — a history table with a million rows per
    // agent is planned from a handful. Positional GROUP BY avoids repeating
    // the partial-index CASE expressions.
    : `SELECT ${quoteIdentifier(store.keyColumn)} AS row_id, ${quoteIdentifier(store.keyColumn)} AS raw_url,
              ${quoteIdentifier(store.keyColumn)} AS stored_key${scopeSelects.map(s => `, ${s}`).join('')}
         FROM public.${quoteIdentifier(store.table)}
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
    ? `t.id::text = r.row_id AND t.${quoteIdentifier(store.sourceColumn)} = r.raw_url`
    : `t.${quoteIdentifier(store.keyColumn)} = r.row_id AND t.${quoteIdentifier(store.sourceColumn)} = r.raw_url`;
  const { rowCount } = await client.query(
    `UPDATE public.${quoteIdentifier(store.table)} AS t
        SET ${quoteIdentifier(store.keyColumn)} = r.new_key
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
      // The key folds a trailing slash for identity; authorization matching
      // is spec-exact (#7829). Keep what was registered so
      // find_agents_for_property still matches the publisher's manifest.
      return {
        ...agent,
        url: key,
        ...(agent.declared_url === undefined ? { declared_url: agent.url } : {}),
      };
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

// =============================================================================
// Merge
// =============================================================================

export interface MergeDrop {
  /** Stored key of the row whose value is not carried into the merged row. */
  rowKey: string;
  column: string;
  dropped: unknown;
  kept: unknown;
}

export interface MergeAction {
  table: string;
  index: string;
  /** The key every row in this group lands on. */
  toKey: string;
  /** The rest of the uniqueness tuple, column => value. */
  scope: Record<string, string | null>;
  /**
   * The unique index's partial predicate, or null. It is part of the
   * identity of the group: `idx_caa_unique_active` and
   * `idx_aao_unique_active` only constrain live rows, so a tombstoned or
   * superseded row sharing the same key and scope is NOT in this collision
   * and must not be read, ranked or deleted with it.
   */
  predicate: string | null;
  winnerKey: string;
  loserKeys: string[];
  /** Columns the policy composes, with the value the merged row gets. */
  merged: Record<string, unknown>;
  /**
   * Every value a losing row held that the merged row does not. This is the
   * "nothing is dropped silently" guarantee — it is printed in the dry run
   * and again on apply.
   */
  drops: MergeDrop[];
  rationale: string;
}

type Row = Record<string, unknown>;

function compareValues(a: unknown, b: unknown, order?: readonly string[]): number {
  if (order) {
    const ia = order.indexOf(String(a));
    const ib = order.indexOf(String(b));
    return ia === ib ? 0 : ia < ib ? -1 : 1;
  }
  if (a === b) return 0;
  // NULL sorts lowest, so `desc` puts a row that has a value above one that
  // does not — "most recently checked" must not lose to "never checked".
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

/** Rank a collision group best-first, deterministically. */
function rankRows(rows: Row[], policy: MergePolicy, keyColumn: string): Row[] {
  return [...rows].sort((left, right) => {
    for (const rule of policy.rank) {
      const cmp = compareValues(left[rule.column], right[rule.column], rule.order);
      if (cmp !== 0) return rule.direction === 'desc' ? -cmp : cmp;
    }
    // Stored key as the final tiebreak: two runs over the same data must
    // pick the same winner, or a dry run does not describe the apply.
    return String(left[keyColumn]) < String(right[keyColumn]) ? -1 : 1;
  });
}

function combineColumn(rows: Row[], column: string, rule: CombineRule): unknown {
  if (rule.kind === 'reset') return rule.value;
  const values = rows.map(row => row[column]).filter(value => value !== null && value !== undefined);
  if (rule.kind === 'anyTrue') return values.some(Boolean);
  if (values.length === 0) return null;
  if (rule.kind === 'min') {
    return values.reduce((best, value) => (compareValues(value, best) < 0 ? value : best));
  }
  const max = values.reduce((best, value) => (compareValues(value, best) > 0 ? value : best));
  if (rule.kind === 'max') return max;
  // maxPlusOne: bigint columns come back from pg as strings.
  return (BigInt(String(max)) + 1n).toString();
}

/**
 * Turn a store's merge collisions into an explicit, reviewable plan.
 *
 * Reads only the rows that actually collide: the plan already knows which
 * stored keys they are, so a table with a million rows and two collisions
 * costs two lookups rather than a full scan.
 */
async function planMerges(
  client: PoolClient,
  store: TableStore,
  plan: StorePlan,
): Promise<MergeAction[]> {
  const policy = MERGE_POLICIES[store.table];
  if (policy === undefined || plan.merges.length === 0) return [];
  const identifier = `public.${quoteIdentifier(store.table)}`;
  const keyColumn = quoteIdentifier(store.keyColumn);
  const actions: MergeAction[] = [];

  for (const collision of plan.merges) {
    const storedKeys = [...new Set(collision.rows.map(row => row.storedKey))];
    const scope = store.scopes.find(entry => collision.scope.startsWith(`${store.scopes.indexOf(entry)}\u0000`))
      ?? store.scopes[0];
    const scopeColumns = scope?.columns ?? [];
    const scopeValues = collision.scope.slice(collision.scope.indexOf('\u0000') + 1).split('\n');
    // The predicate is not optional. Without it this re-read pulls in
    // tombstoned and superseded rows that the plan deliberately excluded —
    // and `rankRows` would happily crown one: a superseded bad_actor
    // override outranks a live correction, a soft-deleted authorization
    // with a fresh updated_at outranks the live grant. The live rows would
    // then be deleted as losers, dropping an authorization or lifting a ban.
    const filters = [`${keyColumn} = ANY($1::text[])`];
    scopeColumns.forEach((column, index) => {
      filters.push(`coalesce(${quoteIdentifier(column)}::text, '') = $${index + 2}`);
    });
    if (scope?.predicate) filters.push(`(${scope.predicate})`);
    const scopeParams = scopeColumns.map((_, index) => scopeValues[index] ?? '');
    const { rows } = await client.query<Row>(
      `SELECT * FROM ${identifier} WHERE ${filters.join(' AND ')}`,
      [storedKeys, ...scopeParams],
    );
    if (rows.length < 2) continue;

    const ranked = rankRows(rows, policy, store.keyColumn);
    const [winner, ...losers] = ranked;
    const merged: Record<string, unknown> = {};
    for (const [column, rule] of Object.entries(policy.combine)) {
      if (!(column in winner)) continue;
      merged[column] = combineColumn(ranked, column, rule);
    }
    // Everything the merged row will NOT carry, column by column, so no
    // value disappears without appearing in the report first.
    const drops: MergeDrop[] = [];
    for (const loser of losers) {
      for (const column of Object.keys(loser)) {
        if (column === store.keyColumn || scopeColumns.includes(column)) continue;
        const keptValue = column in merged ? merged[column] : winner[column];
        const loserValue = loser[column];
        if (loserValue === null || loserValue === undefined) continue;
        if (JSON.stringify(loserValue) === JSON.stringify(keptValue)) continue;
        drops.push({
          rowKey: String(loser[store.keyColumn]),
          column,
          dropped: loserValue,
          kept: keptValue ?? null,
        });
      }
    }
    actions.push({
      table: store.table,
      index: scope?.indexName ?? 'unknown',
      toKey: collision.key,
      scope: Object.fromEntries(scopeColumns.map((column, index) => [column, scopeValues[index] ?? ''])),
      predicate: scope?.predicate ?? null,
      winnerKey: String(winner[store.keyColumn]),
      loserKeys: losers.map(loser => String(loser[store.keyColumn])),
      merged,
      drops,
      rationale: policy.rationale,
    });
  }
  return actions;
}

/**
 * Delete the losing rows, then move the winner onto the merged key and
 * values. Losers go first so the winner's key change cannot trip the unique
 * index on a row that is about to disappear.
 */
async function applyMerges(
  client: PoolClient,
  store: TableStore,
  actions: MergeAction[],
): Promise<number> {
  let merged = 0;
  for (const action of actions) {
    const identifier = `public.${quoteIdentifier(store.table)}`;
    const keyColumn = quoteIdentifier(store.keyColumn);
    const scopeColumns = Object.keys(action.scope);
    // Same predicate the plan was built under — see MergeAction.predicate.
    // Without it the DELETE would remove tombstoned rows the plan never
    // looked at, and the UPDATE could land on one.
    const scopeConditions = scopeColumns
      .map((column, index) => `coalesce(${quoteIdentifier(column)}::text, '') = $${index + 2}`);
    if (action.predicate) scopeConditions.push(`(${action.predicate})`);
    const scopeFilter = scopeConditions.length > 0 ? ` AND ${scopeConditions.join(' AND ')}` : '';
    const scopeParams = scopeColumns.map(column => action.scope[column] ?? '');
    await client.query(
      `DELETE FROM ${identifier}
        WHERE ${keyColumn} = ANY($1::text[])${scopeFilter}`,
      [action.loserKeys, ...scopeParams],
    );
    const assignments = [`${keyColumn} = $${scopeParams.length + 2}`];
    const values: unknown[] = [action.winnerKey, ...scopeParams, action.toKey];
    for (const [column, value] of Object.entries(action.merged)) {
      values.push(value);
      assignments.push(`${quoteIdentifier(column)} = $${values.length}`);
    }
    const { rowCount } = await client.query(
      `UPDATE ${identifier} SET ${assignments.join(', ')}
        WHERE ${keyColumn} = $1${scopeFilter}`,
      values,
    );
    merged += rowCount ?? 0;
  }
  return merged;
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

function summarize(
  plan: StorePlan,
  rawSources: Map<string, Set<string>>,
  merges: MergeAction[],
) {
  return {
    store: plan.store,
    rowCount: plan.rowCount,
    rewriteCount: plan.rewrites.length,
    mergeCount: merges.length,
    // Every fold, with the row that survives, the rows that do not, and
    // every value the merged row does not carry.
    merges,
    blocked: planIsBlocked(plan) && merges.length !== plan.merges.length,
    rewrites: plan.rewrites,
    unkeyable: plan.unkeyable,
    /** The raw collisions, before the policy resolved them into `merges`. */
    mergeCollisions: plan.merges,
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
      `SELECT DISTINCT agent_url FROM public.${quoteIdentifier(table)} WHERE agent_url IS NOT NULL`);
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
      `SELECT count(*)::text AS count FROM public.${quoteIdentifier(table)} WHERE NOT ${predicate}`,
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
  const planned: Array<{
    store: TableStore | null; plan: StorePlan; merges: MergeAction[];
  }> = [];
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
      const plan = planStoreRewrite(store.table, await readTable(client, store), rawIsDerived);
      planned.push({ store, plan, merges: await planMerges(client, store, plan) });
    }
    if (selected(PROFILE_AGENTS_STORE)) {
      planned.push({
        store: null,
        plan: planStoreRewrite(
          PROFILE_AGENTS_STORE, profileAgentRows(await readProfiles(client)), true),
        merges: [],
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

  // A merge collision is only blocking when the table has no policy to
  // resolve it. planMerges returns one action per resolvable collision, so a
  // shortfall means at least one was left unexplained.
  const unresolvedMerges = planned.flatMap(entry =>
    entry.plan.merges.slice(entry.merges.length).map(collision => ({
      store: entry.plan.store,
      key: collision.key,
      storedKeys: [...new Set(collision.rows.map(row => row.storedKey))],
      reason: MERGE_POLICIES[entry.plan.store] === undefined
        ? 'no merge policy for this store — resolve by hand'
        : 'policy exists but the group could not be planned; inspect the rows',
    })));
  const blocked = planned.some(entry =>
      entry.plan.unkeyable.length > 0 || entry.plan.chains.length > 0)
    || unresolvedMerges.length > 0
    || strandedSuppressions.length > 0;
  console.log(JSON.stringify({
    issue: 7830,
    mode: apply ? 'apply' : 'dry-run',
    ...(stores === undefined ? {} : { onlyStores: stores }),
    blocked,
    stores: planned.map(entry => summarize(entry.plan, rawSources, entry.merges)),
    // Collisions a policy cannot resolve. Each one blocks.
    unresolvedMerges,
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
      'Refusing to apply: a store has a chain collision, a merge collision with no '
      + 'policy to resolve it, a row whose URL no longer produces a key, or an active '
      + 'suppression that would stop matching. Resolve them by hand — the rewrite '
      + 'must not pick a winner it was not told how to pick.',
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
    for (const { store, plan, merges } of planned) {
      if (store === null) continue;
      // Merges first: they delete the losing rows, which is what frees the
      // key the surviving row is about to move onto.
      const mergedRows = await applyMerges(writer, store, merges);
      for (const action of merges) {
        console.log(
          `${plan.store}: folded ${action.loserKeys.join(', ')} into ${action.winnerKey} `
          + `-> ${action.toKey}`
          + (action.drops.length > 0
            ? `\n  dropped: ${action.drops.map(d => `${d.column}=${JSON.stringify(d.dropped)}`).join(', ')}`
            : ''));
      }
      const { updated, skipped } = await applyTableRewrite(writer, store, plan);
      console.log(`${plan.store}: merged ${mergedRows} row(s), rewrote ${updated} row(s)`
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
