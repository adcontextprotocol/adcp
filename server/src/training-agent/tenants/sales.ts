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
import { customToolFor } from './custom-tool-helper.js';
import { handleGetAdcpCapabilities } from '../task-handlers.js';

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
        customTools: {
          get_adcp_capabilities: customToolFor(
            'get_adcp_capabilities',
            'Return capabilities and supported features of this AdCP agent, including supported protocol versions, specialisms, and task list.',
            {},
            handleGetAdcpCapabilities,
          ),
        },
      },
    },
  };
}
