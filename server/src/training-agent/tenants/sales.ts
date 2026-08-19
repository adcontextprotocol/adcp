/**
 * /sales tenant — sales-non-guaranteed + sales-guaranteed specialisms.
 *
 * Distinct platform from /signals (single-specialism per tenant). Buyers
 * call sales-track tools at this URL; signals tools live on /signals.
 */

import { z } from 'zod';
import type { TaskRegistry, TenantConfig } from '@adcp/sdk/server';
import {
  TrainingSalesPlatform,
  legacyGetProductsHandler,
  legacyListCreativesHandler,
  legacySyncCreativesHandler,
} from '../v6-sales-platform.js';
import { getTenantSigningMaterial } from './signing.js';
import { buildSalesComplyConfig } from './comply.js';
import { listAccountsTool, syncGovernanceTool } from './account-tools.js';
import { reportUsageTool } from './report-usage-tool.js';
import { validateInputTool } from './validate-input-tool.js';
import { buildCreativeTool, previewCreativeTool } from './creative-tools.js';
import { customToolFor } from './custom-tool-helper.js';
import { handleSyncCatalogs } from '../catalog-event-handlers.js';
import type { TrainingContext } from '../types.js';

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
  const material = getTenantSigningMaterial(TENANT_ID);
  return {
    tenantId: TENANT_ID,
    config: {
      agentUrl: `${host}/${TENANT_ID}`,
      signingKey: material.signingKey,
      label: 'Training agent — sales',
      platform: new TrainingSalesPlatform(
        options.storyboardCompat,
        options.proposalNegotiationProfile ?? 'ask-only',
      ),
      serverOptions: {
        // These operations intentionally remain the legacy wire facade for
        // AdCP 3.0 callers. Current application paths use canonical format
        // identity; the raw seam preserves exact legacy tuples at the wire and
        // persistence boundary without leaking legacy identity into current paths.
        legacyHandlers: {
          mediaBuy: {
            getProducts: legacyGetProductsHandler(options.storyboardCompat),
            listCreatives: legacyListCreativesHandler(options.storyboardCompat),
            syncCreatives: legacySyncCreativesHandler(options.storyboardCompat),
          },
        },
        customTools: {
          list_accounts: listAccountsTool(options.storyboardCompat),
          report_usage: reportUsageTool({ creativeBillsThroughAdcp: false }),
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
          ...(options.storyboardCompat?.version === '3.0' ? {} : {
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
          }),
        },
        complyTest: buildSalesComplyConfig(options.storyboardCompat, taskRegistry),
      },
    },
  };
}
