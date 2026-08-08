/**
 * /brand tenant — brand-rights specialism.
 *
 * Native: getBrandIdentity, getRights, acquireRights, updateRights (4 methods
 * on BrandRightsPlatform — `update_rights` was promoted to framework-first-class
 * registration in @adcp/sdk@6.7.0 / adcp-client#1349, so it lives on the
 * platform interface now, not in customTools).
 *
 * Merge seam: verify_brand_claim, verify_brand_claims, creative_approval —
 * spec-published but not yet in `AdcpToolMap`, so they ride `opts.customTools`
 * until the spec adds them. verify_brand_claim* return a payload-envelope JWS
 * signed under the brand response-signing key (see brand-claim-handlers.ts).
 */

import { z } from 'zod';
import type { TenantConfig } from '@adcp/sdk/server';
import { TrainingBrandPlatform } from '../v6-brand-platform.js';
import { getTenantSigningMaterial } from './signing.js';
import { customToolFor } from './custom-tool-helper.js';
import { listAccountsTool } from './account-tools.js';
import { handleCreativeApproval } from '../brand-handlers.js';
import { verifyBrandClaimHandler, verifyBrandClaimsHandler } from '../brand-claim-handlers.js';
import type { TrainingContext } from '../types.js';

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

// verify_brand_claim — one tool, four claim types discriminated by claim_type.
// The `claim` object varies by type, so it stays passthrough; the handler
// validates the per-type required fields and returns INVALID_INPUT otherwise.
const VERIFY_BRAND_CLAIM_SCHEMA = {
  claim_type: z.enum(['subsidiary', 'parent', 'property', 'trademark']),
  claim: z.object({}).passthrough(),
  authorized: z.boolean().optional(),
  account: ACCOUNT_REF,
  brand: BRAND_REF,
  context: CONTEXT_REF,
};

// verify_brand_claims — bulk variant; one round-trip over many claims.
const VERIFY_BRAND_CLAIMS_SCHEMA = {
  claims: z.array(z.object({
    claim_type: z.enum(['subsidiary', 'parent', 'property', 'trademark']),
    claim: z.object({}).passthrough(),
  })),
  authorized: z.boolean().optional(),
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

export function buildBrandTenantConfig(host: string, options: { storyboardCompat?: TrainingContext['storyboardCompat'] } = {}): {
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
      platform: new TrainingBrandPlatform(options.storyboardCompat) as any,
      serverOptions: {
        customTools: {
          list_accounts: listAccountsTool(options.storyboardCompat),
          verify_brand_claim: customToolFor(
            'verify_brand_claim',
            'Ask whether a claim about this brand\'s identity (subsidiary, parent, property, or trademark) is owned, pending, disputed, or licensed. Returns a verification_status plus a signed_response payload-envelope JWS (adcp_use: response-signing) verifiable against /.well-known/jwks.json. Rejection (not_ours / disputed) is authoritative on a single response; positive assertions require reciprocation before extending trust.',
            VERIFY_BRAND_CLAIM_SCHEMA,
            verifyBrandClaimHandler(`${host}/${TENANT_ID}/mcp`),
            { annotations: { readOnlyHint: true, idempotentHint: true } },
          ),
          verify_brand_claims: customToolFor(
            'verify_brand_claims',
            'Bulk verify_brand_claim — verify many claims in one round-trip. Returns results[] with per-claim verification_status and one signed_response over the batch.',
            VERIFY_BRAND_CLAIMS_SCHEMA,
            verifyBrandClaimsHandler(`${host}/${TENANT_ID}/mcp`),
            { annotations: { readOnlyHint: true, idempotentHint: true } },
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
