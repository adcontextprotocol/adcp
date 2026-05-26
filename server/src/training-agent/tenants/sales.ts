/**
 * /sales tenant — sales-non-guaranteed + sales-guaranteed specialisms.
 *
 * Distinct platform from /signals (single-specialism per tenant). Buyers
 * call sales-track tools at this URL; signals tools live on /signals.
 */

import type { TenantConfig } from '@adcp/sdk/server';
import { TrainingSalesPlatform } from '../v6-sales-platform.js';
import { getTenantSigningMaterial } from './signing.js';
import { buildSalesComplyConfig } from './comply.js';
import { listAccountsTool } from './account-tools.js';
import type { TrainingContext } from '../types.js';

const TENANT_ID = 'sales';

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
        },
        complyTest: buildSalesComplyConfig(),
      },
    },
  };
}
