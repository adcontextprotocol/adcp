/**
 * Experimental AdCP 3.3 identity for the training agent's sandbox identity
 * route: Web Bot Auth request signatures, origin binding through open
 * sandbox onboarding, and demand-side grants from the brand house's
 * trust.json, checked before any spend.
 *
 * Only the fixture identities in `fixture-world.ts` resolve here. A real
 * buyer domain is refused: the route is a conformance and teaching surface,
 * not a production onboarding path.
 */
import {
  OriginIdentityLifecycle,
  OriginRevocationResolver,
  SignatureDirectoryResolver,
  TrustEvaluator,
  createIdentity33Authorization,
  createIdentity33PrincipalResolver,
  createIdentity33StateStores,
} from '@adcp/sdk/identity-3.3';
import { verifySignatureAsAuthenticator, type Authenticator } from '@adcp/sdk/server';
import type { AdcpStateStore } from '@adcp/sdk/server';
import { StaticJwksResolver, type ReplayStore } from '@adcp/sdk/signing';
import type { IncomingMessage } from 'node:http';
import { accountRefForId } from '../account-handlers.js';
import { mcpOperationResolver } from '../request-signing.js';
import { fixtureBrandHouse, fixtureFetch } from './fixture-world.js';

export const IDENTITY33_TENANT_ID = 'training-agent-identity33';

interface AccountClaimInput {
  brand?: { domain?: unknown; brand_id?: unknown; countries?: unknown };
  operator?: unknown;
  sandbox?: unknown;
  billing?: unknown;
  account_id?: unknown;
}

type GrantClaim = {
  brand: { domain: string; brand_id?: string; countries?: string[] };
  accountOperator: string;
  scope: string;
  sandbox?: boolean;
  billing?: 'operator' | 'agent' | 'advertiser';
};

const BILLING = new Set(['operator', 'agent', 'advertiser']);

function claimFromAccount(account: AccountClaimInput | undefined): GrantClaim | undefined {
  const domain = account?.brand?.domain;
  const operator = account?.operator;
  if (typeof domain !== 'string' || typeof operator !== 'string') return undefined;
  const brandId = account?.brand?.brand_id;
  const countries = account?.brand?.countries;
  return {
    brand: {
      domain: domain.toLowerCase(),
      ...(typeof brandId === 'string' && { brand_id: brandId }),
      ...(Array.isArray(countries) && countries.every(c => typeof c === 'string') && { countries: countries as string[] }),
    },
    accountOperator: operator.toLowerCase(),
    // Every spend operation on this route buys media.
    scope: 'adcp:media_buying',
    sandbox: account?.sandbox === true,
    ...(typeof account?.billing === 'string' && BILLING.has(account.billing) && {
      billing: account.billing as GrantClaim['billing'],
    }),
  };
}

/**
 * The acts-for claims a spend call makes. sync_accounts proposes one claim
 * per account row; other spend tools act for the account they reference.
 * Reads only: nothing is provisioned here.
 */
export function resolveGrantClaims(principal: string | undefined, tool: string, params: unknown): GrantClaim[] {
  if (!params || typeof params !== 'object') return [];
  const input = params as { accounts?: unknown; account?: AccountClaimInput };
  if (tool === 'sync_accounts') {
    if (!Array.isArray(input.accounts)) return [];
    return input.accounts.map(row => claimFromAccount(row as AccountClaimInput)).filter((c): c is GrantClaim => !!c);
  }
  const account = input.account;
  if (!account) return [];
  if (typeof account.account_id === 'string') {
    const ref = accountRefForId(account.account_id, principal);
    const claim = claimFromAccount(ref as AccountClaimInput | undefined);
    return claim ? [claim] : [];
  }
  const claim = claimFromAccount(account);
  return claim ? [claim] : [];
}

export interface Identity33Runtime {
  authenticate: Authenticator;
  authorize: ReturnType<typeof createIdentity33Authorization>;
}

export function createIdentity33Runtime(options: {
  stateStore: AdcpStateStore;
  /** Shared across replicas so a nonce accepted on one machine is refused on the others. */
  replayStore?: ReplayStore;
  getUrl: (req: IncomingMessage & { rawBody?: string }) => string;
}): Identity33Runtime {
  const fetchOptions = { trustedFetchFn: fixtureFetch };
  const stores = createIdentity33StateStores({ store: options.stateStore, tenantId: IDENTITY33_TENANT_ID });
  const directory = new SignatureDirectoryResolver({ fetchOptions });
  const trust = new TrustEvaluator({ fetchOptions, authorityHistory: stores.authorityHistory });
  const lifecycle = new OriginIdentityLifecycle({
    store: stores.identity,
    trust,
    // The sandbox onboards any listed buying agent; live billing tiers are not offered.
    onboarding: { sandbox: { mode: 'open' } },
    lookupLegacyPrincipals: async () => [],
  });
  const revocation = new OriginRevocationResolver({ directory, store: stores.revocations, fetchOptions });
  const resolvePrincipal = createIdentity33PrincipalResolver({ lifecycle, revocation });

  const authenticate = verifySignatureAsAuthenticator({
    capability: {
      supported: true,
      profiles: ['web-bot-auth'],
      covers_content_digest: 'either',
      required_for: [],
    },
    // RFC 9421 keys are not accepted here; only Web Bot Auth identities.
    jwks: new StaticJwksResolver([]),
    webBotAuth: { directory, resolvePrincipal },
    ...(options.replayStore && { replayStore: options.replayStore }),
    getUrl: options.getUrl,
    resolveOperation: mcpOperationResolver,
  });

  const authorize = createIdentity33Authorization({
    lifecycle,
    grants: {
      evaluator: trust,
      resolveBrandHouse: async brand => fixtureBrandHouse(brand.domain),
    },
    resolveClaims: async (ctx, tool, params) => resolveGrantClaims(ctx.authInfo?.clientId, tool, params),
  });

  return { authenticate, authorize };
}
