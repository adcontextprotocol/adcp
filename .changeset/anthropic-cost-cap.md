---
---

Close #2790: per-user Anthropic API cost cap at the claude-client boundary. Tool-call frequency limits (#2784, #2789) bound our external API spend (Google Docs, Gemini, Slack) but didn't bound Anthropic spend — a compromised account could keep a session running under the tool-call cap while steadily driving Claude bills.

- **New migration 424** — `addie_token_cost_events(scope_key, cost_usd_micros, model, tokens_input, tokens_output, recorded_at)` indexed for rolling-window sums.
- **New `claude-pricing.ts`** with integer-math cost calculation for Haiku / Sonnet / Opus 4.x. Unknown models fall back to Opus rates so undercounting is impossible.
- **New `claude-cost-tracker.ts`** mirroring the tool-rate-limiter DI seam: Postgres default in prod, in-memory for unit tests. Tiered daily budgets (`anonymous: $1`, `member_free: $5`, `member_paid: $25`). System-user allowlist matches the tool limiter.
- **`claude-client.ts` instrumented** at both `processMessage` and `processMessageStream`: check cap at entry (friendly error + early return when blocked); record cost on completion + max-iteration fallback. All terminal paths accounted for.
- **Callers wired:** web chat (anonymous + authenticated), Slack primary streaming path, Slack mention/DM handler. Other callers (email, tavus voice, MCP chat-tool) tracked in the follow-up issue.

Conservative tier resolution: every authenticated caller is `member_free` for now. Real paying members get the $25/day ceiling once the subscription-status lookup is threaded through (filed as follow-up #2945 alongside the admin observability dashboard).

35 new unit tests (pricing calc correctness + cap enforcement + tier differentiation + system exemption + accumulation across calls). 1971 server unit tests + 631 root unit tests pass.
