/**
 * v6 CreativeBuilderPlatform for the `/creative-builder` tenant.
 *
 * F13 (`841616d7`) merged the template + generative archetypes into a
 * single `CreativeBuilderPlatform` interface. This tenant claims both
 * specialism IDs (`creative-template` + `creative-generative`) since
 * buyer-side discovery still distinguishes them — the implementation
 * surface unifies.
 *
 * The training agent's `/creative` tenant (CreativeAdServerPlatform)
 * handles the stateful library/tags archetype; this tenant handles the
 * stateless transform / brief-driven generation archetype. Two creative
 * tenants for the v5 omni-creative codebase.
 */

import {
  AdcpError,
  type DecisioningPlatform,
  type CreativeBuilderPlatform,
  type SyncCreativesRow,
  type AccountStore,
} from '@adcp/sdk/server';
import {
  handleBuildCreative,
  handlePreviewCreative,
  handleSyncCreatives,
} from './task-handlers.js';
import type { ToolArgs, TrainingContext } from './types.js';

interface TrainingCreativeBuilderMeta {
  brand_domain?: string;
  [key: string]: unknown;
}

interface TrainingCreativeBuilderConfig {
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

const trainingBuilderAccounts: AccountStore<TrainingCreativeBuilderMeta> = {
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
};

export class TrainingCreativeBuilderPlatform
  implements DecisioningPlatform<TrainingCreativeBuilderConfig, TrainingCreativeBuilderMeta>
{
  capabilities = {
    specialisms: ['creative-template', 'creative-generative'] as const,
    creative_agents: [],
    channels: [] as const,
    pricingModels: ['cpm', 'cpa'] as const,
    supportedBillings: ['agent', 'operator'] as const,
    compliance_testing: {},
    config: { strict: false },
  };

  statusMappers = {};
  accounts: AccountStore<TrainingCreativeBuilderMeta> = trainingBuilderAccounts;

  creative: CreativeBuilderPlatform<TrainingCreativeBuilderMeta> = {
    buildCreative: async (req, ctx) => {
      const result = await handleBuildCreative(req as ToolArgs, buildTrainingCtx(ctx.account));
      // F16 (`bca20dfb`) — framework's discriminator detects the
      // envelope shape: bare CreativeManifest wraps as
      // { creative_manifest }; bare CreativeManifest[] wraps as
      // { creative_manifests }; pre-shaped BuildCreativeSuccess /
      // BuildCreativeMultiSuccess envelopes pass through unchanged.
      // v5 returns the envelope shape directly, so passthrough.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return translateV5Result(result) as any;
    },
    previewCreative: async (req, ctx) => {
      const result = await handlePreviewCreative(req as ToolArgs, buildTrainingCtx(ctx.account));
      return translateV5Result(result);
    },
    syncCreatives: async (creatives, ctx) => {
      const result = await handleSyncCreatives({ creatives } as unknown as ToolArgs, buildTrainingCtx(ctx.account));
      const wrapped = translateV5Result<{ creatives?: unknown[] }>(result);
      return (wrapped.creatives ?? []) as SyncCreativesRow[];
    },
    // refineCreative — v5 doesn't have a dedicated handler; the buildCreative
    // handler accepts refinement payloads via the same code path. Skip for
    // now; storyboards exercising refineCreative will hit UNSUPPORTED_FEATURE.
  };
}
