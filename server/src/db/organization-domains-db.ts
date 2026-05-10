/**
 * Canonical writer module for `organization_domains` (#4159 Stage 3).
 *
 * Stage 2 collapsed brand identity and org-membership inference onto a single
 * `organization_domains.is_primary=true` row. Stage 3 consolidates the write
 * paths so every caller goes through the same primitives instead of each
 * reinventing the SQL with subtly different invariants.
 *
 * **Trust model:** `linkDomain` rejects ownership transfer on conflict — the
 * existing row stays put. The WorkOS-sourced primitives (`upsertDomainFromWorkos`
 * and friends) **do** transfer ownership on conflict because WorkOS is the
 * authoritative source of truth for DNS-proof-of-control. Use the
 * member/admin-facing primitives for everything else.
 */
import type { Pool, PoolClient } from 'pg';
import { getPool } from './client.js';
import { createLogger } from '../logger.js';

const logger = createLogger('organization-domains-db');

/**
 * Either a full pool (each query runs on a fresh connection) or a single
 * client checked out by the caller (queries share the caller's transaction).
 */
type Queryable = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

export type DomainSource =
  | 'workos'
  | 'email_verification'
  | 'import'
  | 'admin_discovery'
  | 'manual';

export interface LinkDomainArgs {
  orgId: string;
  domain: string;
  source: DomainSource;
  verified: boolean;
  isPrimary?: boolean;
}

export interface LinkDomainResult {
  inserted: boolean;
  conflictOrgId: string | null;
}

export async function linkDomain(args: LinkDomainArgs): Promise<LinkDomainResult> {
  const { orgId, domain, source, verified, isPrimary = false } = args;
  const pool = getPool();

  const insertResult = await pool.query<{ workos_organization_id: string }>(
    `INSERT INTO organization_domains (workos_organization_id, domain, is_primary, verified, source)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (domain) DO NOTHING
     RETURNING workos_organization_id`,
    [orgId, domain, isPrimary, verified, source],
  );

  if (insertResult.rowCount === 0) {
    const existing = await pool.query<{ workos_organization_id: string }>(
      `SELECT workos_organization_id FROM organization_domains WHERE domain = $1`,
      [domain],
    );
    const existingOrgId = existing.rows[0]?.workos_organization_id ?? null;
    const conflictOrgId = existingOrgId !== orgId ? existingOrgId : null;
    if (conflictOrgId) {
      logger.warn(
        { domain, orgId, existingOrgId },
        'linkDomain: domain conflict — left existing organization_domains row in place',
      );
    }
    return { inserted: false, conflictOrgId };
  }

  if (isPrimary) {
    await pool.query(
      `UPDATE organizations SET email_domain = $1, updated_at = NOW()
        WHERE workos_organization_id = $2`,
      [domain, orgId],
    );
  }

  return { inserted: true, conflictOrgId: null };
}

export interface SetPrimaryDomainArgs {
  orgId: string;
  domain: string;
  requireSource?: ReadonlyArray<DomainSource>;
}

export type SetPrimaryDomainResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'not_found' | 'not_verified' | 'source_not_allowed';
      foundSource?: string;
    };

export async function setPrimaryDomain(
  args: SetPrimaryDomainArgs,
): Promise<SetPrimaryDomainResult> {
  const { orgId, domain, requireSource } = args;
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    await client.query(
      'SELECT 1 FROM organizations WHERE workos_organization_id = $1 FOR UPDATE',
      [orgId],
    );

    const domainRow = await client.query<{ verified: boolean; source: string }>(
      `SELECT verified, source FROM organization_domains
        WHERE workos_organization_id = $1 AND domain = $2`,
      [orgId, domain],
    );
    if (domainRow.rowCount === 0) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'not_found' };
    }
    if (!domainRow.rows[0].verified) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'not_verified' };
    }
    if (requireSource && !requireSource.includes(domainRow.rows[0].source as DomainSource)) {
      await client.query('ROLLBACK');
      return {
        ok: false,
        reason: 'source_not_allowed',
        foundSource: domainRow.rows[0].source,
      };
    }

    await client.query(
      `UPDATE organization_domains SET is_primary = false, updated_at = NOW()
        WHERE workos_organization_id = $1 AND is_primary = true`,
      [orgId],
    );
    await client.query(
      `UPDATE organization_domains SET is_primary = true, updated_at = NOW()
        WHERE workos_organization_id = $1 AND domain = $2`,
      [orgId, domain],
    );
    await client.query(
      `UPDATE organizations SET email_domain = $1, updated_at = NOW()
        WHERE workos_organization_id = $2`,
      [domain, orgId],
    );

    await client.query('COMMIT');
    return { ok: true };
  } catch (err) {
    await client.query('ROLLBACK').catch((rbErr) => {
      logger.error({ rbErr, orgId, domain }, 'ROLLBACK failed in setPrimaryDomain');
    });
    throw err;
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WorkOS-sourced writers (Stage 3b)
//
// These trust WorkOS's domain ownership as authoritative, so they DO transfer
// ownership on conflict — opposite of `linkDomain`. They accept an optional
// `Queryable` so the WorkOS webhook can compose them inside a single
// transaction with the `FOR UPDATE` lock on `organizations`.
// ─────────────────────────────────────────────────────────────────────────────

export interface UpsertDomainFromWorkosArgs {
  orgId: string;
  domain: string;
  verified: boolean;
  /**
   * Set this to true when the caller is sure no other primary exists for the
   * org (e.g. first verified domain on a fresh org). For the conditional
   * "promote-to-primary if no other primary" flow, call
   * `autoPromotePrimaryIfNone` after this.
   */
  isPrimary?: boolean;
}

export async function upsertDomainFromWorkos(
  args: UpsertDomainFromWorkosArgs,
  q: Queryable = getPool(),
): Promise<void> {
  const { orgId, domain, verified, isPrimary = false } = args;
  await q.query(
    `INSERT INTO organization_domains (workos_organization_id, domain, is_primary, verified, source)
     VALUES ($1, $2, $3, $4, 'workos')
     ON CONFLICT (domain) DO UPDATE SET
       workos_organization_id = EXCLUDED.workos_organization_id,
       verified = EXCLUDED.verified,
       source = 'workos',
       updated_at = NOW()`,
    [orgId, domain, isPrimary, verified],
  );
}

/**
 * Promote `domain` to `is_primary=true` for `orgId` only if no other primary
 * exists. Idempotent and race-safe under the caller's transaction lock.
 *
 * When promotion happens, also denormalizes `organizations.email_domain`
 * to match. Returns whether the promotion fired so the caller can branch
 * on side-effects (logging, brand-registry sync).
 */
export async function autoPromotePrimaryIfNone(
  args: { orgId: string; domain: string },
  q: Queryable = getPool(),
): Promise<{ promoted: boolean }> {
  const { orgId, domain } = args;
  const result = await q.query(
    `UPDATE organization_domains SET is_primary = true, updated_at = NOW()
      WHERE workos_organization_id = $1 AND domain = $2
        AND NOT EXISTS (
          SELECT 1 FROM organization_domains
          WHERE workos_organization_id = $1 AND is_primary = true AND domain != $2
        )
      RETURNING domain`,
    [orgId, domain],
  );
  if ((result.rowCount ?? 0) === 0) {
    return { promoted: false };
  }
  await q.query(
    `UPDATE organizations SET email_domain = $1, updated_at = NOW()
      WHERE workos_organization_id = $2`,
    [domain, orgId],
  );
  return { promoted: true };
}

/**
 * Delete a WorkOS-sourced domain row and reselect a new primary if the
 * deleted row was primary. Picks the oldest verified row remaining; falls
 * back to NULL `email_domain` if nothing's verified.
 *
 * Only deletes rows where `source='workos'` — admin/import rows are immune
 * to WorkOS-driven removal.
 */
export async function removeWorkosDomainAndReselectPrimary(
  args: { orgId: string; domain: string },
  q: Queryable = getPool(),
): Promise<{ deleted: boolean; wasPrimary: boolean; newPrimary: string | null }> {
  const { orgId, domain } = args;
  const result = await q.query<{ is_primary: boolean }>(
    `DELETE FROM organization_domains
      WHERE workos_organization_id = $1 AND domain = $2 AND source = 'workos'
      RETURNING is_primary`,
    [orgId, domain],
  );

  if ((result.rowCount ?? 0) === 0) {
    return { deleted: false, wasPrimary: false, newPrimary: null };
  }

  const wasPrimary = result.rows[0].is_primary === true;
  if (!wasPrimary) {
    return { deleted: true, wasPrimary: false, newPrimary: null };
  }

  const remaining = await q.query<{ domain: string }>(
    `SELECT domain FROM organization_domains
      WHERE workos_organization_id = $1 AND verified = true
      ORDER BY created_at ASC
      LIMIT 1`,
    [orgId],
  );
  const newPrimary = remaining.rows[0]?.domain ?? null;

  if (newPrimary) {
    await q.query(
      `UPDATE organization_domains SET is_primary = true, updated_at = NOW()
        WHERE workos_organization_id = $1 AND domain = $2`,
      [orgId, newPrimary],
    );
  }
  await q.query(
    `UPDATE organizations SET email_domain = $1, updated_at = NOW()
      WHERE workos_organization_id = $2`,
    [newPrimary, orgId],
  );

  return { deleted: true, wasPrimary: true, newPrimary };
}
