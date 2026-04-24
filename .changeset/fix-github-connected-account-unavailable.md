---
---

**Fix: distinguish WorkOS unavailable from not-connected in getGitHubConnectedAccount**

`getGitHubConnectedAccount` previously swallowed all non-404 WorkOS errors
and returned `null`, causing the member-hub Connections card to show a
"Connect GitHub" button during a WorkOS outage. Users who were already
connected could inadvertently trigger double-consent or hit a 502 on the
authorize endpoint.

**Changed:**

- `server/src/services/pipes.ts` — `getGitHubConnectedAccount` now returns a
  discriminated union: `{ status: 'connected', login }`, `{ status: 'not_connected' }`,
  or `{ status: 'unavailable', reason }`. Non-404 WorkOS errors map to
  `unavailable` instead of collapsing into `null`.
- `server/src/http.ts` — `GET /api/me/connected-accounts/github` returns HTTP
  503 with `{ connected: false, unavailable: true }` when the status is
  `unavailable`. Callers that do not handle 503 degrade to their existing
  error branch (no regression).
- `server/public/membership/hub.html` — `renderConnections` now renders a
  "temporarily unavailable" message and omits the Connect button when the
  API returns 503. This prevents users from triggering the authorize flow
  during an outage.

**Tests:** `server/tests/unit/pipes-connected-account.test.ts` — 5 new tests
covering connected (with external_user_handle), connected (with external_handle
fallback), not_connected (404), unavailable (5xx), and unavailable (network
error without status code).

Closes #2997.
