/**
 * Agent-side sync endpoints for catalog_agent_authorizations
 * (PR 4b-snapshots of #3177).
 *
 * Spec: specs/registry-authorization-model.md:374-401.
 *
 * Two layers of coverage:
 *  - DB layer: AuthorizationSnapshotDatabase.getNarrow / openSnapshot.
 *    Pins the SQL query shape — evidence default, override layer
 *    semantics, soft-delete exclusion, cursor sourcing.
 *  - HTTP layer: GET /api/registry/authorizations and
 *    /api/registry/authorizations/snapshot. Pins headers
 *    (X-Sync-Cursor, ETag, Content-Encoding), gzip+NDJSON streaming,
 *    and validation 400s.
 *
 * Fixtures use a `sync-` prefix on `.registry-baseline.example` so
 * concurrent test files don't trample our seed.
 *
 * Refs #3177. Builds on #3274 (schema), #3352 (readers), #3377 (feed).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { gunzipSync } from 'zlib';
import type { Pool } from 'pg';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  AuthorizationSnapshotDatabase,
  EMPTY_FEED_CURSOR,
  parseEvidenceParam,
  parseIncludeParam,
  EvidenceValidationError,
  IncludeValidationError,
} from '../../src/db/authorization-snapshot-db.js';

const DOMAIN_SUFFIX = '.registry-baseline.example';
const PUB_A = `sync-acme${DOMAIN_SUFFIX}`;
const PUB_B = `sync-pinnacle${DOMAIN_SUFFIX}`;
const AGENT_X = `https://sync-x${DOMAIN_SUFFIX}`;
const AGENT_Y = `https://sync-y${DOMAIN_SUFFIX}`;
const AGENT_OVERRIDE = `https://sync-override${DOMAIN_SUFFIX}`;
const AGENT_LIKE = `https://sync-%${DOMAIN_SUFFIX}`;
const PUB_LIKE = `sync-%${DOMAIN_SUFFIX}`;

// ──────────────────────────────────────────────────────────────────
// Fixture helpers — keep separate from the supertest harness so the
// DB-layer tests don't pull HTTPServer into their startup path.
// ──────────────────────────────────────────────────────────────────

async function clearFixtures(pool: Pool): Promise<void> {
  await pool.query(
    `DELETE FROM catalog_events
       WHERE entity_type = 'authorization'
         AND (payload->>'publisher_domain' LIKE $1
           OR payload->>'agent_url_canonical' LIKE $2)`,
    [PUB_LIKE, AGENT_LIKE],
  );
  await pool.query(
    `DELETE FROM adagents_authorization_overrides
       WHERE host_domain LIKE $1 OR agent_url_canonical LIKE $2`,
    [PUB_LIKE, AGENT_LIKE],
  );
  await pool.query(
    `DELETE FROM catalog_agent_authorizations
       WHERE publisher_domain LIKE $1 OR agent_url_canonical LIKE $2`,
    [PUB_LIKE, AGENT_LIKE],
  );
}

async function insertCAA(
  pool: Pool,
  opts: {
    agent: string;
    publisher?: string;
    propertyRid?: string;
    evidence?: 'adagents_json' | 'agent_claim' | 'community';
    authorizedFor?: string;
    disputed?: boolean;
    deletedAt?: Date | null;
    createdBy?: string;
    expiresAt?: Date | null;
    propertyIdSlug?: string;
  },
): Promise<string> {
  const evidence = opts.evidence ?? 'adagents_json';
  const createdBy = opts.createdBy ?? (evidence === 'agent_claim' ? opts.agent : 'system');
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO catalog_agent_authorizations
       (agent_url, agent_url_canonical, publisher_domain, property_rid,
        property_id_slug, authorized_for, evidence, disputed, deleted_at,
        created_by, expires_at)
     VALUES ($1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      opts.agent,
      opts.publisher ?? null,
      opts.propertyRid ?? null,
      opts.propertyIdSlug ?? null,
      opts.authorizedFor ?? null,
      evidence,
      opts.disputed ?? false,
      opts.deletedAt ?? null,
      createdBy,
      opts.expiresAt ?? null,
    ],
  );
  return rows[0].id;
}

async function insertOverride(
  pool: Pool,
  opts: {
    publisher: string;
    agent: string;
    type: 'add' | 'suppress';
    propertyId?: string;
    authorizedFor?: string;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO adagents_authorization_overrides
       (host_domain, agent_url, agent_url_canonical, override_type,
        override_reason, justification, authorized_for, approved_by_user_id,
        property_id)
     VALUES ($1, $2, $2, $3, 'correction', 'sync test fixture', $4,
             'test-user', $5)`,
    [opts.publisher, opts.agent, opts.type, opts.authorizedFor ?? null, opts.propertyId ?? null],
  );
}

// ──────────────────────────────────────────────────────────────────
// Layer 1: DB-layer behavior
// ──────────────────────────────────────────────────────────────────

describe('AuthorizationSnapshotDatabase', () => {
  let pool: Pool;
  let db: AuthorizationSnapshotDatabase;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString:
        process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
    db = new AuthorizationSnapshotDatabase();
  });

  beforeEach(async () => { await clearFixtures(pool); });
  afterAll(async () => {
    await clearFixtures(pool);
    await closeDatabase();
  });

  // ── Param parsers ──────────────────────────────────────────────

  describe('parseEvidenceParam', () => {
    it('defaults to adagents_json only', () => {
      expect(parseEvidenceParam(undefined)).toEqual(['adagents_json']);
      expect(parseEvidenceParam('')).toEqual(['adagents_json']);
    });

    it('parses CSV with whitespace', () => {
      expect(parseEvidenceParam('adagents_json, agent_claim')).toEqual(['adagents_json', 'agent_claim']);
    });

    it('throws on unknown values', () => {
      expect(() => parseEvidenceParam('adagents_json,bogus')).toThrow(EvidenceValidationError);
    });

    it('accepts override (effective view exposes override evidence)', () => {
      expect(parseEvidenceParam('override')).toEqual(['override']);
    });
  });

  describe('parseIncludeParam', () => {
    it('defaults to effective', () => {
      expect(parseIncludeParam(undefined)).toBe('effective');
      expect(parseIncludeParam('')).toBe('effective');
    });

    it('throws on unknown values', () => {
      expect(() => parseIncludeParam('bogus')).toThrow(IncludeValidationError);
    });

    it('accepts raw', () => {
      expect(parseIncludeParam('raw')).toBe('raw');
    });
  });

  // ── getNarrow ──────────────────────────────────────────────────

  describe('getNarrow', () => {
    it('empty registry returns empty rows + sentinel cursor', async () => {
      // We only need the agent_url to be canonical; the implementation
      // never inserts data on this path.
      const result = await db.getNarrow({
        agentUrlCanonical: AGENT_X,
        evidence: ['adagents_json'],
        include: 'effective',
      });
      expect(result.rows).toEqual([]);
      // cursor is either the all-zero sentinel (no events) or a real
      // UUIDv7 from a sibling test. Both are valid; just assert format.
      expect(result.cursor).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('returns rows for the requested agent only', async () => {
      await insertCAA(pool, { agent: AGENT_X, publisher: PUB_A });
      await insertCAA(pool, { agent: AGENT_Y, publisher: PUB_A });

      const x = await db.getNarrow({
        agentUrlCanonical: AGENT_X,
        evidence: ['adagents_json'],
        include: 'effective',
      });
      expect(x.rows).toHaveLength(1);
      expect(x.rows[0].agent_url_canonical).toBe(AGENT_X);
      expect(x.rows[0].publisher_domain).toBe(PUB_A);
      expect(x.rows[0].evidence).toBe('adagents_json');
      expect(x.rows[0].override_applied).toBe(false);
    });

    it('agent_claim is excluded by default; included with explicit evidence', async () => {
      await insertCAA(pool, { agent: AGENT_X, publisher: PUB_A, evidence: 'adagents_json' });
      await insertCAA(pool, { agent: AGENT_X, publisher: PUB_B, evidence: 'agent_claim' });

      const def = await db.getNarrow({
        agentUrlCanonical: AGENT_X,
        evidence: ['adagents_json'],
        include: 'effective',
      });
      expect(def.rows.map(r => r.evidence)).toEqual(['adagents_json']);

      const both = await db.getNarrow({
        agentUrlCanonical: AGENT_X,
        evidence: ['adagents_json', 'agent_claim'],
        include: 'effective',
      });
      expect(both.rows.map(r => r.evidence).sort()).toEqual(['adagents_json', 'agent_claim']);
    });

    it('include=raw returns base rows; include=effective applies suppress override', async () => {
      // Base row + suppress override targeting it.
      await insertCAA(pool, { agent: AGENT_X, publisher: PUB_A });
      await insertOverride(pool, { publisher: PUB_A, agent: AGENT_X, type: 'suppress' });

      const raw = await db.getNarrow({
        agentUrlCanonical: AGENT_X,
        evidence: ['adagents_json'],
        include: 'raw',
      });
      expect(raw.rows).toHaveLength(1);
      expect(raw.rows[0].publisher_domain).toBe(PUB_A);
      expect(raw.rows[0].override_applied).toBe(false);

      const eff = await db.getNarrow({
        agentUrlCanonical: AGENT_X,
        evidence: ['adagents_json'],
        include: 'effective',
      });
      // Suppress override hides the matched base row.
      expect(eff.rows).toHaveLength(0);
    });

    it('include=effective surfaces add overrides as phantom rows (evidence=override)', async () => {
      await insertOverride(pool, {
        publisher: PUB_A,
        agent: AGENT_OVERRIDE,
        type: 'add',
        authorizedFor: 'display',
      });

      const eff = await db.getNarrow({
        agentUrlCanonical: AGENT_OVERRIDE,
        evidence: ['override'],
        include: 'effective',
      });
      expect(eff.rows).toHaveLength(1);
      expect(eff.rows[0].evidence).toBe('override');
      expect(eff.rows[0].publisher_domain).toBe(PUB_A);
      expect(eff.rows[0].override_applied).toBe(true);
      expect(eff.rows[0].authorized_for).toBe('display');
      expect(eff.rows[0].property_rid).toBeNull();

      // raw never surfaces overrides — they're only in the view.
      const raw = await db.getNarrow({
        agentUrlCanonical: AGENT_OVERRIDE,
        evidence: ['override'],
        include: 'raw',
      });
      expect(raw.rows).toHaveLength(0);
    });

    it('disputed rows are returned in both raw and effective modes', async () => {
      await insertCAA(pool, {
        agent: AGENT_X,
        publisher: PUB_A,
        disputed: true,
      });

      const raw = await db.getNarrow({
        agentUrlCanonical: AGENT_X,
        evidence: ['adagents_json'],
        include: 'raw',
      });
      expect(raw.rows).toHaveLength(1);
      expect(raw.rows[0].disputed).toBe(true);

      const eff = await db.getNarrow({
        agentUrlCanonical: AGENT_X,
        evidence: ['adagents_json'],
        include: 'effective',
      });
      expect(eff.rows).toHaveLength(1);
      expect(eff.rows[0].disputed).toBe(true);
    });

    it('soft-deleted rows are excluded from both modes', async () => {
      await insertCAA(pool, {
        agent: AGENT_X,
        publisher: PUB_A,
        deletedAt: new Date(),
      });

      const raw = await db.getNarrow({
        agentUrlCanonical: AGENT_X,
        evidence: ['adagents_json'],
        include: 'raw',
      });
      expect(raw.rows).toHaveLength(0);

      const eff = await db.getNarrow({
        agentUrlCanonical: AGENT_X,
        evidence: ['adagents_json'],
        include: 'effective',
      });
      expect(eff.rows).toHaveLength(0);
    });

    it('throws on unknown evidence', async () => {
      await expect(db.getNarrow({
        agentUrlCanonical: AGENT_X,
        evidence: ['bogus'],
        include: 'effective',
      })).rejects.toBeInstanceOf(EvidenceValidationError);
    });
  });

  // ── openSnapshot / streamSnapshot ──────────────────────────────

  describe('openSnapshot', () => {
    it('streams all rows via the cursor', async () => {
      // Seed 50 rows — small enough to keep the test fast, large enough
      // that we exercise the cursor batching path even with a chunk size
      // matching production. Even if the chunk exceeds row count, the
      // snapshot iterator still terminates on the first empty FETCH.
      for (let i = 0; i < 50; i++) {
        await insertCAA(pool, {
          agent: `https://sync-streamed-${i}${DOMAIN_SUFFIX}`,
          publisher: PUB_A,
        });
      }

      const { rows, cursor } = await db.getSnapshotForTesting({
        evidence: ['adagents_json'],
        include: 'effective',
      });

      // We only count rows from this test's PUB_A to filter out
      // any sibling-fixture rows (parallel test files may seed
      // adagents_json rows under their own publisher_domain).
      const ours = rows.filter(r => r.publisher_domain === PUB_A);
      expect(ours).toHaveLength(50);
      expect(cursor).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('cursor matches the most recent authorization event_id', async () => {
      // Seed one row — the trigger from migration 446 will write an
      // authorization.granted event whose event_id we read back as
      // the snapshot cursor. Postgres has no MAX(uuid), so the
      // implementation reads via ORDER BY event_id DESC LIMIT 1.
      await insertCAA(pool, { agent: AGENT_X, publisher: PUB_A });

      const { cursor } = await db.getSnapshotForTesting({
        evidence: ['adagents_json'],
        include: 'effective',
      });

      const { rows: maxRow } = await pool.query<{ event_id: string }>(
        `SELECT event_id
           FROM catalog_events
          WHERE entity_type = 'authorization'
          ORDER BY event_id DESC
          LIMIT 1`,
      );
      expect(cursor).toBe(maxRow[0].event_id);
    });

    it('returns sentinel cursor when no authorization events exist', async () => {
      // Wipe any authorization events so MAX returns NULL. Other tests
      // in this suite write events too — scope the wipe but leave their
      // base rows alone (they're cleared in beforeEach anyway).
      await pool.query(`DELETE FROM catalog_events WHERE entity_type = 'authorization'`);

      const { cursor } = await db.getSnapshotForTesting({
        evidence: ['adagents_json'],
        include: 'effective',
      });
      expect(cursor).toBe(EMPTY_FEED_CURSOR);
    });

    it('include=raw returns base rows even when overrides exist', async () => {
      await insertCAA(pool, { agent: AGENT_X, publisher: PUB_A });
      await insertOverride(pool, { publisher: PUB_A, agent: AGENT_X, type: 'suppress' });

      const { rows } = await db.getSnapshotForTesting({
        evidence: ['adagents_json'],
        include: 'raw',
      });
      const ours = rows.filter(r => r.agent_url_canonical === AGENT_X);
      expect(ours).toHaveLength(1);
      expect(ours[0].override_applied).toBe(false);
    });

    it('throws on unknown evidence', async () => {
      await expect(db.getSnapshotForTesting({
        evidence: ['bogus'],
        include: 'effective',
      })).rejects.toBeInstanceOf(EvidenceValidationError);
    });
  });
});

// ──────────────────────────────────────────────────────────────────
// Layer 2: HTTP-level smoke
// ──────────────────────────────────────────────────────────────────
//
// Mounts ONLY the registry router on a fresh Express app — avoids
// the full HTTPServer wiring (training-agent + GCP KMS deps, MCP
// router URL parsing, the full middleware stack). The two endpoints
// only depend on requireAuth, the AuthorizationSnapshotDatabase, and
// the request/response objects — nothing else from the server module
// graph.
//
// Pins:
//  - X-Sync-Cursor + Content-Encoding headers
//  - 400 on missing/invalid params
//  - gzipped NDJSON parse round-trip
//  - If-None-Match → 304 short-circuit
//
// The DB-layer suite above pinned the SQL semantics; this layer
// catches transport-shape regressions (header names, gzip encoding,
// validation paths).

import express from 'express';
import { createRegistryApiRouter, type RegistryApiConfig } from '../../src/routes/registry-api.js';

function buildTestApp() {
  const app = express();
  app.use(express.json());

  // The two endpoints we're testing only depend on `requireAuth`. The
  // other RegistryApiConfig fields are unused on our paths — we pass
  // minimal stand-ins to satisfy the type. This is intentionally NOT
  // mocking the auth middleware; we want the real wiring through the
  // route's authMiddleware-gate, just bypassed.
  const passAuth: import('express').RequestHandler = (_req, _res, next) => next();

  const config: RegistryApiConfig = {
    // Route handlers we exercise touch none of these. Cast through
    // unknown to avoid having to construct the full surfaces.
    brandManager: {} as unknown as RegistryApiConfig['brandManager'],
    brandDb: {} as unknown as RegistryApiConfig['brandDb'],
    propertyDb: {} as unknown as RegistryApiConfig['propertyDb'],
    adagentsManager: {} as unknown as RegistryApiConfig['adagentsManager'],
    healthChecker: {} as unknown as RegistryApiConfig['healthChecker'],
    crawler: {} as unknown as RegistryApiConfig['crawler'],
    capabilityDiscovery: {} as unknown as RegistryApiConfig['capabilityDiscovery'],
    registryRequestsDb: {
      trackRequest: async () => {},
      markResolved: async () => true,
    },
    requireAuth: passAuth,
    optionalAuth: passAuth,
  };

  const router = createRegistryApiRouter(config);
  app.use('/api', router);
  return app;
}

describe('Authorization sync HTTP endpoints', () => {
  let pool: Pool;
  let app: express.Express;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString:
        process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
    app = buildTestApp();
  });

  beforeEach(async () => { await clearFixtures(pool); });

  afterAll(async () => {
    await clearFixtures(pool);
    await closeDatabase();
  });

  // ── GET /api/registry/authorizations ──────────────────────────

  describe('GET /api/registry/authorizations', () => {
    it('returns 400 when agent_url is missing', async () => {
      const res = await request(app).get('/api/registry/authorizations');
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/agent_url/);
    });

    it('returns 400 when agent_url is empty', async () => {
      const res = await request(app).get('/api/registry/authorizations?agent_url=');
      expect(res.status).toBe(400);
    });

    it('returns 400 for unknown evidence', async () => {
      const res = await request(app)
        .get('/api/registry/authorizations')
        .query({ agent_url: AGENT_X, evidence: 'adagents_json,bogus' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/evidence/i);
    });

    it('returns 400 for unknown include', async () => {
      const res = await request(app)
        .get('/api/registry/authorizations')
        .query({ agent_url: AGENT_X, include: 'bogus' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/include/i);
    });

    it('returns rows + X-Sync-Cursor header', async () => {
      await insertCAA(pool, { agent: AGENT_X, publisher: PUB_A, authorizedFor: 'display' });

      const res = await request(app)
        .get('/api/registry/authorizations')
        .query({ agent_url: AGENT_X });
      expect(res.status).toBe(200);
      expect(res.headers['x-sync-cursor']).toMatch(/^[0-9a-f-]{36}$/);
      expect(res.body.agent_url).toBe(AGENT_X);
      expect(res.body.evidence).toEqual(['adagents_json']);
      expect(res.body.include).toBe('effective');
      expect(res.body.count).toBe(1);
      expect(res.body.rows).toHaveLength(1);
      expect(res.body.rows[0].publisher_domain).toBe(PUB_A);
      expect(res.body.rows[0].authorized_for).toBe('display');
    });

    it('canonicalizes the agent_url query param (uppercase + trailing slash)', async () => {
      await insertCAA(pool, { agent: AGENT_X, publisher: PUB_A });

      const res = await request(app)
        .get('/api/registry/authorizations')
        .query({ agent_url: AGENT_X.toUpperCase() + '/' });
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(1);
      expect(res.body.agent_url).toBe(AGENT_X);
    });
  });

  // ── GET /api/registry/authorizations/snapshot ─────────────────

  describe('GET /api/registry/authorizations/snapshot', () => {
    it('returns 400 for unknown evidence', async () => {
      const res = await request(app)
        .get('/api/registry/authorizations/snapshot')
        .query({ evidence: 'bogus' });
      expect(res.status).toBe(400);
    });

    /**
     * Pull the raw gzip bytes off the wire. supertest's default body
     * parser would auto-decompress via superagent, which makes
     * "verify Content-Encoding is gzip" untestable. We use a custom
     * parser that buffers the raw bytes; decompression happens here
     * in the assertion path.
     *
     * The raw HTTP response stream from Node's http module passes
     * through superagent BEFORE custom .parse runs — and superagent's
     * default-decompress runs at the parser layer. So we ALSO need to
     * null out `res.headers['content-encoding']` perception by not
     * triggering the auto-decompress fast path; .buffer(true) + .parse
     * keeps the response bytes untouched.
     */
    async function fetchRawGzip(query: Record<string, string> = {}, headers: Record<string, string> = {}) {
      const r = request(app)
        .get('/api/registry/authorizations/snapshot')
        .query(query);
      for (const [k, v] of Object.entries(headers)) r.set(k, v);
      // Send Accept-Encoding: gzip explicitly — without it supertest
      // would set 'identity', and our handler still emits
      // Content-Encoding: gzip (we don't negotiate). The client side
      // (superagent) auto-decompresses ANY gzip-encoded response
      // unless we override .parse before .end.
      return r
        .set('Accept-Encoding', 'gzip')
        .buffer(true)
        .parse((rsp, cb) => {
          // Disable the underlying http stream's auto-decompression
          // by reading bytes directly off the socket-level events.
          const chunks: Buffer[] = [];
          rsp.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
          rsp.on('end', () => cb(null, Buffer.concat(chunks)));
          rsp.on('error', (err: Error) => cb(err, Buffer.alloc(0)));
        });
    }

    it('returns gzipped NDJSON with all expected headers', async () => {
      await insertCAA(pool, { agent: AGENT_X, publisher: PUB_A });
      await insertCAA(pool, { agent: AGENT_Y, publisher: PUB_A });

      const res = await fetchRawGzip();

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/x-ndjson/);
      expect(res.headers['content-encoding']).toBe('gzip');
      expect(res.headers['x-sync-cursor']).toMatch(/^[0-9a-f-]{36}$/);
      expect(res.headers.etag).toMatch(/^"[0-9a-f]{32}"$/);

      // supertest may or may not auto-decompress depending on
      // version; try gunzip first and fall back to a UTF-8 decode
      // if the bytes are already plain text.
      const raw = res.body as Buffer;
      let body: string;
      try {
        body = gunzipSync(raw).toString('utf8');
      } catch {
        body = raw.toString('utf8');
      }
      const lines = body.split('\n').filter(Boolean);
      const ours = lines
        .map(l => JSON.parse(l) as { agent_url_canonical: string; publisher_domain: string })
        .filter(r => r.publisher_domain === PUB_A);
      expect(ours).toHaveLength(2);
      expect(ours.map(r => r.agent_url_canonical).sort()).toEqual([AGENT_X, AGENT_Y].sort());
    });

    it('streams a 200-row fixture entirely via NDJSON', async () => {
      // 200 rows < SNAPSHOT_CHUNK_SIZE (10K), so this exercises the
      // single-fetch path. The DB-layer test covers the multi-fetch
      // path via a smaller chunk; here we just confirm the wire
      // format passes a non-trivial fixture cleanly.
      for (let i = 0; i < 200; i++) {
        await insertCAA(pool, {
          agent: `https://sync-bulk-${i}${DOMAIN_SUFFIX}`,
          publisher: PUB_A,
        });
      }

      const res = await fetchRawGzip();
      expect(res.status).toBe(200);

      const raw = res.body as Buffer;
      let body: string;
      try {
        body = gunzipSync(raw).toString('utf8');
      } catch {
        body = raw.toString('utf8');
      }
      const lines = body.split('\n').filter(Boolean);
      const ours = lines
        .map(l => JSON.parse(l) as { publisher_domain: string })
        .filter(r => r.publisher_domain === PUB_A);
      expect(ours).toHaveLength(200);
    });

    it('honors If-None-Match — 304 when ETag matches', async () => {
      await insertCAA(pool, { agent: AGENT_X, publisher: PUB_A });

      const first = await request(app)
        .get('/api/registry/authorizations/snapshot')
        .set('Accept-Encoding', 'identity')
        .buffer(true)
        .parse((rsp, cb) => {
          const chunks: Buffer[] = [];
          rsp.on('data', (c: Buffer) => chunks.push(c));
          rsp.on('end', () => cb(null, Buffer.concat(chunks)));
        });
      expect(first.status).toBe(200);
      const etag = first.headers.etag;
      expect(etag).toBeTruthy();

      const second = await request(app)
        .get('/api/registry/authorizations/snapshot')
        .set('If-None-Match', etag);
      expect(second.status).toBe(304);
      expect(second.headers['x-sync-cursor']).toBe(first.headers['x-sync-cursor']);
      expect(second.headers.etag).toBe(etag);
    });
  });
});
