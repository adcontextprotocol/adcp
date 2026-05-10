/**
 * Canonical writer module for `organization_domains` (#4159 Stage 3).
 *
 * Stage 2 collapsed brand identity and org-membership inference onto a single
 * `organization_domains.is_primary=true` row. Stage 3 consolidates the write
 * paths so every caller goes through the same two primitives instead of
 * each reinventing the SQL with subtly different invariants:
 *
 *   - `linkDomain` — INSERT a row, DO NOTHING on conflict, log when the
 *     existing row is owned by a different org. When `isPrimary=true` and
 *     the row was actually inserted, also denormalize
 *     `organizations.email_domain` so the two stay in sync (#4159 invariant).
 *
 *   - `setPrimaryDomain` — atomic clear-existing-primary + set-new-primary +
 *     update `organizations.email_domain`. Locks the org row to serialize
 *     against concurrent writers (member self-service, WorkOS webhook,
 *     admin Set Primary). Optionally requires the target row's `source`
 *     match an allowlist (the `'workos'`-only gate the member self-service
 *     route enforces today).
 */
import { getPool } from './client.js';
import { createLogger } from '../logger.js';

const logger = createLogger('organization-domains-db');

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
