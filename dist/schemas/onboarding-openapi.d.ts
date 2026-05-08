/**
 * OpenAPI registrations for the onboarding REST surface.
 *
 * `POST /api/organizations` has existed in production for a long time but
 * has only ever been documented as a private endpoint exercised by the AAO
 * dashboard's `/onboarding` form. Surfacing it in the public spec is the
 * minimum-surface answer to the storefront-bootstrap question: a
 * third-party app holding only a user's OAuth token needs *one* documented
 * call to materialize the org, then `POST /api/me/agents` to land an agent
 * (which auto-creates the member profile on first call).
 *
 * Two fields the handler accepts but the public schema deliberately omits:
 *
 * - `membership_tier` — owned exclusively by the Stripe webhook. Accepting
 *   it from the caller would let any user stamp tier intent on their org
 *   row, leaking tier-gated UI state until/unless a real subscription
 *   overwrites the column.
 * - `corporate_domain` — server derives the value from the authenticated
 *   user's email. Accepting it as a field invited 400s when a caller's
 *   value disagreed with their email and gave nothing back when it agreed.
 *
 * Kept in its own module so the spec generator's import graph stays free
 * of route handlers (each route file's transitive imports pull in WorkOS
 * init, which fails at module load without env vars).
 */
export {};
//# sourceMappingURL=onboarding-openapi.d.ts.map