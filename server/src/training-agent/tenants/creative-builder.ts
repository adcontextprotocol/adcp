/**
 * /creative-builder tenant — creative-template + creative-generative.
 *
 * Per F13's CreativeBuilderPlatform unification. Distinct from the
 * `/creative` tenant which serves the creative-ad-server archetype.
 */

import type { TenantConfig } from '@adcp/sdk/server';
import { TrainingCreativeBuilderPlatform } from '../v6-creative-builder-platform.js';
import { getTenantSigningMaterial } from './signing.js';
import { buildCreativeComplyConfig } from './comply.js';

const TENANT_ID = 'creative-builder';

export function buildCreativeBuilderTenantConfig(host: string): {
  tenantId: string;
  config: TenantConfig;
} {
  const material = getTenantSigningMaterial(TENANT_ID);
  return {
    tenantId: TENANT_ID,
    config: {
      agentUrl: `${host}/${TENANT_ID}`,
      signingKey: material.signingKey,
      label: 'Training agent — creative builder',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      platform: new TrainingCreativeBuilderPlatform() as any,
      serverOptions: {
        complyTest: buildCreativeComplyConfig(),
      },
    },
  };
}
