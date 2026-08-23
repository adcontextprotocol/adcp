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
 * The tool stores governance agent URLs per-account; activate_signal requires
 * a check_governance approval context when the activation account has one of
 * those registered governance agents.
 */

import type { TenantConfig } from '@adcp/sdk/server';
import { TrainingPlatform } from '../v6-platform.js';
import { getTenantSigningMaterial } from './signing.js';
import { listAccountsTool, syncGovernanceTool } from './account-tools.js';
import type { TrainingContext } from '../types.js';

const TENANT_ID = 'signals';

export function buildSignalsTenantConfig(host: string, options: { storyboardCompat?: TrainingContext['storyboardCompat'] } = {}): {
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
      platform: new TrainingPlatform(options.storyboardCompat) as any,
      serverOptions: {
        customTools: {
          list_accounts: listAccountsTool(options.storyboardCompat),
          sync_governance: syncGovernanceTool(options.storyboardCompat),
        },
      },
    },
  };
}
