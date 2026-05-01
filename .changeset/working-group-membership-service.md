---
---

Extract a `working-group-membership-service` shared by the route handlers and Addie tools, fixing three Addie tools that have been silently broken since CSRF tightening:

- `join_working_group` — was returning *"this is a private working group"* for public groups (production-confirmed across multiple users this April).
- `express_council_interest` — was throwing on every call.
- `withdraw_council_interest` — was throwing on every call.

Root cause is the same loopback-CSRF pattern fixed for `probe_adcp_agent` / `check_publisher_authorization` in PR #3716: `callApi('POST', …)` from Addie hit our own CSRF middleware before reaching the route. Rather than route around CSRF, the route handlers and the Addie tools now both consume `joinWorkingGroup` / `expressCommitteeInterest` / `withdrawCommitteeInterest` directly. Service throws a discriminated `WorkingGroupMembershipError` (`group_not_found` / `group_private` / `community_only_seat_blocked` / `already_member` / `no_interest_recorded`) so each adapter renders the right HTTP status / chat message — no HTTP-status guessing.

Side effects (community points, badge checks, leader notifications, Slack channel auto-invite, Addie welcome DM) live in the service so they fire regardless of caller surface, and a future drift between web and chat surfaces is impossible.

Also extracts two cache-only modules (`addie/member-context-cache.ts` and `addie/admin-status-cache.ts`) so callers that just need to invalidate caches can do so without dragging in `middleware/auth` (WorkOS module-load) or `addie/services/engagement-planner` (Anthropic module-load). Keeps the unit-test import graph small and stops `admin-tools` from being a chokepoint.

Tracks issue #3736 (3 of 7 tools fixed; document/post tools follow in a second PR, then `callApi` POST/PUT/DELETE lockdown).
