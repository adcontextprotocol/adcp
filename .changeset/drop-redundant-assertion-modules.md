---
---

Drop the local `server/src/compliance/assertions/` modules now that `@adcp/client@5.9` bundles and auto-registers the same three defaults (`idempotency.conflict_no_payload_leak`, `context.no_secret_echo`, `governance.denial_blocks_mutation`) on any `@adcp/client/testing` import (via `default-invariants` side-registration). Closes the #2639 end state.

- `server/src/compliance/assertions/{index,context-no-secret-echo,idempotency-conflict-no-payload-leak,governance-denial-blocks-mutation}.ts` — deleted.
- `server/tests/unit/compliance-assertions.test.ts` — deleted (the bundled upstream versions ship their own coverage).
- Side-effect imports removed from `server/src/services/storyboards.ts`, `server/tests/manual/run-storyboards.ts`, `server/tests/manual/run-one-storyboard.ts`, `server/tests/manual/storyboard-smoke.ts`.
- `.gitignore` — dropped the `/dist/compliance/assertions/` exclusion that was only needed while the compile output was shadowing the published spec-tarball path.
- `static/compliance/source/universal/idempotency.yaml` — comment updated to note that built-in assertions come from `@adcp/client@5.9+` via `default-invariants`; runners no longer need to load anything explicitly.
- `package.json` — `@adcp/client` bumped to `^5.9.0` (caret picks up the upstream widening in `5.9.1+`).

**Security-equivalence.** Shipped 5.9.0 bundled defaults were narrower than the deleted local versions (denylist vs allowlist on `idempotency.conflict_no_payload_leak`, `.context`-only scan on `context.no_secret_echo`). Upstream [`adcp-client#753`](https://github.com/adcontextprotocol/adcp-client/pull/753) restores allowlist-based conflict-envelope checking and whole-body secret scanning with bearer-token regex + suspect-property-name detection — publishing as `5.9.1` alongside this merge. The `^5.9.0` dep picks up the widened defaults automatically. `governance.denial_blocks_mutation` was equivalent between the local and bundled versions from the start.
