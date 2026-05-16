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

const TENANT_ID = 'sales';

export function buildSalesTenantConfig(host: string): {
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
      platform: new TrainingSalesPlatform() as any,
      serverOptions: {
        complyTest: buildSalesComplyConfig(),
      },
    },
  };
}
