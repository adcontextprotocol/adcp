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
 * the caller's markets on every inventory tenant).
 *
 * They speak the media-buy protocol as it is; no new tasks. They are not in
 * the host's brand.json or adagents.json tenant listings.
 */

import type { TenantConfig } from '@adcp/sdk/server';
import { ADSERVER_SEASON, CONTENT_SEASON, type SeasonSeed } from '../inventory-sim/engine/index.js';
import { InventoryPlatform, type InventoryTenantProfile } from '../inventory-sim/platform.js';
import { readSeasonFile } from '../inventory-sim/season-file.js';
import { createLogger } from '../../logger.js';
import { resetMarket } from '../inventory-sim/market-store.js';
import { SANDBOX_CLOCK_SCENARIO, handleSandboxClock } from '../inventory-sim/sandbox-clock.js';
import { resetReportingSubscriptionProbe } from '../subscription-probe.js';
import { getTenantSigningMaterial } from './signing.js';
import { listAccountsTool } from './account-tools.js';
import type { TrainingContext } from '../types.js';
import { creativeProjectionAdapters } from '../task-handlers.js';

export const INVENTORY_ADSERVER_TENANT_ID = 'inventory-adserver';
export const INVENTORY_CONTENT_TENANT_ID = 'inventory-content';

const logger = createLogger('training-agent-inventory-tenants');

/** Env var naming the season file that replaces a tenant's shipped season. */
export const INVENTORY_SEASON_FILE_ENV: Readonly<Record<string, string>> = {
  [INVENTORY_ADSERVER_TENANT_ID]: 'TRAINING_AGENT_INVENTORY_ADSERVER_SEASON_FILE',
  [INVENTORY_CONTENT_TENANT_ID]: 'TRAINING_AGENT_INVENTORY_CONTENT_SEASON_FILE',
};

const SHIPPED_SEASONS: Readonly<Record<string, SeasonSeed>> = {
  [INVENTORY_ADSERVER_TENANT_ID]: ADSERVER_SEASON,
  [INVENTORY_CONTENT_TENANT_ID]: CONTENT_SEASON,
};

function seasonFor(tenantId: string, env: NodeJS.ProcessEnv): SeasonSeed {
  const envVar = INVENTORY_SEASON_FILE_ENV[tenantId];
  const file = env[envVar]?.trim();
  if (!file) return SHIPPED_SEASONS[tenantId];
  let seed: SeasonSeed;
  try {
    seed = readSeasonFile(file);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${envVar}=${file}: ${reason}`, { cause: error });
  }
  logger.info(`${tenantId}: season ${seed.seed_id} from ${file}`);
  return seed;
}

/** Each inventory tenant's profile: the season file its env var names, else
 * the shipped season (the same object, so hosted output is unchanged). A bad
 * file throws, naming the env var and the path. */
export function resolveInventoryTenantProfiles(env: NodeJS.ProcessEnv): Record<string, InventoryTenantProfile> {
  const profiles: Record<string, InventoryTenantProfile> = {};
  for (const tenantId of Object.keys(SHIPPED_SEASONS)) {
    profiles[tenantId] = { tenantId, seed: seasonFor(tenantId, env) };
  }
  return profiles;
}

export const INVENTORY_TENANT_PROFILES: Readonly<Record<string, InventoryTenantProfile>> =
  resolveInventoryTenantProfiles(process.env);

export const INVENTORY_TENANT_IDS: readonly string[] = Object.keys(INVENTORY_TENANT_PROFILES);

const LABELS: Readonly<Record<string, string>> = {
  [INVENTORY_ADSERVER_TENANT_ID]: 'Training agent — inventory: ad server',
  [INVENTORY_CONTENT_TENANT_ID]: 'Training agent — inventory: content',
};

export function isInventoryTenant(tenantId: string): boolean {
  return INVENTORY_TENANT_IDS.includes(tenantId);
}

/** Controller scenarios an inventory tenant lists. */
export const INVENTORY_COMPLY_SCENARIOS: readonly string[] = ['reset_state', SANDBOX_CLOCK_SCENARIO];

/** `sandbox_clock` for a caller, called on one inventory tenant. */
export function handleInventorySandboxClock(tenantId: string, params: Record<string, unknown>, principal: string | undefined) {
  return handleSandboxClock(
    params,
    { mode: 'open', principal: principal ?? 'anonymous' },
    INVENTORY_TENANT_PROFILES[tenantId],
  );
}

/** `reset_state`: unpin the caller's clock, which every tenant shares, and
 * discard the caller's market on every inventory tenant with it. */
async function resetInventoryCaller(principal: string | undefined): Promise<void> {
  await resetReportingSubscriptionProbe({ mode: 'open', principal: principal ?? 'anonymous' });
  for (const id of INVENTORY_TENANT_IDS) await resetMarket(id, principal);
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
          resetState: async ctx => {
            await resetInventoryCaller((ctx.authInfo as { clientId?: string } | undefined)?.clientId);
          },
        },
      },
    },
  };
}
