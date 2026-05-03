/**
 * Shared `accounts.upsert` for the training-agent's v6 per-tenant
 * platforms (sales / signals / governance / creative / creative-builder /
 * brand). Delegates to the v5 `handleSyncAccounts` so the
 * BILLING_NOT_SUPPORTED + BILLING_NOT_PERMITTED_FOR_AGENT gates landed
 * in #3851 fire identically on every per-tenant
 * `/api/training-agent/<tenant>/mcp` route as on the legacy `/mcp`
 * route.
 *
 * **Tenant-independent account state** (by design). All six v6 platforms
 * share a single in-process `accountStore` via `handleSyncAccounts`. A
 * buyer calling `sync_accounts` on `/governance/mcp` provisions an
 * account that's also visible to `/sales/mcp` — that's the spec posture:
 * one buyer-seller account, all surfaces. Future contributors who try to
 * "fix" cross-tenant visibility should consult the spec note in
 * docs/building/integration/accounts-and-agents.mdx ("supported_protocols
 * is not exhaustive — the accounts surface is implicit in every
 * protocol agent") before reshaping.
 *
 * Principal flows from the bearer authenticator (index.ts) through the
 * tenant router's req.auth bridge (tenants/router.ts) onto
 * `ResolveContext.authInfo.clientId` — that's where serve.js stamps the
 * AuthPrincipal.principal in @adcp/sdk@6.7.0+. The training-agent's
 * principal namespace (`static:demo:<token>` / `static:primary` /
 * `workos:<orgId>`) is what `commercial-relationships.ts` keys the
 * per-buyer-agent gate against.
 *
 * Phase 2 of adcp-client#1269 wires framework-level enforcement to the
 * `BILLING_NOT_PERMITTED_FOR_AGENT` code from this seller's
 * `BuyerAgentRegistry`. When that lands, this delegation can be removed
 * — the framework will gate based on `ctx.agent.billing_capabilities`
 * directly.
 */

import type {
  AccountStore,
  ResolveContext,
  SyncAccountsResultRow,
} from '@adcp/sdk/server';
import { handleSyncAccounts } from './account-handlers.js';
import type { ToolArgs, TrainingContext } from './types.js';

function trainingCtxFromResolveCtx(ctx: ResolveContext | undefined): TrainingContext {
  // `clientId` is where serve.js projects AuthPrincipal.principal — see
  // @adcp/sdk@6.7.0 server/serve.js. The tenant router bridges
  // res.locals.trainingPrincipal onto req.auth.clientId so the framework
  // surfaces it as ctx.authInfo.clientId for platform handlers.
  const principal = ctx?.authInfo?.clientId;
  return principal ? { mode: 'open', principal } : { mode: 'open' };
}

export const syncAccountsUpsert: NonNullable<AccountStore['upsert']> = async (refs, ctx) => {
  const trainingCtx = trainingCtxFromResolveCtx(ctx);
  // The `refs as unknown[]` cast assumes v5 and v6 `AccountReference`
  // wire shapes are compatible — both carry `{ brand, operator, billing,
  // payment_terms?, billing_entity?, sandbox? }` with the same field
  // names. If the v6 SDK ever diverges (e.g., renames `billing` to
  // `billing_party`), this cast hides the break and the v5 handler will
  // see a different shape than it validated against.
  const v5Result = handleSyncAccounts(
    { accounts: refs as unknown[] } as ToolArgs,
    trainingCtx,
  );
  // v5 handleSyncAccounts returns `{ accounts: [...] }` where each entry
  // is the per-account result row (status, action, billing, errors, etc.).
  // Per-account errors live inside individual rows — they don't trip the
  // top-level errors-array path that translateV5Result throws on, so a
  // direct shape extract is safe here.
  const wrapped = v5Result as { accounts?: unknown[] };
  return (wrapped.accounts ?? []) as SyncAccountsResultRow[];
};
