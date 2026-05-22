/**
 * /governance tenant — campaign-governance + property-lists +
 * collection-lists + content-standards specialisms.
 *
 * Bundles the governance/buyer-side specialisms in one tenant since
 * storyboards frequently span them (e.g., property-list policy cited in
 * a check_governance finding). Splitting further is a follow-up if any
 * specific surface needs distinct credentials or independent tenant
 * lifecycle.
 */

import type { TenantConfig } from '@adcp/sdk/server';
import { TrainingGovernancePlatform } from '../v6-governance-platform.js';
import { getTenantSigningMaterial } from './signing.js';
import { buildGovernanceComplyConfig } from './comply.js';
import { customToolFor } from './custom-tool-helper.js';
import { handleGetAdcpCapabilities } from '../task-handlers.js';

const TENANT_ID = 'governance';

export function buildGovernanceTenantConfig(host: string): {
  tenantId: string;
  config: TenantConfig;
} {
  const material = getTenantSigningMaterial(TENANT_ID);
  return {
    tenantId: TENANT_ID,
    config: {
      agentUrl: `${host}/${TENANT_ID}`,
      signingKey: material.signingKey,
      label: 'Training agent — governance',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      platform: new TrainingGovernancePlatform() as any,
      serverOptions: {
        complyTest: buildGovernanceComplyConfig(),
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
