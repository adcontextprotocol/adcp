---
---

Phase B of the publisher-page redesign: AAO now records per-fetch metadata (HTTP status code, response body byte length, post-redirect resolved URL) on the `publishers` overlay row and surfaces it through `/api/registry/publisher`. The verifier hero on `/publisher/<domain>` now reads `Last verified · HTTP 200 · 1,438 · Expected URL · Resolved URL` — copy-paste-friendly, scrape-friendly chrome that lets buy-side operators sanity-check they're seeing the same response AAO is.

The route also closes the Case-B `self_redirected` gap from Phase A: when the publisher's `/.well-known/adagents.json` returns a 301/302 to a third-party HTTPS origin (no `authoritative_location` field in the body), the new `resolved_url` column drives `mode = "self_redirected"` so the TLS-chain shift is visible to verifiers. Failed fetches (404, 5xx) record metadata via a new `recordFailedAdagentsFetch` path so the UI can show "Last attempted" even when no manifest is cached.

Migration `469_publisher_fetch_metadata.sql` adds three nullable columns to `publishers`. Backfill is implicit via the 60-min crawl cadence; UI degrades gracefully when the columns are NULL. Schema additions are backward compatible — `last_http_status`, `last_bytes`, and `resolved_url` are all nullable optionals.
