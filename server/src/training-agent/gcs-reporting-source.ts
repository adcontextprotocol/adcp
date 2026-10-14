import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { canonicalize } from '@adcp/sdk';
import type { ReportingPgPool, ReportingLedgerConfigurationV1 } from '@adcp/sdk/reporting/ledger';
import { ReportingSourceNotReadyError, buildReportingSourceManifestV1, completedReportingSourceResponseV1, reportingSourceCapabilitiesV1, type InlineReportingDeliveryFetchV1, type ReportingSourceOfferingV1, type ReportingSourceSliceRequestV1 } from '@adcp/sdk/reporting/source';
import type { ReportingSourceWithReaderV1 } from '@adcp/sdk/reporting/ledger';
import type { ReliableReportingAdapterV1 } from '@adcp/sdk/reporting/service';
import {
  TRAINING_REPORTING_DEFINITION_BYTES,
  TRAINING_REPORTING_ROW_SCHEMA_BYTES,
  TRAINING_REPORTING_CORE_OFFERING,
  obligationId,
} from './reporting-reliability.js';

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
export const GCS_OFFERING_ID = 'training-gcs-daily-v1';
export const GCS_REPORTING_PRODUCT = 'training-reporting-ledger';
export const GCS_REPORT_DEFINITION_ID = 'training_gcs_delivery_summary_v1';
// Identify the actual TS entrypoint in local tests or emitted JS in deployment.
// A version-label hash cannot attest which adapter artifact executed.
const adapterBuildSha256 = sha256(readFileSync(new URL(import.meta.url), 'utf8'));
const mappingBytes = canonicalize({
  contract_version: '1.0', mapping_id: 'training-committed-revisions-v1', mapping_version: '1',
  row_projection: 'identity', fields: ['period_start', 'period_end', 'impressions'],
  target_schema_sha256: sha256(TRAINING_REPORTING_ROW_SCHEMA_BYTES),
});
// The published SDK inspector understands definition contract 1.0. The legacy
// training definition is 1.1. This separate snapshot-only contract keeps its
// row/query semantics and omits the 1.1-only official correction policy.
const legacyDefinition = JSON.parse(TRAINING_REPORTING_DEFINITION_BYTES);
export const TRAINING_GCS_DEFINITION_BYTES = canonicalize({
  ...legacyDefinition, contract_version: '1.0', report_definition_id: GCS_REPORT_DEFINITION_ID,
  metrics: [{ name: 'impressions', source_expression: 'impressions', aggregation: 'sum', unit: 'impressions' }],
  restatement_policy: { source_requery_duration: 'PT0S', emit_only_on_content_change: true },
});
const orderingRows = [
  { period_start: '2026-01-01T00:00:00.000Z', period_end: '2026-01-02T00:00:00.000Z', impressions: 1 },
  { period_start: '2026-01-02T00:00:00.000Z', period_end: '2026-01-03T00:00:00.000Z', impressions: 2 },
];
const vector = (rows: Record<string, unknown>[], canonicalRows: Record<string, unknown>[]) => {
  const bytes = canonicalize(canonicalRows);
  return { input_rows: rows, canonical_utf8_base64: Buffer.from(bytes).toString('base64'), sha256: sha256(bytes) };
};
// Preserve the deliberately noncanonical member order in the encoding vector.
export const TRAINING_GCS_CANONICALIZATION_BYTES = JSON.stringify({
  contract_version: '1.0', media_type: 'application/vnd.adcp.reporting-canonicalization+json',
  algorithm: 'adcp_jcs_rows_v1', schema_sha256: sha256(TRAINING_REPORTING_ROW_SCHEMA_BYTES),
  primary_keys: ['period_start', 'period_end'],
  golden_vectors: {
    empty_report: { name: 'empty', purpose: 'empty_report', ...vector([], []) },
    ordering_encoding: { name: 'ordering', purpose: 'ordering_encoding', ...vector([...orderingRows].reverse(), orderingRows) },
  },
});
export function trainingGcsCanonicalization(bucket: string, contractPrefix: string) {
  return { id: 'training_gcs_jcs_rows_v1', uri: `https://storage.googleapis.com/${bucket}/${contractPrefix}canonicalization.json`,
    sha256: sha256(TRAINING_GCS_CANONICALIZATION_BYTES), primaryKeys: ['period_start', 'period_end'] };
}

/** The private snapshot contract and unchanged row schema have separate pins. */
export function trainingGcsAdapter(db: ReportingPgPool, bucket: string, contractPrefix: string): ReliableReportingAdapterV1 {
  const uri = (name: string) => `https://storage.googleapis.com/${bucket}/${contractPrefix}${name}`;
  const contract = {
    report_definition_id: GCS_REPORT_DEFINITION_ID,
    reportDefinitionUri: uri('definition.json'),
    reportDefinitionSha256: sha256(TRAINING_GCS_DEFINITION_BYTES),
    reportingProfile: TRAINING_REPORTING_CORE_OFFERING.reporting_profile.id,
    schemaVersion: '1.0', schemaUri: uri('schema.json'),
    schemaSha256: sha256(TRAINING_REPORTING_ROW_SCHEMA_BYTES),
    schemaDialect: 'https://json-schema.org/draft/2020-12/schema' as const,
    schemaRefPolicy: 'local_fragment_only' as const,
    mappingId: 'training-committed-revisions-v1', mappingVersion: '1',
    mappingSha256: sha256(mappingBytes),
  };
  const sourceOffering: ReportingSourceOfferingV1 = {
    offeringId: GCS_OFFERING_ID, publicationNamespace: 'training-reporting:gcs',
    publicationClass: 'PROVISIONAL_SNAPSHOT',
    adapterBuild: { executorId: GCS_OFFERING_ID, adapterId: 'training-committed-revisions', adapterVersion: '1.0.0', adapterBuildSha256 },
    applicability: { productIds: [GCS_REPORTING_PRODUCT], constituentKinds: ['media_buy'] },
    contract, sourceTimezone: { ownership: 'source_scope', calendar: 'gregory', ianaTimezone: 'UTC' },
    grain: 'one aggregate delivery summary per reporting period',
    windowing: { kind: 'fixed_closed_window', minimumWindow: 'P1D', maximumWindow: 'P1D', overlappingWindowsSupported: false },
    metrics: [{ name: 'impressions', support: 'exact', semanticContractId: 'training.impressions', semanticContractVersion: '1', semanticContractSha256: contract.reportDefinitionSha256 }],
    dimensions: [], sourceSettings: { currencies: 'source_scope', attributionModels: ['source_default'], attributionWindows: ['source_default'] },
    formats: [{ mediaType: 'application/x-ndjson', compression: 'none' }],
    sourceExecution: { pagination: 'none', asyncJobs: 'optional', maximumWindowDaysPerRequest: 1, supportsCancellation: true, manifestLevels: ['basic'], rateLimitConstraints: [] },
    retentionDays: 31,
    cadence: { fastestSafeCadence: 'PT1H', alignment: 'unaligned', expectedAvailabilityLag: 'PT1H', worstCaseAvailabilityLag: 'PT2H', triggerSupport: { scheduledPoll: true, upstreamReadinessOrChangeWebhook: false, hybrid: false, pollingFallbackRequired: true, webhookSemantics: 'acceleration_hint_only' } },
    revisionSemantics: 'provisional_replaceable',
  };
  return {
    sourceOffering,
    deliveryOffering: {
      ...TRAINING_REPORTING_CORE_OFFERING, offering_id: GCS_OFFERING_ID, feed_purpose: 'analytics',
      report_definition_id: contract.report_definition_id, report_definition_sha256: contract.reportDefinitionSha256,
      reconciliation_mode: 'consumer_receipt',
      report_definition_uri: contract.reportDefinitionUri,
      reporting_profile: {
        ...TRAINING_REPORTING_CORE_OFFERING.reporting_profile, schema_uri: contract.schemaUri,
        primary_keys: ['period_start', 'period_end'],
        canonicalization_id: trainingGcsCanonicalization(bucket, contractPrefix).id,
        canonicalization_uri: trainingGcsCanonicalization(bucket, contractPrefix).uri,
        canonicalization_sha256: trainingGcsCanonicalization(bucket, contractPrefix).sha256,
        canonicalization_contract_version: '1.0', canonicalization_media_type: 'application/vnd.adcp.reporting-canonicalization+json',
      },
      schedule: { period_duration: 'P1D', alignment: 'utc', delivery_sla: 'PT4H' },
      method: { pattern: 'file_transfer', transport: 'gcs', format: 'jsonl', orchestration: 'producer_managed', destination_modes: ['provision'], provider: { domain: 'storage.googleapis.com' }, access_mode: 'read_only' },
    },
    executor: committedTrainingSourceExecutor(db, sourceOffering),
  };
}

/** Retain source staging and exact replay across process restarts. */
export function committedTrainingSourceExecutor(db: ReportingPgPool, offering: ReportingSourceOfferingV1): ReportingSourceWithReaderV1 {
  const sliceHash = (request: ReportingSourceSliceRequestV1) => sha256(canonicalize({
    identity: request.identity, account: request.account, sourceScope: request.sourceScope,
    configuration: [request.delivery_config_id, request.delivery_config_version, request.reporting_obligation_id],
    contract: request.contract, adapterBuild: request.adapterBuild, offeringId: request.offeringId,
    period: request.period, coverage: request.coverage, sourceSettings: request.sourceSettings,
    finality: request.finality, requestedMetrics: request.requestedMetrics, requestedDimensions: request.requestedDimensions,
  }));
  async function retained(request: ReportingSourceSliceRequestV1) {
    const { rows } = await db.query<{ fingerprint: string; slice_hash: string; reference: Parameters<typeof completedReportingSourceResponseV1>[0]['manifest']; manifest_bytes: Buffer }>(
      'SELECT fingerprint, slice_hash, reference, manifest_bytes FROM host_source_executions WHERE execution_key=$1', [request.identity.sourceExecutionKey]);
    const saved = rows[0];
    if (!saved) return undefined;
    if (saved.fingerprint !== request.identity.logicalSliceFingerprint || saved.slice_hash !== sliceHash(request)) throw new Error('Reporting source execution identity conflict.');
    return { ok: true as const, response: completedReportingSourceResponseV1({ request, manifest: saved.reference }), manifestBytes: saved.manifest_bytes };
  }
  return {
    capabilities: reportingSourceCapabilitiesV1([offering], 'training-committed-revisions-v1'),
    execute: async (request, context) => {
      try {
        context.signal.throwIfAborted();
        const replay = await retained(request);
        if (replay) return replay;
        const fetchSlice = committedTrainingRevisionFetch(db);
        const fetched = await fetchSlice({
          account: request.account, media_buy_ids: request.coverage.mediaBuyIds,
          constituents: request.coverage.constituents.flatMap(item => item.constituentKind === 'media_buy' ? [{ constituent_id: item.constituentId, media_buy_id: item.mediaBuyId }] : []),
          start_date: request.period.start, end_date: request.period.end, source_read_cutoff_at: request.period.end,
          requested_metrics: request.requestedMetrics, reporting_dimensions: {},
        }, { signal: context.signal, sourceScope: request.sourceScope, reporting_obligation_id: request.reporting_obligation_id, sourceSettings: request.sourceSettings, contract: request.contract });
        if (!fetched || Array.isArray(fetched) || !('reporting_rows' in fetched) || !fetched.reporting_rows
          || fetched.reporting_period?.start !== request.period.start || fetched.reporting_period?.end !== request.period.end) {
          throw new ReportingSourceNotReadyError('Committed source period does not match the requested reporting slice.');
        }
        if (fetched.reporting_rows.some(row => !row || typeof row !== 'object' || Array.isArray(row)
          || !('period_start' in row) || row.period_start !== request.period.start
          || !('period_end' in row) || row.period_end !== request.period.end
          || !('impressions' in row) || !Number.isSafeInteger(row.impressions) || Number(row.impressions) < 0)) {
          throw new Error('Committed aggregate rows differ from the saved period or metric contract.');
        }
        const bytes = Buffer.from(fetched.reporting_rows.map(row => canonicalize(row) + '\n').join(''));
        if (bytes.length > 4 * 1024 * 1024) throw new Error('Committed source exceeds canary payload limit.');
        const objectRef = `training-source.${sha256(request.identity.sourceExecutionKey)}`;
        const generation = sha256(bytes.toString('utf8'));
        const built = buildReportingSourceManifestV1({
          request, level: 'basic', stagedCommitRef: `${objectRef}.manifest`,
          objects: [{ ordinal: 0, objectRef, objectGeneration: generation, mediaType: 'application/x-ndjson', compression: 'none', sha256: generation, byteCount: bytes.length, rowCount: fetched.reporting_rows.length }],
          completeness: { terminal: true, rowsComplete: true, requestedGroupsComplete: true },
          metricAvailability: request.coverage.constituents.flatMap(item => offering.metrics.map(metric => ({ constituentId: item.constituentId, metric: metric.name, semanticContractId: metric.semanticContractId, semanticContractVersion: metric.semanticContractVersion, semanticContractSha256: metric.semanticContractSha256, status: fetched.reporting_rows!.length === 0 ? 'explicit_zero' as const : 'present' as const, dataThrough: request.period.end }))),
          coverage: { status: 'full', constituents: request.coverage.constituents.map(item => ({ ...item, status: fetched.reporting_rows!.length === 0 ? 'explicit_zero' as const : 'present' as const, dataThrough: request.period.end })) },
          observedAt: fetched.observed_at!, dataThrough: request.period.end,
          finalityEvidence: { owner: 'adapter', basis: 'provisional_observation', observedAt: fetched.observed_at! },
          explicitZero: fetched.reporting_rows.length === 0, acquiredAt: new Date().toISOString(),
          ...(fetched.reporting_rows.length ? { eventTimeRange: { start: request.period.start, end: request.period.end } } : {}),
        });
        context.signal.throwIfAborted();
        const client = await db.connect();
        try {
          await client.query('BEGIN');
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`training-gcs-source:${request.account.account_id}`]);
          // Keep replay longer than the 31-day status/resource retention. Bound admission
          // rather than evicting any source bytes still within that promise.
          await client.query("DELETE FROM host_source_executions WHERE account_id=$1 AND created_at < clock_timestamp() - interval '32 days'", [request.account.account_id]);
          const saved = await client.query<{ count: string }>('SELECT count(*) AS count FROM host_source_executions WHERE account_id=$1', [request.account.account_id]);
          if (Number(saved.rows[0].count) >= 128) throw new Error('Reporting source replay capacity exhausted.');
          context.signal.throwIfAborted();
          await client.query(`INSERT INTO host_source_executions (execution_key, fingerprint, object_ref, generation, account_id, source_scope, delivery_config_id, delivery_config_version, reporting_obligation_id, reference, manifest_bytes, object_bytes, slice_hash, report_definition_id)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT DO NOTHING`,
          [request.identity.sourceExecutionKey, request.identity.logicalSliceFingerprint, objectRef, generation, request.account.account_id, request.sourceScope, request.delivery_config_id, request.delivery_config_version, request.reporting_obligation_id, built.reference, Buffer.from(built.manifestBytes), bytes, sliceHash(request), request.report_definition_id]);
          context.signal.throwIfAborted();
          await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
        context.signal.throwIfAborted();
        return (await retained(request))!;
      } catch (error) {
        if (!(error instanceof ReportingSourceNotReadyError)) throw error;
        return { ok: false, error: { contractVersion: '1.0', code: 'NOT_READY', retry: 'retryable', scope: 'slice', safeMessage: 'A complete committed training period is not yet available.' } };
      }
    },
    read: async input => {
      input.signal.throwIfAborted();
      const { rows } = await db.query<{ object_bytes: Buffer }>(`SELECT object_bytes FROM host_source_executions
        WHERE object_ref=$1 AND generation=$2 AND account_id=$3 AND source_scope=$4
          AND delivery_config_id=$5 AND delivery_config_version=$6 AND reporting_obligation_id=$7
          AND report_definition_id=$8 AND octet_length(object_bytes) <= $9`,
      [input.objectRef, input.objectGeneration, input.account.account_id, input.sourceScope, input.delivery_config_id, input.delivery_config_version, input.reporting_obligation_id, input.report_definition_id, input.maxBytes]);
      input.signal.throwIfAborted();
      if (!rows[0]) throw new Error('Committed source object is unavailable within the authorized scope and byte limit.');
      return rows[0].object_bytes;
    },
  };
}

/** No synthetic empty result: the source must already have committed a revision. */
export function committedTrainingRevisionFetch(db: ReportingPgPool): InlineReportingDeliveryFetchV1 {
  return async (request, context) => {
    context.signal.throwIfAborted();
    const { rows } = await db.query<{ content: {
      revision: { period: { start: string; end: string }; coverage?: { media_buy_ids: string[]; status: string }; created_at: string };
      rows: Record<string, unknown>[];
    } }>(
      `SELECT entry->1 AS content
         FROM public.training_reporting_ledgers ledger,
              jsonb_array_elements(COALESCE(ledger.ledger->'revision_contents', '[]'::jsonb)) entry,
              jsonb_array_elements(COALESCE(ledger.ledger->'published_revisions', '[]'::jsonb)) published
        WHERE ledger.principal_scope = $1 AND ledger.account_id = $2
          AND published->>0 = $3
          AND published->1->>'reporting_revision_id' = entry->>0
          AND entry->1->'revision'->'period'->>'end' = $4
        ORDER BY entry->1->'revision'->>'created_at' DESC LIMIT 1`,
      [context.sourceScope.principal_id, request.account.account_id,
        obligationId(request.account.account_id, {
          delivery_config_id: String(context.sourceScope.source_config_id),
          delivery_config_version: Number(context.sourceScope.source_config_version),
        }, request.source_read_cutoff_at), request.source_read_cutoff_at],
    );
    context.signal.throwIfAborted();
    const content = rows[0]?.content;
    if (!content || content.revision.coverage?.status !== 'full'
      || JSON.stringify([...content.revision.coverage.media_buy_ids].sort()) !== JSON.stringify([...request.media_buy_ids].sort())) {
      throw new ReportingSourceNotReadyError('A complete committed training revision is not yet available.');
    }
    return {
      reporting_period: content.revision.period,
      currency: context.sourceSettings.currency,
      reporting_rows: content.rows,
      data_through: content.revision.period.end,
      observed_at: content.revision.created_at,
      availability_evidence: { version: '1.0', cells: request.constituents.flatMap(item => request.requested_metrics.map(metric => ({
        constituent_id: item.constituent_id, metric,
        status: content.rows.length === 0 ? 'explicit_zero' as const : 'present' as const,
        data_through: content.revision.period.end,
      }))) },
    };
  };
}

export function trainingConstituents(mediaBuyIds: string[]): ReportingLedgerConfigurationV1['constituents'] {
  return mediaBuyIds.map(mediaBuyId => ({
    constituentId: `training:${mediaBuyId}`, constituentKind: 'media_buy', productId: GCS_REPORTING_PRODUCT, mediaBuyId,
    productBinding: { owner: 'caller', bindingKind: 'media_buy_product', bindingId: `training.${sha256(mediaBuyId).slice(0, 32)}`, bindingVersion: 1, bindingSha256: sha256(JSON.stringify([GCS_REPORTING_PRODUCT, mediaBuyId])), productId: GCS_REPORTING_PRODUCT, mediaBuyId },
  }));
}
