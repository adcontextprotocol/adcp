/**
 * v6 platform for the `/si` tenant — Sponsored Intelligence.
 *
 * Minimal platform: no specialism methods. All four SI lifecycle tools
 * (si_get_offering, si_initiate_session, si_send_message, si_terminate_session)
 * ride the customTools merge seam in tenants/si.ts — they're in AdcpToolMap
 * (area: 'si') but the SDK's DecisioningPlatform interface has no SI field
 * yet.
 *
 * This tenant simulates the BRAND-AGENT side of the SI lifecycle. A learner
 * practices as the HOST — they initiate sessions, exchange messages, retrieve
 * offerings, and terminate sessions against a deterministic training brand
 * (Nova Brands). The host-outbound `connect_to_si_agent` tool that Addie uses
 * to call real brand SI agents lives in addie/mcp/si-host-tools.ts and is a
 * different surface entirely.
 */

import {
  type DecisioningPlatform,
  type AccountStore,
} from '@adcp/sdk/server';

export interface TrainingSiConfig {
  strict: boolean;
}

export interface TrainingSiMeta {
  [key: string]: unknown;
}

const trainingSiAccounts: AccountStore<TrainingSiMeta> = {
  resolution: 'explicit',
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  resolve: async (ref: any, _ctx: any) => {
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
      ctx_metadata: {},
      authInfo: { kind: 'api_key' },
    };
  },
};

export class TrainingSiPlatform
  implements DecisioningPlatform<TrainingSiConfig, TrainingSiMeta>
{
  capabilities = {
    specialisms: [] as const,
    creative_agents: [] as const,
    channels: [] as const,
    pricingModels: [] as const,
    supportedBillings: ['agent', 'operator'] as const,
    config: { strict: false },
  };

  statusMappers = {};
  accounts: AccountStore<TrainingSiMeta> = trainingSiAccounts;
}
