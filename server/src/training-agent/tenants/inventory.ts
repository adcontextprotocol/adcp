/**
 * Inventory tenants (#9025 part B; the inventory role of #8993): simulated
 * systems that forecast, book and deliver over simulated time, driven by the
 * deterministic engine in `../inventory-sim/engine/` and the caller's sandbox
 * clock.
 *
 * - `/inventory-adserver` — display, video and a homepage takeover, sold
 *   guaranteed and in a first-price auction.
 * - `/inventory-content` — a podcast, a newsletter and a creator series,
 *   sold as exclusive sponsorships of the installments scheduled in a
 *   package's flight. Installments run, are postponed or are cancelled on
 *   their dates, and each builds its audience over its channel's curve.
 *
 * Their `comply_test_controller` serves `sandbox_clock` (get and advance the
 * caller's sandbox clock; the router intercepts it, as the SDK's controller
 * config has no slot for it) and `reset_state` (unpin the clock and discard
 * the caller's markets on every inventory tenant). It also seeds accounts,
 * products and pricing options, and serves `simulate_delivery` and
 * `simulate_budget_spend` as delivery recorded in the engine.
 *
 * They speak the media-buy protocol as it is; no new tasks. They are not in
 * the host's brand.json or adagents.json tenant listings.
 */

import type { TenantConfig } from '@adcp/sdk/server';
import { ADSERVER_SEASON, CONTENT_SEASON } from '../inventory-sim/engine/index.js';
import { InventoryPlatform, type InventoryTenantProfile } from '../inventory-sim/platform.js';
import { resetMarket, withCallerMarkets } from '../inventory-sim/market-store.js';
import { SANDBOX_CLOCK_SCENARIO, handleSandboxClock } from '../inventory-sim/sandbox-clock.js';
import { resetReportingSubscriptionProbe } from '../subscription-probe.js';
import { getTenantSigningMaterial } from './signing.js';
import { listAccountsTool } from './account-tools.js';
import type { TrainingContext } from '../types.js';
import { creativeProjectionAdapters } from '../task-handlers.js';
import { SALES_COMPLY_INPUT_SCHEMA, createPrincipalScopedSeedCache, seedAccountAdapter } from './comply.js';

export const INVENTORY_ADSERVER_TENANT_ID = 'inventory-adserver';
export const INVENTORY_CONTENT_TENANT_ID = 'inventory-content';

export const INVENTORY_TENANT_PROFILES: Readonly<Record<string, InventoryTenantProfile>> = {
  [INVENTORY_ADSERVER_TENANT_ID]: { tenantId: INVENTORY_ADSERVER_TENANT_ID, seed: ADSERVER_SEASON },
  [INVENTORY_CONTENT_TENANT_ID]: { tenantId: INVENTORY_CONTENT_TENANT_ID, seed: CONTENT_SEASON },
};

export const INVENTORY_TENANT_IDS: readonly string[] = Object.keys(INVENTORY_TENANT_PROFILES);

const LABELS: Readonly<Record<string, string>> = {
  [INVENTORY_ADSERVER_TENANT_ID]: 'Training agent — inventory: ad server',
  [INVENTORY_CONTENT_TENANT_ID]: 'Training agent — inventory: content',
};

export function isInventoryTenant(tenantId: string): boolean {
  return INVENTORY_TENANT_IDS.includes(tenantId);
}

/** Controller scenarios an inventory tenant lists. */
export const INVENTORY_COMPLY_SCENARIOS: readonly string[] = [
  'reset_state', SANDBOX_CLOCK_SCENARIO, 'seed_account', 'seed_product', 'seed_pricing_option',
  'simulate_delivery', 'simulate_budget_spend',
];

/** `sandbox_clock` for a caller, called on one inventory tenant. Moving the
 * clock runs the market's days, so it is one of the caller's market requests. */
export function handleInventorySandboxClock(tenantId: string, params: Record<string, unknown>, principal: string | undefined) {
  return withCallerMarkets(principal, () => handleSandboxClock(
    params,
    { mode: 'open', principal: principal ?? 'anonymous' },
    INVENTORY_TENANT_PROFILES[tenantId],
  ));
}

/** `reset_state`: unpin the caller's clock, which every tenant shares, and
 * discard the caller's market on every inventory tenant with it. */
async function resetInventoryCaller(principal: string | undefined): Promise<void> {
  await withCallerMarkets(principal, async () => {
    await resetReportingSubscriptionProbe({ mode: 'open', principal: principal ?? 'anonymous' });
    for (const id of INVENTORY_TENANT_IDS) await resetMarket(id, principal);
  });
}

function callerOf(ctx: { authInfo?: unknown }): string | undefined {
  return (ctx.authInfo as { clientId?: string } | undefined)?.clientId;
}

export function buildInventoryTenantConfig(
  tenantId: string,
  host: string,
  options: { storyboardCompat?: TrainingContext['storyboardCompat'] } = {},
): { tenantId: string; config: TenantConfig } {
  const profile = INVENTORY_TENANT_PROFILES[tenantId];
  if (!profile) throw new Error(`Unknown inventory tenant ${tenantId}`);
  const material = getTenantSigningMaterial(tenantId);
  const platform = new InventoryPlatform(profile);
  // Project the seed's own formats too, so canonical creatives in them
  // (inline on create_media_buy) map to the formats this tenant serves.
  const projection = creativeProjectionAdapters(platform.formatDeclarations());
  return {
    tenantId,
    config: {
      agentUrl: `${host}/${tenantId}`,
      signingKey: material.signingKey,
      label: LABELS[tenantId] ?? tenantId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      platform: platform as any,
      serverOptions: {
        legacyCreativeFormatConverter: projection.legacyFormatConverter,
        canonicalFormatLegacyResolver: projection.canonicalFormatLegacyResolver,
        legacyHandlers: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          mediaBuy: platform.creativeHandlers(options.storyboardCompat) as any,
        },
        customTools: {
          list_accounts: listAccountsTool(options.storyboardCompat),
        },
        complyTest: {
          // The sales schema keeps the router-stamped caller field, so
          // seed_account provisions for the bearer's principal, not anonymous.
          inputSchema: SALES_COMPLY_INPUT_SCHEMA,
          seedCache: createPrincipalScopedSeedCache(),
          // Seeds a storyboard's fixtures. Accounts go to the shared account
          // store; products and pricing options to the caller's market here,
          // which reset_state discards.
          seed: {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            account: seedAccountAdapter(options.storyboardCompat) as any,
            product: async (params, ctx) => {
              await platform.seedProduct(callerOf(ctx), params.product_id, params.fixture ?? {});
            },
            pricing_option: async (params, ctx) => {
              await platform.seedPricingOption(callerOf(ctx), params.product_id, params.pricing_option_id, params.fixture ?? {});
            },
          },
          // Simulated delivery and spend land in the caller's market as
          // engine delivery, which reset_state discards with the market.
          simulate: {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            delivery: (params, ctx) => platform.simulateDelivery(callerOf(ctx), params) as any,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            budget_spend: (params, ctx) => platform.simulateBudgetSpend(callerOf(ctx), params) as any,
          },
          resetState: async ctx => {
            await resetInventoryCaller(callerOf(ctx));
          },
        },
      },
    },
  };
}
