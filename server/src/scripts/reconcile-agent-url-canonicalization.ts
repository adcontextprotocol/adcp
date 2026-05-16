/**
 * One-shot cleanup of pre-PR-#4551 non-canonical `agent_url` rows in
 * `agent_registry_metadata` and `member_profiles.agents`. Pairs the
 * audit script `audit-agent-url-canonicalization-collisions.ts`.
 *
 * Dry-run by default. Pass `--apply` to write.
 *
 * Scope:
 *   1. `agent_registry_metadata` — merge canonical-collision pairs into
 *      a single canonical-form row, applying the per-column merge rules
 *      below. Drop the non-canonical PK.
 *   2. `member_profiles.agents` (JSONB array) — rewrite each element's
 *      `url` to canonical form, deduping intra-profile collisions.
 *
 * Out of scope: the ~20 other tables that hold `agent_url` as a soft
 * pointer. PR #4551's read-side canonical-key + `?? raw` fallback in
 * `FederatedIndexService` is the documented strategy for those; this
 * script targets only the two stores with duplicate-row pathology
 * (compliance heartbeat double-counting, member-profile badge drop).
 *
 * Merge rules (`agent_registry_metadata`, per canonical key):
 *   - agent_url           → canonical form
 *   - lifecycle_stage     → from most-recently-updated row
 *   - compliance_opt_out  → TRUE if any row is TRUE  (conservative)
 *   - monitoring_paused   → TRUE if any row is TRUE  (conservative)
 *   - check_interval_hours→ MIN (more-frequent monitoring wins)
 *   - monitoring_paused_at→ MAX, non-null preferred
 *   - created_at          → MIN
 *   - updated_at          → MAX
 *
 * JSONB merge rules (`member_profiles.agents`, per profile, per canonical):
 *   - url        → canonical form
 *   - any other field — if siblings agree, take the shared value; if
 *                       siblings disagree, take the value from whichever
 *                       sibling's raw `url` was already canonical (matches
 *                       what the post-#4551 write path would produce). If
 *                       no sibling is canonical, take the first entry's
 *                       value. The drop is logged.
 *     (Empty/missing fields are dropped silently.)
 *
 * Usage (dev):
 *   DATABASE_URL=… npx tsx server/src/scripts/reconcile-agent-url-canonicalization.ts            # dry-run
 *   DATABASE_URL=… npx tsx server/src/scripts/reconcile-agent-url-canonicalization.ts --apply    # write
 *
 * Usage (prod):
 *   fly ssh console -a adcp-docs -C 'node /app/dist/scripts/reconcile-agent-url-canonicalization.js'           # dry-run
 *   fly ssh console -a adcp-docs -C 'node /app/dist/scripts/reconcile-agent-url-canonicalization.js --apply'   # write
 */

import { initializeDatabase, getPool, closeDatabase } from '../db/client.js';
import { getDatabaseConfig } from '../config.js';
import { canonicalizeAgentUrl } from '../db/publisher-db.js';

interface MetadataRow {
  agent_url: string;
  lifecycle_stage: string;
  compliance_opt_out: boolean;
  monitoring_paused: boolean;
  check_interval_hours: number;
  monitoring_paused_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface ProfileRow {
  id: string;
  slug: string;
  agents: Record<string, unknown>[];
}

function pickMostRecent<T extends { updated_at: Date; agent_url: string }>(rows: T[], canonical: string): T {
  // Ties on updated_at break toward the canonical-form row so the merged
  // lifecycle_stage matches what a fresh canonical write would produce.
  return rows.reduce((a, b) => {
    if (a.updated_at > b.updated_at) return a;
    if (b.updated_at > a.updated_at) return b;
    if (a.agent_url === canonical) return a;
    if (b.agent_url === canonical) return b;
    return a;
  });
}

function minDate(dates: Date[]): Date {
  return dates.reduce((a, b) => (a <= b ? a : b));
}

function maxDate(dates: Date[]): Date {
  return dates.reduce((a, b) => (a >= b ? a : b));
}

function maxNullableDate(dates: (Date | null)[]): Date | null {
  const nonNull = dates.filter((d): d is Date => d !== null);
  return nonNull.length === 0 ? null : maxDate(nonNull);
}

interface JsonbResolution {
  profile_slug: string;
  canonical: string;
  field: string;
  kept: unknown;
  dropped: unknown[];
}

function mergeJsonbAgents(
  profileSlug: string,
  agents: Record<string, unknown>[],
): { next: Record<string, unknown>[]; resolutions: JsonbResolution[]; changed: boolean } {
  // Group by canonical url. Preserve first-seen order.
  const groups = new Map<string, Record<string, unknown>[]>();
  const order: string[] = [];
  for (const elem of agents) {
    const rawUrl = typeof elem.url === 'string' ? elem.url : null;
    if (!rawUrl) {
      // Pass through elements without a url — defensive; never observed.
      const key = `__no_url_${order.length}`;
      groups.set(key, [elem]);
      order.push(key);
      continue;
    }
    const canonical = canonicalizeAgentUrl(rawUrl) ?? rawUrl;
    if (!groups.has(canonical)) {
      groups.set(canonical, []);
      order.push(canonical);
    }
    groups.get(canonical)!.push(elem);
  }

  const resolutions: JsonbResolution[] = [];
  const merged: Record<string, unknown>[] = [];
  let changed = false;

  for (const key of order) {
    const group = groups.get(key)!;
    if (group.length === 1) {
      const elem = group[0];
      const rawUrl = typeof elem.url === 'string' ? elem.url : null;
      if (rawUrl) {
        const canonical = canonicalizeAgentUrl(rawUrl);
        if (canonical && canonical !== rawUrl) {
          merged.push({ ...elem, url: canonical });
          changed = true;
          continue;
        }
      }
      merged.push(elem);
      continue;
    }

    // Two or more elements share a canonical key. Pick the "winner": the
    // sibling whose raw url already equals the canonical form. If none
    // is already canonical (all are slashed/cased variants — possible
    // only on pre-#4551 data where neither sibling was ever written
    // canonically), fall back to the first sibling in array order and
    // warn — operator should inspect.
    changed = true;
    let winner = group.find(e => e.url === key);
    if (!winner) {
      console.warn(
        `  WARN profile=${profileSlug} canonical=${key}: no canonical-form sibling; defaulting to first array element. Inspect manually.`,
      );
      winner = group[0];
    }
    const out: Record<string, unknown> = { ...winner, url: key };

    // Log any field where the winner kept its value over a non-empty
    // value from a sibling — these are decisions an operator should see.
    const fieldKeys = new Set<string>();
    for (const elem of group) for (const k of Object.keys(elem)) if (k !== 'url') fieldKeys.add(k);
    for (const f of fieldKeys) {
      const kept = winner[f];
      const dropped: unknown[] = [];
      for (const elem of group) {
        if (elem === winner) continue;
        const v = elem[f];
        if (v === null || v === undefined || v === '') continue;
        if (JSON.stringify(v) === JSON.stringify(kept)) continue;
        dropped.push(v);
      }
      if (dropped.length > 0) {
        resolutions.push({ profile_slug: profileSlug, canonical: key, field: f, kept, dropped });
      }
    }
    merged.push(out);
  }

  return { next: merged, resolutions, changed };
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');

  const dbConfig = getDatabaseConfig();
  if (!dbConfig) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  initializeDatabase(dbConfig);
  const pool = getPool();

  console.log(`=== agent_url reconciliation (${apply ? 'APPLY' : 'DRY-RUN'}) ===\n`);

  // ─── 1. agent_registry_metadata ──────────────────────────────────
  const metadataPairsQ = await pool.query<{ canonical: string }>(`
    SELECT regexp_replace(lower(trim(agent_url)), '/+$', '') AS canonical
    FROM agent_registry_metadata
    WHERE agent_url IS NOT NULL
    GROUP BY regexp_replace(lower(trim(agent_url)), '/+$', '')
    HAVING COUNT(DISTINCT agent_url) > 1
    ORDER BY canonical
  `);

  console.log(`1. agent_registry_metadata canonical pair-sets: ${metadataPairsQ.rowCount}\n`);

  let metadataMerged = 0;
  let metadataDeleted = 0;

  for (const { canonical } of metadataPairsQ.rows) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const rowsQ = await client.query<MetadataRow>(
        `SELECT * FROM agent_registry_metadata
         WHERE regexp_replace(lower(trim(agent_url)), '/+$', '') = $1
         ORDER BY agent_url
         FOR UPDATE`,
        [canonical],
      );
      const rows = rowsQ.rows;
      if (rows.length < 2) {
        await client.query('ROLLBACK');
        continue;
      }

      const mostRecent = pickMostRecent(rows, canonical);
      const merged = {
        agent_url: canonical,
        lifecycle_stage: mostRecent.lifecycle_stage,
        compliance_opt_out: rows.some(r => r.compliance_opt_out),
        monitoring_paused: rows.some(r => r.monitoring_paused),
        check_interval_hours: Math.min(...rows.map(r => r.check_interval_hours)),
        monitoring_paused_at: maxNullableDate(rows.map(r => r.monitoring_paused_at)),
        created_at: minDate(rows.map(r => r.created_at)),
        updated_at: maxDate(rows.map(r => r.updated_at)),
      };

      console.log(`  canonical=${canonical}`);
      for (const r of rows) {
        console.log(
          `    in:  url=${r.agent_url}  lifecycle=${r.lifecycle_stage}  opt_out=${r.compliance_opt_out}  paused=${r.monitoring_paused}  interval=${r.check_interval_hours}h  updated=${r.updated_at.toISOString()}`,
        );
      }
      console.log(
        `    out: url=${merged.agent_url}  lifecycle=${merged.lifecycle_stage}  opt_out=${merged.compliance_opt_out}  paused=${merged.monitoring_paused}  interval=${merged.check_interval_hours}h  updated=${merged.updated_at.toISOString()}`,
      );

      if (apply) {
        // Strategy: delete every row in the pair-set, then insert the
        // merged row. This avoids the UPDATE-PK-to-existing-value
        // conflict when the canonical row already exists; ON CONFLICT
        // on the insert would also work but is harder to reason about.
        await client.query(
          `DELETE FROM agent_registry_metadata
           WHERE regexp_replace(lower(trim(agent_url)), '/+$', '') = $1`,
          [canonical],
        );
        await client.query(
          `INSERT INTO agent_registry_metadata
            (agent_url, lifecycle_stage, compliance_opt_out, monitoring_paused,
             check_interval_hours, monitoring_paused_at, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            merged.agent_url,
            merged.lifecycle_stage,
            merged.compliance_opt_out,
            merged.monitoring_paused,
            merged.check_interval_hours,
            merged.monitoring_paused_at,
            merged.created_at,
            merged.updated_at,
          ],
        );
        await client.query('COMMIT');
      } else {
        await client.query('ROLLBACK');
      }

      metadataMerged += 1;
      metadataDeleted += rows.length - 1;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // Also: singleton non-canonical rows (no sibling). These won't double-
  // count anything but they keep the table on a different shape from the
  // new write path. Normalize them so the table is uniformly canonical
  // after this run. Skip any that would collide with an existing row.
  const singletonsQ = await pool.query<{ agent_url: string }>(`
    SELECT agent_url FROM agent_registry_metadata
    WHERE agent_url <> regexp_replace(lower(trim(agent_url)), '/+$', '')
      AND NOT EXISTS (
        SELECT 1 FROM agent_registry_metadata m2
        WHERE m2.agent_url = regexp_replace(lower(trim(agent_registry_metadata.agent_url)), '/+$', '')
      )
    ORDER BY agent_url
  `);

  console.log(`\n   Singleton non-canonical rows to normalize: ${singletonsQ.rowCount}`);
  let singletonsNormalized = 0;
  for (const { agent_url } of singletonsQ.rows) {
    const canonical = canonicalizeAgentUrl(agent_url);
    if (!canonical || canonical === agent_url) continue;
    console.log(`     ${agent_url}  →  ${canonical}`);
    if (!apply) continue;
    // Race with concurrent member-side writes: a writer could insert the
    // canonical PK between our SELECT above and the UPDATE below. Lock
    // both rows FOR UPDATE inside one transaction so the writer either
    // blocks on us (we win, our UPDATE conflicts → ON CONFLICT skip) or
    // we block on the writer (their canonical row already exists → skip).
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT agent_url FROM agent_registry_metadata
         WHERE agent_url IN ($1, $2) FOR UPDATE`,
        [agent_url, canonical],
      );
      const exists = await client.query(
        `SELECT 1 FROM agent_registry_metadata WHERE agent_url = $1`,
        [canonical],
      );
      if (exists.rowCount && exists.rowCount > 0) {
        console.log(`     (skip — canonical row appeared during run)`);
        await client.query('ROLLBACK');
        continue;
      }
      await client.query(
        `UPDATE agent_registry_metadata SET agent_url = $1 WHERE agent_url = $2`,
        [canonical, agent_url],
      );
      await client.query('COMMIT');
      singletonsNormalized += 1;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  console.log(
    `\n   metadata pairs merged: ${metadataMerged}, rows dropped: ${metadataDeleted}, singletons normalized: ${apply ? singletonsNormalized : singletonsQ.rowCount}\n`,
  );

  // ─── 2. member_profiles.agents ───────────────────────────────────
  const profilesQ = await pool.query<ProfileRow>(`
    SELECT id, slug, agents
    FROM member_profiles
    WHERE agents IS NOT NULL AND jsonb_array_length(agents) > 0
  `);

  let profilesTouched = 0;
  const allResolutions: JsonbResolution[] = [];

  for (const profile of profilesQ.rows) {
    const result = mergeJsonbAgents(profile.slug, profile.agents);
    if (!result.changed) continue;

    allResolutions.push(...result.resolutions);

    console.log(`  profile=${profile.slug} [${profile.id}]`);
    console.log(`    in:  ${JSON.stringify(profile.agents)}`);
    console.log(`    out: ${JSON.stringify(result.next)}`);
    for (const r of result.resolutions) {
      console.log(
        `    field=${r.field}  kept=${JSON.stringify(r.kept)}  dropped=${JSON.stringify(r.dropped)}`,
      );
    }

    profilesTouched += 1;
    if (apply) {
      await pool.query(
        `UPDATE member_profiles SET agents = $1::jsonb, updated_at = NOW() WHERE id = $2`,
        [JSON.stringify(result.next), profile.id],
      );
    }
  }

  console.log(
    `\n2. member_profiles touched: ${profilesTouched}, field resolutions (dropped non-empty sibling values): ${allResolutions.length}\n`,
  );

  if (!apply) {
    console.log('Dry-run complete. Pass --apply to write.');
  } else {
    console.log('Apply complete.');
  }

  await closeDatabase();
}

main().catch((err) => {
  console.error('reconciliation failed:', err);
  process.exit(1);
});
