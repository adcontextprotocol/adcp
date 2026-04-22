---
---

refactor(addie): `read_google_doc` returns structured result — closes #2752, #2753, #2754, #2756.

Four follow-up issues from the PR #2744 expert review bundled. They all share one file and the structured return subsumes the others:

**#2754 — Structured return.** New `GoogleDocResult` type: `{ status: 'ok' | 'access_denied' | 'empty' | 'invalid_input' | 'unsupported_type' | 'error', title, body, format, mime_type, message, truncated }`. The LLM-facing `read_google_doc` tool now returns a JSON string of this shape instead of a pre-formatted markdown blob. Addie's prompt branches on `status` and forwards `title`/`body` to `propose_content.title`/`content` — no more string manipulation, no more "strip leading `# <title>\\n\\n`" fragility.

**#2756 — Sentinel collision.** The old code used `result.startsWith("I don't have access")` as the error signal, which false-positives on any doc whose body naturally starts with that phrase. Replaced with the `status` enum. The `GOOGLE_DOCS_ERROR_PREFIX` / `GOOGLE_DOCS_ACCESS_DENIED_PREFIX` constants are removed — no internal callers referenced them after migration.

**#2753 — Path divergence.** Previously two different code paths produced subtly different markdown for the same doc (Drive API `text/markdown` export vs our custom `readViaDocsApi` converter). Both now flow through one `readGoogleDocStructured` function that normalizes its output into the structured shape before callers see it. No more "same doc, different output depending on URL format."

**#2752 — Dead-code caps.** Unified: the 500KB inner cap in `readGoogleDocStructured` is what internal callers see (committee-document-indexer, content-curator). The LLM-facing handler caps at 30KB before JSON-stringifying — one doc can't dominate Sonnet's context window. The old 15K outer cap that was overriding the 500KB inner caps is gone.

**Migrations:**
- `committee-document-indexer.ts` → uses new `createGoogleDocsReader()` factory, branches on `status`
- `content-curator.ts` → same pattern
- The legacy string-returning `readGoogleDoc` wrapper is preserved for any transitional internal caller, implemented as a thin formatter over the structured result

Tests: 22 unit tests pass (5 new — reader/handler factories return null when creds missing, valid factory when creds present, `GoogleDocResult` status/format contract). Typecheck clean.

Remaining epic #2693 follow-ups: #2735 channel privacy TOCTOU, #2736 interactive Slack DMs, #2755 web Addie rate limit.
