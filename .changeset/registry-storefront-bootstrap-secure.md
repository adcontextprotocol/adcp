---
---

feat(registry): one-call storefront bootstrap on `POST /api/me/agents`, with `membership_tier` no longer caller-controlled

Strategic replacement for #4141. That PR collapsed the storefront-bootstrap chain from three calls to two by auto-creating the member profile on first `POST /api/me/agents`, but documented `POST /api/organizations` with two fields the handler should never have accepted from the caller. This PR keeps the profile auto-bootstrap, locks down the security gap, and pushes the auto-bootstrap one level further so the storefront experience collapses to **one call**.

### What works now

A third-party app holding only a user's OAuth token can:

```
POST /api/me/agents { url: "..." }
```

…and have the org, member profile, and registered agent all materialize in a single request. The response surfaces `org_auto_created: true` and `profile_auto_created: true` so the caller can render setup hints without having to detect the prior 4xx → bootstrap → retry shape.

### Changes

- **`POST /api/organizations` no longer accepts `membership_tier` from the caller.** The Stripe webhook (`http.ts:3904`) is the sole writer of `organizations.membership_tier` — accepting it from the caller let any authenticated user stamp tier intent on their org row, leaking tier-gated UI state (announcement targeting, member-context display, the `is_academic` prompt rule, internal admin/dashboard surfaces) until/unless a real subscription overwrote the column. Caller-supplied values are now logged and discarded.

- **`POST /api/organizations` no longer accepts `corporate_domain` from the caller.** The server derives the corporate domain from the authenticated user's email; accepting it as a field invited 400s when a caller's value disagreed with their email and gave nothing back when it agreed.

- **Org-creation logic extracted into `server/src/services/organization-bootstrap.ts`.** The 280-line route body is now a callable `performCreateOrganization(input, deps)` returning a discriminated outcome. The route handler maps outcome → HTTP status. Behavioral parity with the prior route (prospect adoption, FOR UPDATE row lock, ToS/privacy/marketing-opt-in recording, audit logging, dev-mode mock org IDs).

- **`POST /api/me/agents` auto-bootstraps the org** when the caller has zero memberships. Personal-vs-corporate is inferred from the email domain (free-email providers → `is_personal: true` with name `${first} ${last}'s Workspace`; corporate → `is_personal: false` with name derived from the domain root). Users with existing memberships but no `users.primary_organization_id` set fall through to a clear 400 telling them to pass `?org=<id>` rather than silently forking a new org.

- **`POST /api/me/agents` auto-bootstraps the member profile** when the caller's org doesn't have one yet (Emma's contribution from #4141, kept). Reuses `ensureMemberProfileExists` — the same helper Addie's `save_agent` tool uses.

- **`POST /api/organizations` is now documented in the public OpenAPI spec** under a new `Onboarding` tag. The tag prose makes clear that *most* callers don't need this endpoint — `POST /api/me/agents` covers the storefront use case directly. `POST /api/organizations` is the customization escape hatch (override org name / company_type / revenue_tier).

- **`server/public/onboarding.html`** stops sending the dropped fields. Paid-tier intent picked during onboarding is stashed in `localStorage.aao_intent_tier` so the dashboard's `/membership` page can pre-select it for Stripe checkout.

### Coverage

- `server/tests/integration/member-agents-auto-bootstrap.test.ts` — first-call profile auto-create, idempotent agent-update, PATCH does not auto-bootstrap, **org auto-bootstrap for corporate email**, **org auto-bootstrap for free-email provider creates personal workspace**, **memberships-without-primary returns 400 not silent fork**.
- `server/tests/integration/organizations-tier-not-caller-controlled.test.ts` — caller-supplied `membership_tier` stays NULL on the DB row; caller-supplied `corporate_domain` mismatching email no longer 400s and the server-derived domain wins.
