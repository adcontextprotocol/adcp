/**
 * Inventory tenants (#9025 part B; the inventory role of #8993): simulated
 * systems that forecast, book and deliver over simulated time, driven by the
 * deterministic engine in `../inventory-sim/engine/` and the caller's sandbox
 * clock.
 *
 * - `/inventory-adserver` — display, video and a homepage takeover, sold
 *   guaranteed and in a first-price auction.
 *
 * They speak the media-buy protocol as it is; no new tasks. They are not in
 * the host's brand.json or adagents.json tenant listings.
 */

import type { TenantConfig } from '@adcp/sdk/server';
import { ADSERVER_SEASON } from '../inventory-sim/engine/index.js';
import { InventoryPlatform, type InventoryTenantProfile } from '../inventory-sim/platform.js';
import { getTenantSigningMaterial } from './signing.js';
import { listAccountsTool } from './account-tools.js';
import type { TrainingContext } from '../types.js';

export const INVENTORY_ADSERVER_TENANT_ID = 'inventory-adserver';

export const INVENTORY_TENANT_PROFILES: Readonly<Record<string, InventoryTenantProfile>> = {
  [INVENTORY_ADSERVER_TENANT_ID]: { tenantId: INVENTORY_ADSERVER_TENANT_ID, seed: ADSERVER_SEASON },
};

export const INVENTORY_TENANT_IDS: readonly string[] = Object.keys(INVENTORY_TENANT_PROFILES);

const LABELS: Readonly<Record<string, string>> = {
  [INVENTORY_ADSERVER_TENANT_ID]: 'Training agent — inventory: ad server',
};

export function isInventoryTenant(tenantId: string): boolean {
  return INVENTORY_TENANT_IDS.includes(tenantId);
}

export function buildInventoryTenantConfig(
  tenantId: string,
  host: string,
  options: { storyboardCompat?: TrainingContext['storyboardCompat'] } = {},
): { tenantId: string; config: TenantConfig } {
  const profile = INVENTORY_TENANT_PROFILES[tenantId];
  if (!profile) throw new Error(`Unknown inventory tenant ${tenantId}`);
  const material = getTenantSigningMaterial(tenantId);
  return {
    tenantId,
    config: {
      agentUrl: `${host}/${tenantId}`,
      signingKey: material.signingKey,
      label: LABELS[tenantId] ?? tenantId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      platform: new InventoryPlatform(profile) as any,
      serverOptions: {
        customTools: {
          list_accounts: listAccountsTool(options.storyboardCompat),
        },
      },
    },
  };
}
