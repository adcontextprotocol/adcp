/**
 * v6 BrandRightsPlatform for the `/brand` tenant.
 *
 * Single-specialism platform claiming `brand-rights`. Implements 3 methods
 * the spec ships with stable schemas in `AdcpToolMap`: getBrandIdentity,
 * getRights, acquireRights. The two related surfaces (`update_rights`,
 * `creative_approval`) are spec-published but not yet in `AdcpToolMap`,
 * so they ride the merge seam (`opts.customTools`) until v6.1+.
 *
 * Spike-grade port: shim through to v5 handlers via `translateV5Result`.
 */

import {
  AdcpError,
  type DecisioningPlatform,
  type BrandRightsPlatform,
  type AccountStore,
} from '@adcp/sdk/server';
import {
  handleGetBrandIdentity,
  handleGetRights,
  handleAcquireRights,
  handleUpdateRights,
} from './brand-handlers.js';
import type { ToolArgs, TrainingContext } from './types.js';

interface TrainingBrandMeta {
  brand_domain?: string;
  [key: string]: unknown;
}

interface TrainingBrandConfig {
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

const trainingBrandAccounts: AccountStore<TrainingBrandMeta> = {
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

export class TrainingBrandPlatform
  implements DecisioningPlatform<TrainingBrandConfig, TrainingBrandMeta>
{
  capabilities = {
    specialisms: ['brand-rights'] as const,
    creative_agents: [],
    channels: [] as const,
    pricingModels: ['cpm', 'cpa'] as const,
    supportedBillings: ['agent', 'operator'] as const,
    // brand-rights claims require capabilities.brand block per
    // RequiredCapabilitiesFor<S>. Empty inner object opts in;
    // BrandRightsPlatform impl below auto-derives `brand.rights: true`.
    brand: {},
    config: { strict: false },
  };

  statusMappers = {};
  accounts: AccountStore<TrainingBrandMeta> = trainingBrandAccounts;

  brandRights: BrandRightsPlatform<TrainingBrandMeta> = {
    getBrandIdentity: async (req, ctx) => {
      const result = await handleGetBrandIdentity(req as ToolArgs, buildTrainingCtx(ctx.account));
      return translateV5Result(result);
    },
    getRights: async (req, ctx) => {
      const result = await handleGetRights(req as ToolArgs, buildTrainingCtx(ctx.account));
      return translateV5Result(result);
    },
    acquireRights: async (req, ctx) => {
      const result = await handleAcquireRights(req as ToolArgs, buildTrainingCtx(ctx.account));
      return translateV5Result(result);
    },
    updateRights: async (req, ctx) => {
      const result = await handleUpdateRights(req as ToolArgs, buildTrainingCtx(ctx.account));
      return translateV5Result(result);
    },
    reviewCreativeApproval: async () => {
      // Webhook handler — the spec models creative approval as an HTTP
      // webhook (POST to the seller's approval_webhook URL). The training
      // agent is a single-process MCP/A2A server with no public HTTP
      // surface for buyer-initiated webhooks, so this method is wired but
      // not reachable. Throw a structured error so anything that does
      // dispatch here gets a clean rejection rather than a silent stub.
      throw new AdcpError('NOT_IMPLEMENTED', {
        message:
          'Training agent does not expose a creative-approval webhook receiver. ' +
          'Production sellers mount this method behind the approval_webhook URL ' +
          'they returned from acquire_rights.',
        recovery: 'terminal',
      });
    },
  };
}
