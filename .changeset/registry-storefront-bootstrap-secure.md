---
---

feat(registry): document `POST /api/organizations`, auto-bootstrap profile on first agent registration, and stop accepting caller-controlled `membership_tier`

Strategic replacement for #4141. That PR collapsed the storefront-bootstrap chain from three calls to two by auto-creating the member profile on first `POST /api/me/agents`, but it documented `POST /api/organizations` with two fields the handler should never have accepted from the caller.

### Changes

- **`POST /api/organizations` no longer accepts `membership_tier` from the caller.** The Stripe webhook (`http.ts:3904`) is the sole writer of `organizations.membership_tier` — accepting it from the caller let any authenticated user stamp tier intent on their org row, leaking tier-gated UI state (announcement targeting, member-context display, "is academic" prompt rules, internal admin surfaces) until/unless a real subscription overwrote the column. Caller-supplied values are now logged and discarded.

- **`POST /api/organizations` no longer accepts `corporate_domain` from the caller.** The server derives the corporate domain from the authenticated user's email; accepting it as a field invited 400s when a caller's value disagreed with their email and gave nothing back when it agreed.

- **`POST /api/me/agents` auto-bootstraps the member profile** when the caller's organization doesn't have one yet. Reuses the existing `ensureMemberProfileExists` helper (the same one Addie's `save_agent` tool uses), so slug-collision handling and the private-by-default invariant stay consistent across surfaces. The response includes `profile_auto_created: true` on the bootstrap path so callers can render a "we set up your profile" hint without needing to detect the prior 404 → bootstrap → retry shape.

- **`POST /api/organizations` is now documented in the public OpenAPI spec** under a new `Onboarding` tag, with the safe field set: `organization_name`, `is_personal`, `company_type`, `revenue_tier`, `marketing_opt_in`. Schemas live in `server/src/schemas/onboarding-openapi.ts`. The OpenAPI surface drives storefront-style integration; the dashboard's onboarding form keeps using the same handler with the same authenticated session.

- **`server/public/onboarding.html`** stops sending the dropped fields. Paid-tier intent picked during onboarding is stashed in `localStorage.aao_intent_tier` so the dashboard's `/membership` page can pre-select it for Stripe checkout (the only path that actually sets a tier).

### Coverage

- `server/tests/integration/member-agents-auto-bootstrap.test.ts` — first-call auto-create, subsequent calls don't re-trigger the warning, idempotent agent-update path, PATCH does not auto-bootstrap.
- `server/tests/integration/organizations-tier-not-caller-controlled.test.ts` — caller-supplied `membership_tier` stays NULL on the DB row; caller-supplied `corporate_domain` mismatching the email no longer 400s and the server-derived domain wins.

### Follow-up

The true one-call storefront experience (`POST /api/me/agents` auto-bootstrapping the org as well as the profile when the caller has none) requires extracting the 446-line `POST /api/organizations` handler into a callable helper. Tracked separately so the security fix and the documented contract land first.
