---
---

feat(registry): add `POST /api/me/member-profile` to bootstrap an organization member profile via REST

Two existing registry endpoints (`GET /api/me/agents`, `POST /api/me/agents`) already advertise — in their `404` error descriptions — that callers should "create one via `POST /api/me/member-profile`". Until now that endpoint has only been reachable via the AAO dashboard's `/onboarding` form, which means downstream registry consumers (e.g. the Scope3 storefront's "Connect agents" dialog) cannot complete the sign-up→register-agent flow without dropping the user into a new tab on agenticadvertising.org.

This change adds the OpenAPI definition for both `GET /api/me/member-profile` (canonical "do I have a profile yet?" check) and `POST /api/me/member-profile` (first-time onboarding via REST). Body shape mirrors the dashboard's existing form: `organization_name`, `company_type`, `revenue_tier?`, `corporate_domain`, `primary_brand_domain?`, `marketing_opt_in?`, `membership_tier?`. Same domain-match invariant as the dashboard form (caller's email domain must equal `corporate_domain`; personal-email domains rejected).

Idempotent on `(organization_id, corporate_domain)` so a second call returns `200` with the existing profile rather than `409` — keeps client retry logic simple.

This is a **spec-only** change — the backend implementation is tracked separately in #TBD. Spec lands first so registry API consumers can build against the contract while the implementation is in flight.

Surfaced by: scope3data/agentic-api#2178 (Scope3 storefront "Connect agents" dialog needs to register AAO members natively, no iframe / popup).
