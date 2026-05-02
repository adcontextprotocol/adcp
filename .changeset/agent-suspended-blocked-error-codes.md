---
"adcontextprotocol": minor
---

spec(errors): register AGENT_SUSPENDED / AGENT_BLOCKED error codes + buyer-agent status docs

Closes #3871. Extends the error-code vocabulary with two new codes for the buyer-agent commercial-relationship rejection surface introduced by `BuyerAgentRegistry` (adcp-client#1269). Without standard codes, every SDK and seller invents its own discriminator for "this buyer agent is not in good standing."

**New error codes** in `static/schemas/source/enums/error-code.json`:

- `AGENT_SUSPENDED` — buyer agent's commercial relationship with the seller is temporarily paused. Recovery: `terminal` (re-onboarding may resolve; agent MUST surface to a human). Sibling to `ACCOUNT_SUSPENDED` (account-level) but scoped to the agent-relationship layer, orthogonal to any specific account on that agent.
- `AGENT_BLOCKED` — buyer agent's commercial relationship is permanently denied. Recovery: `terminal` (no retry path; agent MUST surface to a human). Distinct from `AGENT_SUSPENDED` — no re-onboarding path exists.

**New `error-details/` schemas** (both `additionalProperties: false`):

- `error-details/agent-suspended.json` — intentionally empty; sellers MUST NOT include suspension reason, contract dates, or any per-agent commercial state.
- `error-details/agent-blocked.json` — intentionally empty; sellers MUST NOT include block basis, contract history, or any per-agent commercial state.

**Cross-tenant oracle clamp** (both codes): sellers MUST emit `AGENT_SUSPENDED` / `AGENT_BLOCKED` only when buyer-agent identity has been established via signed-request derivation (per `security.mdx` Agent identity section) or a credential-to-agent mapping in the seller's onboarding record. Callers without established identity MUST receive `PERMISSION_DENIED` without scope. Same threat model and uniform-response shape as `BILLING_NOT_PERMITTED_FOR_AGENT` (PR #3831) and the `*_NOT_FOUND` family.

**Docs** (`error-handling.mdx`): new "Buyer-agent status" subsection with the normative oracle-clamp rule, clamped-details requirement, and a dispatch example distinguishing the two new codes from `BILLING_NOT_PERMITTED_FOR_AGENT`.

The JS SDK is currently using `PERMISSION_DENIED + scope:'agent'` as a non-standard placeholder (adcp-client#1269 Stage 1). These registered codes let the SDK migrate to standard codes; Python and future SDK adopters inherit behavior parity without per-seller coordination.

Conformance fixtures for the oracle clamp are a follow-up (same pattern as `billing-gate-conformance-and-resolver-naming.md` following #3831).
