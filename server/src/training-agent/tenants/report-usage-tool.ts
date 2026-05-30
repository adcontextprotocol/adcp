import { z } from 'zod';
import { customToolFor } from './custom-tool-helper.js';
import { handleReportUsage } from '../task-handlers.js';
import type { TrainingContext } from '../types.js';

const ACCOUNT_REF_SCHEMA = z.object({
  account_id: z.string().optional(),
  brand: z.object({ domain: z.string() }).passthrough().optional(),
  operator: z.string().optional(),
}).passthrough();

const REPORT_USAGE_SCHEMA = {
  account: ACCOUNT_REF_SCHEMA.optional(),
  idempotency_key: z.string(),
  reporting_period: z.object({
    start: z.string(),
    end: z.string(),
  }).passthrough(),
  usage: z.array(z.object({
    account: ACCOUNT_REF_SCHEMA,
    media_buy_id: z.string().optional(),
    creative_id: z.string().optional(),
    signal_agent_segment_id: z.string().optional(),
    pricing_option_id: z.string().optional(),
    impressions: z.number().optional(),
    media_spend: z.number().optional(),
    vendor_cost: z.number(),
    currency: z.string(),
    final: z.boolean().optional(),
    finalized_at: z.string().optional(),
    measurement_window: z.string().optional(),
  }).passthrough()).min(1),
  context: z.any().optional(),
  ext: z.any().optional(),
};

export function reportUsageTool(options: Pick<TrainingContext, 'creativeBillsThroughAdcp'> = {}) {
  return customToolFor(
    'report_usage',
    'Report usage records for billing verification and reconciliation.',
    REPORT_USAGE_SCHEMA,
    handleReportUsage,
    {
      annotations: { readOnlyHint: false, idempotentHint: true },
      enforceIdempotency: true,
      payloadErrorsAsSuccess: true,
      trainingContext: options,
      responseSummary: (result) => `Accepted ${result.accepted ?? 0} usage records`,
    },
  );
}
