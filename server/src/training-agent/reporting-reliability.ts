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
