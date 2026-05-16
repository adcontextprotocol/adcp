/**
 * Audit `agent_url` collisions that would collapse under the canonicalizer
 * added in PR #4551 / issue #3573. Read-only — emits a report only.
 *
 * Two stores are surveyed:
 *
 *   1. `agent_registry_metadata` (PK = `agent_url`) — direct readers
 *      (compliance heartbeat, lifecycle dashboards) won't get the
 *      `FederatedIndexService` read-side fallback, so duplicates here
 *      are the ones that need a one-shot cleanup the most.
 *
 *   2. `member_profiles.agents` (JSONB array of {url, ...}) — duplicates
 *      here drive the badge-drop bug #3573 describes. PR #4551's
 *      canonical-key + `?? raw` fallback papers over reads, but the
 *      stored bytes stay non-canonical until the member next saves.
 *
 * Canonical form mirrors `canonicalizeAgentUrl` (publisher-db.ts):
 *   trim → lower → strip trailing slashes. Wildcards / whitespace-only
 *   rows are surfaced separately so an operator can decide what to do
 *   with them; they would canonicalize to null in JS.
 *
 * Usage (dev):
 *   DATABASE_URL=… npx tsx server/src/scripts/audit-agent-url-canonicalization-collisions.ts
 *
 * Usage (prod, via fly ssh):
 *   fly ssh console -a adcp-docs -C 'node /app/dist/scripts/audit-agent-url-canonicalization-collisions.js'
 */

import { initializeDatabase, getPool, closeDatabase } from '../db/client.js';
import { getDatabaseConfig } from '../config.js';

interface MetadataCollisionRow {
  canonical: string;
  raw_urls: string[];
  row_count: number;
}

interface ProfileCollisionRow {
  profile_id: string;
  profile_slug: string;
  canonical: string;
  raw_urls: string[];
  row_count: number;
}

interface CrossStoreMismatch {
  canonical: string;
  metadata_raw: string | null;
  profile_raws: string[];
}

async function main(): Promise<void> {
  const dbConfig = getDatabaseConfig();
  if (!dbConfig) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  initializeDatabase(dbConfig);
  const pool = getPool();

  // SQL canonicalization mirrors canonicalizeAgentUrl:
  //   trim → lower → strip 1+ trailing slashes.
  // `regexp_replace(..., '/+$', '')` strips all trailing slashes in one pass.
  // Wildcard '*' is kept literal (no trailing slashes to strip anyway).
  const sqlCanonical = `regexp_replace(lower(trim(agent_url)), '/+$', '')`;

  // 1. agent_registry_metadata collisions
  const metadataCollisions = await pool.query<MetadataCollisionRow>(`
    SELECT
      ${sqlCanonical} AS canonical,
      array_agg(DISTINCT agent_url ORDER BY agent_url) AS raw_urls,
      COUNT(*)::int AS row_count
    FROM agent_registry_metadata
    WHERE agent_url IS NOT NULL
    GROUP BY ${sqlCanonical}
    HAVING COUNT(DISTINCT agent_url) > 1
    ORDER BY COUNT(*) DESC, canonical
  `);

  // 2. member_profiles.agents JSONB collisions (within a single profile)
  const profileCollisions = await pool.query<ProfileCollisionRow>(`
    WITH unnested AS (
      SELECT
        mp.id AS profile_id,
        mp.slug AS profile_slug,
        (elem ->> 'url') AS raw_url,
        regexp_replace(lower(trim(elem ->> 'url')), '/+$', '') AS canonical
      FROM member_profiles mp,
           jsonb_array_elements(mp.agents) elem
      WHERE elem ->> 'url' IS NOT NULL
    )
    SELECT
      profile_id,
      profile_slug,
      canonical,
      array_agg(DISTINCT raw_url ORDER BY raw_url) AS raw_urls,
      COUNT(*)::int AS row_count
    FROM unnested
    GROUP BY profile_id, profile_slug, canonical
    HAVING COUNT(DISTINCT raw_url) > 1
    ORDER BY COUNT(*) DESC, profile_slug, canonical
  `);

  // 3. Cross-store mismatch — one canonical key shared between the two
  //    stores but with different raw spellings. This is the case that
  //    silently drops the member badge: registered side wrote one shape,
  //    discovered/metadata side has another.
  const crossStore = await pool.query<CrossStoreMismatch>(`
    WITH meta AS (
      SELECT
        agent_url AS raw,
        regexp_replace(lower(trim(agent_url)), '/+$', '') AS canonical
      FROM agent_registry_metadata
      WHERE agent_url IS NOT NULL
    ),
    profile_urls AS (
      SELECT DISTINCT
        (elem ->> 'url') AS raw,
        regexp_replace(lower(trim(elem ->> 'url')), '/+$', '') AS canonical
      FROM member_profiles mp,
           jsonb_array_elements(mp.agents) elem
      WHERE elem ->> 'url' IS NOT NULL
    ),
    joined AS (
      SELECT
        COALESCE(m.canonical, p.canonical) AS canonical,
        m.raw AS metadata_raw,
        p.raw AS profile_raw
      FROM meta m
      FULL OUTER JOIN profile_urls p ON m.canonical = p.canonical
    )
    SELECT
      canonical,
      MAX(metadata_raw) AS metadata_raw,
      array_agg(DISTINCT profile_raw) FILTER (WHERE profile_raw IS NOT NULL) AS profile_raws
    FROM joined
    GROUP BY canonical
    HAVING
      -- Drop the common case where both stores agree byte-for-byte.
      NOT (
        COUNT(DISTINCT metadata_raw) <= 1
        AND COUNT(DISTINCT profile_raw) <= 1
        AND (
          MAX(metadata_raw) IS NULL
          OR MAX(profile_raw) IS NULL
          OR MAX(metadata_raw) = MAX(profile_raw)
        )
      )
    ORDER BY canonical
  `);

  // 4. Whitespace / wildcard / null-canonical rows in metadata — these
  //    would canonicalize to null in JS and need operator attention
  //    regardless of #4551.
  const malformed = await pool.query<{ agent_url: string }>(`
    SELECT agent_url
    FROM agent_registry_metadata
    WHERE agent_url ~ '[[:space:]]'
       OR agent_url = ''
       OR agent_url LIKE '%*%'
  `);

  console.log('=== agent_url canonicalization sweep (PR #4551 / issue #3573) ===\n');

  console.log(`1. agent_registry_metadata collisions: ${metadataCollisions.rowCount}`);
  if (metadataCollisions.rowCount && metadataCollisions.rowCount > 0) {
    for (const row of metadataCollisions.rows) {
      console.log(`   canonical=${row.canonical}  rows=${row.row_count}`);
      for (const raw of row.raw_urls) console.log(`     - ${raw}`);
    }
  }
  console.log('');

  console.log(`2. member_profiles.agents intra-profile collisions: ${profileCollisions.rowCount}`);
  if (profileCollisions.rowCount && profileCollisions.rowCount > 0) {
    for (const row of profileCollisions.rows) {
      console.log(`   profile=${row.profile_slug} [${row.profile_id}]`);
      console.log(`     canonical=${row.canonical}  rows=${row.row_count}`);
      for (const raw of row.raw_urls) console.log(`     - ${raw}`);
    }
  }
  console.log('');

  console.log(`3. Cross-store mismatches (registered vs metadata raw spelling differs but canonical matches): ${crossStore.rowCount}`);
  if (crossStore.rowCount && crossStore.rowCount > 0) {
    for (const row of crossStore.rows) {
      console.log(`   canonical=${row.canonical}`);
      console.log(`     metadata_raw=${row.metadata_raw ?? '(missing)'}`);
      const profiles = row.profile_raws ?? [];
      if (profiles.length === 0) {
        console.log(`     profile_raws=(none)`);
      } else {
        for (const raw of profiles) console.log(`     profile_raw=${raw}`);
      }
    }
  }
  console.log('');

  console.log(`4. Malformed metadata rows (whitespace / wildcard / empty): ${malformed.rowCount}`);
  if (malformed.rowCount && malformed.rowCount > 0) {
    for (const row of malformed.rows) {
      console.log(`   - ${JSON.stringify(row.agent_url)}`);
    }
  }
  console.log('');

  const totalIssues =
    (metadataCollisions.rowCount ?? 0)
    + (profileCollisions.rowCount ?? 0)
    + (crossStore.rowCount ?? 0)
    + (malformed.rowCount ?? 0);

  if (totalIssues === 0) {
    console.log('Clean. No backfill needed; PR #4551 prevents new drift going forward.');
  } else {
    console.log(`Total findings: ${totalIssues}. A one-shot cleanup is warranted; see issue #3573 "out of scope" guidance.`);
  }

  await closeDatabase();
}

main().catch((err) => {
  console.error('audit failed:', err);
  process.exit(1);
});
