/**
 * /si tenant — Sponsored Intelligence (SI Chat Protocol).
 *
 * Exposes the four SI lifecycle tasks through the SDK's first-class
 * SponsoredIntelligencePlatform surface.
 *
 * sync_catalogs follows the canonical media-buy/sync-catalogs-request.json shape:
 *   required: idempotency_key, account — enforceIdempotency: true (mutating).
 *   optional: catalogs[] (omit = discovery-only call).
 *
 * The SDK owns canonical SI schemas and idempotency enforcement for
 * si_initiate_session and si_send_message.
 */

import { z } from 'zod';
import type { TenantConfig } from '@adcp/sdk/server';
import { TrainingSiPlatform } from '../v6-si-platform.js';
import { getTenantSigningMaterial } from './signing.js';
import { customToolFor } from './custom-tool-helper.js';
import { listAccountsTool } from './account-tools.js';
import {
  handleSyncCatalogs,
} from '../si-handlers.js';
import type { TrainingContext } from '../types.js';

const TENANT_ID = 'si';

const CONTEXT_REF = z.any().optional();
const EXT_REF = z.any().optional();

// sync_catalogs — canonical media-buy/sync-catalogs-request.json shape.
// Required: idempotency_key, account. Optional: catalogs[] (omit = discovery).
const SYNC_CATALOGS_SCHEMA = {
  idempotency_key: z.string().min(16).max(255),
  account: z.object({
    account_id: z.string().optional(),
    brand: z.object({ domain: z.string().optional() }).passthrough().optional(),
    operator: z.string().optional(),
  }).passthrough(),
  catalogs: z.array(z.object({
    catalog_id: z.string(),
    name: z.string().optional(),
    type: z.string().optional(),
    url: z.string().optional(),
    feed_format: z.string().optional(),
    update_frequency: z.string().optional(),
    items: z.array(z.object({}).passthrough()).optional(),
  }).passthrough()).optional(),
  catalog_ids: z.array(z.string()).optional(),
  delete_missing: z.boolean().optional(),
  dry_run: z.boolean().optional(),
  context: CONTEXT_REF,
  ext: EXT_REF,
};

export function buildSiTenantConfig(
  host: string,
  options: { storyboardCompat?: TrainingContext['storyboardCompat'] } = {},
): { tenantId: string; config: TenantConfig } {
  const material = getTenantSigningMaterial(TENANT_ID);
  return {
    tenantId: TENANT_ID,
    config: {
      agentUrl: `${host}/${TENANT_ID}`,
      signingKey: material.signingKey,
      label: 'Training agent — sponsored intelligence',
      platform: new TrainingSiPlatform(options.storyboardCompat),
      serverOptions: {
        customTools: {
          list_accounts: listAccountsTool(options.storyboardCompat),

          sync_catalogs: customToolFor(
            'sync_catalogs',
            'Sync a product catalog to the Sponsored Intelligence platform. Enables brand agents to serve context-aware product recommendations during SI Chat Protocol sessions. Call this before creating SI media buys to ensure catalog richness for creative generation.',
            SYNC_CATALOGS_SCHEMA,
            handleSyncCatalogs,
            {
              annotations: { readOnlyHint: false, idempotentHint: false },
              enforceIdempotency: true,
            },
          ),
        },
      },
    },
  };
}
