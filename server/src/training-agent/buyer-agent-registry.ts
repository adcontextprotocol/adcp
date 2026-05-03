/**
 * Per-buyer-agent identity registry for the v6 per-tenant platforms.
 * Phase 1 of `adcp-client#1269` (shipped in @adcp/sdk@6.7.0); the
 * `extra`-forwarding fix that lets us migrate prefix-based bearer
 * conventions shipped in @adcp/sdk@6.8.0 (`adcp-client#1488`).
 *
 * **What this resolver does.** Given a request's `AdcpCredential` and
 * the `extra` bag the bearer authenticator stamped on the AuthPrincipal,
 * looks up the buyer agent's commercial relationship with the seller
 * (passthrough_only / agent_billable) and returns a `BuyerAgent` record
 * with the appropriate `billing_capabilities` Set. The framework
 * threads the resolved record through `ctx.agent` to platform handlers
 * (`accounts.upsert`, `getProducts`, etc.) — read-side handlers that
 * want to gate on commercial state consult `ctx.agent.billing_capabilities`
 * directly, no separate lookup needed.
 *
 * **Why bearerOnly.** The training-agent's auth chain is bearer-shaped
 * (`verifyApiKey` static keys + dynamic `demo-*` prefix matcher). No
 * signed-request path. `signingOnly` would refuse all traffic;
 * `bearerOnly` accepts api_key kind and rejects http_sig, matching
 * the deployment posture.
 *
 * **Why `extra.demo_token`.** `ResolveBuyerAgentByCredential` receives
 * `AdcpCredential` whose `api_key` variant carries `key_id: SHA-256(token)`
 * — the raw bearer is intentionally hashed at the framework boundary.
 * That makes prefix-based test conventions (`demo-billing-passthrough-*`
 * → passthrough_only) impossible to match from `key_id` alone (the
 * prefix space is infinite by design). The bearer authenticator at
 * `index.ts:84` stamps `extra: { demo_token: token }` on the returned
 * AuthPrincipal; @adcp/sdk@6.8.0's `attachAuthInfo` forwards it through
 * to `BuyerAgentResolveInput.extra`, which `bearerOnly` passes as the
 * second arg to this resolver.
 *
 * **Source of truth.** Delegates to `commercial-relationships.ts` for
 * the principal → relationship lookup so both consumers — legacy `/mcp`
 * via `handleSyncAccounts` and v6 per-tenant routes via `ctx.agent` —
 * read the same data. When SDK Phase 2 ships framework-level
 * enforcement of `BILLING_NOT_PERMITTED_FOR_AGENT` against
 * `ctx.agent.billing_capabilities`, this delegation can collapse —
 * the gate logic in `account-handlers.ts` becomes redundant with the
 * framework's check.
 *
 * **Sandbox-only is unset.** The training-agent's demo agents operate
 * against the public-sandbox account; they don't carry the `sandbox_only`
 * gate that production test credentials would use. Real sellers wiring
 * BuyerAgentRegistry SHOULD set `sandbox_only: true` on their test-
 * environment agents per the field's docstring (defense-in-depth: a
 * leaked test credential is bounded to sandbox accounts).
 */

import { BuyerAgentRegistry, type BuyerAgent } from '@adcp/sdk/server';
import { getCommercialRelationship } from './commercial-relationships.js';

const TRAINING_AGENT_BASE_URL = 'https://training-agent.adcontextprotocol.org';

const PASSTHROUGH_BILLING_CAPABILITIES = new Set(['operator'] as const);
const AGENT_BILLABLE_BILLING_CAPABILITIES = new Set([
  'operator',
  'agent',
  'advertiser',
] as const);

export const trainingBuyerAgentRegistry = BuyerAgentRegistry.bearerOnly({
  resolveByCredential: async (credential, extra) => {
    if (credential.kind !== 'api_key') return null;
    const token = extra?.demo_token;
    if (typeof token !== 'string') return null;

    const principal = `static:demo:${token}`;
    const relationship = getCommercialRelationship(principal);
    if (!relationship) return null;

    const billing_capabilities =
      relationship === 'passthrough_only'
        ? PASSTHROUGH_BILLING_CAPABILITIES
        : AGENT_BILLABLE_BILLING_CAPABILITIES;

    const agent: BuyerAgent = {
      // Stable agent_url per token. Real sellers would use the buyer's
      // canonical agent URL from their onboarding ledger; the training
      // agent synthesizes a per-token URL so log/audit lines distinguish
      // demo callers without colliding.
      agent_url: `${TRAINING_AGENT_BASE_URL}/demo/${token}`,
      display_name: `Demo ${relationship.replace('_', ' ')} agent (${token})`,
      status: 'active',
      billing_capabilities,
    };
    return agent;
  },
});
