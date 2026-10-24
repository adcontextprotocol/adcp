/**
 * Rewrite stored registry revision snapshots to the allowlisted shape.
 *
 * `brand_revisions.snapshot` and `property_revisions.snapshot` were written
 * from `SELECT *` registry rows, so historical rows can carry ownership,
 * contact and verification columns that the allowlists in
 * `db/registry-revision-snapshot.ts` now keep out. The read paths apply the
 * same allowlists, so nothing stored can be served as written; this script is
 * the data-at-rest half — it removes the fields from the rows themselves.
 *
 * It reproduces both passes a sanitizer makes: the row allowlist, and the
 * nested paths `sanitizeBrandSnapshot` strips below it
 * (`brand_manifest.classification`, `brand_manifest.brand_context` — the
 * classifier verdict that gates membership inheritance).
 *
 * Dry-run first and KEEP THE OUTPUT. Scrubbing is what makes the exposure
 * window unrecoverable from the database, so the report of which domains held
 * a `claim_token` or `verification_token` — the list that drives rotation —
 * can only be produced before the rewrite. Both modes print it before writing
 * anything.
 *
 * Order of operations: dry-run, rotate what the report names, re-run the
 * dry-run to confirm the rotation list is empty, then --apply. `--apply`
 * refuses to run while a live credential still matches a stored snapshot
 * value (override with `--allow-unrotated`).
 *
 * Usage:
 *   npx tsx server/src/scripts/scrub-registry-revision-snapshots.ts             # dry-run
 *   npx tsx server/src/scripts/scrub-registry-revision-snapshots.ts --apply     # write
 *
 *   fly ssh console -a adcp-docs -C 'node /app/dist/scripts/scrub-registry-revision-snapshots.js'
 *   fly ssh console -a adcp-docs -C 'node /app/dist/scripts/scrub-registry-revision-snapshots.js --apply'
 *
 * Idempotent: a second run reports zero affected rows.
 *
 * Prerequisites: DATABASE_URL set.
 */

import { initializeDatabase, getPool, closeDatabase } from '../db/client.js';
import { getDatabaseConfig } from '../config.js';
import {
  BRAND_REVISION_SNAPSHOT_FIELDS,
  PROPERTY_REVISION_SNAPSHOT_FIELDS,
} from '../db/registry-revision-snapshot.js';
import { DISALLOWED_MANIFEST_KEYS } from '../db/brand-db.js';

const apply = process.argv.includes('--apply');
const dryRun = !apply;
/** Escape hatch for the rotation preflight below. */
const allowUnrotated = process.argv.includes('--allow-unrotated');

/** Fields whose presence in a snapshot means the value behind it must be rotated. */
const ROTATABLE_FIELDS = ['claim_token', 'verification_token'] as const;

/**
 * Fields that are not credentials but were published to anyone: whoever owns
 * or created a record, and which org was claiming it. Reported per domain for
 * the same reason the tokens are — after the rewrite the mapping is gone, and
 * whether it needs a notification is a decision someone has to be able to make.
 */
const DISCLOSED_FIELDS = [
  'created_by_email',
  'workos_organization_id',
  'claimant_org_id',
  'prior_owner_org_id',
] as const;

interface RevisionTable {
  table: string;
  domainColumn: string;
  /**
   * Nested paths the snapshot sanitizer strips below the row level. The row
   * allowlist alone would leave these in place at rest, and for brands they
   * carry the classifier verdict that gates membership inheritance.
   */
  nestedPaths: string[][];
  /** The live table the snapshots were copied from, for the rotation preflight. */
  sourceTable: string;
  sourceDomainColumn: string;
  /** Credential columns the live table actually has. */
  sourceTokenColumns: string[];
  allowed: string[];
}

const TABLES: RevisionTable[] = [
  {
    table: 'property_revisions',
    domainColumn: 'publisher_domain',
    nestedPaths: [],
    sourceTable: 'hosted_properties',
    sourceDomainColumn: 'publisher_domain',
    sourceTokenColumns: ['claim_token', 'verification_token'],
    allowed: [...PROPERTY_REVISION_SNAPSHOT_FIELDS],
  },
  {
    table: 'brand_revisions',
    domainColumn: 'brand_domain',
    nestedPaths: [...DISALLOWED_MANIFEST_KEYS].map((key) => ['brand_manifest', key]),
    sourceTable: 'brands',
    sourceDomainColumn: 'domain',
    sourceTokenColumns: ['verification_token'],
    allowed: [...BRAND_REVISION_SNAPSHOT_FIELDS],
  },
];

/**
 * SQL for "this snapshot still holds something the sanitizers remove" —
 * a non-allowlisted top-level column, or a stripped nested path.
 * `$1` is the allowlist.
 */
function needsScrubSql(spec: RevisionTable): string {
  const nested = spec.nestedPaths
    .map((path) => ` OR snapshot #> '{${path.join(',')}}' IS NOT NULL`)
    .join('');
  return `jsonb_typeof(snapshot) = 'object'
      AND (EXISTS (SELECT 1 FROM jsonb_object_keys(snapshot) k WHERE k <> ALL($1::text[]))${nested})`;
}

/** The rewritten snapshot: allowlisted columns, minus the stripped paths. */
function scrubbedSnapshotSql(spec: RevisionTable): string {
  const strip = spec.nestedPaths.map((path) => ` #- '{${path.join(',')}}'`).join('');
  return `COALESCE(
            (SELECT jsonb_object_agg(k, v) FROM jsonb_each(snapshot) AS e(k, v) WHERE k = ANY($1::text[])),
            '{}'::jsonb
          )${strip}`;
}

/** Rows this script will touch, pre-filtered so a scalar snapshot never reaches a lateral join. */
function objectSnapshotRows(spec: RevisionTable): string {
  return `(SELECT * FROM ${spec.table} WHERE jsonb_typeof(snapshot) = 'object')`;
}

/** Per-domain report of which rows carried a named field, before anything is rewritten. */
async function domainsCarrying(spec: RevisionTable, fields: readonly string[]): Promise<Array<{ domain: string; fields: string[] }>> {
  const result = await getPool().query<{ domain: string; fields: string[] }>(
    `SELECT ${spec.domainColumn} AS domain, array_agg(DISTINCT k ORDER BY k) AS fields
       FROM ${objectSnapshotRows(spec)} t, LATERAL jsonb_object_keys(t.snapshot) k
      WHERE k = ANY($1::text[]) AND t.snapshot->>k IS NOT NULL
      GROUP BY ${spec.domainColumn} ORDER BY ${spec.domainColumn}`,
    [[...fields]],
  );
  return result.rows;
}

async function reportTable(spec: RevisionTable): Promise<number> {
  const pool = getPool();

  const total = await pool.query<{ count: string }>(`SELECT COUNT(*) AS count FROM ${spec.table}`);
  // `jsonb_object_keys` raises on a scalar or array. The column is NOT NULL
  // and every writer stringifies an object, but an ops script should report a
  // malformed row rather than abort the whole run on it.
  const affected = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM ${spec.table} WHERE ${needsScrubSql(spec)}`,
    [spec.allowed],
  );
  const malformed = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM ${spec.table} WHERE jsonb_typeof(snapshot) <> 'object'`,
  );
  if (parseInt(malformed.rows[0].count, 10) > 0) {
    console.log(`[${spec.table}] ${malformed.rows[0].count} snapshot(s) are not JSON objects — left alone, inspect by hand`);
  }
  const affectedCount = parseInt(affected.rows[0].count, 10);

  console.log(`[${spec.table}] ${total.rows[0].count} revisions, ${affectedCount} carrying non-allowlisted fields`);

  if (affectedCount === 0) return 0;

  const byField = await pool.query<{ field: string; count: string }>(
    `SELECT k AS field, COUNT(*) AS count
       FROM ${objectSnapshotRows(spec)} t, LATERAL jsonb_object_keys(t.snapshot) k
      WHERE k <> ALL($1::text[])
      GROUP BY k ORDER BY count DESC, field`,
    [spec.allowed],
  );
  for (const row of byField.rows) {
    console.log(`[${spec.table}]   ${row.field}: ${row.count}`);
  }
  for (const path of spec.nestedPaths) {
    const nested = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM ${spec.table}
        WHERE jsonb_typeof(snapshot) = 'object' AND snapshot #> '{${path.join(',')}}' IS NOT NULL`,
    );
    if (parseInt(nested.rows[0].count, 10) > 0) {
      console.log(`[${spec.table}]   ${path.join('.')}: ${nested.rows[0].count}`);
    }
  }

  // Both lists are printed before any write: the rewrite is what makes them
  // unreconstructable, and each drives a decision someone has to make.
  const rotatable = await domainsCarrying(spec, ROTATABLE_FIELDS);
  if (rotatable.length > 0) {
    console.log(`[${spec.table}] ROTATE — ${rotatable.length} domain(s) had a credential in a stored snapshot:`);
    for (const row of rotatable) {
      console.log(`[${spec.table}]   ${row.domain} (${row.fields.join(', ')})`);
    }
  } else {
    console.log(`[${spec.table}] no stored snapshot carried a non-null ${ROTATABLE_FIELDS.join(' / ')}`);
  }

  const disclosed = await domainsCarrying(spec, DISCLOSED_FIELDS);
  if (disclosed.length > 0) {
    console.log(`[${spec.table}] DISCLOSED — ${disclosed.length} domain(s) had owner or contact data in a stored snapshot:`);
    for (const row of disclosed) {
      console.log(`[${spec.table}]   ${row.domain} (${row.fields.join(', ')})`);
    }
  }

  return affectedCount;
}

async function scrubTable(spec: RevisionTable): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE ${spec.table}
          SET snapshot = ${scrubbedSnapshotSql(spec)}
        WHERE ${needsScrubSql(spec)}`,
      [spec.allowed],
    );
    await client.query('COMMIT');
    console.log(`[${spec.table}] COMMITTED — ${result.rowCount} row(s) rewritten`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`[${spec.table}] FAILED — rolled back:`, err);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Credentials that are still live AND still equal to a value a snapshot
 * holds. Rotation has to happen first: the scrub deletes the only record of
 * which value was exposed, so afterwards there is nothing left to match on.
 */
async function liveExposedTokens(spec: RevisionTable): Promise<Array<{ domain: string; column: string }>> {
  const pool = getPool();
  const found: Array<{ domain: string; column: string }> = [];
  for (const column of spec.sourceTokenColumns) {
    const result = await pool.query<{ domain: string }>(
      `SELECT src.${spec.sourceDomainColumn} AS domain
         FROM ${spec.sourceTable} src
        WHERE src.${column} IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM ${spec.table} rev
             WHERE rev.${spec.domainColumn} = src.${spec.sourceDomainColumn}
               AND rev.snapshot->>$1 = src.${column}
          )
        ORDER BY 1`,
      [column],
    );
    for (const row of result.rows) found.push({ domain: row.domain, column });
  }
  return found;
}

async function main(): Promise<void> {
  const dbConfig = getDatabaseConfig();
  if (!dbConfig) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  initializeDatabase(dbConfig);

  console.log('=== Scrub registry revision snapshots to the allowlisted shape ===');
  console.log(`Mode: ${dryRun ? 'DRY-RUN (no writes; pass --apply to persist)' : 'APPLY'}\n`);

  const unrotated: Array<{ table: string; domain: string; column: string }> = [];
  for (const spec of TABLES) {
    for (const hit of await liveExposedTokens(spec)) unrotated.push({ table: spec.table, ...hit });
  }
  if (unrotated.length > 0) {
    console.log('ROTATE FIRST — these credentials are still live and still match a stored snapshot:');
    for (const hit of unrotated) console.log(`  ${hit.table}: ${hit.domain} (${hit.column})`);
    console.log('');
    if (apply && !allowUnrotated) {
      console.error('Refusing to scrub: rotating after the scrub is impossible, because the scrub removes');
      console.error('the snapshot values this list is derived from. Rotate the credentials above, re-run');
      console.error('this script to confirm the list is empty, then --apply. Override with --allow-unrotated.');
      process.exit(2);
    }
  } else {
    console.log('No live credential still matches a stored snapshot value.\n');
  }

  for (const spec of TABLES) {
    const affected = await reportTable(spec);
    if (affected === 0) {
      console.log('');
      continue;
    }
    // A dry run takes no row locks and writes no WAL on a production table:
    // `reportTable` already counted the rows, so there is nothing an
    // UPDATE-then-ROLLBACK would tell us that is worth the lock.
    if (dryRun) console.log(`[${spec.table}] DRY-RUN — ${affected} row(s) would be rewritten; no write attempted`);
    else await scrubTable(spec);
    console.log('');
  }

  await closeDatabase();
}

main().catch((err) => {
  console.error('scrub failed:', err);
  process.exit(1);
});
