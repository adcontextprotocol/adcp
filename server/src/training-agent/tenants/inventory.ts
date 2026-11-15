/**
 * Inventory tenants (#9025 part B; the inventory role of #8993): simulated
 * systems that forecast, book and deliver over simulated time, driven by the
 * deterministic engine in `../inventory-sim/engine/` and the caller's sandbox
 * clock.
 *
 * - `/inventory-adserver` — display, video and a homepage takeover, sold
 *   guaranteed and in a first-price auction.
 *
 * Their `comply_test_controller` serves `sandbox_clock` (get and advance the
 * caller's sandbox clock; the router intercepts it, as the SDK's controller
 * config has no slot for it) and `reset_state` (unpin the clock and discard
 * the caller's market on the tenant).
 *
 * They speak the media-buy protocol as it is; no new tasks. They are not in
 * the host's brand.json or adagents.json tenant listings.
 */

import type { TenantConfig } from '@adcp/sdk/server';
import { ADSERVER_SEASON } from '../inventory-sim/engine/index.js';
import { InventoryPlatform, type InventoryTenantProfile } from '../inventory-sim/platform.js';
import { resetMarket } from '../inventory-sim/market-store.js';
import { SANDBOX_CLOCK_SCENARIO, handleSandboxClock } from '../inventory-sim/sandbox-clock.js';
import { resetReportingSubscriptionProbe } from '../subscription-probe.js';
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

/** Controller scenarios an inventory tenant lists. */
export const INVENTORY_COMPLY_SCENARIOS: readonly string[] = ['reset_state', SANDBOX_CLOCK_SCENARIO];

/** `sandbox_clock` for a caller: moving the clock catches up every
 * inventory market the caller has. */
export function handleInventorySandboxClock(params: Record<string, unknown>, principal: string | undefined) {
  return handleSandboxClock(
    params,
    { mode: 'open', principal: principal ?? 'anonymous' },
    Object.values(INVENTORY_TENANT_PROFILES),
  );
}

async function resetInventoryCaller(tenantId: string, principal: string | undefined): Promise<void> {
  await resetReportingSubscriptionProbe({ mode: 'open', principal: principal ?? 'anonymous' });
  await resetMarket(tenantId, principal);
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
        complyTest: {
          resetState: async ctx => {
            await resetInventoryCaller(tenantId, (ctx.authInfo as { clientId?: string } | undefined)?.clientId);
          },
        },
      },
    },
  };
}
