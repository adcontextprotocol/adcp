/**
 * /sales tenant — sales-non-guaranteed + sales-guaranteed specialisms.
 *
 * Distinct platform from /signals (single-specialism per tenant). Buyers
 * call sales-track tools at this URL; signals tools live on /signals.
 */

import { z } from 'zod';
import type { TenantConfig } from '@adcp/sdk/server';
import { TrainingSalesPlatform } from '../v6-sales-platform.js';
import { getTenantSigningMaterial } from './signing.js';
import { buildSalesComplyConfig } from './comply.js';
import { listAccountsTool } from './account-tools.js';
import { reportUsageTool } from './report-usage-tool.js';
import { validateInputTool } from './validate-input-tool.js';
import { buildCreativeTool, previewCreativeTool } from './creative-tools.js';
import { customToolFor } from './custom-tool-helper.js';
import { handleSyncGovernance } from '../account-handlers.js';
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

const SYNC_GOVERNANCE_SCHEMA = {
  accounts: z.array(z.object({
    account: ACCOUNT_REF,
    governance_agents: z.array(z.object({
      url: z.string(),
      authentication: z.object({
        schemes: z.array(z.string()),
        credentials: z.string(),
      }),
    })).min(1),
  })),
  idempotency_key: z.string().optional(),
  context: z.any().optional(),
};

export function buildSalesTenantConfig(host: string, options: { storyboardCompat?: TrainingContext['storyboardCompat'] } = {}): {
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      platform: new TrainingSalesPlatform(options.storyboardCompat) as any,
      serverOptions: {
        customTools: {
          list_accounts: listAccountsTool(options.storyboardCompat),
          report_usage: reportUsageTool({ creativeBillsThroughAdcp: false }),
          // sync_governance is a 3.1+ account task. The released 3.0.x sales
          // scenarios predate it and gracefully skip the step when the tool is
          // absent; advertising it under 3.0-compat makes those steps execute
          // and fail the older response schema. Gate it off 3.0 like the
          // creative tools below. (/signals keeps it across versions.)
          ...(options.storyboardCompat?.version === '3.0' ? {} : {
            sync_governance: customToolFor(
              'sync_governance',
              'Register governance agent endpoints on accounts. The seller calls these agents via check_governance during media buy lifecycle events. Uses replace semantics: each call replaces previously synced agents on the specified accounts.',
              SYNC_GOVERNANCE_SCHEMA,
              handleSyncGovernance,
            ),
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
        complyTest: buildSalesComplyConfig(),
      },
    },
  };
}
