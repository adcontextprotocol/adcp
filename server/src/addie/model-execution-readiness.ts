import { query as defaultQuery } from '../db/client.js';

export type ModelExecutionReadinessSurface = 'thread_messages' | 'interactions';

export type ModelExecutionReadinessBlockerReason =
  | 'insufficient_sample_size'
  | 'unclassified_executions'
  | 'legacy_executions'
  | 'invalid_provenance';

export interface ModelExecutionReadinessBlocker {
  surface: ModelExecutionReadinessSurface;
  reason: ModelExecutionReadinessBlockerReason;
}

export interface ModelExecutionReadinessSurfaceSummary {
  total: number;
  provider: number;
  local: number;
  unclassified: number;
  legacy: number;
  invalid: number;
  fallback: number;
  canonicalized: number;
  classification_rate: number;
  persisted_data_ready: boolean;
  blockers: ModelExecutionReadinessBlockerReason[];
}

export interface ModelExecutionReadinessSummary {
  scope: 'persisted_provenance_data';
  limitations: [
    'requires_deployment_drain_confirmation',
    'does_not_measure_failed_database_writes',
    'not_a_provider_canary_gate',
  ];
  window: {
    start: string;
    end: string;
    hours: number;
  };
  minimum_thread_message_samples: number;
  minimum_interaction_samples: 1;
  surfaces: Record<ModelExecutionReadinessSurface, ModelExecutionReadinessSurfaceSummary>;
  persisted_data_ready: boolean;
  blockers: ModelExecutionReadinessBlocker[];
}

interface AggregateRow {
  surface: ModelExecutionReadinessSurface;
  total: string;
  provider: string;
  local: string;
  unclassified: string;
  legacy: string;
  invalid: string;
  fallback: string;
  canonicalized: string;
}

export interface ModelExecutionReadinessOptions {
  hours?: number;
  minimumSamples?: number;
  now?: Date;
}

type AggregateQuery = (
  text: string,
  params: unknown[],
) => Promise<{ rows: AggregateRow[] }>;

// Keep the canonical message history and the still-active legacy audit sink as
// separate surfaces: many Slack responses are written to both tables, so
// combining them would produce a misleading response denominator. A dirty row
// in either sink still blocks the overall readiness decision.
const AGGREGATE_SQL = `
  WITH executions AS (
    SELECT
      'thread_messages'::text AS surface,
      role,
      role = 'assistant' AS included_in_denominator,
      model_execution_source,
      requested_model_provider,
      requested_model,
      model_provider,
      provider_model,
      provider_model_resolution,
      provider_fallback_reason,
      local_response_reason
    FROM addie_thread_messages
    WHERE created_at >= $1
      AND created_at < $2
      AND (
        role = 'assistant'
        OR model_execution_source IS NOT NULL
        OR requested_model_provider IS NOT NULL OR requested_model IS NOT NULL
        OR model_provider IS NOT NULL OR provider_model IS NOT NULL
        OR provider_model_resolution IS NOT NULL OR provider_fallback_reason IS NOT NULL
        OR local_response_reason IS NOT NULL
      )

    UNION ALL

    SELECT
      'interactions'::text AS surface,
      NULL::text AS role,
      TRUE AS included_in_denominator,
      model_execution_source,
      requested_model_provider,
      requested_model,
      model_provider,
      provider_model,
      provider_model_resolution,
      provider_fallback_reason,
      local_response_reason
    FROM addie_interactions
    WHERE created_at >= $1
      AND created_at < $2
  ), surfaces(surface) AS (
    VALUES ('thread_messages'::text), ('interactions'::text)
  )
  SELECT
    surfaces.surface,
    COUNT(*) FILTER (WHERE included_in_denominator)::text AS total,
    COUNT(*) FILTER (WHERE included_in_denominator AND model_execution_source = 'provider')::text AS provider,
    COUNT(*) FILTER (WHERE included_in_denominator AND model_execution_source = 'local')::text AS local,
    COUNT(*) FILTER (WHERE included_in_denominator AND model_execution_source IS NULL)::text AS unclassified,
    COUNT(*) FILTER (WHERE included_in_denominator AND model_execution_source = 'legacy')::text AS legacy,
    COUNT(*) FILTER (WHERE included_in_denominator AND provider_model_resolution = 'fallback')::text AS fallback,
    COUNT(*) FILTER (WHERE included_in_denominator AND provider_model_resolution = 'provider_canonicalized')::text AS canonicalized,
    COUNT(*) FILTER (WHERE executions.surface IS NOT NULL AND (
      (executions.surface = 'thread_messages' AND role IS DISTINCT FROM 'assistant')
      OR (model_execution_source IS NULL AND (
        requested_model_provider IS NOT NULL OR requested_model IS NOT NULL
        OR model_provider IS NOT NULL OR provider_model IS NOT NULL
        OR provider_model_resolution IS NOT NULL OR provider_fallback_reason IS NOT NULL
        OR local_response_reason IS NOT NULL
      ))
      OR (model_execution_source IS NOT NULL AND model_execution_source NOT IN ('provider', 'local', 'legacy'))
      OR (requested_model_provider IS NOT NULL AND requested_model_provider NOT IN ('anthropic', 'openai', 'google'))
      OR (model_provider IS NOT NULL AND model_provider NOT IN ('anthropic', 'openai', 'google'))
      OR (requested_model IS NOT NULL AND length(btrim(requested_model)) NOT BETWEEN 1 AND 256)
      OR (provider_model IS NOT NULL AND length(btrim(provider_model)) NOT BETWEEN 1 AND 256)
      OR (provider_fallback_reason IS NOT NULL AND provider_fallback_reason NOT IN (
        'primary_unavailable', 'primary_rate_limited', 'primary_timeout',
        'primary_capability_unsupported', 'primary_policy_blocked'
      ))
      OR (local_response_reason IS NOT NULL AND local_response_reason NOT IN (
        'cost_cap_exceeded', 'provider_error', 'stream_interrupted',
        'no_provider_response', 'canned_response'
      ))
      OR (model_execution_source = 'legacy' AND (
        requested_model_provider IS NOT NULL OR requested_model IS NOT NULL
        OR model_provider IS NOT NULL OR provider_model IS NOT NULL
        OR provider_model_resolution IS NOT NULL OR provider_fallback_reason IS NOT NULL
        OR local_response_reason IS NOT NULL
      ))
      OR (model_execution_source = 'local' AND (
        ((requested_model_provider IS NULL) <> (requested_model IS NULL))
        OR model_provider IS NOT NULL OR provider_model IS NOT NULL
        OR provider_model_resolution IS NOT NULL OR provider_fallback_reason IS NOT NULL
        OR local_response_reason IS NULL
      ))
      OR (model_execution_source = 'provider' AND (
        requested_model_provider IS NULL OR requested_model IS NULL
        OR model_provider IS NULL OR provider_model IS NULL
        OR provider_model_resolution IS NULL OR local_response_reason IS NOT NULL
        OR (provider_model_resolution = 'exact' AND (
          requested_model_provider IS DISTINCT FROM model_provider
          OR requested_model IS DISTINCT FROM provider_model
          OR provider_fallback_reason IS NOT NULL
        ))
        OR (provider_model_resolution = 'provider_canonicalized' AND (
          requested_model_provider IS DISTINCT FROM model_provider
          OR requested_model IS NOT DISTINCT FROM provider_model
          OR provider_fallback_reason IS NOT NULL
        ))
        OR (provider_model_resolution = 'fallback' AND (
          (requested_model_provider IS NOT DISTINCT FROM model_provider
            AND requested_model IS NOT DISTINCT FROM provider_model)
          OR provider_fallback_reason IS NULL
        ))
        OR provider_model_resolution NOT IN ('exact', 'provider_canonicalized', 'fallback')
      ))
    ))::text AS invalid
  FROM surfaces
  LEFT JOIN executions USING (surface)
  GROUP BY surfaces.surface
  ORDER BY surfaces.surface
`;

function parseCount(value: string | undefined, field: string): number {
  if (value === undefined || !/^\d+$/.test(value)) {
    throw new TypeError(`Invalid aggregate count for ${field}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new TypeError(`Invalid aggregate count for ${field}`);
  }
  return parsed;
}

function summarizeSurface(
  row: AggregateRow,
  minimumSamples: number | null,
): ModelExecutionReadinessSurfaceSummary {
  const total = parseCount(row.total, `${row.surface}.total`);
  const provider = parseCount(row.provider, `${row.surface}.provider`);
  const local = parseCount(row.local, `${row.surface}.local`);
  const unclassified = parseCount(row.unclassified, `${row.surface}.unclassified`);
  const legacy = parseCount(row.legacy, `${row.surface}.legacy`);
  const invalid = parseCount(row.invalid, `${row.surface}.invalid`);
  const fallback = parseCount(row.fallback, `${row.surface}.fallback`);
  const canonicalized = parseCount(row.canonicalized, `${row.surface}.canonicalized`);
  const blockers: ModelExecutionReadinessBlockerReason[] = [];
  if (minimumSamples !== null && total < minimumSamples) blockers.push('insufficient_sample_size');
  if (unclassified > 0) blockers.push('unclassified_executions');
  if (legacy > 0) blockers.push('legacy_executions');
  if (invalid > 0) blockers.push('invalid_provenance');

  return {
    total,
    provider,
    local,
    unclassified,
    legacy,
    invalid,
    fallback,
    canonicalized,
    classification_rate: total === 0 ? 0 : (provider + local) / total,
    persisted_data_ready: blockers.length === 0,
    blockers,
  };
}

export function summarizeModelExecutionReadiness(
  rows: AggregateRow[],
  options: Required<Pick<ModelExecutionReadinessOptions, 'hours' | 'minimumSamples' | 'now'>>,
): ModelExecutionReadinessSummary {
  const expectedSurfaces: ModelExecutionReadinessSurface[] = ['thread_messages', 'interactions'];
  if (rows.length !== expectedSurfaces.length
    || expectedSurfaces.some((surface) => rows.filter((row) => row.surface === surface).length !== 1)
    || rows.some((row) => !expectedSurfaces.includes(row.surface))) {
    throw new TypeError('Readiness aggregate must contain exactly one row per surface');
  }
  const bySurface = new Map(rows.map((row) => [row.surface, row]));
  const surfaces = {
    thread_messages: summarizeSurface(
      bySurface.get('thread_messages')!,
      options.minimumSamples,
    ),
    interactions: summarizeSurface(
      bySurface.get('interactions')!,
      1,
    ),
  };
  const blockers = (Object.entries(surfaces) as Array<[
    ModelExecutionReadinessSurface,
    ModelExecutionReadinessSurfaceSummary,
  ]>).flatMap(([surface, summary]) => summary.blockers.map((reason) => ({ surface, reason })));

  const end = new Date(options.now);
  const start = new Date(end.getTime() - options.hours * 60 * 60 * 1000);
  return {
    scope: 'persisted_provenance_data',
    limitations: [
      'requires_deployment_drain_confirmation',
      'does_not_measure_failed_database_writes',
      'not_a_provider_canary_gate',
    ],
    window: {
      start: start.toISOString(),
      end: end.toISOString(),
      hours: options.hours,
    },
    minimum_thread_message_samples: options.minimumSamples,
    minimum_interaction_samples: 1,
    surfaces,
    persisted_data_ready: blockers.length === 0,
    blockers,
  };
}

export async function getModelExecutionReadiness(
  options: ModelExecutionReadinessOptions = {},
  query: AggregateQuery = defaultQuery as AggregateQuery,
): Promise<ModelExecutionReadinessSummary> {
  const hours = options.hours ?? 24;
  const minimumSamples = options.minimumSamples ?? 100;
  const now = options.now ?? new Date();
  if (!Number.isInteger(hours) || hours < 1 || hours > 168) {
    throw new RangeError('hours must be an integer from 1 to 168');
  }
  if (!Number.isInteger(minimumSamples) || minimumSamples < 1 || minimumSamples > 10_000) {
    throw new RangeError('minimumSamples must be an integer from 1 to 10000');
  }
  if (!Number.isFinite(now.getTime())) {
    throw new RangeError('now must be a valid date');
  }

  const start = new Date(now.getTime() - hours * 60 * 60 * 1000);
  const result = await query(AGGREGATE_SQL, [start, now]);
  return summarizeModelExecutionReadiness(result.rows, { hours, minimumSamples, now });
}
