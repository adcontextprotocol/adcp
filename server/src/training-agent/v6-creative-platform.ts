/**
 * v6 CreativeAdServerPlatform for the `/creative` tenant.
 *
 * Single-specialism platform claiming `creative-ad-server`. Implements
 * 5 methods: buildCreative, previewCreative, listCreatives,
 * getCreativeDelivery, syncCreatives.
 *
 * Spike-grade port: shim through to v5 handlers via `translateV5Result`.
 */

import {
  AdcpError,
  type DecisioningPlatform,
  type CreativeAdServerPlatform,
  type SyncCreativesRow,
  type AccountStore,
} from '@adcp/sdk/server';
import {
  handleBuildCreative,
  handlePreviewCreative,
  handleListCreatives,
  handleListCreativeFormats,
  handleGetCreativeDelivery,
  handleSyncCreatives,
} from './task-handlers.js';
import { syncAccountsUpsert } from './v6-account-helpers.js';
import type { ToolArgs, TrainingContext } from './types.js';

interface TrainingCreativeMeta {
  brand_domain?: string;
  [key: string]: unknown;
}

interface TrainingCreativeConfig {
  strict: boolean;
}

function buildTrainingCtx(account: { authInfo?: { principal?: string } } | undefined): TrainingContext {
  return {
    mode: 'open',
    principal: account?.authInfo?.principal ?? 'anonymous',
  };
}

function translateV5Result<T extends object>(result: unknown): T {
  const errs = (result as {
    errors?: Array<{
      code: string;
      message: string;
      field?: string;
      details?: unknown;
      recovery?: string;
    }>;
  } | undefined)?.errors;
  if (Array.isArray(errs) && errs.length > 0) {
    const first = errs[0]!;
    const recovery = (first.recovery === 'transient' || first.recovery === 'correctable' || first.recovery === 'terminal')
      ? first.recovery
      : 'correctable';
    throw new AdcpError(first.code, {
      recovery,
      message: first.message,
      ...(first.field !== undefined && { field: first.field }),
      ...(first.details !== undefined && { details: first.details as Record<string, unknown> }),
    });
  }
  return result as T;
}

const trainingCreativeAccounts: AccountStore<TrainingCreativeMeta> = {
  resolution: 'explicit',
  resolve: async (ref, _ctx) => {
    if (ref == null) {
      return {
        id: 'public_sandbox',
        name: 'Public Sandbox',
        status: 'active',
        ctx_metadata: {},
        authInfo: { kind: 'public' },
      };
    }
    const brandDomain =
      'brand' in ref && ref.brand && typeof ref.brand === 'object' && 'domain' in ref.brand
        ? (ref.brand.domain as string | undefined)
        : undefined;
    const accountId =
      'account_id' in ref && typeof ref.account_id === 'string' ? ref.account_id : undefined;
    const id = accountId ?? `synthetic_${brandDomain ?? 'anon'}`;
    return {
      id,
      name: brandDomain ?? id,
      status: 'active',
      ...(brandDomain != null && { brand: { domain: brandDomain } }),
      ...('operator' in ref && typeof ref.operator === 'string' && { operator: ref.operator }),
      ctx_metadata: { brand_domain: brandDomain },
      authInfo: { kind: 'api_key' },
    };
  },
  upsert: syncAccountsUpsert,
};

export class TrainingCreativePlatform
  implements DecisioningPlatform<TrainingCreativeConfig, TrainingCreativeMeta>
{
  capabilities = {
    specialisms: ['creative-ad-server'] as const,
    creative_agents: [],
    channels: [] as const,
    pricingModels: ['cpm', 'cpa'] as const,
    supportedBillings: ['agent', 'operator'] as const,
    compliance_testing: {},
    config: { strict: false },
  };

  statusMappers = {};
  accounts: AccountStore<TrainingCreativeMeta> = trainingCreativeAccounts;

  creative: CreativeAdServerPlatform<TrainingCreativeMeta> = {
    buildCreative: async (req, ctx) => {
      const result = await handleBuildCreative(req as ToolArgs, buildTrainingCtx(ctx.account));
      // F16 (`bca20dfb`) — framework's discriminator passes through
      // pre-shaped BuildCreativeSuccess / BuildCreativeMultiSuccess
      // envelopes. v5 returns the envelope shape directly.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return translateV5Result(result) as any;
    },
    previewCreative: async (req, ctx) => {
      const result = await handlePreviewCreative(req as ToolArgs, buildTrainingCtx(ctx.account));
      return translateV5Result(result);
    },
    listCreatives: async (req, ctx) => {
      const result = await handleListCreatives(req as ToolArgs, buildTrainingCtx(ctx.account));
      return translateV5Result(result);
    },
    listCreativeFormats: async (req, ctx) => {
      const result = await handleListCreativeFormats(req as ToolArgs, buildTrainingCtx(ctx.account));
      return translateV5Result(result);
    },
    getCreativeDelivery: async (filter, ctx) => {
      const result = await handleGetCreativeDelivery(filter as ToolArgs, buildTrainingCtx(ctx.account));
      return translateV5Result(result);
    },
    syncCreatives: async (creatives, ctx) => {
      // Thread brand domain through so sessionKeyFromArgs in the v5
      // handler resolves to the same session the test-controller seeded
      // creative_policy against. Without this, the sync lands in
      // open:default while seeded products live on open:<brand>, and
      // aggregateCreativePolicy returns null — provenance enforcement
      // silently no-ops.
      const brandDomain = (ctx.account as { ctx_metadata?: { brand_domain?: string } } | undefined)?.ctx_metadata?.brand_domain;
      const args = brandDomain ? { creatives, brand: { domain: brandDomain } } : { creatives };
      const result = await handleSyncCreatives(args as unknown as ToolArgs, buildTrainingCtx(ctx.account));
      // v5 returns wire-wrapped `{ creatives: [...] }`; v6 wants rows.
      const wrapped = translateV5Result<{ creatives?: unknown[] }>(result);
      return (wrapped.creatives ?? []) as SyncCreativesRow[];
    },
  };
}
