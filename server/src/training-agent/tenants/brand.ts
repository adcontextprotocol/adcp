/**
 * /brand tenant — brand-rights specialism.
 *
 * Native: getBrandIdentity, getRights, acquireRights (3 methods on
 * BrandRightsPlatform). Merge seam: update_rights + creative_approval —
 * spec-published but not yet in `AdcpToolMap`, so they ride
 * `opts.customTools` until the spec adds them.
 */

import { z } from 'zod';
import type { TenantConfig } from '@adcp/sdk/server';
import { TrainingBrandPlatform } from '../v6-brand-platform.js';
import { getTenantSigningMaterial } from './signing.js';
import { customToolFor } from './custom-tool-helper.js';
import { handleUpdateRights, handleCreativeApproval } from '../brand-handlers.js';

const TENANT_ID = 'brand';

const ACCOUNT_REF = z.object({
  publisher_id: z.string().optional(),
  buyer_id: z.string().optional(),
  sandbox: z.boolean().optional(),
}).passthrough().optional();

const BRAND_REF = z.object({
  domain: z.string().optional(),
}).passthrough().optional();

const CONTEXT_REF = z.any().optional();

const UPDATE_RIGHTS_SCHEMA = {
  rights_id: z.string(),
  end_date: z.string().optional(),
  impression_cap: z.number().optional(),
  paused: z.boolean().optional(),
  account: ACCOUNT_REF,
  brand: BRAND_REF,
  context: CONTEXT_REF,
};

const CREATIVE_APPROVAL_SCHEMA = {
  rights_id: z.string().optional(),
  rights_grant_id: z.string().optional(),
  creative_url: z.string().optional(),
  creative_id: z.string().optional(),
  creative_format: z.string().optional(),
  creative: z.object({
    creative_id: z.string().optional(),
    format: z.string().optional(),
    assets: z.array(z.any()).optional(),
  }).passthrough().optional(),
  account: ACCOUNT_REF,
  brand: BRAND_REF,
  context: CONTEXT_REF,
};

export function buildBrandTenantConfig(host: string): {
  tenantId: string;
  config: TenantConfig;
} {
  const material = getTenantSigningMaterial(TENANT_ID);
  return {
    tenantId: TENANT_ID,
    config: {
      agentUrl: `${host}/${TENANT_ID}`,
      signingKey: material.signingKey,
      label: 'Training agent — brand',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      platform: new TrainingBrandPlatform() as any,
      serverOptions: {
        customTools: {
          update_rights: customToolFor(
            'update_rights',
            'Update an existing rights grant — extend dates, adjust impression caps, or pause/resume.',
            UPDATE_RIGHTS_SCHEMA,
            handleUpdateRights,
          ),
          creative_approval: customToolFor(
            'creative_approval',
            'Submit a generated creative for brand approval against rights grant terms.',
            CREATIVE_APPROVAL_SCHEMA,
            handleCreativeApproval,
          ),
        },
      },
    },
  };
}
