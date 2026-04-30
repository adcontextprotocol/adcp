/**
 * /creative tenant — creative-ad-server specialism.
 */

import type { TenantConfig } from '@adcp/sdk/server';
import { TrainingCreativePlatform } from '../v6-creative-platform.js';
import { getTenantSigningMaterial } from './signing.js';
import { buildCreativeComplyConfig } from './comply.js';

const TENANT_ID = 'creative';

export function buildCreativeTenantConfig(host: string): {
  tenantId: string;
  config: TenantConfig;
} {
  const material = getTenantSigningMaterial(TENANT_ID);
  return {
    tenantId: TENANT_ID,
    config: {
      agentUrl: `${host}/${TENANT_ID}`,
      signingKey: material.signingKey,
      label: 'Training agent — creative',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      platform: new TrainingCreativePlatform() as any,
      serverOptions: {
        complyTest: buildCreativeComplyConfig(),
      },
    },
  };
}
