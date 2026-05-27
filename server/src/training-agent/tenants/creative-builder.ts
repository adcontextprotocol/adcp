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
import { listAccountsTool } from './account-tools.js';
import { validateInputTool } from './validate-input-tool.js';
import type { TrainingContext } from '../types.js';

const TENANT_ID = 'creative-builder';

export function buildCreativeBuilderTenantConfig(host: string, options: { storyboardCompat?: TrainingContext['storyboardCompat'] } = {}): {
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
      platform: new TrainingCreativeBuilderPlatform(options.storyboardCompat) as any,
      serverOptions: {
        customTools: {
          list_accounts: listAccountsTool(options.storyboardCompat),
          ...(options.storyboardCompat?.version === '3.0' ? {} : {
            validate_input: validateInputTool({
              tenantId: TENANT_ID,
              creativeBillsThroughAdcp: false,
              ...(options.storyboardCompat && { storyboardCompat: options.storyboardCompat }),
            }),
          }),
        },
        complyTest: buildCreativeComplyConfig(),
      },
    },
  };
}
