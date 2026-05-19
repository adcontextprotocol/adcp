---
"adcontextprotocol": patch
---

Two coordinated updates ahead of 3.1 beta:

- **Docs banner switch**: `docs.json` banner content updated from "🎉 AdCP 3.0 is now GA — see what's new" → "🚀 AdCP 3.1 beta is now available — see what's new". Links to `/docs/reference/whats-new-in-3-1`. The 3.0 GA banner had been displayed on docs.adcontextprotocol.org for months and was out of date. AAO main site (`server/public/index.html`) banner intentionally stays on "3.0 GA" — that audience is operators/agencies/members, beta messaging adds confusion without value.

- **`whats-new-in-3-1.mdx` updates**:
  - **Beta status callout** at top: status is 3.1 beta; spec feature-complete; SDK + grader advisory-only during beta; GA target 2026-05-29; adopters can pin `adcp_version: "3.1-beta"` today.
  - **New "Final-spec clarifications (WG-review batch)" section** covering the 10 normative tightenings from PR #4796 (`4c124545f1`): `PROPOSAL_NOT_FOUND`, forward-compatible `error.code` decoding, `idempotency_key` required on every task request, MCP tool wrapper envelope tolerance, MCP serialization normalization (drops `payload.required`, adds `context` envelope field), idempotency replay returns historical snapshot, `refine[]` finalize-exclusivity, `pending_creatives` status disambiguation, `notices` advisory channel on runner-output-contract.

The clarifications batch shipped after the original whats-new page was written; this catches the page up to current main.
