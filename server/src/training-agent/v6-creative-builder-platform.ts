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
  type LegacyCreativeHandlers,
  type AccountStore,
} from '@adcp/sdk/server';
import {
  handleBuildCreative,
  handlePreviewCreative,
  handleListCreativeFormats,
  handleSyncCreatives,
} from './task-handlers.js';
import { syncAccountsUpsert } from './v6-account-helpers.js';
import { trainingBuyerAgentRegistry } from './buyer-agent-registry.js';
import type { ToolArgs, TrainingContext } from './types.js';

interface TrainingCreativeBuilderMeta {
  brand_domain?: string;
  [key: string]: unknown;
}

interface TrainingCreativeBuilderConfig {
  strict: boolean;
}

function buildTrainingCtx(
  ctx: {
    account?: unknown;
    authInfo?: { clientId?: string };
    agent?: { agent_url: string };
  } | undefined,
  storyboardCompat?: TrainingContext['storyboardCompat'],
): TrainingContext {
  const account = ctx?.account as { authInfo?: { principal?: string } } | undefined;
  return {
    mode: 'open',
    tenantId: 'creative-builder',
    principal: ctx?.authInfo?.clientId ?? account?.authInfo?.principal ?? 'anonymous',
    ...(ctx?.agent?.agent_url && { authenticatedAgentUrl: ctx.agent.agent_url }),
    ...(storyboardCompat && { storyboardCompat }),
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
  resolve: async (ref, ctx) => {
    const principal = ctx?.authInfo?.clientId;
    const authInfo = {
      kind: 'api_key' as const,
      ...(principal && { principal }),
    };
    if (ref == null) {
      return {
        id: 'public_sandbox',
        name: 'Public Sandbox',
        status: 'active',
        mode: 'sandbox',
        ctx_metadata: {},
        sandbox: true,
        authInfo: { kind: 'public' as const, ...(principal && { principal }) },
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
      mode: 'sandbox',
      ...(brandDomain != null && { brand: { domain: brandDomain } }),
      ...('operator' in ref && typeof ref.operator === 'string' && { operator: ref.operator }),
      ctx_metadata: { brand_domain: brandDomain },
      sandbox: true,
      authInfo,
    };
  },
  upsert: syncAccountsUpsert,
};

export function legacyCreativeBuilderSyncHandler(
  storyboardCompat?: TrainingContext['storyboardCompat'],
): NonNullable<LegacyCreativeHandlers['syncCreatives']> {
  return async (req, ctx) => await handleSyncCreatives(
    req as unknown as ToolArgs,
    buildTrainingCtx(ctx, storyboardCompat),
  ) as unknown as Awaited<ReturnType<NonNullable<LegacyCreativeHandlers['syncCreatives']>>>;
}

export class TrainingCreativeBuilderPlatform
  implements DecisioningPlatform<TrainingCreativeBuilderConfig, TrainingCreativeBuilderMeta>
{
  constructor(private readonly storyboardCompat?: TrainingContext['storyboardCompat']) {}

  get capabilities() {
    return {
    specialisms: this.storyboardCompat?.version === '3.0'
      ? ['creative-template', 'creative-generative'] as const
      : ['creative-template', 'creative-generative', 'creative-transformers'] as const,
    creative_agents: [],
    channels: [] as const,
    pricingModels: ['cpm', 'cpa'] as const,
    requireOperatorAuth: this.storyboardCompat?.version === '3.0' ? true : false,
    supportedBillings: ['agent', 'operator'] as const,
    compliance_testing: {},
      config: { strict: false },
    };
  }

  statusMappers = {};
  accounts: AccountStore<TrainingCreativeBuilderMeta> = trainingBuilderAccounts;
  agentRegistry = trainingBuyerAgentRegistry;

  creative: CreativeBuilderPlatform<TrainingCreativeBuilderMeta> = {
    buildCreativeLegacy: async (req, ctx) => {
      const result = await handleBuildCreative(req as ToolArgs, buildTrainingCtx(ctx, this.storyboardCompat));
      // F16 (`bca20dfb`) — framework's discriminator detects the
      // envelope shape: bare CreativeManifest wraps as
      // { creative_manifest }; bare CreativeManifest[] wraps as
      // { creative_manifests }; pre-shaped BuildCreativeSuccess /
      // BuildCreativeMultiSuccess envelopes pass through unchanged.
      // v5 returns the envelope shape directly, so passthrough.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return translateV5Result(result) as any;
    },
    previewCreativeLegacy: async (req, ctx) => {
      const result = await handlePreviewCreative(req as ToolArgs, buildTrainingCtx(ctx, this.storyboardCompat));
      return translateV5Result(result);
    },
    listCreativeFormatsLegacy: async (req, ctx) => {
      const result = await handleListCreativeFormats(req as ToolArgs, buildTrainingCtx(ctx, this.storyboardCompat));
      return translateV5Result(result);
    },
    // refineCreative — v5 doesn't have a dedicated handler; the buildCreative
    // handler accepts refinement payloads via the same code path. Skip for
    // now; storyboards exercising refineCreative will hit UNSUPPORTED_FEATURE.
  };
}
