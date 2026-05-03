/**
 * v6 DecisioningPlatform skeleton for the training agent.
 *
 * Spike — feature-flagged behind TRAINING_AGENT_USE_V6. Coexists with
 * `framework-server.ts` (v5 createAdcpServer path); not the production
 * default until v6.0 GA.
 *
 * Spike strategy: shim v5 handlers into v6 platform method bodies. The
 * shim translates the v5 `(args, TrainingContext) → success | { errors }`
 * convention into the v6 `(req, ctx) → success | throw AdcpError`
 * convention. This lets us validate framework wiring + storyboard parity
 * without first porting handler bodies. Native v6 throws come later, one
 * handler at a time.
 */

import {
  AdcpError,
  type DecisioningPlatform,
  type SignalsPlatform,
  type AccountStore,
} from '@adcp/sdk/server';
import { handleGetSignals, handleActivateSignal } from './task-handlers.js';
import { syncAccountsUpsert } from './v6-account-helpers.js';
import type { ToolArgs, TrainingContext } from './types.js';

export interface TrainingConfig {
  /** Strict route advertises required_for: ['create_media_buy']. */
  strict: boolean;
}

export interface TrainingMeta {
  /** brand.domain when the wire request carried a brand reference. */
  brand_domain?: string;
  [key: string]: unknown;
}

/**
 * Synthetic-account constructor for the public-sandbox posture.
 *
 * v5 doesn't wire `resolveAccount` — sessions key off `brand.domain` directly
 * inside handlers. v6 requires `accounts.resolve()` on every request, so we
 * synthesize an Account from the wire reference (or from auth for no-account
 * tools like `provide_performance_feedback` / `list_creative_formats`).
 */
const trainingAccounts: AccountStore<TrainingMeta> = {
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

/**
 * Translate a v5 handler return value into a v6-shaped response.
 *
 * v5 handlers return either the success body OR `{ errors: [{ code, message, ... }] }`
 * on failure. v6 platform methods return the success body OR throw `AdcpError`.
 * This translates the envelope-error path to a throw.
 */
function translateV5Result<T extends object>(result: unknown): T {
  const errs = (result as { errors?: Array<{ code: string; message: string; field?: string; details?: unknown; recovery?: string }> } | undefined)?.errors;
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

/**
 * Build a TrainingContext from a v6 RequestContext.Account.
 *
 * `accounts.resolve` stamps the AuthPrincipal onto the resolved Account's
 * `authInfo` field (training-agent's resolver uses `{ kind: 'api_key' }`
 * — no principal — so this path falls back to `'anonymous'` today). The
 * authoritative principal source for the v6 path is `ctx.authInfo.clientId`
 * on `ResolveContext`, populated by the tenant router's req.auth bridge —
 * see `v6-account-helpers.ts` `trainingCtxFromResolveCtx` for the shape
 * billing gates consume.
 */
function buildTrainingCtx(account: { authInfo?: { principal?: string } } | undefined): TrainingContext {
  return {
    mode: 'open',
    principal: account?.authInfo?.principal ?? 'anonymous',
  };
}

/**
 * v6 TrainingPlatform.
 *
 * Specialism fields are populated incrementally — currently `signals` only.
 * Other domains stay in the merge seam (`opts.mediaBuy / creative / governance
 * / accounts / brandRights / customTools`) until they're ported.
 */
export class TrainingPlatform implements DecisioningPlatform<TrainingConfig, TrainingMeta> {
  // Claim only the specialism we've ported. RequiredPlatformsFor<S> compile-
  // checks that signal-marketplace + signal-owned ⇒ this.signals exists.
  capabilities = {
    specialisms: ['signal-marketplace', 'signal-owned'] as const,
    creative_agents: [],
    channels: [] as const,
    pricingModels: ['cpm', 'cpa'] as const,
    targeting: {
      geo_countries: true,
      geo_regions: true,
      geo_metros: { nielsen_dma: true },
      geo_postal_areas: { us_zip: true },
      language: true,
      keyword_targets: { supported_match_types: ['broad', 'phrase', 'exact'] as const },
      negative_keywords: { supported_match_types: ['broad', 'phrase', 'exact'] as const },
    },
    audience_targeting: {
      supported_identifier_types: ['hashed_email' as const],
      minimum_audience_size: 100,
    },
    conversion_tracking: {
      supported_event_types: ['purchase' as const, 'add_to_cart' as const, 'lead' as const, 'page_view' as const],
      supported_hashed_identifiers: ['hashed_email' as const],
      supported_action_sources: ['website' as const, 'app' as const],
    },
    supportedBillings: ['agent', 'operator'] as const,
    config: { strict: false },
  };

  statusMappers = {};

  accounts: AccountStore<TrainingMeta> = trainingAccounts;

  signals: SignalsPlatform<TrainingMeta> = {
    getSignals: async (req, ctx) => {
      const trainingCtx = buildTrainingCtx(ctx.account);
      const result = await handleGetSignals(req as ToolArgs, trainingCtx);
      return translateV5Result(result);
    },

    activateSignal: async (req, ctx) => {
      const trainingCtx = buildTrainingCtx(ctx.account);
      const result = await handleActivateSignal(req as ToolArgs, trainingCtx);
      return translateV5Result(result);
    },
  };
}
