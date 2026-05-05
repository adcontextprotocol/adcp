---
---

Add a "Refresh now" button to the publisher self-service page hero. The
publisher page only auto-crawls on first view (when no validation row
exists, or a stub row without a brand manifest). Once both files are
populated, nothing re-triggers the crawl — so a publisher who updates
their `adagents.json` or `brand.json` had no way to invalidate the
cached registry view.

The button hits the existing `/api/registry/crawl-request` endpoint, so
it inherits the per-domain rate limit (60s) and per-member hourly limit
already in place. Logged-out users see a "Sign in to refresh" CTA
instead of a public trigger — the endpoint is auth-gated server-side, so
exposing a public button would just produce 401s.

On 202 the hero subtitle switches to a refreshing-state and the page
re-loads after 4s (same cadence as the auto-crawl-on-view flow). On 429
the button shows a wait timer and the subtitle reports the retry-after
window. On 401/403 the user is redirected to login.
