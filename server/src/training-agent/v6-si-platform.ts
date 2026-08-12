/**
 * v6 platform for the `/si` (Sponsored Intelligence) tenant.
 *
 * The SDK exposes SI as a first-class SponsoredIntelligencePlatform. Keeping
 * these handlers on that surface gives the tenant canonical request validation,
 * tool metadata, capability projection, and session hydration.
 */

import {
  AdcpError,
  type DecisioningPlatform,
  type SponsoredIntelligencePlatform,
  type AccountStore,
} from '@adcp/sdk/server';
import {
  handleSiGetOffering,
  handleSiInitiateSession,
  handleSiSendMessage,
  handleSiTerminateSession,
} from './si-handlers.js';
import { syncAccountsUpsert } from './v6-account-helpers.js';
import { trainingBuyerAgentRegistry } from './buyer-agent-registry.js';
import type { ToolArgs, TrainingContext } from './types.js';

interface TrainingSiMeta {
  brand_domain?: string;
  [key: string]: unknown;
}

interface TrainingSiConfig {
  strict: boolean;
}

function buildTrainingCtx(
  account: { authInfo?: { principal?: string } } | undefined,
  storyboardCompat?: TrainingContext['storyboardCompat'],
): TrainingContext {
  return {
    mode: 'open',
    tenantId: 'si',
    principal: account?.authInfo?.principal ?? 'anonymous',
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
    const recovery =
      first.recovery === 'transient' ||
      first.recovery === 'correctable' ||
      first.recovery === 'terminal'
        ? first.recovery
        : 'correctable';
    throw new AdcpError(first.code, {
      recovery,
      message: first.message,
      ...(first.field !== undefined && { field: first.field }),
      ...(first.details !== undefined && {
        details: first.details as Record<string, unknown>,
      }),
    });
  }
  return result as T;
}

const trainingSiAccounts: AccountStore<TrainingSiMeta> = {
  resolution: 'explicit',
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  resolve: async (ref: any, ctx?: { authInfo?: { clientId?: string } }) => {
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
        authInfo: principal ? authInfo : { kind: 'public' as const },
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

export class TrainingSiPlatform
  implements DecisioningPlatform<TrainingSiConfig, TrainingSiMeta>
{
  constructor(private readonly storyboardCompat?: TrainingContext['storyboardCompat']) {}

  get capabilities() {
    return {
      specialisms: ['sponsored-intelligence'] as const,
      creative_agents: [],
      channels: [] as const,
      pricingModels: ['cpm', 'cpa', 'cpc'] as const,
      requireOperatorAuth: this.storyboardCompat?.version === '3.0' ? true : false,
      supportedBillings: ['agent', 'operator'] as const,
      config: { strict: false },
    };
  }

  statusMappers = {};
  accounts: AccountStore<TrainingSiMeta> = trainingSiAccounts;
  agentRegistry = trainingBuyerAgentRegistry;

  sponsoredIntelligence: SponsoredIntelligencePlatform<TrainingSiMeta> = {
    getOffering: async (req, ctx) => {
      const result = await handleSiGetOffering(
        req as ToolArgs,
        buildTrainingCtx(ctx.account, this.storyboardCompat),
      );
      return translateV5Result(result);
    },
    initiateSession: async (req, ctx) => {
      const result = await handleSiInitiateSession(
        req as ToolArgs,
        buildTrainingCtx(ctx.account, this.storyboardCompat),
      );
      return translateV5Result(result);
    },
    sendMessage: async (req, ctx) => {
      const result = await handleSiSendMessage(
        req as ToolArgs,
        buildTrainingCtx(ctx.account, this.storyboardCompat),
      );
      return translateV5Result(result);
    },
    terminateSession: async (req, ctx) => {
      const result = await handleSiTerminateSession(
        req as ToolArgs,
        buildTrainingCtx(ctx.account, this.storyboardCompat),
      );
      return translateV5Result(result);
    },
  };
}
