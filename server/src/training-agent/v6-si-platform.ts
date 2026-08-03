/**
 * v6 platform for the `/si` (Sponsored Intelligence) tenant.
 *
 * SI Chat Protocol tools (si_get_offering, si_initiate_session,
 * si_send_message, si_terminate_session) are not yet a first-class specialism
 * field on `DecisioningPlatform`. All four tools ride the `customTools` merge
 * seam via the tenant config until the SDK adds a `sponsoredIntelligence`
 * field (tracked as a follow-up to issue #3961 where the `sponsored-intelligence`
 * specialism graduated from PREVIEW).
 *
 * This platform claims no specialisms so the SDK does not attempt to enforce
 * `RequiredPlatformsFor<'sponsored-intelligence'>` interface compliance before
 * the interface exists.
 */

import {
  type DecisioningPlatform,
  type AccountStore,
} from '@adcp/sdk/server';
import { syncAccountsUpsert } from './v6-account-helpers.js';
import { trainingBuyerAgentRegistry } from './buyer-agent-registry.js';
import type { TrainingContext } from './types.js';

interface TrainingSiMeta {
  brand_domain?: string;
  [key: string]: unknown;
}

interface TrainingSiConfig {
  strict: boolean;
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
      specialisms: [] as const,
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
}
