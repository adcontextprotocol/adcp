/**
 * Deterministic Core-tier reporting ledger for the public sales training
 * agent. This deliberately models the durable reporting contract rather
 * than reusing delivery metrics: a configuration creates period obligations;
 * a media-buy acceptance or a materialized report never does.
 *
 * The production SDK owns tool registration and wire validation. This module
 * owns only sandbox fixture state so the same runnable exercise can show the
 * otherwise hard-to-observe "missing first report" boundary immediately.
 */

import { createHash, randomBytes } from 'node:crypto';
import type {
  GetReportingStatusRequest,
  GetReportingStatusResponse,
  ReportingObligation,
  ReportingRevision,
} from '@adcp/sdk';
import { canonicalize } from '@adcp/sdk';
import { getPool, isDatabaseInitialized } from '../db/client.js';
import { accountScopeFromRef } from './account-scope.js';
import { validateSourceSchema } from './source-schema.js';
import type { AccountRef } from './types.js';

// The training agent tracks the unreleased Reliable Reporting additions while
// the published SDK remains on the preceding experimental schema snapshot.
// Keep the compatibility surface explicit so callers and tests do not need to
// hide the new wire fields behind ad-hoc casts.
export type TrainingGetReportingStatusRequest = GetReportingStatusRequest & {
  changes_after?: string;
};

export type TrainingGetReportingStatusResponse = GetReportingStatusResponse & {
  changes_checkpoint?: string;
  adjustments?: unknown[];
  adjustment_receipts?: unknown[];
};

export interface TrainingReportingAdjustment {
  reporting_adjustment_id: string;
  adjusts_reporting_revision_id: string;
  reason_code: 'invalid_traffic' | 'late_attribution' | 'source_correction' | 'mapping_correction' | 'commercial_adjustment' | 'other';
  reason_detail?: string;
  accounting_period: { start: string; end: string };
  control_total_deltas: Array<{ name: string; value: string; value_type: 'integer' | 'decimal'; unit?: string }>;
  canonical_adjustment_sha256?: string;
  correction_observed_at: string;
  created_at: string;
}

/** Validate the unreleased Reliable Reporting wire shape at the handler seam. */
export function validateReliableReportingResponse(
  value: unknown,
): TrainingGetReportingStatusResponse {
  const validation = validateSourceSchema('media-buy/get-reporting-status-response.json', value);
  if (!validation.valid) {
    throw new Error(`Invalid Reliable Reporting response: ${JSON.stringify(validation.errors)}`);
  }
  return value as TrainingGetReportingStatusResponse;
}

export function syncReliableReportingReceiptsForAccount(
  params: { receipts?: Array<Record<string, unknown>>; adjustment_receipts?: Array<Record<string, unknown>> },
  principal: string | undefined,
  accountId: string,
): Record<string, unknown> {
  const submittedReceipts = [...(params.receipts ?? []), ...(params.adjustment_receipts ?? [])];
  if (submittedReceipts.length > 100) {
    throw new Error('A reporting receipt batch may contain at most 100 total receipts.');
  }
  const submittedIds = submittedReceipts.map(receipt => receipt.reporting_receipt_id);
  if (new Set(submittedIds).size !== submittedIds.length) {
    throw new Error('reporting_receipt_id must be unique across the complete receipt batch.');
  }
  const ledger = ledgerFor(principal, accountId);
  const results: Array<Record<string, unknown>> = [];
  let mutated = false;
  const failed = (submitted: Record<string, unknown>, message: string): Record<string, unknown> => ({
    result: 'failed',
    reporting_receipt_id: submitted.reporting_receipt_id,
    errors: [{ code: 'REPORTING_RECEIPT_INVALID', message, recovery: 'correctable' }],
  });
  const sameSubmission = (existing: Record<string, unknown>, submitted: Record<string, unknown>): boolean => {
    const stored = { ...existing };
    delete stored.received_at;
    return canonicalize(stored) === canonicalize(submitted);
  };
  for (const submitted of params.receipts ?? []) {
    const id = submitted.reporting_receipt_id;
    const existing = ledger.receipts.find(receipt => receipt.reporting_receipt_id === id);
    const conflictingAdjustmentReceipt = ledger.adjustmentReceipts.find(receipt => receipt.reporting_receipt_id === id);
    if (conflictingAdjustmentReceipt) {
      results.push(failed(submitted, 'The reporting receipt identifier is already bound to different immutable content.'));
      continue;
    }
    if (existing) {
      results.push(sameSubmission(existing, submitted)
        ? { result: 'unchanged', receipt: existing }
        : failed(submitted, 'The reporting receipt identifier is already bound to different immutable content.'));
      continue;
    }
    const record = ledger.integrityRecords?.find(candidate => (
      candidate.obligation.reporting_obligation_id === submitted.reporting_obligation_id
      && candidate.revision?.reporting_revision_id === submitted.reporting_revision_id
    ));
    const materialization = ledger.materializations.find(candidate => (
      candidate.reporting_materialization_id === submitted.reporting_materialization_id
      && candidate.reporting_revision_id === submitted.reporting_revision_id
      && candidate.reporting_obligation_id === submitted.reporting_obligation_id
    ));
    const verification = materialization?.verification as Record<string, unknown> | undefined;
    if (!record || !materialization || record.obligation.reconciliation_mode !== 'consumer_receipt') {
      results.push(failed(submitted, 'The referenced reporting evidence is unavailable for this account and caller.'));
      continue;
    }
    if (submitted.status === 'accepted') {
      const matches = submitted.verification_profile === verification?.verification_profile
        && submitted.observed_row_count === verification?.row_count
        && canonicalize(submitted.observed_control_totals) === canonicalize(verification?.control_totals)
        && (submitted.verification_profile !== 'canonical_digest'
          || canonicalize(submitted.observed_canonical_content_digest) === canonicalize(verification?.canonical_content_digest))
        && (submitted.verification_profile !== 'manifest_checksums'
          || submitted.observed_manifest_sha256 === verification?.manifest_sha256)
        && (submitted.verification_profile !== 'native_commit'
          || submitted.observed_native_version_ref === (verification?.native_commit_evidence as Record<string, unknown> | undefined)?.native_version_ref);
      if (!matches) {
        results.push(failed(submitted, 'An accepted receipt must exactly match the selected materialization evidence.'));
        continue;
      }
    }
    const receipt = { ...structuredClone(submitted), received_at: '2026-08-27T04:01:01.000Z' };
    ledger.receipts.push(receipt);
    mutated = true;
    results.push({ result: 'recorded', receipt });
  }
  for (const submitted of params.adjustment_receipts ?? []) {
    const id = submitted.reporting_receipt_id;
    const existing = ledger.adjustmentReceipts.find(receipt => receipt.reporting_receipt_id === id);
    const conflictingRevisionReceipt = ledger.receipts.find(receipt => receipt.reporting_receipt_id === id);
    if (conflictingRevisionReceipt) {
      results.push(failed(submitted, 'The reporting receipt identifier is already bound to different immutable content.'));
      continue;
    }
    if (existing) {
      results.push(sameSubmission(existing, submitted)
        ? { result: 'unchanged', adjustment_receipt: existing }
        : failed(submitted, 'The reporting receipt identifier is already bound to different immutable content.'));
      continue;
    }
    const adjustment = ledger.adjustments.get(String(submitted.reporting_adjustment_id));
    const record = ledger.integrityRecords?.find(candidate => (
      candidate.revision?.reporting_revision_id === submitted.adjusts_reporting_revision_id
    ));
    if (!adjustment
      || !record
      || record.obligation.reconciliation_mode !== 'consumer_receipt'
      || adjustment.adjusts_reporting_revision_id !== submitted.adjusts_reporting_revision_id) {
      results.push(failed(submitted, 'The referenced reporting evidence is unavailable for this account and caller.'));
      continue;
    }
    if (submitted.status === 'accepted'
      && submitted.observed_adjustment_sha256 !== adjustment.canonical_adjustment_sha256) {
      results.push(failed(submitted, 'An accepted adjustment receipt must match the canonical adjustment digest.'));
      continue;
    }
    const receipt = { ...structuredClone(submitted), received_at: '2026-08-29T10:01:02.000Z' };
    ledger.adjustmentReceipts.push(receipt);
    mutated = true;
    results.push({ result: 'recorded', adjustment_receipt: receipt });
  }
  if (results.length === 0) throw new Error('At least one reporting receipt is required.');
  const record = ledger.integrityRecords?.[0];
  if (record) {
    const accepted = ledger.receipts.filter(receipt => receipt.status === 'accepted').length;
    const adjustmentAccepted = ledger.adjustmentReceipts.filter(receipt => receipt.status === 'accepted').length;
    const isReconciled = record.obligation.reconciliation_mode === 'consumer_receipt';
    const healthComplete = isReconciled ? accepted > 0 && adjustmentAccepted > 0 : accepted > 0;
    record.obligation = {
      ...record.obligation,
      receipt_count: ledger.receipts.length,
      accepted_receipt_count: accepted,
      reconciliation_status: accepted > 0 ? 'accepted' : record.obligation.reconciliation_status,
      health: healthComplete ? 'complete' : record.obligation.health,
    } as ReportingObligation;
  }
  if (mutated) ledger.version += 1;
  const response = { status: 'completed', results };
  const validation = validateSourceSchema('media-buy/sync-reporting-receipts-response.json', response);
  if (!validation.valid) {
    throw new Error(`Invalid Reliable Reporting receipt response: ${JSON.stringify(validation.errors)}`);
  }
  return response;
}

const HOUR_MS = 60 * 60 * 1000;
const RETENTION_DAYS = 31;
const RECOVERY_WINDOW_MS = 2 * HOUR_MS;
const TRAINING_SCHEMA_URI = 'https://test-agent.adcontextprotocol.org/reporting/schemas/delivery-summary-v1.json';
const TRAINING_DEFINITION_URI = 'https://test-agent.adcontextprotocol.org/reporting/definitions/delivery-summary-v1.json';
const TRAINING_SOURCE_CALENDAR_DEFINITION_URI = 'https://test-agent.adcontextprotocol.org/reporting/definitions/source-calendar-billing-v1.json';

// Immutable documents advertised by the Core offering. Keep the exact bytes
// here (rather than a `res.json` object) so their published digest can be
// verified by a consumer without depending on an Express serialization detail.
export const TRAINING_REPORTING_ROW_SCHEMA_BYTES = JSON.stringify({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: TRAINING_SCHEMA_URI,
  type: 'object',
  additionalProperties: false,
  properties: {
    period_start: { type: 'string', format: 'date-time' },
    period_end: { type: 'string', format: 'date-time' },
    impressions: { type: 'integer', minimum: 0 },
  },
  required: ['period_start', 'period_end', 'impressions'],
});
export const TRAINING_REPORTING_CANONICALIZATION_BYTES = `{
  "contract_version": "1.0",
  "media_type": "application/vnd.adcp.reporting-canonicalization+json",
  "algorithm": "adcp_jcs_rows_v1",
  "schema_sha256": "a76b10957579a086c3b8cb800b884a72fcec039b496947982f2f1068c0178103",
  "primary_keys": ["media_buy_id", "date"],
  "golden_vectors": {
    "empty_report": {
      "name": "empty",
      "purpose": "empty_report",
      "input_rows": [],
      "canonical_utf8_base64": "W10=",
      "sha256": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"
    },
    "ordering_encoding": {
      "name": "ordering",
      "purpose": "ordering_encoding",
      "input_rows": [
        { "media_buy_id": "buy-2", "spend": "4.50", "date": "2026-08-26", "impressions": "3" },
        { "spend": "3.50", "media_buy_id": "buy-1", "impressions": "2", "date": "2026-08-26" }
      ],
      "canonical_utf8_base64": "W3siZGF0ZSI6IjIwMjYtMDgtMjYiLCJpbXByZXNzaW9ucyI6IjIiLCJtZWRpYV9idXlfaWQiOiJidXktMSIsInNwZW5kIjoiMy41MCJ9LHsiZGF0ZSI6IjIwMjYtMDgtMjYiLCJpbXByZXNzaW9ucyI6IjMiLCJtZWRpYV9idXlfaWQiOiJidXktMiIsInNwZW5kIjoiNC41MCJ9XQ==",
      "sha256": "bcd079902f3c8edb4315dbbdaf9b4e37f6fd5af33c80d1fe6ac8c655581342d4"
    }
  }
}
`;
export const TRAINING_REPORTING_DEFINITION_BYTES = JSON.stringify({
  contract_version: '1.1',
  media_type: 'application/vnd.adcp.reporting-definition+json',
  report_definition_id: 'training_delivery_summary_v1',
  reporting_profile: 'training_delivery_summary_v1',
  grain: 'one aggregate delivery summary per reporting period',
  source: {
    provider: { domain: 'test-agent.adcontextprotocol.org' },
    system: 'training-agent-deterministic-ledger',
    api_version: '1.0',
    query_semantics: { metrics: ['impressions'], reporting_timezone: 'UTC' },
  },
  calendar: { timezone_basis: 'utc' },
  metrics: [{ name: 'impressions', source_expression: 'sum(impressions)', aggregation: 'sum', unit: 'impressions' }],
  dimensions: [],
  restatement_policy: { source_requery_duration: 'PT0S', emit_only_on_content_change: true, official_correction_mode: 'adjustments_only' },
  finality_policies: [{ finality_policy_id: 'training_snapshot', basis: 'contractual_cutoff', duration_after_period_end: 'PT0S' }],
});
export const TRAINING_SOURCE_CALENDAR_DEFINITION_BYTES = JSON.stringify({
  contract_version: '1.1',
  media_type: 'application/vnd.adcp.reporting-definition+json',
  report_definition_id: 'training_source_calendar_billing_v1',
  reporting_profile: 'training_delivery_summary_v1',
  grain: 'one aggregate delivery summary per source-calendar reporting period',
  source: {
    provider: { domain: 'test-agent.adcontextprotocol.org' },
    system: 'training-agent-deterministic-ledger',
    api_version: '1.0',
    query_semantics: { metrics: ['impressions'], reporting_timezone: 'schedule_timezone' },
  },
  calendar: { timezone_basis: 'schedule_timezone' },
  metrics: [{ name: 'impressions', source_expression: 'sum(impressions)', aggregation: 'sum', unit: 'impressions' }],
  dimensions: [],
  restatement_policy: { source_requery_duration: 'P31D', emit_only_on_content_change: true, official_correction_mode: 'adjustments_only' },
  finality_policies: [{ finality_policy_id: 'training_source_cutoff', basis: 'contractual_cutoff', duration_after_period_end: 'PT4H' }],
});
const TRAINING_DEFINITION_SHA256 = createHash('sha256').update(TRAINING_REPORTING_DEFINITION_BYTES).digest('hex');
const TRAINING_SOURCE_CALENDAR_DEFINITION_SHA256 = createHash('sha256')
  .update(TRAINING_SOURCE_CALENDAR_DEFINITION_BYTES)
  .digest('hex');
const TRAINING_SCHEMA_SHA256 = createHash('sha256').update(TRAINING_REPORTING_ROW_SCHEMA_BYTES).digest('hex');
const TRAINING_CANONICALIZATION_SHA256 = createHash('sha256')
  .update(TRAINING_REPORTING_CANONICALIZATION_BYTES)
  .digest('hex');

type CoreConfig = {
  delivery_config_id: string;
  delivery_config_version: number;
  offering_id: string;
  active: boolean;
  revocation_effective_at?: string;
  feed_purpose: 'pacing' | 'analytics' | 'billing';
  report_definition_id: string;
  reporting_profile: string;
  scope: { all_media_buys: true } | { media_buy_ids: string[] };
  coverage_requirement: 'full' | 'allow_partial';
  required_finality: 'snapshot' | 'official';
  reconciliation_mode: 'delivery_only' | 'consumer_receipt';
  method?: Record<string, unknown>;
  schedule: {
    period_duration: 'PT1H' | 'P1D';
    alignment: 'utc' | 'source_timezone';
    period_timezone?: string;
    delivery_sla: 'PT1H' | 'PT4H';
  };
};

interface StoredConfig {
  config: CoreConfig;
  activatedAt: string;
  /** First instant at which this generation may not start another period. */
  deactivatedAt?: string;
  activeWindows: Array<{ start: string; end?: string }>;
}

interface ReportingMediaBuyCandidateState {
  effectiveAt: string;
  start: string;
  end: string;
  knownAt: string;
  packages: ReportingPackageApplicability[];
}

interface ReportingLedger {
  /** Monotonic content version used to make snapshot identity collision-free. */
  version: number;
  /** The account's current resolved configuration state, for settings echoes. */
  configs: Map<string, StoredConfig>;
  /** Retained generations, including deactivated and superseded configurations. */
  history: StoredConfig[];
  virtualNow?: string;
  publishedRevisions: Map<string, ReportingRevision>;
  /** Controller-only records for the daily source-calendar integrity probe. */
  integrityRecords?: LedgerRecord[];
  adjustments: Map<string, TrainingReportingAdjustment>;
  materializations: Array<Record<string, unknown>>;
  receipts: Array<Record<string, unknown>>;
  adjustmentReceipts: Array<Record<string, unknown>>;
  managedResourceReadable?: boolean;
  managedAccessRevoked?: boolean;
  /** Sandbox-only negative fixture: expected periods intentionally absent from the ledger. */
  suppressedObligationIds: Set<string>;
  mediaBuyCandidates: Map<string, ReportingMediaBuyCandidateState[]>;
  obligationMediaBuyIds: Map<string, string[]>;
  obligationCoverage: Map<string, ReturnType<typeof emptyCoverage>>;
  /** One durable resource snapshot per pagination walk. */
  pageSnapshots: Map<string, StoredPageSnapshot>;
  /** Lightweight offsets into pageSnapshots. */
  pageCursors: Map<string, StoredPageCursor>;
}

const ledgers = new Map<string, ReportingLedger>();
const reportingAccountBindings = new Map<string, {
  accountId: string;
  account: AccountRef;
  accountState?: Record<string, unknown>;
}>();

function cacheReportingAccountBinding(
  principalScope: string,
  accountId: string,
  account: AccountRef,
  accountState?: Record<string, unknown>,
): void {
  const scopeKey = `${principalScope}\u001f${accountScopeFromRef(account)}`;
  const idKey = `${principalScope}\u001fa:${accountId}`;
  const preservedAccountState = accountState
    ?? reportingAccountBindings.get(scopeKey)?.accountState
    ?? reportingAccountBindings.get(idKey)?.accountState;
  const binding = {
    accountId,
    account: structuredClone(account),
    ...(preservedAccountState && { accountState: structuredClone(preservedAccountState) }),
  };
  reportingAccountBindings.set(scopeKey, binding);
  if (account.brand && account.sandbox === true) {
    const { sandbox: _sandboxAssertion, ...buyerAccount } = account;
    reportingAccountBindings.set(
      `${principalScope}\u001f${accountScopeFromRef(buyerAccount)}`,
      { ...binding, account: structuredClone(buyerAccount) },
    );
  }
  reportingAccountBindings.set(idKey, binding);
}

interface SerializedReportingLedger {
  version: number;
  current_generation_keys: string[];
  history: StoredConfig[];
  virtual_now?: string;
  published_revisions: Array<[string, ReportingRevision]>;
  integrity_records?: LedgerRecord[];
  adjustments?: Array<[string, TrainingReportingAdjustment]>;
  materializations?: Array<Record<string, unknown>>;
  receipts?: Array<Record<string, unknown>>;
  adjustment_receipts?: Array<Record<string, unknown>>;
  managed_resource_readable?: boolean;
  managed_access_revoked?: boolean;
  suppressed_obligation_ids: string[];
  media_buy_candidates: Array<[string, ReportingMediaBuyCandidateState[]]>;
  obligation_media_buy_ids: Array<[string, string[]]>;
  obligation_coverage: Array<[string, ReturnType<typeof emptyCoverage>]>;
  page_snapshots?: Array<[string, StoredPageSnapshot]>;
  page_cursors: Array<[string, StoredPageCursor]>;
}

function emptyLedger(): ReportingLedger {
  return {
    version: 0,
    configs: new Map(),
    history: [],
    publishedRevisions: new Map(),
    adjustments: new Map(),
    materializations: [],
    receipts: [],
    adjustmentReceipts: [],
    suppressedObligationIds: new Set(),
    mediaBuyCandidates: new Map(),
    obligationMediaBuyIds: new Map(),
    obligationCoverage: new Map(),
    pageSnapshots: new Map(),
    pageCursors: new Map(),
  };
}

function serializeLedger(ledger: ReportingLedger): SerializedReportingLedger {
  return {
    version: ledger.version,
    current_generation_keys: [...ledger.configs.keys()],
    history: structuredClone(ledger.history),
    ...(ledger.virtualNow && { virtual_now: ledger.virtualNow }),
    published_revisions: [...ledger.publishedRevisions].map(([id, revision]) => [id, structuredClone(revision)]),
    ...(ledger.integrityRecords && { integrity_records: structuredClone(ledger.integrityRecords) }),
    adjustments: [...ledger.adjustments].map(([id, adjustment]) => [id, structuredClone(adjustment)]),
    materializations: structuredClone(ledger.materializations),
    receipts: structuredClone(ledger.receipts),
    adjustment_receipts: structuredClone(ledger.adjustmentReceipts),
    ...(ledger.managedResourceReadable !== undefined && { managed_resource_readable: ledger.managedResourceReadable }),
    ...(ledger.managedAccessRevoked !== undefined && { managed_access_revoked: ledger.managedAccessRevoked }),
    suppressed_obligation_ids: [...ledger.suppressedObligationIds],
    media_buy_candidates: [...ledger.mediaBuyCandidates].map(([id, candidate]) => [id, structuredClone(candidate)]),
    obligation_media_buy_ids: [...ledger.obligationMediaBuyIds].map(([id, mediaBuyIdsValue]) => [id, [...mediaBuyIdsValue]]),
    obligation_coverage: [...ledger.obligationCoverage].map(([id, coverage]) => [id, structuredClone(coverage)]),
    page_snapshots: [...ledger.pageSnapshots].map(([id, snapshot]) => [id, structuredClone(snapshot)]),
    page_cursors: [...ledger.pageCursors].map(([token, cursor]) => [token, structuredClone(cursor)]),
  };
}

function deserializeLedger(value: SerializedReportingLedger): ReportingLedger {
  const history = structuredClone(value.history ?? []);
  const byGeneration = new Map(history.map(entry => [generationKey(entry.config), entry]));
  return {
    version: value.version ?? 0,
    configs: new Map((value.current_generation_keys ?? []).flatMap(key => {
      const entry = byGeneration.get(key);
      return entry ? [[key, entry] as const] : [];
    })),
    history,
    ...(value.virtual_now && { virtualNow: value.virtual_now }),
    publishedRevisions: new Map(value.published_revisions ?? []),
    ...(value.integrity_records && { integrityRecords: structuredClone(value.integrity_records) }),
    adjustments: new Map(value.adjustments ?? []),
    materializations: structuredClone(value.materializations ?? []),
    receipts: structuredClone(value.receipts ?? []),
    adjustmentReceipts: structuredClone(value.adjustment_receipts ?? []),
    ...(value.managed_resource_readable !== undefined && { managedResourceReadable: value.managed_resource_readable }),
    ...(value.managed_access_revoked !== undefined && { managedAccessRevoked: value.managed_access_revoked }),
    suppressedObligationIds: new Set(value.suppressed_obligation_ids ?? []),
    mediaBuyCandidates: new Map((value.media_buy_candidates ?? []).map(([id, history]) => [
      id,
      Array.isArray(history) ? history : [{
        ...(history as unknown as Omit<ReportingMediaBuyCandidateState, 'effectiveAt'>),
        effectiveAt: (history as unknown as { knownAt: string }).knownAt,
      }],
    ])),
    obligationMediaBuyIds: new Map(value.obligation_media_buy_ids ?? []),
    obligationCoverage: new Map(value.obligation_coverage ?? []),
    pageSnapshots: new Map(value.page_snapshots ?? []),
    pageCursors: new Map((value.page_cursors ?? []).filter((entry): entry is [string, StoredPageCursor] => (
      typeof entry[1]?.snapshotId === 'string'
    ))),
  };
}

/**
 * Run one caller/account ledger operation under a cross-instance database
 * lock. Tests and local development without a database retain the deterministic
 * in-memory store; deployed training agents persist the exact ledger snapshot.
 */
export async function withDurableReportingLedger<T>(
  principal: string | undefined,
  accountId: string,
  persist: boolean,
  operation: () => T | Promise<T>,
  account?: AccountRef,
  accountState?: Record<string, unknown>,
): Promise<T> {
  const principalScope = principal && principal.length > 0 ? principal : 'anonymous';
  if (!isDatabaseInitialized()) {
    const result = await operation();
    if (persist && account) cacheReportingAccountBinding(principalScope, accountId, account, accountState);
    return result;
  }
  const cacheKey = callerScope(principal, accountId);
  const priorCache = ledgers.get(cacheKey);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`${principalScope}\u001f${accountId}`],
    );
    const { rows } = await client.query<{
      ledger: SerializedReportingLedger | string;
      account_state: Record<string, unknown> | string | null;
    }>(
      `SELECT ledger, account_state
         FROM training_reporting_ledgers
        WHERE principal_scope = $1 AND account_id = $2
        FOR UPDATE`,
      [principalScope, accountId],
    );
    const stored = rows[0]?.ledger;
    const storedAccountState = typeof rows[0]?.account_state === 'string'
      ? JSON.parse(rows[0].account_state) as Record<string, unknown>
      : rows[0]?.account_state ?? undefined;
    ledgers.set(cacheKey, stored
      ? deserializeLedger(typeof stored === 'string' ? JSON.parse(stored) as SerializedReportingLedger : stored)
      : emptyLedger());
    const result = await operation();
    if (persist) {
      await client.query(
        `INSERT INTO training_reporting_ledgers (
           principal_scope, account_id, ledger, account_scope, account_ref, account_state, updated_at
         ) VALUES ($1, $2, $3::jsonb, $4, $5::jsonb, $6::jsonb, now())
         ON CONFLICT (principal_scope, account_id) DO UPDATE SET
           ledger = EXCLUDED.ledger,
           account_scope = COALESCE(EXCLUDED.account_scope, training_reporting_ledgers.account_scope),
           account_ref = COALESCE(EXCLUDED.account_ref, training_reporting_ledgers.account_ref),
           account_state = COALESCE(EXCLUDED.account_state, training_reporting_ledgers.account_state),
           updated_at = EXCLUDED.updated_at`,
        [
          principalScope,
          accountId,
          JSON.stringify(serializeLedger(ledgerFor(principal, accountId))),
          account ? accountScopeFromRef(account) : null,
          account ? JSON.stringify(account) : null,
          accountState ? JSON.stringify(accountState) : null,
        ],
      );
    }
    await client.query('COMMIT');
    if (persist && account) {
      cacheReportingAccountBinding(principalScope, accountId, account, accountState ?? storedAccountState);
    }
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (priorCache) ledgers.set(cacheKey, priorCache);
    else ledgers.delete(cacheKey);
    throw error;
  } finally {
    client.release();
  }
}

export async function resolveReportingAccountDurably(
  principal: string | undefined,
  account: AccountRef,
): Promise<{ accountId: string; account: AccountRef; accountState?: Record<string, unknown> } | undefined> {
  const principalScope = principal && principal.length > 0 ? principal : 'anonymous';
  const scope = accountScopeFromRef(account);
  const cached = reportingAccountBindings.get(`${principalScope}\u001f${scope}`);
  if (cached) return structuredClone(cached);
  if (!isDatabaseInitialized()) return undefined;
  const lookupById = account.account_id !== undefined;
  const { rows } = await getPool().query<{
    account_id: string;
    account_ref: AccountRef | string | null;
    account_state: Record<string, unknown> | string | null;
  }>(
    `SELECT account_id, account_ref, account_state
       FROM training_reporting_ledgers
      WHERE principal_scope = $1 AND ${lookupById ? 'account_id' : 'account_scope'} = $2`,
    [principalScope, lookupById ? account.account_id : scope],
  );
  const row = rows[0];
  if (!row?.account_ref) return undefined;
  const storedAccount = typeof row.account_ref === 'string'
    ? JSON.parse(row.account_ref) as AccountRef
    : row.account_ref;
  const storedAccountState = typeof row.account_state === 'string'
    ? JSON.parse(row.account_state) as Record<string, unknown>
    : row.account_state ?? undefined;
  const binding = {
    accountId: row.account_id,
    account: storedAccount,
    ...(storedAccountState && { accountState: storedAccountState }),
  };
  cacheReportingAccountBinding(principalScope, row.account_id, storedAccount, storedAccountState);
  return structuredClone(binding);
}

export async function listReportingAccountsDurably(
  principal: string | undefined,
): Promise<Array<{ accountId: string; account: AccountRef; accountState?: Record<string, unknown> }>> {
  const principalScope = principal && principal.length > 0 ? principal : 'anonymous';
  if (isDatabaseInitialized()) {
    const { rows } = await getPool().query<{
      account_id: string;
      account_ref: AccountRef | string | null;
      account_state: Record<string, unknown> | string | null;
    }>(
      `SELECT account_id, account_ref, account_state
         FROM training_reporting_ledgers
        WHERE principal_scope = $1 AND account_ref IS NOT NULL`,
      [principalScope],
    );
    return rows.flatMap(row => {
      if (!row.account_ref) return [];
      const account = typeof row.account_ref === 'string'
        ? JSON.parse(row.account_ref) as AccountRef
        : row.account_ref;
      const accountState = typeof row.account_state === 'string'
        ? JSON.parse(row.account_state) as Record<string, unknown>
        : row.account_state ?? undefined;
      cacheReportingAccountBinding(principalScope, row.account_id, account, accountState);
      return [{ accountId: row.account_id, account, ...(accountState && { accountState }) }];
    });
  }
  const unique = new Map<string, { accountId: string; account: AccountRef; accountState?: Record<string, unknown> }>();
  for (const [key, binding] of reportingAccountBindings) {
    if (key.startsWith(`${principalScope}\u001f`)) unique.set(binding.accountId, binding);
  }
  return structuredClone([...unique.values()]);
}

function callerScope(principal: string | undefined, accountId: string): string {
  return `${principal && principal.length > 0 ? principal : 'anonymous'}\u001f${accountId}`;
}

function ledgerFor(principal: string | undefined, accountId: string): ReportingLedger {
  const key = callerScope(principal, accountId);
  let ledger = ledgers.get(key);
  if (!ledger) {
    ledger = emptyLedger();
    ledgers.set(key, ledger);
  }
  return ledger;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function stableId(kind: string, values: readonly string[]): string {
  const digest = createHash('sha256').update(values.join('\u001f')).digest('hex').slice(0, 24);
  return `${kind}.${digest}`;
}

function parseInstant(value: string): number {
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw new Error(`Invalid reporting fixture time: ${value}`);
  return result;
}

function floorHour(ms: number): number {
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

function canonicalCoreConfig(value: unknown): CoreConfig {
  const validation = validateSourceSchema('core/reporting-delivery-config.json', value);
  if (!validation.valid) {
    throw new Error(`Invalid reporting_delivery_configs entry: ${validation.errors[0]?.message ?? 'schema validation failed'}`);
  }
  const config = structuredClone(value) as Record<string, unknown>;
  const schedule = config.schedule as Record<string, unknown> | undefined;
  const offerings = [
    TRAINING_REPORTING_CORE_OFFERING,
    TRAINING_REPORTING_MANAGED_OFFERING,
    TRAINING_REPORTING_RECONCILED_OFFERING,
  ];
  const offering = offerings.find(candidate => candidate.offering_id === config.offering_id);
  const expectedMethod = offering && 'method' in offering ? offering.method : undefined;
  const configuredMethod = config.method as Record<string, unknown> | undefined;
  const configuredDestination = configuredMethod?.destination as Record<string, unknown> | undefined;
  const methodMatches = expectedMethod === undefined
    ? configuredMethod === undefined
    : configuredMethod?.pattern === expectedMethod.pattern
      && configuredMethod.transport === expectedMethod.transport
      && configuredMethod.orchestration === expectedMethod.orchestration
      && typeof configuredDestination?.mode === 'string'
      && expectedMethod.destination_modes.includes(configuredDestination.mode as 'provision')
      && (configuredDestination.mode !== 'provision'
        || ((configuredDestination.provider as Record<string, unknown> | undefined)?.domain === expectedMethod.provider.domain
          && configuredDestination.access_mode === expectedMethod.access_mode));
  const supported = offering !== undefined
    && config.feed_purpose === offering.feed_purpose
    && config.report_definition_id === offering.report_definition_id
    && config.reporting_profile === offering.reporting_profile.id
    && config.required_finality === offering.supported_finality[0]
    && config.reconciliation_mode === offering.reconciliation_mode
    && methodMatches
    && schedule?.period_duration === offering.schedule.period_duration
    && schedule?.alignment === offering.schedule.alignment
    && schedule?.delivery_sla === offering.schedule.delivery_sla;
  if (!supported) {
    throw new Error('The reporting configuration must exactly select one advertised Reliable Reporting offering.');
  }
  return structuredClone(config) as unknown as CoreConfig;
}

function immutableConfig(config: CoreConfig): Omit<CoreConfig, 'active' | 'revocation_effective_at'> {
  const { active: _active, revocation_effective_at: _revocationEffectiveAt, ...immutable } = config;
  return immutable;
}

function canonicalJsonObject(value: unknown): string {
  if (Array.isArray(value)) return '[' + [...value].sort().map(canonicalJsonObject).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value as object).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJsonObject((value as Record<string, unknown>)[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function generationKey(config: Pick<CoreConfig, 'delivery_config_id' | 'delivery_config_version'>): string {
  return `${config.delivery_config_id}\u001f${config.delivery_config_version}`;
}

function activeWindowAt(stored: StoredConfig, evaluatedAtMs: number): { start: string; end?: string } | undefined {
  return stored.activeWindows.find(window => (
    parseInstant(window.start) <= evaluatedAtMs
    && (window.end === undefined || evaluatedAtMs < parseInstant(window.end))
  ));
}

/** Validate an account replacement before mutating either account or ledger state. */
export function validateReportingConfigurations(configurations: unknown[]): void {
  const generations = new Set<string>();
  const activeIds = new Set<string>();
  for (const raw of configurations) {
    const config = canonicalCoreConfig(raw);
    const key = generationKey(config);
    if (generations.has(key)) {
      throw new Error(`delivery_config_id "${config.delivery_config_id}" version ${config.delivery_config_version} must be unique within an account.`);
    }
    generations.add(key);
    if (config.active && activeIds.has(config.delivery_config_id)) {
      throw new Error(`delivery_config_id "${config.delivery_config_id}" may have only one active generation.`);
    }
    if (config.active) activeIds.add(config.delivery_config_id);
  }
}

/** Validate replacement semantics before mutating account or ledger state. */
export function validateReportingConfigurationReplacement(
  principal: string | undefined,
  accountId: string,
  configurations: unknown[],
): void {
  validateReportingConfigurations(configurations);
  // Validation also serves dry_run. Do not create an empty caller ledger just
  // to inspect an otherwise absent prior generation.
  const history = ledgers.get(callerScope(principal, accountId))?.history ?? [];
  for (const raw of configurations) {
    const config = canonicalCoreConfig(raw);
    const sameGeneration = history.find(entry => (
      entry.config.delivery_config_id === config.delivery_config_id
      && entry.config.delivery_config_version === config.delivery_config_version
    ));
    if (sameGeneration && canonicalJsonObject(immutableConfig(sameGeneration.config)) !== canonicalJsonObject(immutableConfig(config))) {
      throw new Error(`delivery_config_id "${config.delivery_config_id}" version ${config.delivery_config_version} is immutable.`);
    }
  }
}

/** Persist caller-owned replace semantics after a successful sync_accounts. */
export function replaceReportingConfigurations(
  principal: string | undefined,
  accountId: string,
  configurations: unknown[],
  activatedAt = new Date().toISOString(),
): void {
  const ledger = ledgerFor(principal, accountId);
  const next = new Map<string, StoredConfig>();
  validateReportingConfigurationReplacement(principal, accountId, configurations);
  const incomingGenerations = new Set<string>();
  for (const raw of configurations) {
    const config = canonicalCoreConfig(raw);
    const key = generationKey(config);
    const shouldBeActive = config.active;
    incomingGenerations.add(key);
    const prior = ledger.configs.get(key);
    if (shouldBeActive) {
      for (const [otherKey, other] of ledger.configs) {
        if (otherKey === key || other.config.delivery_config_id !== config.delivery_config_id) continue;
        const otherWindow = other.activeWindows.at(-1);
        if (otherWindow && (!otherWindow.end || parseInstant(otherWindow.end) > parseInstant(activatedAt))) {
          otherWindow.end = activatedAt;
          other.deactivatedAt = activatedAt;
        }
      }
    }
    const existingGeneration = ledger.history.find(entry => (
      entry.config.delivery_config_id === config.delivery_config_id
      && entry.config.delivery_config_version === config.delivery_config_version
    ));
    const entry: StoredConfig = existingGeneration ?? {
      config,
      activatedAt: prior?.activatedAt ?? activatedAt,
      activeWindows: shouldBeActive ? [{ start: activatedAt }] : [],
    };
    if (existingGeneration) {
      const effectiveAt = config.revocation_effective_at ?? activatedAt;
      const openWindow = entry.activeWindows.at(-1);
      if (!shouldBeActive && openWindow && (!openWindow.end || parseInstant(openWindow.end) > parseInstant(effectiveAt))) {
        openWindow.end = effectiveAt;
        entry.deactivatedAt = effectiveAt;
      } else if (shouldBeActive && openWindow?.end && parseInstant(openWindow.end) > parseInstant(activatedAt)) {
        // Reactivation before a scheduled cutoff cancels that cutoff instead
        // of opening an overlapping window for the same generation.
        delete openWindow.end;
        delete entry.deactivatedAt;
      } else if (shouldBeActive && (!openWindow || openWindow.end)) {
        entry.activeWindows.push({ start: activatedAt });
        delete entry.deactivatedAt;
      }
      entry.config = config;
    } else if (!shouldBeActive) {
      entry.deactivatedAt = config.revocation_effective_at ?? activatedAt;
    }
    if (!existingGeneration) ledger.history.push(entry);
    next.set(key, entry);
  }
  for (const [key, prior] of ledger.configs) {
    if (!incomingGenerations.has(key)) {
      const openWindow = prior.activeWindows.at(-1);
      if (openWindow && (!openWindow.end || parseInstant(openWindow.end) > parseInstant(activatedAt))) {
        openWindow.end = activatedAt;
      }
      if (!prior.deactivatedAt || parseInstant(prior.deactivatedAt) > parseInstant(activatedAt)) {
        prior.deactivatedAt = activatedAt;
      }
    }
  }
  ledger.configs = next;
  ledger.version += 1;
}

/** Test/controller-only reset. Kept out of normal buyer inputs. */
export function prepareReportingCoreLifecycleProbe(principal: string | undefined, accountId: string): {
  account_id: string;
  resolved_configuration: CoreConfig;
  delivery_config_id: string;
  delivery_config_version: number;
  reporting_obligation_id: string;
  period: { start: string; end: string };
  expected_at: string;
  recovery_deadline: string;
  simulated_now: string;
} {
  const activatedAt = '2026-08-01T00:00:00.000Z';
  const simulatedNow = '2026-08-01T01:30:00.000Z';
  // `prepare` is a deterministic sandbox reset, not an ordinary account
  // settings retry. Discard any earlier wall-clock configuration for this
  // caller/account so the returned obligation identity and subsequent status
  // read always describe the same fixture generation.
  const nextVersion = (ledgers.get(callerScope(principal, accountId))?.version ?? 0) + 1;
  ledgers.set(callerScope(principal, accountId), {
    version: nextVersion,
    configs: new Map(),
    history: [],
    publishedRevisions: new Map(),
    adjustments: new Map(),
    materializations: [],
    receipts: [],
    adjustmentReceipts: [],
    suppressedObligationIds: new Set(),
    mediaBuyCandidates: new Map(),
    obligationMediaBuyIds: new Map(),
    obligationCoverage: new Map(),
    pageSnapshots: new Map(),
    pageCursors: new Map(),
  });
  replaceReportingConfigurations(principal, accountId, [TRAINING_REPORTING_CORE_CONFIGURATION], activatedAt);
  const ledger = ledgerFor(principal, accountId);
  ledger.virtualNow = simulatedNow;
  ledger.publishedRevisions.clear();
  return {
    account_id: accountId,
    resolved_configuration: structuredClone(TRAINING_REPORTING_CORE_CONFIGURATION),
    delivery_config_id: TRAINING_REPORTING_CORE_CONFIGURATION.delivery_config_id,
    delivery_config_version: TRAINING_REPORTING_CORE_CONFIGURATION.delivery_config_version,
    reporting_obligation_id: obligationId(accountId, TRAINING_REPORTING_CORE_CONFIGURATION, '2026-08-01T01:00:00.000Z'),
    period: { start: '2026-08-01T00:00:00.000Z', end: '2026-08-01T01:00:00.000Z' },
    expected_at: '2026-08-01T02:00:00.000Z',
    recovery_deadline: '2026-08-01T04:00:00.000Z',
    simulated_now: simulatedNow,
  };
}

/** Create a deliberate seller-ledger omission for the buyer reconciliation lab. */
export function omitReportingCoreObligationProbe(principal: string | undefined, accountId: string): {
  account_id: string;
  resolved_configuration: CoreConfig;
  expected_reporting_obligation_id: string;
  omitted_period: { start: string; end: string };
  expected_at: string;
  simulated_now: string;
} {
  const ledger = ledgerFor(principal, accountId);
  const first = [...ledger.configs.values()][0];
  if (!first) throw new Error('Prepare the reporting_core_lifecycle_probe before omitting an obligation.');
  ledger.virtualNow = '2026-08-01T02:30:00.000Z';
  const periodEnd = '2026-08-01T02:00:00.000Z';
  const expectedId = obligationId(accountId, first.config, periodEnd);
  ledger.suppressedObligationIds.add(expectedId);
  ledger.version += 1;
  return {
    account_id: accountId,
    resolved_configuration: structuredClone(first.config),
    expected_reporting_obligation_id: expectedId,
    omitted_period: { start: '2026-08-01T01:00:00.000Z', end: periodEnd },
    expected_at: '2026-08-01T03:00:00.000Z',
    simulated_now: ledger.virtualNow,
  };
}

export function advanceReportingCoreLifecycleProbe(
  principal: string | undefined,
  accountId: string,
  targetHealth: 'delayed' | 'action_required',
): {
  account_id: string;
  delivery_config_id: string;
  delivery_config_version: number;
  reporting_obligation_id: string;
  expected_at: string;
  recovery_deadline: string;
  simulated_now: string;
  target_health: 'delayed' | 'action_required';
} {
  const ledger = ledgerFor(principal, accountId);
  if (ledger.configs.size === 0) throw new Error('Prepare the reporting_core_lifecycle_probe before advancing time.');
  const nextVirtualNow = targetHealth === 'delayed'
    ? '2026-08-01T02:05:00.000Z'
    : '2026-08-01T04:05:00.000Z';
  if (ledger.virtualNow !== nextVirtualNow) ledger.version += 1;
  ledger.virtualNow = nextVirtualNow;
  const first = ledger.history[0];
  if (!first) throw new Error('Prepare the reporting_core_lifecycle_probe before advancing time.');
  return {
    account_id: accountId,
    delivery_config_id: first.config.delivery_config_id,
    delivery_config_version: first.config.delivery_config_version,
    reporting_obligation_id: obligationId(accountId, first.config, '2026-08-01T01:00:00.000Z'),
    expected_at: '2026-08-01T02:00:00.000Z',
    recovery_deadline: '2026-08-01T04:00:00.000Z',
    simulated_now: ledger.virtualNow,
    target_health: targetHealth,
  };
}

/** Deterministic boundary control for source-schema regression tests. */
export function setReportingCoreLifecycleProbeClock(
  principal: string | undefined,
  accountId: string,
  simulatedNow: string,
): void {
  parseInstant(simulatedNow);
  const ledger = ledgerFor(principal, accountId);
  if (ledger.configs.size === 0) throw new Error('Prepare the reporting_core_lifecycle_probe before setting its clock.');
  if (ledger.virtualNow !== simulatedNow) ledger.version += 1;
  ledger.virtualNow = simulatedNow;
}

export function publishZeroRowReportingCoreLifecycleProbe(
  principal: string | undefined,
  accountId: string,
): {
  account_id: string;
  delivery_config_id: string;
  delivery_config_version: number;
  reporting_obligation_id: string;
  reporting_revision_id: string;
  row_count: 0;
  simulated_now: string;
} {
  const ledger = ledgerFor(principal, accountId);
  const first = [...ledger.configs.values()][0];
  if (!first) throw new Error('Prepare the reporting_core_lifecycle_probe before publishing a revision.');
  const end = '2026-08-01T01:00:00.000Z';
  const obligation = obligationId(accountId, first.config, end);
  const publishedAtMs = ledger.virtualNow ? parseInstant(ledger.virtualNow) : Date.now();
  const record = recordsFor(principal, accountId, [first], publishedAtMs)
    .find(candidate => candidate.obligation.reporting_obligation_id === obligation);
  if (!record) throw new Error('The reporting obligation is not yet available at the current fixture time.');
  const revision = zeroRowRevision(record.obligation, publishedAtMs);
  const priorRevision = ledger.publishedRevisions.get(obligation);
  if (JSON.stringify(priorRevision) !== JSON.stringify(revision)) ledger.version += 1;
  ledger.publishedRevisions.set(obligation, revision);
  return {
    account_id: accountId,
    delivery_config_id: first.config.delivery_config_id,
    delivery_config_version: first.config.delivery_config_version,
    reporting_obligation_id: obligation,
    reporting_revision_id: revisionId(obligation),
    row_count: 0,
    simulated_now: ledger.virtualNow ?? iso(Date.now()),
  };
}

/**
 * Controller-only Reliable Reporting integrity fixture. The period spans the
 * 2026 New York fall-back boundary, proving a source-calendar day is not a
 * fixed 24-hour UTC bucket.
 */
export function prepareReliableReportingCoreIntegrityProbe(
  principal: string | undefined,
  accountId: string,
): {
  account_id: string;
  reporting_obligation_id: string;
  period_timezone: 'America/New_York';
  period_duration: 'P1D';
} {
  const config: CoreConfig = {
    delivery_config_id: 'reliable-reporting-core-integrity',
    delivery_config_version: 1,
    offering_id: 'reliable-reporting-core-integrity',
    active: true,
    feed_purpose: 'billing',
    report_definition_id: 'training_source_calendar_billing_v1',
    reporting_profile: 'training_delivery_summary_v1',
    scope: { all_media_buys: true },
    coverage_requirement: 'full',
    required_finality: 'official',
    reconciliation_mode: 'delivery_only',
    schedule: {
      period_duration: 'P1D',
      alignment: 'source_timezone',
      period_timezone: 'America/New_York',
      delivery_sla: 'PT4H',
    },
  };
  const period = {
    start: '2026-11-01T04:00:00.000Z',
    end: '2026-11-02T05:00:00.000Z',
    source_timezone: 'America/New_York',
  };
  const obligation = obligationId(accountId, config, period.end);
  const evaluatedAt = '2026-11-02T06:00:00.000Z';
  const coverage = emptyCoverage(period.end, []);
  const record: LedgerRecord = {
    obligation: {
      reporting_obligation_id: obligation,
      delivery_config_id: config.delivery_config_id,
      delivery_config_version: config.delivery_config_version,
      report_definition_id: config.report_definition_id,
      feed_purpose: config.feed_purpose,
      reporting_profile: config.reporting_profile,
      account_id: accountId,
      media_buy_ids: [],
      scope_resolved_at: period.end,
      coverage,
      period,
      expected_at: '2026-11-02T09:00:00.000Z',
      schedule: config.schedule,
      required_finality: 'official',
      reconciliation_mode: 'delivery_only',
      reconciliation_status: 'not_required',
      health: 'waiting',
      production_status: 'pending',
      revision_count: 0,
      adjustment_count: 0,
      issues: [],
    } as ReportingObligation,
  };
  const stored: StoredConfig = {
    config,
    activatedAt: period.start,
    activeWindows: [{ start: period.start }],
  };
  const ledger = emptyLedger();
  ledger.version = (ledgers.get(callerScope(principal, accountId))?.version ?? 0) + 1;
  ledger.configs.set(generationKey(config), stored);
  ledger.history.push(stored);
  ledger.virtualNow = evaluatedAt;
  ledger.integrityRecords = [record];
  ledgers.set(callerScope(principal, accountId), ledger);
  return {
    account_id: accountId,
    reporting_obligation_id: obligation,
    period_timezone: 'America/New_York',
    period_duration: 'P1D',
  };
}

export function publishReliableReportingCoreIntegrityCorrection(
  principal: string | undefined,
  accountId: string,
): {
  account_id: string;
  reporting_obligation_id: string;
  reporting_revision_id: string;
  reporting_adjustment_id: string;
  notification_order: ['adjustment', 'revision', 'adjustment'];
} {
  const ledger = ledgerFor(principal, accountId);
  const record = ledger.integrityRecords?.[0];
  if (!record) throw new Error('Prepare reliable_reporting_core_integrity_probe before publication.');
  const revisionIdValue = stableId('reporting-revision', [record.obligation.reporting_obligation_id, 'official-v1']);
  const revision: ReportingRevision = {
    reporting_revision_id: revisionIdValue,
    report_definition_id: record.obligation.report_definition_id,
    report_definition_uri: TRAINING_SOURCE_CALENDAR_DEFINITION_URI,
    report_definition_sha256: TRAINING_SOURCE_CALENDAR_DEFINITION_SHA256,
    reporting_profile: record.obligation.reporting_profile,
    schema_version: '1.0',
    schema_uri: TRAINING_SCHEMA_URI,
    schema_sha256: TRAINING_SCHEMA_SHA256,
    schema_dialect: 'https://json-schema.org/draft/2020-12/schema',
    schema_ref_policy: 'local_fragment_only',
    account_id: accountId,
    media_buy_ids: [],
    coverage: record.obligation.coverage,
    period: record.obligation.period,
    finality: 'official',
    finality_basis: 'contractual_cutoff',
    finality_policy_id: 'training_source_cutoff',
    finalized_at: '2026-11-02T09:00:00.000Z',
    observed_at: '2026-11-02T09:00:00.000Z',
    data_through: record.obligation.period.end,
    data_through_precision: 'exact',
    row_count: 0,
    control_totals: [],
    created_at: '2026-11-02T09:00:01.000Z',
  };
  const adjustment: TrainingReportingAdjustment = {
    reporting_adjustment_id: stableId('reporting-adjustment', [revisionIdValue, 'source-correction-v1']),
    adjusts_reporting_revision_id: revisionIdValue,
    reason_code: 'source_correction',
    reason_detail: 'Deterministic post-official source correction for checkpoint recovery.',
    accounting_period: {
      start: '2026-11-02T00:00:00.000Z',
      end: '2026-12-01T00:00:00.000Z',
    },
    control_total_deltas: [{ name: 'impressions', value: '-1', value_type: 'integer', unit: 'impressions' }],
    correction_observed_at: '2026-11-02T10:00:00.000Z',
    created_at: '2026-11-02T10:00:01.000Z',
  };
  record.revision = revision;
  record.obligation = {
    ...record.obligation,
    health: 'complete',
    production_status: 'published',
    revision_count: 1,
    adjustment_count: 1,
    issues: [],
  } as ReportingObligation;
  ledger.publishedRevisions.set(record.obligation.reporting_obligation_id, revision);
  ledger.adjustments.set(adjustment.reporting_adjustment_id, adjustment);
  ledger.virtualNow = '2026-11-02T10:01:00.000Z';
  ledger.version += 1;
  return {
    account_id: accountId,
    reporting_obligation_id: record.obligation.reporting_obligation_id,
    reporting_revision_id: revisionIdValue,
    reporting_adjustment_id: adjustment.reporting_adjustment_id,
    notification_order: ['adjustment', 'revision', 'adjustment'],
  };
}

function prepareReliableReportingOptionalTierProbe(
  principal: string | undefined,
  accountId: string,
  tier: 'managed' | 'reconciled',
): {
  account_id: string;
  reporting_obligation_id: string;
  reporting_revision_id: string;
  reporting_materialization_id: string;
  destination_ref: string;
  canonical_content_digest?: Record<string, unknown>;
} {
  const reconciled = tier === 'reconciled';
  const config: CoreConfig = {
    delivery_config_id: reconciled ? 'rr-reconciled-billing' : 'rr-managed-delivery',
    delivery_config_version: 1,
    offering_id: reconciled
      ? TRAINING_REPORTING_RECONCILED_OFFERING.offering_id
      : TRAINING_REPORTING_MANAGED_OFFERING.offering_id,
    active: true,
    feed_purpose: reconciled ? 'billing' : 'analytics',
    report_definition_id: 'training_delivery_summary_v1',
    reporting_profile: 'training_delivery_summary_v1',
    scope: { all_media_buys: true },
    coverage_requirement: 'full',
    required_finality: 'official',
    reconciliation_mode: reconciled ? 'consumer_receipt' : 'delivery_only',
    schedule: { period_duration: 'P1D', alignment: 'utc', delivery_sla: 'PT4H' },
    method: {
      pattern: TRAINING_REPORTING_MANAGED_OFFERING.method.pattern,
      transport: TRAINING_REPORTING_MANAGED_OFFERING.method.transport,
      orchestration: TRAINING_REPORTING_MANAGED_OFFERING.method.orchestration,
      destination: {
        mode: 'provision',
        provider: TRAINING_REPORTING_MANAGED_OFFERING.method.provider,
        access_mode: TRAINING_REPORTING_MANAGED_OFFERING.method.access_mode,
        recipient: { identity: 'reliable-reporting-training-recipient' },
      },
    },
  };
  const period = { start: '2026-08-26T00:00:00.000Z', end: '2026-08-27T00:00:00.000Z', source_timezone: 'UTC' };
  const obligationIdValue = obligationId(accountId, config, period.end);
  const revisionIdValue = stableId('reporting-revision', [obligationIdValue, 'official-v1']);
  const materializationId = stableId('reporting-materialization', [revisionIdValue, tier]);
  const destinationRef = reconciled ? 'rr-billing-destination' : 'rr-managed-dataset';
  const digest = {
    algorithm: 'sha256',
    value: 'bcd079902f3c8edb4315dbbdaf9b4e37f6fd5af33c80d1fe6ac8c655581342d4',
    canonicalization_id: 'billing-rows-v1',
    canonicalization_uri: 'https://test-agent.adcontextprotocol.org/reporting/canonicalization/billing-rows-v1.json',
    canonicalization_sha256: TRAINING_CANONICALIZATION_SHA256,
  };
  const coverage = emptyCoverage(period.end, []);
  const revision = {
    reporting_revision_id: revisionIdValue,
    report_definition_id: config.report_definition_id,
    report_definition_uri: TRAINING_DEFINITION_URI,
    report_definition_sha256: TRAINING_DEFINITION_SHA256,
    reporting_profile: config.reporting_profile,
    schema_version: '1.0',
    schema_uri: TRAINING_SCHEMA_URI,
    schema_sha256: TRAINING_SCHEMA_SHA256,
    schema_dialect: 'https://json-schema.org/draft/2020-12/schema',
    schema_ref_policy: 'local_fragment_only',
    account_id: accountId,
    media_buy_ids: [],
    coverage,
    period,
    finality: 'official',
    finality_basis: 'contractual_cutoff',
    finality_policy_id: 'training_snapshot',
    finalized_at: '2026-08-27T04:00:00.000Z',
    observed_at: '2026-08-27T04:00:00.000Z',
    data_through: period.end,
    data_through_precision: 'exact',
    row_count: reconciled ? 2 : 0,
    control_totals: reconciled ? [
      { name: 'impressions', value: '5', value_type: 'integer', unit: 'impressions' },
      { name: 'spend', value: '8.00', value_type: 'decimal', unit: 'USD' },
    ] : [],
    ...(reconciled && { canonical_content_digest: digest }),
    created_at: '2026-08-27T04:00:01.000Z',
  } as ReportingRevision;
  const materialization: Record<string, unknown> = {
    reporting_materialization_id: materializationId,
    reporting_revision_id: revisionIdValue,
    reporting_obligation_id: obligationIdValue,
    delivery_config_id: config.delivery_config_id,
    delivery_config_version: 1,
    destination_ref: destinationRef,
    feed_purpose: config.feed_purpose,
    method: 'dataset_share',
    transport: 'training_dataset',
    attempt: 1,
    status: 'available',
    ready_at: '2026-08-27T04:00:02.000Z',
    resource: {
      resource_ref: `${materializationId}-resource`,
      kind: 'dataset',
      location: `training/reliable-reporting/${tier}`,
      native_version_ref: `${revisionIdValue}:v1`,
      immutability: 'native_version',
      expires_at: '2026-09-27T04:00:02.000Z',
    },
    verification: reconciled ? {
      verified_at: '2026-08-27T04:00:02.000Z',
      verification_path: 'representative_consumer',
      verification_profile: 'canonical_digest',
      row_count: 2,
      control_totals: revision.control_totals,
      canonical_content_digest: digest,
    } : {
      verified_at: '2026-08-27T04:00:02.000Z',
      verification_path: 'representative_consumer',
      verification_profile: 'native_commit',
      row_count: 0,
      control_totals: [],
      native_commit_evidence: {
        native_version_ref: `${revisionIdValue}:v1`,
        observed_through: 'representative_consumer',
      },
    },
    created_at: '2026-08-27T04:00:00.000Z',
  };
  const record: LedgerRecord = {
    obligation: {
      reporting_obligation_id: obligationIdValue,
      delivery_config_id: config.delivery_config_id,
      delivery_config_version: 1,
      report_definition_id: config.report_definition_id,
      feed_purpose: config.feed_purpose,
      reporting_profile: config.reporting_profile,
      account_id: accountId,
      media_buy_ids: [],
      scope_resolved_at: period.end,
      coverage,
      period,
      expected_at: '2026-08-27T04:00:00.000Z',
      schedule: config.schedule,
      destination_ref: destinationRef,
      required_finality: 'official',
      reconciliation_mode: config.reconciliation_mode,
      reconciliation_status: reconciled ? 'pending' : 'not_required',
      health: reconciled ? 'waiting' : 'complete',
      production_status: 'published',
      revision_count: 1,
      adjustment_count: 0,
      materialization_count: 1,
      successful_materialization_count: 1,
      receipt_count: 0,
      accepted_receipt_count: 0,
      issues: [],
      resource_retained_until: '2026-09-27T04:00:02.000Z',
    } as ReportingObligation,
    revision,
  };
  const stored: StoredConfig = { config, activatedAt: period.start, activeWindows: [{ start: period.start }] };
  const ledger = emptyLedger();
  ledger.version = (ledgers.get(callerScope(principal, accountId))?.version ?? 0) + 1;
  ledger.configs.set(generationKey(config), stored);
  ledger.history.push(stored);
  ledger.virtualNow = '2026-08-27T04:01:00.000Z';
  ledger.integrityRecords = [record];
  ledger.publishedRevisions.set(obligationIdValue, revision);
  ledger.materializations = [materialization];
  ledger.managedResourceReadable = true;
  ledger.managedAccessRevoked = false;
  ledgers.set(callerScope(principal, accountId), ledger);
  return {
    account_id: accountId,
    reporting_obligation_id: obligationIdValue,
    reporting_revision_id: revisionIdValue,
    reporting_materialization_id: materializationId,
    destination_ref: destinationRef,
    ...(reconciled && { canonical_content_digest: digest }),
  };
}

export function prepareReliableReportingManagedDeliveryProbe(principal: string | undefined, accountId: string) {
  return prepareReliableReportingOptionalTierProbe(principal, accountId, 'managed');
}

export function updateReliableReportingManagedDeliveryProbe(
  principal: string | undefined,
  accountId: string,
  operation: 'suppress_readiness' | 'advance_within_retention' | 'revoke_access',
): Record<string, unknown> {
  const ledger = ledgerFor(principal, accountId);
  const materialization = ledger.materializations[0];
  if (!materialization) throw new Error('Prepare reliable_reporting_managed_delivery_probe first.');
  if (operation === 'suppress_readiness') return { readiness_notification_suppressed: true };
  if (operation === 'advance_within_retention') {
    ledger.virtualNow = '2026-09-26T04:00:02.000Z';
    return { resource_readable: ledger.managedResourceReadable === true, reporting_materialization_id: materialization.reporting_materialization_id };
  }
  ledger.managedAccessRevoked = true;
  ledger.managedResourceReadable = false;
  ledger.version += 1;
  return {
    access_revoked: true,
    historical_metadata_retained: ledger.materializations.length === 1,
    revocation_elapsed_seconds: 30,
    reporting_materialization_id: materialization.reporting_materialization_id,
  };
}

export function prepareReliableReportingReconciledBillingProbe(principal: string | undefined, accountId: string) {
  return prepareReliableReportingOptionalTierProbe(principal, accountId, 'reconciled');
}

export function publishReliableReportingReconciledAdjustments(
  principal: string | undefined,
  accountId: string,
): { adjustments: TrainingReportingAdjustment[]; disputed_observed_adjustment_sha256: string } {
  const ledger = ledgerFor(principal, accountId);
  const record = ledger.integrityRecords?.[0];
  const revision = record?.revision;
  if (!record || !revision) throw new Error('Prepare reliable_reporting_reconciled_billing_probe first.');
  const definitions: Array<Omit<TrainingReportingAdjustment, 'canonical_adjustment_sha256'>> = [
    {
      reporting_adjustment_id: stableId('reporting-adjustment', [revision.reporting_revision_id, 'accepted']),
      adjusts_reporting_revision_id: revision.reporting_revision_id,
      reason_code: 'invalid_traffic',
      accounting_period: { start: '2026-08-29T00:00:00.000Z', end: '2026-09-01T00:00:00.000Z' },
      control_total_deltas: [{ name: 'impressions', value: '-1', value_type: 'integer', unit: 'impressions' }],
      correction_observed_at: '2026-08-29T10:00:00.000Z',
      created_at: '2026-08-29T10:00:01.000Z',
    },
    {
      reporting_adjustment_id: stableId('reporting-adjustment', [revision.reporting_revision_id, 'disputed']),
      adjusts_reporting_revision_id: revision.reporting_revision_id,
      reason_code: 'source_correction',
      accounting_period: { start: '2026-08-29T00:00:00.000Z', end: '2026-09-01T00:00:00.000Z' },
      control_total_deltas: [{ name: 'spend', value: '-0.50', value_type: 'decimal', unit: 'USD' }],
      correction_observed_at: '2026-08-29T10:00:00.000Z',
      created_at: '2026-08-29T10:00:02.000Z',
    },
  ];
  const adjustments = definitions.map(definition => ({
    ...definition,
    canonical_adjustment_sha256: createHash('sha256').update(canonicalize(definition)).digest('hex'),
  }));
  for (const adjustment of adjustments) ledger.adjustments.set(adjustment.reporting_adjustment_id, adjustment);
  record.obligation = { ...record.obligation, adjustment_count: adjustments.length } as ReportingObligation;
  ledger.virtualNow = '2026-08-29T10:00:03.000Z';
  ledger.version += 1;
  return { adjustments, disputed_observed_adjustment_sha256: '0'.repeat(64) };
}

function obligationId(accountId: string, config: CoreConfig, periodEnd: string): string {
  return stableId('reporting-obligation', [accountId, config.delivery_config_id, String(config.delivery_config_version), periodEnd]);
}

function revisionId(obligationIdValue: string): string {
  return stableId('reporting-revision', [obligationIdValue, 'zero-row-v1']);
}

interface ReportingCoverageFixture {
  status: 'full' | 'partial' | 'none' | 'unknown';
  evaluated_at: string;
  media_buy_ids: string[];
  fully_covered_media_buy_ids: string[];
  partially_covered_media_buy_ids: string[];
  unsupported_media_buy_ids: string[];
  unknown_media_buy_ids: string[];
  package_ids: string[];
  covered_package_ids: string[];
  unsupported_package_ids: string[];
  unknown_package_ids: string[];
  limitations: Array<{ reason: 'offering_unsupported'; media_buy_id: string; package_ids?: [string, ...string[]] }>;
}

function emptyCoverage(evaluatedAt: string, mediaBuyIds: string[]): ReportingCoverageFixture {
  return {
    status: 'full' as const,
    evaluated_at: evaluatedAt,
    media_buy_ids: mediaBuyIds,
    fully_covered_media_buy_ids: mediaBuyIds,
    partially_covered_media_buy_ids: [],
    unsupported_media_buy_ids: [],
    unknown_media_buy_ids: [],
    package_ids: [],
    covered_package_ids: [],
    unsupported_package_ids: [],
    unknown_package_ids: [],
    limitations: [],
  };
}

export interface ReportingMediaBuyCandidate {
  mediaBuyId: string;
  startTime: string;
  endTime: string;
  knownAt: string;
  effectiveAt?: string;
  packages?: ReportingPackageApplicability[];
}

interface ReportingPackageApplicability {
  packageId: string;
  /** Legacy deterministic fixtures may provide the already-resolved answer. */
  supported?: boolean;
  /** Runtime callers preserve the product's atomic offering applicability. */
  offeringIds?: string[];
}

function packageSupportsOffering(pkg: ReportingPackageApplicability, offeringId: string): boolean {
  return pkg.offeringIds ? pkg.offeringIds.includes(offeringId) : pkg.supported === true;
}

function candidateStateMap(candidates: ReportingMediaBuyCandidate[]): ReportingLedger['mediaBuyCandidates'] {
  return new Map(candidates.map(candidate => [candidate.mediaBuyId, [{
    effectiveAt: candidate.effectiveAt ?? candidate.knownAt,
    start: candidate.startTime,
    end: candidate.endTime,
    knownAt: candidate.knownAt,
    packages: structuredClone(candidate.packages ?? []),
  }]]));
}

function candidateAt(
  history: ReportingMediaBuyCandidateState[],
  instantMs: number,
): ReportingMediaBuyCandidateState | undefined {
  return [...history]
    .filter(candidate => parseInstant(candidate.effectiveAt) <= instantMs)
    .sort((left, right) => left.effectiveAt.localeCompare(right.effectiveAt))
    .at(-1);
}

/** Refresh the caller-authorized buy facts used to freeze all_media_buys scopes. */
export function setReportingMediaBuyCandidates(
  principal: string | undefined,
  accountId: string,
  candidates: ReportingMediaBuyCandidate[],
): void {
  const ledger = ledgerFor(principal, accountId);
  const incoming = candidateStateMap(candidates);
  // Accepted-buy identity, lifetime, and package applicability are historical
  // reporting facts. Merge newly observed buys, but never delete or rewrite a
  // previously captured candidate merely because a later live session or
  // product catalog no longer contains it.
  let changed = false;
  for (const [mediaBuyId, snapshots] of incoming) {
    const history = ledger.mediaBuyCandidates.get(mediaBuyId) ?? [];
    for (const snapshot of snapshots) {
      if (!history.some(existing => JSON.stringify(existing) === JSON.stringify(snapshot))) {
        history.push(snapshot);
        changed = true;
      }
    }
    history.sort((left, right) => left.effectiveAt.localeCompare(right.effectiveAt));
    ledger.mediaBuyCandidates.set(mediaBuyId, history);
  }
  if (changed) ledger.version += 1;
}

/**
 * Validate explicit scopes while the caller's authorization context is still
 * available. Unknown buy IDs are intentionally reported as one generic row
 * failure so account sync cannot be used as a cross-account existence oracle.
 */
export function validateReportingConfigurationScopes(
  configurations: unknown[],
  candidates: ReportingMediaBuyCandidate[],
): void {
  const byId = new Map(candidates.map(candidate => [candidate.mediaBuyId, candidate]));
  for (const raw of configurations) {
    const config = canonicalCoreConfig(raw);
    if (!('media_buy_ids' in config.scope)) continue;
    const selected = config.scope.media_buy_ids.map(id => byId.get(id));
    if (selected.some(candidate => candidate === undefined)) {
      throw new Error('One or more reporting scope media buys are unavailable for this account.');
    }
    const support = selected.flatMap(candidate => candidate?.packages ?? [])
      .map(pkg => packageSupportsOffering(pkg, config.offering_id));
    const hasCovered = support.length === 0 || support.some(Boolean);
    const hasUnsupported = support.some(supported => !supported);
    if ((config.coverage_requirement === 'full' && hasUnsupported) || !hasCovered) {
      throw new Error('The selected reporting offering does not satisfy the requested media-buy scope coverage.');
    }
  }
}

function coverageForCandidates(
  config: CoreConfig,
  candidates: ReadonlyArray<readonly [string, ReportingMediaBuyCandidateState]>,
  knownMediaBuyIds: Set<string>,
  evaluatedAtMs: number,
): ReportingCoverageFixture {
  const requestedIds = 'media_buy_ids' in config.scope
    ? [...config.scope.media_buy_ids].sort()
    : undefined;
  const mediaBuyIdsValue = requestedIds ?? candidates.map(([mediaBuyId]) => mediaBuyId);
  const fullyCovered: string[] = [];
  const partiallyCovered: string[] = [];
  const unsupported: string[] = [];
  const packageIds: string[] = [];
  const coveredPackageIds: string[] = [];
  const unsupportedPackageIds: string[] = [];
  const limitations: ReportingCoverageFixture['limitations'] = [];
  for (const [mediaBuyId, candidate] of candidates) {
    const packages = candidate.packages;
    const covered = packages.filter(pkg => packageSupportsOffering(pkg, config.offering_id)).map(pkg => pkg.packageId);
    const rejected = packages.filter(pkg => !packageSupportsOffering(pkg, config.offering_id)).map(pkg => pkg.packageId);
    packageIds.push(...packages.map(pkg => pkg.packageId));
    coveredPackageIds.push(...covered);
    unsupportedPackageIds.push(...rejected);
    if (packages.length === 0 || rejected.length === 0) fullyCovered.push(mediaBuyId);
    else if (covered.length > 0) partiallyCovered.push(mediaBuyId);
    else unsupported.push(mediaBuyId);
    if (rejected.length > 0) limitations.push({
      reason: 'offering_unsupported',
      media_buy_id: mediaBuyId,
      package_ids: rejected as [string, ...string[]],
    });
  }
  const hasCovered = fullyCovered.length > 0 || coveredPackageIds.length > 0;
  const hasExcluded = partiallyCovered.length > 0 || unsupported.length > 0;
  const unknownMediaBuyIds = requestedIds?.filter(id => !knownMediaBuyIds.has(id)) ?? [];
  return {
    status: unknownMediaBuyIds.length > 0
      ? (hasCovered || hasExcluded ? 'partial' : 'unknown')
      : hasExcluded ? (hasCovered ? 'partial' : 'none') : 'full',
    evaluated_at: iso(evaluatedAtMs),
    media_buy_ids: mediaBuyIdsValue,
    fully_covered_media_buy_ids: fullyCovered,
    partially_covered_media_buy_ids: partiallyCovered,
    unsupported_media_buy_ids: unsupported,
    unknown_media_buy_ids: unknownMediaBuyIds,
    package_ids: [...new Set(packageIds)].sort(),
    covered_package_ids: [...new Set(coveredPackageIds)].sort(),
    unsupported_package_ids: [...new Set(unsupportedPackageIds)].sort(),
    unknown_package_ids: [],
    limitations,
  };
}

function frozenCoverage(
  ledger: ReportingLedger,
  config: CoreConfig,
  obligationIdValue: string,
  periodStartMs: number,
  periodEndMs: number,
): ReportingCoverageFixture {
  const existing = ledger.obligationCoverage.get(obligationIdValue);
  if (existing) return structuredClone(existing);
  const requestedIds = 'media_buy_ids' in config.scope
    ? [...config.scope.media_buy_ids].sort()
    : undefined;
  const candidates = (requestedIds
    ? requestedIds.flatMap(mediaBuyId => {
        const history = ledger.mediaBuyCandidates.get(mediaBuyId);
        const candidate = history && candidateAt(history, periodEndMs);
        return candidate ? [[mediaBuyId, candidate] as const] : [];
      })
    : [...ledger.mediaBuyCandidates].flatMap(([mediaBuyId, history]) => {
        const candidate = candidateAt(history, periodEndMs);
        return candidate ? [[mediaBuyId, candidate] as const] : [];
      })
      .filter(([, candidate]) => (
        parseInstant(candidate.knownAt) <= periodEndMs
        && parseInstant(candidate.start) < periodEndMs
        && parseInstant(candidate.end) > periodStartMs
      )))
    .sort(([left], [right]) => left.localeCompare(right));
  const mediaBuyIdsValue = requestedIds ?? candidates.map(([mediaBuyId]) => mediaBuyId);
  const coverage = coverageForCandidates(
    config,
    candidates,
    new Set(ledger.mediaBuyCandidates.keys()),
    periodEndMs,
  );
  ledger.obligationMediaBuyIds.set(obligationIdValue, mediaBuyIdsValue);
  ledger.obligationCoverage.set(obligationIdValue, coverage);
  ledger.version += 1;
  return structuredClone(coverage);
}

function currentCoverage(
  ledger: Pick<ReportingLedger, 'mediaBuyCandidates'>,
  config: CoreConfig,
  evaluatedAt: string,
): ReportingCoverageFixture {
  const evaluatedAtMs = parseInstant(evaluatedAt);
  const requestedIds = 'media_buy_ids' in config.scope
    ? [...config.scope.media_buy_ids].sort()
    : undefined;
  const candidates = (requestedIds
    ? requestedIds.flatMap(mediaBuyId => {
        const history = ledger.mediaBuyCandidates.get(mediaBuyId);
        const candidate = history && candidateAt(history, evaluatedAtMs);
        return candidate ? [[mediaBuyId, candidate] as const] : [];
      })
    : [...ledger.mediaBuyCandidates].flatMap(([mediaBuyId, history]) => {
        const candidate = candidateAt(history, evaluatedAtMs);
        return candidate ? [[mediaBuyId, candidate] as const] : [];
      }).filter(([, candidate]) => (
        parseInstant(candidate.knownAt) <= evaluatedAtMs
        && parseInstant(candidate.start) <= evaluatedAtMs
        && parseInstant(candidate.end) > evaluatedAtMs
      )))
    .sort(([left], [right]) => left.localeCompare(right));
  return coverageForCandidates(
    config,
    candidates,
    new Set(ledger.mediaBuyCandidates.keys()),
    evaluatedAtMs,
  );
}

function aggregateCoverage(records: LedgerRecord[], evaluatedAt: string): ReportingCoverageFixture {
  if (records.length === 0) return emptyCoverage(evaluatedAt, []);
  const values = records.map(record => record.obligation.coverage as ReportingCoverageFixture);
  const unique = (items: string[]): string[] => [...new Set(items)].sort();
  const mediaBuyIdsValue = unique(values.flatMap(value => value.media_buy_ids));
  const unknown = new Set(values.flatMap(value => value.unknown_media_buy_ids));
  const unsupported = new Set(values.flatMap(value => value.unsupported_media_buy_ids).filter(id => !unknown.has(id)));
  const partial = new Set(values.flatMap(value => value.partially_covered_media_buy_ids)
    .filter(id => !unknown.has(id) && !unsupported.has(id)));
  const full = unique(values.flatMap(value => value.fully_covered_media_buy_ids)
    .filter(id => !unknown.has(id) && !unsupported.has(id) && !partial.has(id)));
  const unknownPackages = new Set(values.flatMap(value => value.unknown_package_ids));
  const unsupportedPackages = new Set(values.flatMap(value => value.unsupported_package_ids)
    .filter(id => !unknownPackages.has(id)));
  const coveredPackages = unique(values.flatMap(value => value.covered_package_ids)
    .filter(id => !unknownPackages.has(id) && !unsupportedPackages.has(id)));
  const hasCovered = full.length > 0 || partial.size > 0 || coveredPackages.length > 0;
  const hasExcluded = unsupported.size > 0 || partial.size > 0 || unknown.size > 0;
  return {
    status: !hasExcluded ? 'full' : hasCovered ? 'partial' : unknown.size > 0 ? 'unknown' : 'none',
    evaluated_at: evaluatedAt,
    media_buy_ids: mediaBuyIdsValue,
    fully_covered_media_buy_ids: full,
    partially_covered_media_buy_ids: [...partial].sort(),
    unsupported_media_buy_ids: [...unsupported].sort(),
    unknown_media_buy_ids: [...unknown].sort(),
    package_ids: unique(values.flatMap(value => value.package_ids)),
    covered_package_ids: coveredPackages,
    unsupported_package_ids: [...unsupportedPackages].sort(),
    unknown_package_ids: [...unknownPackages].sort(),
    limitations: values.flatMap(value => value.limitations).filter((limitation, index, all) => (
      all.findIndex(candidate => JSON.stringify(candidate) === JSON.stringify(limitation)) === index
    )),
  };
}

function healthFor(expectedAtMs: number, nowMs: number): 'waiting' | 'delayed' | 'action_required' {
  if (nowMs <= expectedAtMs) return 'waiting';
  return nowMs > expectedAtMs + RECOVERY_WINDOW_MS ? 'action_required' : 'delayed';
}

interface LedgerRecord {
  obligation: ReportingObligation;
  revision?: ReportingRevision;
}

function recordsFor(
  principal: string | undefined,
  accountId: string,
  configs: StoredConfig[],
  nowMs: number,
): LedgerRecord[] {
  const ledger = ledgerFor(principal, accountId);
  if (ledger.integrityRecords) {
    const generations = new Set(configs.map(stored => generationKey(stored.config)));
    return structuredClone(ledger.integrityRecords.filter(record => generations.has(
      `${record.obligation.delivery_config_id}\u001f${record.obligation.delivery_config_version}`,
    )));
  }
  const records: LedgerRecord[] = [];
  const retentionStartMs = floorHour(nowMs) - RETENTION_DAYS * 24 * HOUR_MS;
  for (const stored of configs) {
    for (const window of stored.activeWindows) {
      const activatedMs = parseInstant(window.start);
      const periodMs = stored.config.schedule.period_duration === 'P1D' ? 24 * HOUR_MS : HOUR_MS;
      const slaMs = stored.config.schedule.delivery_sla === 'PT4H' ? 4 * HOUR_MS : HOUR_MS;
      const firstStart = Math.max(floorHour(activatedMs + periodMs - 1), retentionStartMs);
      const finalEnd = Math.min(
        floorHour(nowMs),
        window.end ? floorHour(parseInstant(window.end) + periodMs - 1) : floorHour(nowMs),
      );
      for (let startMs = firstStart; startMs < finalEnd; startMs += periodMs) {
      const endMs = startMs + periodMs;
      // The obligation is committed only for snapshots strictly after its
      // boundary, never for a snapshot taken at the exact boundary.
      if (endMs >= nowMs) continue;
      const periodEnd = iso(endMs);
      const id = obligationId(accountId, stored.config, periodEnd);
      if (ledger.suppressedObligationIds.has(id)) continue;
      const coverage = frozenCoverage(ledger, stored.config, id, startMs, endMs);
      const ids = coverage.media_buy_ids;
      const revision = ledger.publishedRevisions.get(id);
      const published = revision !== undefined;
      const incompleteFullCoverage = stored.config.coverage_requirement === 'full'
        && coverage.status !== 'full';
      const health = incompleteFullCoverage
        ? 'action_required'
        : published ? 'complete' : healthFor(endMs + slaMs, nowMs);
      const issues = incompleteFullCoverage ? [{
        issue_id: stableId('reporting-issue', [id, 'coverage-incomplete']),
        code: 'REPORTING_COVERAGE_INCOMPLETE' as const,
        severity: 'action_required' as const,
        responsible_party: 'seller' as const,
        recommended_action: 'change_reporting_scope' as const,
        reporting_obligation_id: id,
        delivery_config_id: stored.config.delivery_config_id,
        delivery_config_version: stored.config.delivery_config_version,
        feed_purpose: stored.config.feed_purpose,
        ...(ids.length > 0 && { media_buy_ids: ids as [string, ...string[]] }),
        ...(coverage.unsupported_package_ids.length > 0 && {
          package_ids: coverage.unsupported_package_ids as [string, ...string[]],
        }),
        period_start: iso(startMs),
        period_end: periodEnd,
        expected_at: iso(endMs + slaMs),
      }] : health === 'waiting' ? [] : published ? [] : [{
        issue_id: stableId('reporting-issue', [id, health]),
        code: 'REPORT_OVERDUE' as const,
        severity: health as 'delayed' | 'action_required',
        responsible_party: 'seller' as const,
        recommended_action: health === 'delayed' ? 'wait_for_retry' as const : 'contact_seller' as const,
        reporting_obligation_id: id,
        delivery_config_id: stored.config.delivery_config_id,
        delivery_config_version: stored.config.delivery_config_version,
        feed_purpose: stored.config.feed_purpose,
        period_start: iso(startMs),
        period_end: periodEnd,
        expected_at: iso(endMs + slaMs),
      }];
      const obligation = {
        reporting_obligation_id: id,
        delivery_config_id: stored.config.delivery_config_id,
        delivery_config_version: stored.config.delivery_config_version,
        report_definition_id: stored.config.report_definition_id,
        feed_purpose: stored.config.feed_purpose,
        reporting_profile: stored.config.reporting_profile,
        account_id: accountId,
        media_buy_ids: ids,
        scope_resolved_at: periodEnd,
        coverage,
        period: { start: iso(startMs), end: periodEnd, source_timezone: 'UTC' },
        expected_at: iso(endMs + slaMs),
        schedule: stored.config.schedule,
        required_finality: 'snapshot',
        reconciliation_mode: 'delivery_only',
        reconciliation_status: 'not_required',
        health,
        production_status: published ? 'published' : 'pending',
        revision_count: published ? 1 : 0,
        adjustment_count: 0,
        issues,
      } as ReportingObligation;
      records.push({ obligation, ...(revision && { revision: structuredClone(revision) }) });
      }
    }
  }
  return records.sort((a, b) => a.obligation.period.start.localeCompare(b.obligation.period.start));
}

function zeroRowRevision(obligation: ReportingObligation, nowMs: number): ReportingRevision {
  return {
    reporting_revision_id: revisionId(obligation.reporting_obligation_id),
    report_definition_id: obligation.report_definition_id,
    report_definition_uri: TRAINING_DEFINITION_URI,
    report_definition_sha256: TRAINING_DEFINITION_SHA256,
    reporting_profile: obligation.reporting_profile,
    schema_version: '1.0',
    schema_uri: TRAINING_SCHEMA_URI,
    schema_sha256: TRAINING_SCHEMA_SHA256,
    schema_dialect: 'https://json-schema.org/draft/2020-12/schema',
    schema_ref_policy: 'local_fragment_only',
    account_id: obligation.account_id,
    media_buy_ids: obligation.media_buy_ids,
    coverage: obligation.coverage,
    period: obligation.period,
    finality: 'snapshot',
    observed_at: iso(nowMs),
    data_through: obligation.period.end,
    data_through_precision: 'exact',
    row_count: 0,
    control_totals: [],
    created_at: iso(nowMs),
  };
}

function unavailable(view: GetReportingStatusRequest['view']): TrainingGetReportingStatusResponse {
  return {
    status: 'failed',
    view,
    failure_kind: 'lookup_unavailable',
    errors: [{ code: 'NOT_FOUND', message: 'Reporting status resource is unavailable.' }],
  } as TrainingGetReportingStatusResponse;
}

export function reportingStatusUnavailable(
  view: GetReportingStatusRequest['view'],
): GetReportingStatusResponse {
  return unavailable(view);
}

function worstHealth(records: LedgerRecord[]): 'waiting' | 'complete' | 'delayed' | 'action_required' {
  if (records.some(record => record.obligation.health === 'action_required')) return 'action_required';
  if (records.some(record => record.obligation.health === 'delayed')) return 'delayed';
  if (records.length === 0 || records.every(record => record.obligation.health === 'complete')) return 'complete';
  return 'waiting';
}

function withinHalfOpenPeriod(record: LedgerRecord, period: GetReportingStatusRequest['period']): boolean {
  if (!period) return true;
  const start = parseInstant(period.start);
  const end = parseInstant(period.end);
  const recordStart = parseInstant(record.obligation.period.start);
  const recordEnd = parseInstant(record.obligation.period.end);
  return start < end && recordStart >= start && recordEnd <= end;
}

type PageResource =
  | { kind: 'period'; record: LedgerRecord }
  | { kind: 'revision'; record: LedgerRecord }
  | { kind: 'adjustment'; adjustment: TrainingReportingAdjustment }
  | { kind: 'materialization'; materialization: Record<string, unknown> }
  | { kind: 'receipt'; receipt: Record<string, unknown> }
  | { kind: 'adjustment_receipt'; adjustmentReceipt: Record<string, unknown> };
interface StoredPageSnapshot {
  scope: string;
  nowMs: number;
  expiresAtMs: number;
  resources: PageResource[];
  common: Record<string, unknown>;
}
interface StoredPageCursor {
  snapshotId: string;
  offset: number;
  expiresAtMs: number;
}
interface ResolvedPageSnapshot extends StoredPageSnapshot {
  snapshotId: string;
  offset: number;
}
const PAGE_CURSOR_TTL_MS = 15 * 60 * 1000;

function sweepPageCursors(ledger: ReportingLedger, nowMs = Date.now()): void {
  for (const [token, cursor] of ledger.pageCursors) {
    if (cursor.expiresAtMs <= nowMs) ledger.pageCursors.delete(token);
  }
  const referenced = new Set([...ledger.pageCursors.values()].map(cursor => cursor.snapshotId));
  for (const [snapshotId, snapshot] of ledger.pageSnapshots) {
    if (snapshot.expiresAtMs <= nowMs || !referenced.has(snapshotId)) {
      ledger.pageSnapshots.delete(snapshotId);
    }
  }
}

function cursorFor(
  ledger: ReportingLedger,
  snapshot: Omit<StoredPageSnapshot, 'expiresAtMs'>,
  offset: number,
  snapshotId?: string,
): string {
  sweepPageCursors(ledger);
  const resolvedSnapshotId = snapshotId ?? randomBytes(24).toString('base64url');
  const token = randomBytes(24).toString('base64url');
  const expiresAtMs = Date.now() + PAGE_CURSOR_TTL_MS;
  if (!ledger.pageSnapshots.has(resolvedSnapshotId)) {
    ledger.pageSnapshots.set(resolvedSnapshotId, {
      ...snapshot,
      resources: structuredClone(snapshot.resources),
      common: structuredClone(snapshot.common),
      expiresAtMs,
    });
  } else {
    ledger.pageSnapshots.get(resolvedSnapshotId)!.expiresAtMs = expiresAtMs;
  }
  ledger.pageCursors.set(token, {
    snapshotId: resolvedSnapshotId,
    offset,
    expiresAtMs,
  });
  return token;
}

function snapshotFromCursor(
  ledger: ReportingLedger,
  cursor: string | undefined,
  scope: string,
): ResolvedPageSnapshot | undefined | null {
  sweepPageCursors(ledger);
  if (!cursor) return undefined;
  const pageCursor = ledger.pageCursors.get(cursor);
  const snapshot = pageCursor && ledger.pageSnapshots.get(pageCursor.snapshotId);
  if (!pageCursor || !snapshot || snapshot.scope !== scope) {
    if (pageCursor) ledger.pageCursors.delete(cursor);
    return null;
  }
  return {
    ...snapshot,
    snapshotId: pageCursor.snapshotId,
    offset: pageCursor.offset,
  };
}

/** First-class SDK handler body for get_reporting_status. */
export function getReportingStatusForAccount(
  params: TrainingGetReportingStatusRequest,
  principal: string | undefined,
  accountId: string,
): TrainingGetReportingStatusResponse {
  const request = params;
  const ledger = ledgerFor(principal, accountId);
  const checkpointScope = stableId('reporting-change-scope', [
    callerScope(principal, accountId), JSON.stringify({
      delivery_config_ids: params.delivery_config_ids ? [...params.delivery_config_ids].sort() : params.delivery_config_ids,
      media_buy_ids: params.media_buy_ids ? [...params.media_buy_ids].sort() : params.media_buy_ids,
      feed_purposes: params.feed_purposes ? [...params.feed_purposes].sort() : params.feed_purposes,
      period: params.period,
      health: params.health,
      finality: params.finality ? [...params.finality].sort() : params.finality,
    }),
  ]);
  const cursorScope = stableId('reporting-page', [
    checkpointScope,
    params.view,
    params.reporting_revision_id ?? '',
    request.changes_after ?? 'full',
  ]);
  const snapshot = snapshotFromCursor(ledger, params.pagination?.cursor, cursorScope);
  if (snapshot === null) return unavailable(params.view);
  // Opaque server-held cursors pin both ledger_as_of and the complete resource
  // set. Callers cannot forge timestamps/offsets or observe concurrent writes
  // halfway through a paginated snapshot.
  const nowMs = snapshot?.nowMs ?? (ledger.virtualNow ? parseInstant(ledger.virtualNow) : Date.now());
  if (params.period && !(parseInstant(params.period.start) < parseInstant(params.period.end))) return unavailable(params.view);
  const retainedFromMs = floorHour(nowMs) - RETENTION_DAYS * 24 * HOUR_MS;
  if (params.period && parseInstant(params.period.start) < retainedFromMs) return unavailable(params.view);
  const horizonStartMs = params.period ? parseInstant(params.period.start) : retainedFromMs;
  const horizonEndMs = params.period ? parseInstant(params.period.end) : nowMs;
  const intersectsHorizon = (entry: StoredConfig) => entry.activeWindows.some(window => (
    parseInstant(window.start) < horizonEndMs
    && (window.end === undefined || parseInstant(window.end) > horizonStartMs)
  ));
  const current = [...ledger.configs.values()];
  const active = current.filter(entry => activeWindowAt(entry, nowMs) !== undefined);
  const requestedConfigIds = params.delivery_config_ids;
  if (requestedConfigIds?.some(id => !ledger.history.some(entry => entry.config.delivery_config_id === id))) {
    return unavailable(params.view);
  }
  const configs = requestedConfigIds
    ? ledger.history.filter(entry => requestedConfigIds.includes(entry.config.delivery_config_id) && intersectsHorizon(entry))
    : active;
  const knownMediaBuyIds = new Set([
    ...ledger.mediaBuyCandidates.keys(),
    ...[...ledger.obligationCoverage.values()].flatMap(coverage => coverage.media_buy_ids),
  ]);
  if (params.media_buy_ids?.some(id => !knownMediaBuyIds.has(id))) return unavailable(params.view);
  const records = recordsFor(principal, accountId, configs, nowMs)
    .filter(record => withinHalfOpenPeriod(record, params.period))
    .filter(record => !params.media_buy_ids
      || params.media_buy_ids.some(id => record.obligation.media_buy_ids.includes(id)))
    .filter(record => !params.feed_purposes || params.feed_purposes.includes(record.obligation.feed_purpose))
    .filter(record => !params.finality || params.finality.includes(record.obligation.required_finality));
  let deltaRecords = records;
  if (request.changes_after) {
    const match = /^reporting_change_(\d+)_([a-f0-9]{16})$/.exec(request.changes_after);
    const scopeFingerprint = createHash('sha256').update(checkpointScope).digest('hex').slice(0, 16);
    if (!match || match[2] !== scopeFingerprint || Number(match[1]) > ledger.version) {
      return unavailable(params.view);
    }
    // This training implementation may replay older immutable records, but a
    // current checkpoint always produces an empty delta. Production sellers
    // can retain per-record commit ordinals to avoid the safe replay.
    if (Number(match[1]) === ledger.version) deltaRecords = [];
  }
  if (params.view === 'revision') {
    const revision = recordsFor(principal, accountId, ledger.history, nowMs).map(record => record.revision)
      .find((candidate): candidate is ReportingRevision => candidate?.reporting_revision_id === params.reporting_revision_id);
    if (!revision) return unavailable(params.view);
    return {
      status: 'completed',
      view: 'revision',
      ledger_snapshot_id: stableId('reporting-ledger', [callerScope(principal, accountId), iso(nowMs), String(ledger.version)]),
      ledger_as_of: iso(nowMs),
      account_id: accountId,
      revision,
      adjustments: [...ledger.adjustments.values()].filter(
        adjustment => adjustment.adjusts_reporting_revision_id === revision.reporting_revision_id,
      ),
      adjustment_receipts: ledger.adjustmentReceipts.filter(
        receipt => receipt.adjusts_reporting_revision_id === revision.reporting_revision_id,
      ),
      materializations: ledger.materializations.filter(
        materialization => materialization.reporting_revision_id === revision.reporting_revision_id,
      ),
      receipts: ledger.receipts.filter(
        receipt => receipt.reporting_revision_id === revision.reporting_revision_id,
      ),
      pagination: { has_more: false, total_count: 1 },
    } as TrainingGetReportingStatusResponse;
  }
  const issues = records.flatMap(record => record.obligation.issues);
  const periodEnd = params.period ? parseInstant(params.period.end) : floorHour(nowMs);
  const periodStart = params.period
    ? parseInstant(params.period.start)
    : configs.length > 0
      ? Math.max(retainedFromMs, Math.min(...configs.map(config => floorHour(parseInstant(config.activatedAt) + HOUR_MS - 1))))
      : floorHour(nowMs) - HOUR_MS;
  const scopeClosed = configs.length === 0 || periodEnd < nowMs;
  const health = records.length === 0 && !scopeClosed ? 'waiting' : worstHealth(records);
  const scope = {
    period_start: iso(periodStart),
    period_end: iso(periodEnd),
    // Closure is the fixed-period denominator, independent of whether a
    // revision has arrived. Missing-first-report must remain observable here.
    scope_closed: scopeClosed,
    ...(params.media_buy_ids && { media_buy_ids: [...params.media_buy_ids].sort() }),
    all_accessible_media_buys: params.media_buy_ids === undefined,
    delivery_config_generations: configs.map(entry => ({
      delivery_config_id: entry.config.delivery_config_id,
      delivery_config_version: entry.config.delivery_config_version,
      feed_purpose: entry.config.feed_purpose,
    })),
    feed_purposes: [...new Set(configs.map(entry => entry.config.feed_purpose))],
    finality: [...new Set(configs.map(entry => entry.config.required_finality))],
    ledger_retained_from: iso(retainedFromMs),
    coverage_complete: periodStart >= retainedFromMs,
  };
  const coverage = aggregateCoverage(records, iso(nowMs));
  const counts = {
    total: records.length,
    waiting: records.filter(record => record.obligation.health === 'waiting').length,
    healthy: 0,
    delayed: records.filter(record => record.obligation.health === 'delayed').length,
    action_required: records.filter(record => record.obligation.health === 'action_required').length,
    complete: records.filter(record => record.obligation.health === 'complete').length,
  };
  const common = {
    status: 'completed' as const,
    view: params.view,
    ledger_snapshot_id: stableId('reporting-ledger', [callerScope(principal, accountId), iso(nowMs), String(ledger.version)]),
    ledger_as_of: iso(nowMs),
    account_id: accountId,
    scope,
    health,
    coverage,
    data_through: records.filter(record => record.revision).at(-1)?.obligation.period.end ?? null,
    ...(!scopeClosed && { next_expected_at: iso(periodEnd + HOUR_MS) }),
    obligation_counts: counts,
    issues,
  };
  if (params.view === 'summary') return common as GetReportingStatusResponse;
  const filtered = params.health
    ? deltaRecords.filter(record => params.health?.includes(record.obligation.health))
    : deltaRecords;
  const currentResources: PageResource[] = filtered.flatMap(record => [
    { kind: 'period' as const, record },
    ...(record.revision ? [{ kind: 'revision' as const, record }] : []),
    ...[...ledger.adjustments.values()]
      .filter(adjustment => adjustment.adjusts_reporting_revision_id === record.revision?.reporting_revision_id)
      .map(adjustment => ({ kind: 'adjustment' as const, adjustment })),
    ...ledger.materializations
      .filter(materialization => materialization.reporting_revision_id === record.revision?.reporting_revision_id)
      .map(materialization => ({ kind: 'materialization' as const, materialization })),
    ...ledger.receipts
      .filter(receipt => receipt.reporting_revision_id === record.revision?.reporting_revision_id)
      .map(receipt => ({ kind: 'receipt' as const, receipt })),
    ...ledger.adjustmentReceipts
      .filter(receipt => receipt.adjusts_reporting_revision_id === record.revision?.reporting_revision_id)
      .map(adjustmentReceipt => ({ kind: 'adjustment_receipt' as const, adjustmentReceipt })),
  ]);
  const resources = snapshot?.resources ?? currentResources;
  const scopeFingerprint = createHash('sha256').update(checkpointScope).digest('hex').slice(0, 16);
  const currentChangesCheckpoint = `reporting_change_${ledger.version}_${scopeFingerprint}`;
  const responseCommon = snapshot?.common ?? { ...common, changes_checkpoint: currentChangesCheckpoint };
  const offset = snapshot?.offset ?? 0;
  const page = resources.slice(offset, offset + (params.pagination?.max_results ?? 100));
  const hasMore = offset + page.length < resources.length;
  return {
    ...responseCommon,
    status: 'completed',
    view: 'periods',
    periods: page.filter(item => item.kind === 'period').map(item => item.record.obligation),
    revisions: page.filter(item => item.kind === 'revision').flatMap(item => item.record.revision ? [item.record.revision] : []),
    adjustments: page.filter((item): item is Extract<PageResource, { kind: 'adjustment' }> => item.kind === 'adjustment')
      .map(item => item.adjustment),
    adjustment_receipts: page
      .filter((item): item is Extract<PageResource, { kind: 'adjustment_receipt' }> => item.kind === 'adjustment_receipt')
      .map(item => item.adjustmentReceipt),
    materializations: page
      .filter((item): item is Extract<PageResource, { kind: 'materialization' }> => item.kind === 'materialization')
      .map(item => item.materialization),
    receipts: page
      .filter((item): item is Extract<PageResource, { kind: 'receipt' }> => item.kind === 'receipt')
      .map(item => item.receipt),
    pagination: {
      has_more: hasMore,
      ...(hasMore && {
        cursor: cursorFor(
          ledger,
          { scope: cursorScope, nowMs, resources, common: responseCommon },
          offset + page.length,
          snapshot?.snapshotId,
        ),
      }),
      // A page walks one flat union of every retained ledger resource.
      total_count: resources.length,
    },
  } as TrainingGetReportingStatusResponse;
}

export function clearReportingReliabilityStore(): void {
  ledgers.clear();
  reportingAccountBindings.clear();
}

/** Test-only process-cache loss without discarding the in-memory ledger. */
export function clearReportingAccountBindingCacheForTesting(): void {
  reportingAccountBindings.clear();
}

/** Test-only visibility into the accepted-buy history behind frozen coverage. */
export function reportingMediaBuyCandidateHistoryForTesting(
  principal: string | undefined,
  accountId: string,
  mediaBuyId: string,
): ReportingMediaBuyCandidateState[] {
  return structuredClone(ledgerFor(principal, accountId).mediaBuyCandidates.get(mediaBuyId) ?? []);
}

export async function replaceReportingConfigurationsDurably(
  principal: string | undefined,
  accountId: string,
  configurations: unknown[],
  activatedAt = new Date().toISOString(),
  account?: AccountRef,
  mediaBuyCandidates?: ReportingMediaBuyCandidate[],
  accountState?: Record<string, unknown>,
): Promise<void> {
  await withDurableReportingLedger(principal, accountId, true, () => {
    if (mediaBuyCandidates) {
      validateReportingConfigurationScopes(configurations, mediaBuyCandidates);
      setReportingMediaBuyCandidates(principal, accountId, mediaBuyCandidates);
    }
    replaceReportingConfigurations(principal, accountId, configurations, activatedAt);
  }, account, accountState);
}

/** Persist authoritative account ownership even when reporting is unconfigured. */
export async function bindReportingAccountDurably(
  principal: string | undefined,
  accountId: string,
  account: AccountRef,
  accountState?: Record<string, unknown>,
): Promise<void> {
  await withDurableReportingLedger(principal, accountId, true, () => undefined, account, accountState);
}

/** Capture accepted-buy applicability before live catalog/session state can change. */
export async function captureReportingMediaBuyCandidateDurably(
  principal: string | undefined,
  accountId: string,
  account: AccountRef,
  candidate: ReportingMediaBuyCandidate,
): Promise<void> {
  const existingBinding = account.account_id
    ? await resolveReportingAccountDurably(principal, { account_id: accountId })
    : undefined;
  await withDurableReportingLedger(principal, accountId, true, () => {
    setReportingMediaBuyCandidates(principal, accountId, [candidate]);
  }, existingBinding?.account ?? account);
}

export async function validateReportingConfigurationReplacementDurably(
  principal: string | undefined,
  accountId: string,
  configurations: unknown[],
): Promise<void> {
  await withDurableReportingLedger(principal, accountId, false, () => {
    validateReportingConfigurationReplacement(principal, accountId, configurations);
  });
}

export async function reportingConfigurationStatesForAccountDurably(
  principal: string | undefined,
  accountId: string,
): Promise<Array<Record<string, unknown>>> {
  return await withDurableReportingLedger(principal, accountId, false, () => (
    reportingConfigurationStatesForAccount(principal, accountId)
  ));
}

export async function getReportingStatusForAccountDurably(
  params: TrainingGetReportingStatusRequest,
  principal: string | undefined,
  accountId: string,
  mediaBuyCandidates: Array<{
    mediaBuyId: string;
    startTime: string;
    endTime: string;
    knownAt: string;
    packages?: ReportingPackageApplicability[];
  }>,
): Promise<TrainingGetReportingStatusResponse> {
  // A status read may commit the first frozen all_media_buys denominator for
  // an elapsed period, so it is a durable ledger mutation even though the
  // protocol task itself is read-only.
  return await withDurableReportingLedger(principal, accountId, true, () => {
    setReportingMediaBuyCandidates(principal, accountId, mediaBuyCandidates);
    return getReportingStatusForAccount(params, principal, accountId);
  });
}

/** Secret-free account projection for sync_accounts and list_accounts. */
export function reportingConfigurationStatesForAccount(
  principal: string | undefined,
  accountId: string,
): Array<Record<string, unknown>> {
  const ledger = ledgers.get(callerScope(principal, accountId));
  if (!ledger) return [];
  const evaluatedAt = new Date().toISOString();
  return [...ledger.configs.values()].map(stored => configurationState(stored, evaluatedAt, ledger));
}

/** Resolve a dry-run echo without creating a ledger or materializing obligations. */
export function projectedReportingConfigurationStates(
  configurations: unknown[],
  evaluatedAt: string,
  candidates: ReportingMediaBuyCandidate[] = [],
): Array<Record<string, unknown>> {
  validateReportingConfigurations(configurations);
  const coverageLedger = { mediaBuyCandidates: candidateStateMap(candidates) };
  return configurations.map(raw => {
    const config = canonicalCoreConfig(raw);
    return configurationState({
      config,
      activatedAt: evaluatedAt,
      activeWindows: config.active ? [{ start: evaluatedAt }] : [],
    }, evaluatedAt, coverageLedger);
  });
}

function configurationState(
  stored: StoredConfig,
  evaluatedAt: string,
  ledger: Pick<ReportingLedger, 'mediaBuyCandidates'>,
): Record<string, unknown> {
  const { config, activatedAt, deactivatedAt } = stored;
  const evaluatedAtMs = parseInstant(evaluatedAt);
  const activeWindow = activeWindowAt(stored, evaluatedAtMs);
  if (activeWindow) {
    const coverage = currentCoverage(ledger, config, evaluatedAt);
    if (config.coverage_requirement === 'full' && coverage.status !== 'full') {
      return {
        configuration: structuredClone(config),
        state: 'action_required',
        validated_at: evaluatedAt,
        activated_at: activeWindow.start,
        current_coverage: coverage,
        issues: [{
          issue_id: stableId('reporting-config-issue', [config.delivery_config_id, String(config.delivery_config_version), 'coverage-incomplete']),
          code: 'REPORTING_COVERAGE_INCOMPLETE',
          severity: 'action_required',
          responsible_party: 'seller',
          recommended_action: 'change_reporting_scope',
          delivery_config_id: config.delivery_config_id,
          delivery_config_version: config.delivery_config_version,
          feed_purpose: config.feed_purpose,
          ...(coverage.media_buy_ids.length > 0 && { media_buy_ids: coverage.media_buy_ids }),
          ...(coverage.unsupported_package_ids.length > 0 && { package_ids: coverage.unsupported_package_ids }),
        }],
      };
    }
    return {
      configuration: structuredClone(config),
      state: 'ready',
      validated_at: evaluatedAt,
      activated_at: activeWindow.start,
      current_coverage: coverage,
    };
  }
  const stoppedAt = [...stored.activeWindows]
    .reverse()
    .find(window => window.end !== undefined && parseInstant(window.end) <= evaluatedAtMs)?.end
    ?? deactivatedAt
    ?? activatedAt;
  return {
    configuration: structuredClone(config),
    state: 'inactive',
    deactivated_at: stoppedAt,
    publication_stopped_at: iso(floorHour(parseInstant(stoppedAt) + HOUR_MS - 1)),
  };
}

export const TRAINING_REPORTING_CORE_OFFERING = {
  offering_id: 'pacing-hourly-core',
  feed_purpose: 'pacing' as const,
  report_definition_id: 'training_delivery_summary_v1',
  report_definition_uri: TRAINING_DEFINITION_URI,
  report_definition_sha256: TRAINING_DEFINITION_SHA256,
  reporting_profile: {
    id: 'training_delivery_summary_v1',
    version: '1.0',
    schema_uri: TRAINING_SCHEMA_URI,
    schema_sha256: TRAINING_SCHEMA_SHA256,
    schema_dialect: 'https://json-schema.org/draft/2020-12/schema' as const,
    schema_ref_policy: 'local_fragment_only' as const,
    grain: 'one aggregate delivery summary per reporting period',
    primary_keys: ['period_start'] as [string],
  },
  schedule: { period_duration: 'PT1H', alignment: 'utc' as const, delivery_sla: 'PT1H' },
  supported_finality: ['snapshot'] as ['snapshot'],
  reconciliation_mode: 'delivery_only' as const,
};

export const TRAINING_REPORTING_MANAGED_OFFERING = {
  ...TRAINING_REPORTING_CORE_OFFERING,
  offering_id: 'analytics-daily-managed',
  feed_purpose: 'analytics' as const,
  schedule: { period_duration: 'P1D', alignment: 'utc' as const, delivery_sla: 'PT4H' },
  supported_finality: ['official'] as ['official'],
  method: {
    pattern: 'dataset_share' as const,
    transport: 'training_dataset',
    orchestration: 'producer_managed' as const,
    destination_modes: ['provision'] as ['provision'],
    provider: { domain: 'test-agent.adcontextprotocol.org' },
    access_mode: 'read_only',
  },
};

export const TRAINING_REPORTING_RECONCILED_OFFERING = {
  ...TRAINING_REPORTING_MANAGED_OFFERING,
  offering_id: 'billing-daily-reconciled',
  feed_purpose: 'billing' as const,
  reconciliation_mode: 'consumer_receipt' as const,
  reporting_profile: {
    ...TRAINING_REPORTING_CORE_OFFERING.reporting_profile,
    canonicalization_id: 'billing-rows-v1',
    canonicalization_contract_version: '1.0' as const,
    canonicalization_media_type: 'application/vnd.adcp.reporting-canonicalization+json' as const,
    canonicalization_uri: 'https://test-agent.adcontextprotocol.org/reporting/canonicalization/billing-rows-v1.json',
    canonicalization_sha256: TRAINING_CANONICALIZATION_SHA256,
  },
};

export const TRAINING_REPORTING_CORE_CONFIGURATION: CoreConfig = {
  delivery_config_id: 'training-pacing-core',
  delivery_config_version: 1,
  offering_id: TRAINING_REPORTING_CORE_OFFERING.offering_id,
  active: true,
  feed_purpose: 'pacing',
  report_definition_id: TRAINING_REPORTING_CORE_OFFERING.report_definition_id,
  reporting_profile: TRAINING_REPORTING_CORE_OFFERING.reporting_profile.id,
  scope: { all_media_buys: true },
  coverage_requirement: 'full',
  required_finality: 'snapshot',
  reconciliation_mode: 'delivery_only',
  schedule: { period_duration: 'PT1H', alignment: 'utc', delivery_sla: 'PT1H' },
};
