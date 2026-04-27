---
---

chore: bump @adcp/client 5.21.0 → 5.21.1

Patch bump picks up the grader fix from
[adcontextprotocol/adcp-client#1026](https://github.com/adcontextprotocol/adcp-client/pull/1026)
— `adcp grade request-signing` against Cloudflare-fronted endpoints
(closing my-filed [#1025](https://github.com/adcontextprotocol/adcp-client/issues/1025)).

Validated end-to-end: the grader now reaches `/api/training-agent/mcp-strict`
on prod and runs all 39 vectors. 30 pass, 3 fail (verifier-side conformance
gaps unrelated to this PR), 6 are mcp-mode skips.

Runtime API surface unchanged. No code changes in this repo other than the
version pin.
