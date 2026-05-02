/**
 * /signals tenant — signal-marketplace + signal-owned specialisms.
 *
 * Reuses our existing v6 `TrainingPlatform` which already claims
 * `signal-marketplace` + `signal-owned` and implements `SignalsPlatform`.
 * For the tenant model, the platform stays focused on signals — the rest
 * of the v5 surface (sales, governance, etc.) lives in other tenants.
 */

import type { TenantConfig } from '@adcp/sdk/server';
import { TrainingPlatform } from '../v6-platform.js';
import { getTenantSigningMaterial } from './signing.js';

const TENANT_ID = 'signals';

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
    },
  };
}
