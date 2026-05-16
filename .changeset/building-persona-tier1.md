---
---

docs(building): persona-walk Tier 1 fixes — six day-1 friction points

Six fixes from the post-merge persona walks (greenfield buy-side dev, greenfield seller, hand-rolled migrator, SDK porter, evaluator/CTO).

1. **Live test agent on `build-a-caller.mdx`.** Buy-side persona stalled at hour 1: every code block used `https://sales.example.com` placeholder with no real URL to call. Added a Tip callout near the top pointing at `https://test-agent.adcontextprotocol.org` (with per-domain endpoints) — `getAdcpCapabilities()` works without auth, so day-1 success unblocked.

2. **Inline-define `account.operator` and `brand.domain` on first use.** Both pages used `'sales.example'` as a placeholder without explaining what string goes there. Buy-side persona couldn't make first call. Inline-glossed on `build-a-caller.mdx:115` and `calling-an-agent.mdx:46`.

3. **Fixed broken anchor on `migrate-from-hand-rolled.mdx:10`.** Pointed at `#three-questions-to-pick-your-layer` (old structure); index now uses `#two-checks-before-you-start`. Defensive readers test links — broken anchor on the second sentence eroded trust for the migrator persona.

4. **`L4/index.mdx` updated to reflect Phase 3.** Listed only `build-an-agent` and `migrate-from-hand-rolled`; missing `build-a-caller` and `choose-your-sdk` (added in Phase 3 PR #4031). Removed the "later docs phase" caveat. Added `choose-your-sdk` as the first listed page (the SDK choice gates everything else).

5. **5th Card on `building/index.mdx`: "Run a prebuilt agent."** Greenfield seller persona with a 2-engineer team had to dig three levels deep to find their right answer (self-host Prebid SalesAgent or partner with a managed platform). Added the small-team path as a peer Card. Also tightened the "2–8 minutes" framing on the Build an agent card to flag that it covers the protocol layer only — full going-live scope on `operating-an-agent`.

6. **Specialism decision rubric on `build-an-agent.mdx`.** Seller persona couldn't tell `sales-guaranteed` vs `sales-proposal-mode` from the bare table. Added a 3-bullet decision rubric naming the buying motion that maps to each (IO + rate card → guaranteed; real-time auction → non-guaranteed; per-buy negotiation → proposal-mode).

These are the Tier 1 ship-blockers from the persona walks. Tier 2 (extract 2.5→3.0 changelog, inline per-layer SDK contracts into `by-layer/L*/index.mdx` stubs) ships in a separate PR.
