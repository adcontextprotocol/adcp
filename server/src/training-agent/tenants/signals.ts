/**
 * /signals tenant — signal-marketplace + signal-owned specialisms.
 *
 * Reuses our existing v6 `TrainingPlatform` which already claims
 * `signal-marketplace` + `signal-owned` and implements `SignalsPlatform`.
 * For the tenant model, the platform stays focused on signals — the rest
 * of the v5 surface (sales, governance, etc.) lives in other tenants.
 *
 * sync_governance rides opts.customTools (same merge seam as creative_approval
 * on /brand) until the SDK promotes it to a first-class AccountStore method.
 * The tool stores governance agent URLs per-account; activate_signal consults
 * the shared session-level governance plans (keyed by brand.domain, shared
 * with /governance) to enforce the denial check.
 */

import { z } from 'zod';
import type { TenantConfig } from '@adcp/sdk/server';
import { TrainingPlatform } from '../v6-platform.js';
import { getTenantSigningMaterial } from './signing.js';
import { customToolFor } from './custom-tool-helper.js';
import { handleSyncGovernance } from '../account-handlers.js';

const TENANT_ID = 'signals';

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
    })).min(1).max(1),
  })),
  idempotency_key: z.string().optional(),
  context: z.any().optional(),
};

export function buildSignalsTenantConfig(host: string): {
  tenantId: string;
  config: TenantConfig;
} {
  const material = getTenantSigningMaterial(TENANT_ID);
  return {
    tenantId: TENANT_ID,
    config: {
      agentUrl: `${host}/${TENANT_ID}`,
      signingKey: material.signingKey,
      label: 'Training agent — signals',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      platform: new TrainingPlatform() as any,
      serverOptions: {
        customTools: {
          sync_governance: customToolFor(
            'sync_governance',
            'Register governance agent endpoints on accounts. The seller calls these agents via check_governance during signal activation. Uses replace semantics: each call replaces previously synced agents on the specified accounts.',
            SYNC_GOVERNANCE_SCHEMA,
            handleSyncGovernance,
          ),
        },
      },
    },
  };
}
