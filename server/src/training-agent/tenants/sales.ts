/**
 * /sales tenant — non-guaranteed, guaranteed, and DOOH sales specialisms.
 *
 * Distinct platform from /signals (single-specialism per tenant). Buyers
 * call sales-track tools at this URL; signals tools live on /signals.
 */

import { z } from 'zod';
import type { TaskRegistry, TenantConfig } from '@adcp/sdk/server';
import { TOOL_INPUT_SHAPES } from '@adcp/sdk/schemas';
import {
  TrainingSalesPlatform,
  legacyGetProductsHandler,
  legacyListCreativesHandler,
  legacySyncCreativesHandler,
  reportingStatusForCustomTool,
  syncReportingReceiptsForCustomTool,
} from '../v6-sales-platform.js';
import { getTenantSigningMaterial } from './signing.js';
import { buildSalesComplyConfig } from './comply.js';
import { listAccountChangesTool, listAccountsTool, syncGovernanceTool } from './account-tools.js';
import { reportUsageTool } from './report-usage-tool.js';
import { validateInputTool } from './validate-input-tool.js';
import { buildCreativeTool, previewCreativeTool } from './creative-tools.js';
import { customToolFor } from './custom-tool-helper.js';
import { handleSyncCatalogs } from '../catalog-event-handlers.js';
import { supportsAccountChangeFeed, type TrainingContext } from '../types.js';
import { syncAgentNotificationConfigsLegacy } from '../agent-notification-configs.js';

const TENANT_ID = 'sales';

// sync_governance rides opts.customTools (same merge seam as /signals) until
// the SDK promotes it to a first-class AccountStore method. Every media_buy_seller
// specialism (sales-guaranteed, sales-non-guaranteed, sales-broadcast-tv,
// sales-catalog-driven, sales-social, governance-aware-seller) registers a
// governance agent on the account before spend moves, then consults it via
// check_governance during the media buy lifecycle.
const ACCOUNT_REF = z.object({
  account_id: z.string().optional(),
  brand: z.object({ domain: z.string().optional() }).passthrough().optional(),
  operator: z.string().optional(),
}).passthrough();

const GET_REPORTING_STATUS_SCHEMA = {
  account: ACCOUNT_REF,
  view: z.enum(['summary', 'periods', 'revision']),
  adcp_version: z.string().optional(),
  adcp_major_version: z.number().int().optional(),
  media_buy_ids: z.array(z.string().min(1)).min(1).max(100).optional(),
  delivery_config_ids: z.array(z.string().min(1)).min(1).max(16).optional(),
  feed_purposes: z.array(z.string()).min(1).optional(),
  period: z.object({ start: z.string(), end: z.string() }).optional(),
  health: z.array(z.string()).min(1).optional(),
  finality: z.array(z.string()).min(1).optional(),
  reporting_revision_id: z.string().min(1).max(255).optional(),
  pagination: z.any().optional(),
  context: z.any().optional(),
  ext: z.any().optional(),
};
// `tools/list` cannot see an individual request's negotiated wire version.
// The deployed RC0 list therefore exposes only its frozen input. Test-only
// direct construction can exercise the pending RC1 delta selector.
const RELIABLE_GET_REPORTING_STATUS_SCHEMA = {
  ...GET_REPORTING_STATUS_SCHEMA,
  changes_after: z.string().min(1).max(2048).optional(),
};

// These primitives deliberately mirror the source schemas rather than the
// looser legacy SDK Zod shapes: the direct/test-only MCP projection must not
// accept a receipt the pending RC1 source contract rejects.
const RECEIPT_ID = z.string().min(16).max(255).regex(/^[A-Za-z0-9_.:-]{16,255}$/);
const REFERENCE_ID = z.string().min(1).max(255).regex(/^[A-Za-z0-9_.:-]{1,255}$/);
const CONTROL_TOTAL_NAME = z.string().min(1).max(128).regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/);
const CONTROL_TOTAL_UNIT = z.string().min(1).max(32);
const INTEGER_CONTROL_VALUE = z.string().regex(/^-?(?:0|[1-9][0-9]*)$/);
const DECIMAL_CONTROL_VALUE = z.string().regex(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/);
const CONTROL_TOTAL = z.union([
  z.object({ name: CONTROL_TOTAL_NAME, value: INTEGER_CONTROL_VALUE, value_type: z.literal('integer'), unit: CONTROL_TOTAL_UNIT.optional() }).strict(),
  z.object({ name: CONTROL_TOTAL_NAME, value: DECIMAL_CONTROL_VALUE, value_type: z.literal('decimal'), unit: CONTROL_TOTAL_UNIT.optional() }).strict(),
]);
const UNIQUE_CONTROL_TOTALS = z.array(CONTROL_TOTAL).refine(
  values => new Set(values.map(value => JSON.stringify(value))).size === values.length,
  'observed_control_totals must be unique',
);
const REJECTION_CODES = z.array(z.string().min(1).max(128).regex(/^[A-Z][A-Z0-9_]*$/)).min(1)
  .refine(values => new Set(values).size === values.length, 'rejection_codes must be unique');
const SHA256 = z.string().regex(/^[A-Fa-f0-9]{64}$/);
const CANONICALIZATION_URI = z.string().url().regex(
  /^https:\/\/(?![^/]*@)(?!localhost(?:[:/]|$))(?!\[)(?!\d+(?:\.\d+){3}(?::|\/|$))(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?::\d+)?(?:\/|$)/,
);
const REPORTING_RECEIPT = z.object({
  reporting_receipt_id: RECEIPT_ID, reporting_obligation_id: REFERENCE_ID,
  reporting_revision_id: REFERENCE_ID, reporting_materialization_id: REFERENCE_ID,
  status: z.enum(['accepted', 'rejected']), verification_profile: z.enum(['canonical_digest', 'manifest_checksums', 'native_commit']),
  observed_row_count: z.number().int().min(0), observed_control_totals: UNIQUE_CONTROL_TOTALS, observed_at: z.string().datetime({ offset: true }),
  consumer_commit_ref: z.string().min(1).max(512).optional(), supersedes_reporting_receipt_id: RECEIPT_ID.optional(), rejection_codes: REJECTION_CODES.optional(),
  observed_canonical_content_digest: z.object({ algorithm: z.literal('sha256'), value: SHA256, canonicalization_id: z.string().min(1).max(128), canonicalization_uri: CANONICALIZATION_URI, canonicalization_sha256: SHA256 }).strict().optional(),
  observed_manifest_sha256: SHA256.optional(), observed_native_version_ref: z.string().min(1).max(512).optional(),
}).strict();
const ADJUSTMENT_RECEIPT = z.object({
  reporting_receipt_id: RECEIPT_ID, reporting_adjustment_id: REFERENCE_ID,
  adjusts_reporting_revision_id: REFERENCE_ID, status: z.enum(['accepted', 'rejected']),
  observed_adjustment_sha256: SHA256, observed_at: z.string().datetime({ offset: true }),
  supersedes_reporting_receipt_id: RECEIPT_ID.optional(), rejection_codes: REJECTION_CODES.optional(),
}).strict();
export const SYNC_REPORTING_RECEIPTS_SCHEMA = z.object({
  account: ACCOUNT_REF, idempotency_key: z.string().min(16).max(255), adcp_version: z.string().optional(), adcp_major_version: z.number().int().optional(),
  receipts: z.array(REPORTING_RECEIPT).min(1).max(100).optional(), adjustment_receipts: z.array(ADJUSTMENT_RECEIPT).min(1).max(100).optional(),
  context: z.any().optional(), ext: z.any().optional(),
}).superRefine((value, context) => {
  if ((value.receipts?.length ?? 0) + (value.adjustment_receipts?.length ?? 0) === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'At least one receipt is required.' });
  }
  if ((value.receipts?.length ?? 0) + (value.adjustment_receipts?.length ?? 0) > 100) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'receipts and adjustment_receipts combined may contain at most 100 items.' });
  }
  for (const [index, receipt] of (value.receipts ?? []).entries()) if (receipt.status === 'rejected' && !receipt.rejection_codes?.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['receipts', index, 'rejection_codes'], message: 'rejected receipts require rejection_codes.' });
  }
  for (const [index, receipt] of (value.receipts ?? []).entries()) {
    if (receipt.status !== 'accepted') continue;
    if (receipt.verification_profile === 'canonical_digest' && !receipt.observed_canonical_content_digest) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['receipts', index, 'observed_canonical_content_digest'], message: 'accepted canonical_digest receipts require observed_canonical_content_digest.' });
    }
    if (receipt.verification_profile === 'manifest_checksums' && !receipt.observed_manifest_sha256) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['receipts', index, 'observed_manifest_sha256'], message: 'accepted manifest_checksums receipts require observed_manifest_sha256.' });
    }
    if (receipt.verification_profile === 'native_commit' && !receipt.observed_native_version_ref) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['receipts', index, 'observed_native_version_ref'], message: 'accepted native_commit receipts require observed_native_version_ref.' });
    }
  }
  for (const [index, receipt] of (value.adjustment_receipts ?? []).entries()) if (receipt.status === 'rejected' && !receipt.rejection_codes?.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['adjustment_receipts', index, 'rejection_codes'], message: 'rejected adjustment receipts require rejection_codes.' });
  }
  for (const [index, receipt] of (value.adjustment_receipts ?? []).entries()) if (receipt.status === 'accepted' && receipt.rejection_codes !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['adjustment_receipts', index, 'rejection_codes'], message: 'accepted adjustment receipts must not carry rejection_codes.' });
  }
});

const SYNC_CATALOGS_SCHEMA = {
  idempotency_key: z.string().min(16).max(255),
  account: ACCOUNT_REF,
  catalogs: z.array(z.object({
    catalog_id: z.string(),
    type: z.string().optional(),
    name: z.string().optional(),
    url: z.string().optional(),
    feed_format: z.string().optional(),
    update_frequency: z.string().optional(),
    items: z.array(z.object({}).passthrough()).optional(),
  }).passthrough()).optional(),
  catalog_ids: z.array(z.string()).optional(),
  delete_missing: z.boolean().optional(),
  dry_run: z.boolean().optional(),
  context: z.any().optional(),
  ext: z.any().optional(),
};

export function buildSalesTenantConfig(
  host: string,
  options: {
    storyboardCompat?: TrainingContext['storyboardCompat'];
    proposalNegotiationProfile?: TrainingContext['proposalNegotiationProfile'];
  } = {},
  taskRegistry?: TaskRegistry,
): {
  tenantId: string;
  config: TenantConfig;
} {
  // MCP tools/list has no negotiated-version input. Until the RC.1 SDK is
  // published, mounting these source-schema tools in a deployed RC.0 process
  // would advertise an unreachable wire surface. Direct/unit construction is
  // deliberately enabled only by the test runtime.
  const enableReliableReportingTools = process.env.NODE_ENV === 'test';
  const material = getTenantSigningMaterial(TENANT_ID);
  const platform = new TrainingSalesPlatform(
    options.storyboardCompat,
    options.proposalNegotiationProfile ?? 'ask-only',
    taskRegistry,
  );
  return {
    tenantId: TENANT_ID,
    config: {
      agentUrl: `${host}/${TENANT_ID}`,
      signingKey: material.signingKey,
      label: 'Training agent — sales',
      platform,
      serverOptions: {
        observability: {
          onWebhookEmit(info) {
            // The SDK also fires this hook when delivery throws before its
            // durable checkpoint. Only a confirmed delivery may retire the
            // seller outbox; every failure remains eligible for recovery.
            if (info.tool === 'control_media_buy' && info.success) {
              return platform.acknowledgeSellerManagedWebhook(info.taskId);
            }
          },
        },
        // The public training sandbox intentionally exposes both current
        // compact tools and registered compatibility aliases.
        mcpToolProfile: 'all',
        // These operations intentionally remain the legacy wire facade for
        // AdCP 3.0 callers. Current application paths use canonical format
        // identity; the raw seam preserves exact legacy tuples at the wire and
        // persistence boundary without leaking legacy identity into current paths.
        legacyHandlers: {
          mediaBuy: {
            getProducts: legacyGetProductsHandler(options.storyboardCompat, taskRegistry),
            listCreatives: legacyListCreativesHandler(options.storyboardCompat),
            syncCreatives: legacySyncCreativesHandler(options.storyboardCompat),
          },
        },
        customTools: {
          list_accounts: listAccountsTool(options.storyboardCompat),
          report_usage: reportUsageTool({ creativeBillsThroughAdcp: false }),
          ...(options.storyboardCompat?.version !== '3.0' && {
            get_reporting_status: customToolFor(
              'get_reporting_status',
              'Check reporting health, enumerate expected periods and all retained revisions, or resolve one exact reporting revision.',
              enableReliableReportingTools ? RELIABLE_GET_REPORTING_STATUS_SCHEMA : GET_REPORTING_STATUS_SCHEMA,
              reportingStatusForCustomTool,
              // A reporting lookup can validly return the protocol's
              // `status: "failed"` payload with resource-level errors. Keep
              // that result intact instead of turning it into an MCP error
              // envelope solely because it has an `errors` array.
              {
                annotations: { readOnlyHint: true, idempotentHint: true },
                payloadErrorsAsSuccess: true,
              },
            ),
            ...(enableReliableReportingTools && {
            sync_reporting_receipts: customToolFor(
              'sync_reporting_receipts',
              "Record a consumer's independently verified reporting totals and destination evidence in the seller ledger.",
              SYNC_REPORTING_RECEIPTS_SCHEMA,
              syncReportingReceiptsForCustomTool,
              {
                annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
                enforceIdempotency: true,
              },
            ),
            }),
          }),
          sync_catalogs: customToolFor(
            'sync_catalogs',
            'Push product catalogs (feeds, items, inventory) for catalog-driven campaigns. Supports URL feeds for scheduled re-fetch and inline items for small catalogs. Returns per-item approval status. Omit catalogs to discover existing synced catalogs.',
            SYNC_CATALOGS_SCHEMA,
            handleSyncCatalogs,
            { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }, enforceIdempotency: true },
          ),
          // sync_governance is a 3.1+ account task. The released 3.0.x sales
          // scenarios predate it and gracefully skip the step when the tool is
          // absent; advertising it under 3.0-compat makes those steps execute
          // and fail the older response schema. Gate it off 3.0 like the
          // creative tools below. (/signals keeps it across versions.)
          ...(supportsAccountChangeFeed(options.storyboardCompat?.version ?? '3.2-beta.5') ? {
            list_account_changes: listAccountChangesTool(options.storyboardCompat),
            sync_agent_notification_configs: customToolFor(
              'sync_agent_notification_configs',
              'Register, replace, pause, or clear caller-scoped agent-level capability-change webhook subscribers.',
              TOOL_INPUT_SHAPES.sync_agent_notification_configs!,
              syncAgentNotificationConfigsLegacy,
              {
                annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
                enforceIdempotency: true,
                payloadErrorsAsSuccess: true,
              },
            ),
            sync_governance: syncGovernanceTool(options.storyboardCompat),
            build_creative: buildCreativeTool({
              tenantId: TENANT_ID,
              creativeBillsThroughAdcp: false,
              ...(options.storyboardCompat && { storyboardCompat: options.storyboardCompat }),
            }),
            preview_creative: previewCreativeTool({
              tenantId: TENANT_ID,
              creativeBillsThroughAdcp: false,
              ...(options.storyboardCompat && { storyboardCompat: options.storyboardCompat }),
            }),
            validate_input: validateInputTool({
              tenantId: TENANT_ID,
              creativeBillsThroughAdcp: false,
              ...(options.storyboardCompat && { storyboardCompat: options.storyboardCompat }),
            }),
          } : {}),
        },
        complyTest: buildSalesComplyConfig(options.storyboardCompat, taskRegistry),
      },
    },
  };
}
