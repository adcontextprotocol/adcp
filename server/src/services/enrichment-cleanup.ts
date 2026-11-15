/**
 * Admin cleanup for enrichment records that should never have been saved
 * (adcp#9024).
 *
 * Before the write guard in `enrichment-persistence-guard.ts`, any lookup
 * could save a Brandfetch answer, so test runs filed made-up subdomains and
 * reserved names as brands. This finds those records and removes them.
 *
 * Two modes:
 *
 *  - **criteria**: `source_type = 'enriched'` rows whose domain is a reserved
 *    name or is not its own registrable domain, the same domain rules the
 *    write guard now applies. A preview without a domain list scans the
 *    registry; a preview or delete with a list keeps only the listed domains
 *    that meet the criteria.
 *  - **explicit_list**: the listed domains, when each is an enriched record.
 *    For junk that is a registrable domain, such as a lookup Brandfetch
 *    answered with another domain's brand.
 *
 * A delete always takes the exact list the admin previewed and removes
 * nothing else. Each listed record is re-checked against the mode's rules
 * and against `REMOVABLE_ENRICHMENT_SQL`: enriched, held by no organization,
 * never edited by a person, no logo from anyone but Brandfetch, no admin
 * alias, and not the house of another brand. That predicate runs again
 * inside each DELETE, so hosted, brand.json, community and curated records
 * are never removed, even if one changes after the preview. Lists are
 * capped, and running the same delete twice removes nothing the second time.
 */

import { query } from '../db/client.js';
import { brandDb, REMOVABLE_ENRICHMENT_SQL } from '../db/brand-db.js';
import { createLogger } from '../logger.js';
import { classifyEnrichmentDomain } from './enrichment-persistence-guard.js';

const logger = createLogger('enrichment-cleanup');

/** Most records one request may list or delete. Run again for the rest. */
export const ENRICHMENT_CLEANUP_MAX_BATCH = 200;

/** `source` recorded on every audit entry the cleanup writes. */
export const ENRICHMENT_CLEANUP_AUDIT_SOURCE = 'cleanup_test_enrichment';

const DOMAIN_SHAPE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export type EnrichmentCleanupMode = 'criteria' | 'explicit_list';

export type EnrichmentCleanupReason = 'reserved_name' | 'not_registrable_domain' | 'explicit_list';

export type EnrichmentCleanupSkipReason =
  | 'invalid_domain'
  | 'not_found'
  | 'registrable_domain'
  | 'not_enriched'
  | 'owned_by_organization'
  | 'edited_or_curated'
  /** The row stopped being removable, or was already gone, by the time of its DELETE. */
  | 'no_longer_removable';

export interface EnrichmentCleanupCandidate {
  domain: string;
  brand_name: string | null;
  reason: EnrichmentCleanupReason;
  /** Registrable domain of the domain, so the admin can see which brand it shadows. */
  registrable_domain: string | null;
}

export interface EnrichmentCleanupSkip {
  domain: string;
  brand_name?: string | null;
  reason: EnrichmentCleanupSkipReason;
}

export interface EnrichmentCleanupPreview {
  mode: EnrichmentCleanupMode;
  candidates: EnrichmentCleanupCandidate[];
  skipped: EnrichmentCleanupSkip[];
  /** Candidates found before the cap. */
  total_candidates: number;
  /** Skipped records found before the cap. */
  total_skipped: number;
  truncated: boolean;
  max_batch: number;
}

export interface EnrichmentCleanupResult {
  mode: EnrichmentCleanupMode;
  deleted: EnrichmentCleanupCandidate[];
  skipped: EnrichmentCleanupSkip[];
  failed: Array<{ domain: string; error: string }>;
  max_batch: number;
}

type CandidateRow = {
  domain: string;
  brand_name: string | null;
  source_type: string | null;
  workos_organization_id: string | null;
  removable: boolean;
};

export class EnrichmentCleanupInputError extends Error {}

/** Validate the requested mode. Defaults to criteria without a list and explicit_list with one. */
export function parseCleanupMode(raw: unknown, hasDomains: boolean): EnrichmentCleanupMode {
  if (raw === undefined || raw === null) return hasDomains ? 'explicit_list' : 'criteria';
  if (raw === 'criteria' || raw === 'explicit_list') return raw;
  throw new EnrichmentCleanupInputError('mode must be "criteria" or "explicit_list"');
}

/**
 * Validate a domain list. Domains are matched exactly, after trimming and
 * lowercasing, because a delete should name the row it removes.
 */
export function normalizeCleanupDomains(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new EnrichmentCleanupInputError('domains must be an array of strings');
  }
  if (raw.length === 0) {
    throw new EnrichmentCleanupInputError('domains must not be empty; omit it to preview by criteria');
  }
  if (raw.length > ENRICHMENT_CLEANUP_MAX_BATCH) {
    throw new EnrichmentCleanupInputError(`At most ${ENRICHMENT_CLEANUP_MAX_BATCH} domains per request`);
  }
  const domains: string[] = [];
  for (const value of raw) {
    if (typeof value !== 'string') {
      throw new EnrichmentCleanupInputError('domains must be an array of strings');
    }
    domains.push(value.trim().toLowerCase());
  }
  return [...new Set(domains)];
}

function skipReasonFor(row: CandidateRow): EnrichmentCleanupSkipReason {
  if (row.source_type !== 'enriched') return 'not_enriched';
  if (row.workos_organization_id) return 'owned_by_organization';
  return 'edited_or_curated';
}

/** The domain-rule reason a domain qualifies under criteria mode, if any. */
function criteriaReason(domain: string): { reason: 'reserved_name' | 'not_registrable_domain'; registrable_domain: string | null } | null {
  const classification = classifyEnrichmentDomain(domain);
  if (classification.rejection === 'reserved_name' || classification.rejection === 'not_registrable_domain') {
    return { reason: classification.rejection, registrable_domain: classification.registrable_domain };
  }
  return null;
}

async function scanByCriteria(): Promise<{ candidates: EnrichmentCleanupCandidate[]; skipped: EnrichmentCleanupSkip[] }> {
  // SQL narrows to enriched rows that could fail the domain rules: three or
  // more labels, or a reserved suffix. The Public Suffix List check runs
  // here in code, since a name like `acme.co.uk` is a subdomain only if the
  // PSL says so.
  const result = await query<CandidateRow>(
    `SELECT brands.domain, brands.brand_name, brands.source_type,
            brands.workos_organization_id,
            ${REMOVABLE_ENRICHMENT_SQL} AS removable
     FROM brands
     WHERE brands.source_type = 'enriched'
       AND (
         brands.domain LIKE '%.%.%'
         OR brands.domain LIKE '%.example'
         OR brands.domain LIKE '%.test'
         OR brands.domain LIKE '%.invalid'
         OR brands.domain LIKE '%.localhost'
         OR brands.domain IN ('example.com', 'example.net', 'example.org')
       )
     ORDER BY brands.domain`,
  );

  const candidates: EnrichmentCleanupCandidate[] = [];
  const skipped: EnrichmentCleanupSkip[] = [];
  for (const row of result.rows) {
    const match = criteriaReason(row.domain);
    if (!match) continue;
    if (!row.removable) {
      skipped.push({ domain: row.domain, brand_name: row.brand_name, reason: skipReasonFor(row) });
      continue;
    }
    candidates.push({ domain: row.domain, brand_name: row.brand_name, ...match });
  }
  return { candidates, skipped };
}

async function selectFromList(
  domains: string[],
  mode: EnrichmentCleanupMode,
): Promise<{ candidates: EnrichmentCleanupCandidate[]; skipped: EnrichmentCleanupSkip[] }> {
  const candidates: EnrichmentCleanupCandidate[] = [];
  const skipped: EnrichmentCleanupSkip[] = [];

  const valid = domains.filter((domain) => {
    if (domain.length > 253 || !DOMAIN_SHAPE.test(domain)) {
      skipped.push({ domain, reason: 'invalid_domain' });
      return false;
    }
    return true;
  });

  const result = valid.length > 0
    ? await query<CandidateRow>(
        `SELECT brands.domain, brands.brand_name, brands.source_type,
                brands.workos_organization_id,
                ${REMOVABLE_ENRICHMENT_SQL} AS removable
         FROM brands
         WHERE brands.domain = ANY($1::text[])`,
        [valid],
      )
    : { rows: [] as CandidateRow[] };
  const byDomain = new Map(result.rows.map((row) => [row.domain, row]));

  for (const domain of valid) {
    const row = byDomain.get(domain);
    if (!row) {
      skipped.push({ domain, reason: 'not_found' });
      continue;
    }
    const match = criteriaReason(domain);
    if (mode === 'criteria' && !match) {
      skipped.push({ domain, brand_name: row.brand_name, reason: 'registrable_domain' });
      continue;
    }
    if (!row.removable) {
      skipped.push({ domain, brand_name: row.brand_name, reason: skipReasonFor(row) });
      continue;
    }
    candidates.push({
      domain,
      brand_name: row.brand_name,
      reason: match?.reason ?? 'explicit_list',
      registrable_domain: match?.registrable_domain ?? classifyEnrichmentDomain(domain).registrable_domain,
    });
  }
  return { candidates, skipped };
}

/** List what a cleanup would remove. Deletes nothing. */
export async function previewEnrichmentCleanup(options: {
  domains?: string[];
  mode?: EnrichmentCleanupMode;
} = {}): Promise<EnrichmentCleanupPreview> {
  const mode = options.mode ?? (options.domains ? 'explicit_list' : 'criteria');
  if (mode === 'explicit_list' && !options.domains) {
    throw new EnrichmentCleanupInputError('explicit_list mode needs a domains list');
  }
  const { candidates, skipped } = options.domains
    ? await selectFromList(options.domains, mode)
    : await scanByCriteria();
  return {
    mode,
    candidates: candidates.slice(0, ENRICHMENT_CLEANUP_MAX_BATCH),
    skipped: skipped.slice(0, ENRICHMENT_CLEANUP_MAX_BATCH),
    total_candidates: candidates.length,
    total_skipped: skipped.length,
    truncated: candidates.length > ENRICHMENT_CLEANUP_MAX_BATCH || skipped.length > ENRICHMENT_CLEANUP_MAX_BATCH,
    max_batch: ENRICHMENT_CLEANUP_MAX_BATCH,
  };
}

/**
 * Remove exactly the listed records that still qualify, with an audit entry
 * per record attributed to `actorUserId`. Listed records that no longer
 * qualify are reported in `skipped`, never removed.
 */
export async function applyEnrichmentCleanup(options: {
  domains: string[];
  mode: EnrichmentCleanupMode;
  actorUserId: string;
  actorEmail?: string | null;
}): Promise<EnrichmentCleanupResult> {
  if (!options.actorUserId) {
    throw new EnrichmentCleanupInputError('An admin user is required to apply a cleanup');
  }
  if (!Array.isArray(options.domains) || options.domains.length === 0) {
    throw new EnrichmentCleanupInputError('A delete needs the exact domains list from the preview');
  }
  const { candidates, skipped: selectionSkips } = await selectFromList(
    options.domains.slice(0, ENRICHMENT_CLEANUP_MAX_BATCH),
    options.mode,
  );
  const deleted: EnrichmentCleanupCandidate[] = [];
  const skipped = [...selectionSkips];
  const failed: Array<{ domain: string; error: string }> = [];

  for (const candidate of candidates) {
    try {
      const removed = await brandDb.deleteDiscoveredBrand(
        candidate.domain,
        { actor_user_id: options.actorUserId, source: ENRICHMENT_CLEANUP_AUDIT_SOURCE },
        {
          onlyIfRemovableEnrichment: true,
          recordDeletion: {
            reason: candidate.reason,
            registrable_domain: candidate.registrable_domain,
            mode: options.mode,
            ...(options.actorEmail ? { actor_email: options.actorEmail } : {}),
          },
        },
      );
      if (removed) {
        deleted.push(candidate);
      } else {
        skipped.push({ domain: candidate.domain, brand_name: candidate.brand_name, reason: 'no_longer_removable' });
      }
    } catch (err) {
      logger.error({ err, domain: candidate.domain }, 'Failed to delete enrichment record during cleanup');
      failed.push({ domain: candidate.domain, error: 'delete failed' });
    }
  }

  logger.info(
    {
      actor: options.actorUserId,
      mode: options.mode,
      requested: options.domains.length,
      deleted: deleted.length,
      skipped: skipped.length,
      failed: failed.length,
    },
    'Enrichment cleanup applied',
  );

  return { mode: options.mode, deleted, skipped, failed, max_batch: ENRICHMENT_CLEANUP_MAX_BATCH };
}
