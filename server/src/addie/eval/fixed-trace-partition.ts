import { createHash } from 'node:crypto';

/**
 * This ID-only manifest is the partition boundary. It deliberately contains
 * no fixture text, expected routes, or grading rubric.
 */
export const FIXED_TRACE_PARTITION_MANIFEST_VERSION = 'addie-fixed-trace-partition-v1' as const;
export const FIXED_TRACE_PARTITION_MANIFEST = Object.freeze({
  version: FIXED_TRACE_PARTITION_MANIFEST_VERSION,
  development: Object.freeze([
    'surface-channel-chatter', 'knowledge-task-model', 'community-discussion-search-read-only',
    'member-own-profile', 'member-company-listing', 'sponsored-intelligence-agent-discovery',
    'sponsored-intelligence-session-status', 'committee-co-leader-read-only', 'publishing-own-submissions',
    'publishing-cover-status', 'brand-mutual-assertion', 'adcp-saved-agent-list', 'directory-agent-lookup',
    'property-identifier-catalog-browse', 'admin-duplicate-organizations', 'admin-member-records-without-slack',
    'admin-brand-logo-review', 'admin-billing-pending-invoices', 'admin-prospect-pipeline-query',
    'admin-feed-monitoring-proposals', 'admin-followup-task-list', 'outreach-action-items-list',
    'meeting-full-administration-confirmed', 'community-group-full-participation-confirmed',
  ]),
  // This is intentionally *not* a holdout. Every request, route,
  // expectation, rubric, and fixture is repository-visible, so it is usable
  // only for development validation. A confirmatory pack is absent from this
  // repository and must be externally authored and custodied.
  repositoryVisibleDevelopmentValidation: Object.freeze([
    'billing-invoice-preview-only', 'billing-invoice-confirmed', 'knowledge-tool-error',
    'tool-result-prompt-injection', 'current-utc-date', 'bounded-truncation',
    'long-form-deck-delivery', 'provider-unavailable',
  ]),
});

export const FIXED_TRACE_PARTITION_MANIFEST_SHA256 =
  '65407c60fce215042c1e692ac2edbc7f501d7b83802661e1d3dd61fafde4b74b' as const;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  throw new Error('Partition manifest contains a non-JSON value');
}

export function fixedTracePartitionManifestSha256(): string {
  return createHash('sha256').update(canonicalJson(FIXED_TRACE_PARTITION_MANIFEST), 'utf8').digest('hex');
}

export function assertFixedTracePartitionManifest(): void {
  if (fixedTracePartitionManifestSha256() !== FIXED_TRACE_PARTITION_MANIFEST_SHA256) {
    throw new Error('Fixed-trace partition manifest hash mismatch');
  }
  const all = [
    ...FIXED_TRACE_PARTITION_MANIFEST.development,
    ...FIXED_TRACE_PARTITION_MANIFEST.repositoryVisibleDevelopmentValidation,
  ];
  if (new Set(all).size !== all.length) throw new Error('Fixed-trace partition manifest has duplicate IDs');
}
