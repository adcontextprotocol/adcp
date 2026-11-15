/**
 * Admin cleanup for enrichment records that should never have been saved
 * (adcp#9024).
 *
 * Before the write guard in `enrichment-persistence-guard.ts`, any lookup
 * could save a Brandfetch answer, so test runs filed made-up subdomains and
 * reserved names as brands. This finds those records and removes them.
 *
 * Two ways to select:
 *
 *  - **Criteria** (no domain list): `source_type = 'enriched'` rows whose
 *    domain is a reserved name or is not its own registrable domain, the
 *    same domain rules the write guard now applies.
 *  - **Explicit list**: the given domains, when each is an enriched record.
 *    For junk that is a registrable domain, such as a lookup Brandfetch
 *    answered with another domain's brand.
 *
 * Either way, a record is only ever removed while it matches
 * `REMOVABLE_ENRICHMENT_SQL`: enriched, held by no organization, never edited
 * by a person, no logo from anyone but Brandfetch, and not the house of
 * another brand. That predicate runs in the selection and again inside each
 * DELETE, so hosted, brand.json, community and curated records are never
 * removed, even if one changes between the preview and the apply. Batches
 * are capped, and running the same cleanup twice removes nothing the second
 * time.
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

export type EnrichmentCleanupReason = 'reserved_name' | 'not_registrable_domain' | 'explicit_list';

export type EnrichmentCleanupSkipReason =
  | 'invalid_domain'
  | 'not_found'
  | 'not_enriched'
  | 'owned_by_organization'
  | 'edited_or_curated'
  | 'changed_since_preview';

export interface EnrichmentCleanupCandidate {
  domain: string;
  brand_name: string | null;
  reason: EnrichmentCleanupReason;
  /** eTLD+1 of the domain, so the admin can see which brand it shadows. */
  registrable_domain: string | null;
}

export interface EnrichmentCleanupSkip {
  domain: string;
  brand_name?: string | null;
  reason: EnrichmentCleanupSkipReason;
}

export interface EnrichmentCleanupPreview {
  mode: 'criteria' | 'explicit_list';
  candidates: EnrichmentCleanupCandidate[];
  skipped: EnrichmentCleanupSkip[];
  /** Candidates found before the batch cap. */
  total_candidates: number;
  truncated: boolean;
  max_batch: number;
}

export interface EnrichmentCleanupResult {
  mode: 'criteria' | 'explicit_list';
  deleted: EnrichmentCleanupCandidate[];
  skipped: EnrichmentCleanupSkip[];
  failed: Array<{ domain: string; error: string }>;
  /** Candidates past the batch cap, left for another run. */
  remaining: number;
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

/**
 * Validate an explicit domain list. Domains are matched exactly, after
 * trimming and lowercasing, because a delete should name the row it removes.
 */
export function normalizeCleanupDomains(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new EnrichmentCleanupInputError('domains must be an array of strings');
  }
  if (raw.length === 0) {
    throw new EnrichmentCleanupInputError('domains must not be empty; omit it to select by criteria');
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

async function selectByCriteria(): Promise<{ candidates: EnrichmentCleanupCandidate[]; skipped: EnrichmentCleanupSkip[] }> {
  // SQL narrows to enriched rows that could fail the domain rules: three or
  // more labels, or a reserved suffix. The Public Suffix List check runs
  // here in code, since a two-label name like `acme.co.uk` is a subdomain
  // only if the PSL says so.
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
    const classification = classifyEnrichmentDomain(row.domain);
    if (classification.rejection !== 'reserved_name' && classification.rejection !== 'not_registrable_domain') {
      continue;
    }
    if (!row.removable) {
      skipped.push({ domain: row.domain, brand_name: row.brand_name, reason: skipReasonFor(row) });
      continue;
    }
    candidates.push({
      domain: row.domain,
      brand_name: row.brand_name,
      reason: classification.rejection,
      registrable_domain: classification.registrable_domain,
    });
  }
  return { candidates, skipped };
}

async function selectByList(domains: string[]): Promise<{ candidates: EnrichmentCleanupCandidate[]; skipped: EnrichmentCleanupSkip[] }> {
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
    if (!row.removable) {
      skipped.push({ domain, brand_name: row.brand_name, reason: skipReasonFor(row) });
      continue;
    }
    const classification = classifyEnrichmentDomain(domain);
    const reason: EnrichmentCleanupReason =
      classification.rejection === 'reserved_name' || classification.rejection === 'not_registrable_domain'
        ? classification.rejection
        : 'explicit_list';
    candidates.push({
      domain,
      brand_name: row.brand_name,
      reason,
      registrable_domain: classification.registrable_domain,
    });
  }
  return { candidates, skipped };
}

/** List what a cleanup would remove. Deletes nothing. */
export async function previewEnrichmentCleanup(options: { domains?: string[] } = {}): Promise<EnrichmentCleanupPreview> {
  const mode = options.domains ? 'explicit_list' : 'criteria';
  const { candidates, skipped } = options.domains
    ? await selectByList(options.domains)
    : await selectByCriteria();
  return {
    mode,
    candidates: candidates.slice(0, ENRICHMENT_CLEANUP_MAX_BATCH),
    skipped,
    total_candidates: candidates.length,
    truncated: candidates.length > ENRICHMENT_CLEANUP_MAX_BATCH,
    max_batch: ENRICHMENT_CLEANUP_MAX_BATCH,
  };
}

/**
 * Remove what `previewEnrichmentCleanup` lists, up to the batch cap, with an
 * audit entry per record attributed to `actorUserId`.
 */
export async function applyEnrichmentCleanup(options: {
  domains?: string[];
  actorUserId: string;
  actorEmail?: string | null;
}): Promise<EnrichmentCleanupResult> {
  if (!options.actorUserId) {
    throw new EnrichmentCleanupInputError('An admin user is required to apply a cleanup');
  }
  const preview = await previewEnrichmentCleanup({ domains: options.domains });
  const deleted: EnrichmentCleanupCandidate[] = [];
  const skipped = [...preview.skipped];
  const failed: Array<{ domain: string; error: string }> = [];

  for (const candidate of preview.candidates) {
    try {
      const removed = await brandDb.deleteDiscoveredBrand(
        candidate.domain,
        { actor_user_id: options.actorUserId, source: ENRICHMENT_CLEANUP_AUDIT_SOURCE },
        {
          onlyIfRemovableEnrichment: true,
          recordDeletion: {
            reason: candidate.reason,
            registrable_domain: candidate.registrable_domain,
            mode: preview.mode,
            ...(options.actorEmail ? { actor_email: options.actorEmail } : {}),
          },
        },
      );
      if (removed) {
        deleted.push(candidate);
      } else {
        skipped.push({ domain: candidate.domain, brand_name: candidate.brand_name, reason: 'changed_since_preview' });
      }
    } catch (err) {
      logger.error({ err, domain: candidate.domain }, 'Failed to delete enrichment record during cleanup');
      failed.push({ domain: candidate.domain, error: 'delete failed' });
    }
  }

  logger.info(
    {
      actor: options.actorUserId,
      mode: preview.mode,
      deleted: deleted.length,
      skipped: skipped.length,
      failed: failed.length,
    },
    'Enrichment cleanup applied',
  );

  return {
    mode: preview.mode,
    deleted,
    skipped,
    failed,
    remaining: Math.max(preview.total_candidates - preview.candidates.length, 0),
    max_batch: ENRICHMENT_CLEANUP_MAX_BATCH,
  };
}
