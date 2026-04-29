/**
 * Agent-side sync queries for catalog_agent_authorizations
 * (PR 4b-snapshots of #3177).
 *
 * Two read shapes for verification consumers, per
 * specs/registry-authorization-model.md:374-401:
 *
 *  1. getNarrow — small per-agent pull. A DSP, sales house, or agency
 *     fetches only the rows where it appears as `agent_url`. Indexed via
 *     idx_caa_by_agent (migration 440). Sub-millisecond at cardinality.
 *
 *  2. streamSnapshot — full bootstrap for inline verifiers that maintain
 *     a local copy. Streams via Postgres cursor in chunks so memory stays
 *     bounded as the table grows toward the long-run target (~5M rows,
 *     ~150-300 MB gzipped on the wire).
 *
 * Both shapes share two query knobs:
 *  - `include`: 'effective' (default) reads from
 *    v_effective_agent_authorizations; 'raw' reads from
 *    catalog_agent_authorizations directly with deleted_at IS NULL.
 *  - `evidence`: CSV of evidence values to include. Defaults to
 *    ['adagents_json'] only — `agent_claim` is opt-in by spec line 391
 *    to prevent buy-side trust footgun.
 *
 * X-Sync-Cursor is read once per call from
 *   SELECT MAX(event_id) FROM catalog_events WHERE entity_type='authorization'
 * and represents the change-feed position consumers tail from after
 * applying the snapshot. The all-zeros UUID
 * '00000000-0000-7000-8000-000000000000' is returned when zero events
 * exist so the consumer can hand it to /api/registry/feed unchanged.
 */

import type { PoolClient } from 'pg';
import { getClient, query } from './client.js';
import { createLogger } from '../logger.js';

const log = createLogger('authorization-snapshot-db');

/** Empty-feed sentinel — UUIDv7 with all-zero fields. */
const EMPTY_CURSOR = '00000000-0000-7000-8000-000000000000';

const VALID_EVIDENCE = new Set(['adagents_json', 'agent_claim', 'community', 'override']);
const DEFAULT_EVIDENCE: ReadonlyArray<string> = ['adagents_json'];

const VALID_INCLUDE = new Set(['raw', 'effective']);
const DEFAULT_INCLUDE: 'effective' = 'effective';

/** Streaming chunk size for the Postgres cursor. */
const SNAPSHOT_CHUNK_SIZE = 10_000;

export type IncludeMode = 'raw' | 'effective';

export interface AuthRow {
  id: string;
  agent_url: string;
  agent_url_canonical: string;
  property_rid: string | null;
  property_id_slug: string | null;
  publisher_domain: string | null;
  authorized_for: string | null;
  evidence: string;
  disputed: boolean;
  created_by: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  override_applied: boolean;
  override_reason: string | null;
}

export interface NarrowOpts {
  agentUrlCanonical: string;
  evidence: ReadonlyArray<string>;
  include: IncludeMode;
}

export interface SnapshotOpts {
  evidence: ReadonlyArray<string>;
  include: IncludeMode;
}

export interface NarrowResult {
  rows: AuthRow[];
  cursor: string;
}

export class EvidenceValidationError extends Error {
  readonly code = 'invalid_evidence';
  constructor(public readonly badValue: string) {
    super(`Invalid evidence value: ${badValue}. Expected one of: ${[...VALID_EVIDENCE].join(', ')}.`);
    this.name = 'EvidenceValidationError';
  }
}

export class IncludeValidationError extends Error {
  readonly code = 'invalid_include';
  constructor(public readonly badValue: string) {
    super(`Invalid include value: ${badValue}. Expected 'raw' or 'effective'.`);
    this.name = 'IncludeValidationError';
  }
}

/**
 * Parse and validate an `evidence` CSV from a query string. Returns the
 * default (`['adagents_json']`) when the param is missing or empty.
 *
 * Throws EvidenceValidationError on unknown values rather than silently
 * dropping them — the spec's default-exclude-agent_claim contract is
 * load-bearing and an unrecognized value here is a caller bug, not a
 * filter we should ignore.
 */
export function parseEvidenceParam(raw: string | undefined): ReadonlyArray<string> {
  if (raw === undefined || raw === null) return DEFAULT_EVIDENCE;
  const parts = raw
    .split(',')
    .map(v => v.trim())
    .filter(v => v.length > 0);
  if (parts.length === 0) return DEFAULT_EVIDENCE;
  for (const v of parts) {
    if (!VALID_EVIDENCE.has(v)) throw new EvidenceValidationError(v);
  }
  return parts;
}

/**
 * Parse and validate the `include` query param. Returns 'effective' when
 * missing.
 */
export function parseIncludeParam(raw: string | undefined): IncludeMode {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_INCLUDE;
  if (!VALID_INCLUDE.has(raw)) throw new IncludeValidationError(raw);
  return raw as IncludeMode;
}

/**
 * Build the source table/view + extra columns for the SELECT.
 * `raw` reads catalog_agent_authorizations directly, with override_applied
 * forced to FALSE so the row shape stays uniform with the view's. The
 * raw arm intentionally does NOT join catalog_properties to derive
 * publisher_domain for per-property rows — those rows already carry
 * publisher_domain=NULL by schema constraint, and the consumer's local
 * copy resolves the JOIN itself when needed. Joining here would make
 * `raw` indistinguishable from `effective` for those rows.
 */
function selectClause(include: IncludeMode): string {
  if (include === 'effective') {
    return `
      SELECT
        id,
        agent_url,
        agent_url_canonical,
        property_rid,
        property_id_slug,
        publisher_domain,
        authorized_for,
        evidence,
        disputed,
        created_by,
        expires_at,
        created_at,
        updated_at,
        override_applied,
        override_reason
      FROM v_effective_agent_authorizations
    `;
  }
  return `
    SELECT
      id,
      agent_url,
      agent_url_canonical,
      property_rid,
      property_id_slug,
      publisher_domain,
      authorized_for,
      evidence,
      disputed,
      created_by,
      expires_at,
      created_at,
      updated_at,
      FALSE AS override_applied,
      NULL::text AS override_reason
    FROM catalog_agent_authorizations
    WHERE deleted_at IS NULL
  `;
}

/**
 * Returns the WHERE-clause connector — the view has no built-in WHERE,
 * so we start with WHERE; raw already has WHERE deleted_at IS NULL,
 * so subsequent predicates use AND.
 */
function whereConnector(include: IncludeMode): 'WHERE' | 'AND' {
  return include === 'effective' ? 'WHERE' : 'AND';
}

/**
 * Read the change-feed position to record alongside this snapshot. The
 * caller persists this as their `last_feed_cursor`; subsequent delta
 * pulls feed it to /api/registry/feed?cursor=<value>.
 *
 * Postgres has no MAX(uuid). The catalog_events_pkey B-tree on event_id
 * sorts ASC, so a `ORDER BY event_id DESC LIMIT 1` is the same shape
 * MAX() would compile to and is index-only. The
 * (entity_type, entity_id) secondary index narrows the scan when this
 * is one of many entity types in the table.
 *
 * Returns the all-zero UUIDv7 sentinel when zero authorization events
 * exist so the cursor is always a string the feed endpoint accepts.
 */
const SYNC_CURSOR_SQL = `
  SELECT event_id
    FROM catalog_events
   WHERE entity_type = 'authorization'
   ORDER BY event_id DESC
   LIMIT 1
`;

async function readSyncCursor(client: PoolClient): Promise<string> {
  const { rows } = await client.query<{ event_id: string }>(SYNC_CURSOR_SQL);
  return rows[0]?.event_id ?? EMPTY_CURSOR;
}

/**
 * Database operations for the agent-side sync endpoints.
 *
 * Purely read-side; the writer in publisher-db.ts and the change-feed
 * triggers in migration 446 own the data. This class only formats the
 * read shape for the two endpoints.
 */
export class AuthorizationSnapshotDatabase {
  /**
   * Narrow per-agent pull. Returns all matching rows in one shot —
   * agents typically have at most a few hundred rows, sub-millisecond
   * via idx_caa_by_agent.
   *
   * Caller has already canonicalized agentUrl through
   * publisher-db.ts:canonicalizeAgentUrl so the equality match against
   * agent_url_canonical hits the index.
   */
  async getNarrow({ agentUrlCanonical, evidence, include }: NarrowOpts): Promise<NarrowResult> {
    // Guard: defensive copy + recheck. Public callers come through
    // parseEvidenceParam / parseIncludeParam, but a programmatic caller
    // could bypass that — keep the validation here too.
    for (const v of evidence) {
      if (!VALID_EVIDENCE.has(v)) throw new EvidenceValidationError(v);
    }
    if (!VALID_INCLUDE.has(include)) throw new IncludeValidationError(include);

    const client = await getClient();
    try {
      const cursor = await readSyncCursor(client);

      const sql = `
        ${selectClause(include)}
        ${whereConnector(include)} agent_url_canonical = $1
          AND evidence = ANY($2::text[])
        ORDER BY publisher_domain NULLS LAST, property_id_slug NULLS LAST, id
      `;
      const { rows } = await client.query<AuthRow>(sql, [agentUrlCanonical, [...evidence]]);
      return { rows, cursor };
    } finally {
      client.release();
    }
  }

  /**
   * Bootstrap snapshot. Returns the change-feed cursor up-front (so the
   * HTTP handler can set headers / handle If-None-Match before opening
   * the response body) plus an async iterator that streams rows in
   * chunks of SNAPSHOT_CHUNK_SIZE.
   *
   * The cursor is read BEFORE the data cursor opens. A write that lands
   * during the stream is visible to the consumer via the change feed
   * (no rows lost), at the cost of some rows possibly being delivered
   * twice (once in the snapshot, once via the feed). At-least-once
   * delivery is the spec-compliant behavior; upserts on the consumer
   * side dedupe.
   *
   * Caller MUST drain the iterator (or call its return()) to release
   * the underlying connection. The HTTP route handler does this in
   * both the success path and the catch-and-end path.
   */
  async openSnapshot(opts: SnapshotOpts): Promise<{
    cursor: string;
    rows: AsyncIterableIterator<AuthRow[]>;
  }> {
    for (const v of opts.evidence) {
      if (!VALID_EVIDENCE.has(v)) throw new EvidenceValidationError(v);
    }
    if (!VALID_INCLUDE.has(opts.include)) throw new IncludeValidationError(opts.include);

    const client = await getClient();

    let cursor: string;
    try {
      cursor = await readSyncCursor(client);
      // Cursors require a transaction. WITH HOLD would keep the cursor
      // alive across commit, but that materializes the result on the
      // server — defeats the streaming. Plain DECLARE inside BEGIN/COMMIT
      // is the right shape.
      //
      // REPEATABLE READ pins the snapshot to the cursor's read time:
      // every FETCH sees the same MVCC snapshot, so the rows the
      // consumer receives match the X-Sync-Cursor exactly. Without it,
      // a write committed mid-stream is visible to later FETCHes —
      // consumers still recover via at-least-once feed delivery, but
      // the snapshot wouldn't be a true point-in-time view.
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const declareSql = `
        DECLARE auth_snapshot_cursor NO SCROLL CURSOR FOR
        ${selectClause(opts.include)}
        ${whereConnector(opts.include)} evidence = ANY($1::text[])
        ORDER BY id
      `;
      await client.query(declareSql, [[...opts.evidence]]);
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        // Log rather than silent — a rollback failure indicates the
        // pool client is in a bad state and the connection is about to
        // be evicted. Surface for incident triage.
        log.warn({ rollbackErr }, 'snapshot rollback failed after open error');
      }
      client.release();
      throw err;
    }

    const rows = this.makeSnapshotIterator(client);
    return { cursor, rows };
  }

  private makeSnapshotIterator(client: PoolClient): AsyncIterableIterator<AuthRow[]> {
    let exhausted = false;

    const cleanup = async (): Promise<void> => {
      if (exhausted) return;
      exhausted = true;
      try {
        await client.query('CLOSE auth_snapshot_cursor');
      } catch { /* ignored — likely connection error or txn aborted */ }
      try {
        await client.query('COMMIT');
      } catch { /* ignored */ }
      client.release();
    };

    const it: AsyncIterableIterator<AuthRow[]> = {
      [Symbol.asyncIterator]() { return it; },
      async next(): Promise<IteratorResult<AuthRow[]>> {
        if (exhausted) return { value: undefined, done: true };
        try {
          const { rows } = await client.query<AuthRow>(
            `FETCH ${SNAPSHOT_CHUNK_SIZE} FROM auth_snapshot_cursor`,
          );
          if (rows.length === 0) {
            await cleanup();
            return { value: undefined, done: true };
          }
          return { value: rows, done: false };
        } catch (err) {
          await cleanup();
          throw err;
        }
      },
      async return(): Promise<IteratorResult<AuthRow[]>> {
        await cleanup();
        return { value: undefined, done: true };
      },
    };
    return it;
  }

  /**
   * One-shot wrapper around openSnapshot for tests + small fixtures.
   * Buffers the entire snapshot in memory — DO NOT use this in the HTTP
   * handler; that path streams chunk-by-chunk.
   */
  async getSnapshotForTesting(opts: SnapshotOpts): Promise<NarrowResult> {
    const { cursor, rows } = await this.openSnapshot(opts);
    const all: AuthRow[] = [];
    for await (const chunk of rows) {
      all.push(...chunk);
    }
    return { rows: all, cursor };
  }
}

/**
 * Sentinel for consumers writing tests against the empty-feed path.
 * Equal to the all-zero UUIDv7 — also documented at
 * specs/registry-authorization-model.md:389.
 */
export const EMPTY_FEED_CURSOR = EMPTY_CURSOR;

/**
 * Standalone helper: query without instantiating the class. Convenient
 * for the route handler which doesn't need the class wrapper.
 */
export async function getNarrowAuthorizations(opts: NarrowOpts): Promise<NarrowResult> {
  return new AuthorizationSnapshotDatabase().getNarrow(opts);
}

/**
 * Standalone helper used by the test layer to verify the cursor matches
 * the most recent authorization event_id. Same shape readSyncCursor uses
 * (DESC LIMIT 1 — Postgres has no MAX(uuid)).
 */
export async function readAuthorizationFeedCursor(): Promise<string> {
  const { rows } = await query<{ event_id: string }>(SYNC_CURSOR_SQL);
  return rows[0]?.event_id ?? EMPTY_CURSOR;
}
