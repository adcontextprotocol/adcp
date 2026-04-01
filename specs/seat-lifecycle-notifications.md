# Seat Lifecycle Notifications

## Problem

Org admins have tools to invite members with seat types and promote/demote
existing members, but the system is passive. Admins only learn about seat
pressure when an invite fails. New members who join via domain verification
land as `community_only` with no prompt to assign a seat type. When a company
upgrades tiers and unlocks more contributor seats, nobody tells the admin they
can now promote people. When a company downgrades, nobody tells them they're
over their new limit. The result is under-utilized entitlements, confused
members who don't understand why they can't access working groups, and silent
failures for single-admin orgs whose Slack notifications never fire.

## Goal

Make seat assignment a natural part of signup, upgrade, and ongoing team
management — so admins always know their seat posture and members get the
access they need without manual detective work.

## Design Principles

- **Pull, don't push** — surface seat decisions at natural moments (signup,
  upgrade, new member join) rather than sending unprompted reminders.
- **Admin is the decider** — the system recommends but never auto-promotes.
  Seat assignment is an intentional act.
- **Fail-closed stays** — `community_only` remains the default. These
  notifications exist so the default doesn't become a dead end.
- **Channel-appropriate** — Slack for real-time awareness, email for durable
  actions (upgrades, seat assignment links).
- **Close the loop** — both admins and members get feedback when seat state
  changes. No silent dead ends.
- **Escape user names** — all user-supplied strings in Slack messages must
  have `<>&` characters escaped to prevent mrkdwn injection.

## Scenarios

### 1. Company signup — seat entitlement awareness

**When**: A company completes payment during onboarding.

**What happens**:
- Enhance the existing `notifySubscriptionThankYou` message to include seat
  entitlement: "Your plan includes N contributor seats and M community seats.
  When teammates join, you'll get a prompt to assign access. Manage your
  team → [link to /team]"
- After payment confirmation, add an optional "Set up your team" step. Shows
  seat entitlement, existing members (if any from domain verification) with
  seat toggles, and an inline invite form. Skip button available — this is a
  nudge, not a gate. Most admins will skip; the real activation is Scenario 4
  when the first person joins.

**Where**: Thank-you message enhancement in subscription handler.
Onboarding step in `server/public/onboarding.html`.

**API**: Existing `GET /api/organizations/:orgId/members` (returns seat usage
and limits) + existing `PATCH` and invite endpoints.

### 2. Tier upgrade — new seats available

**When**: A subscription change results in higher seat limits (e.g.,
`company_standard` → `company_icl`, gaining 5 more contributor seats and 45
more community seats).

**What happens**:
- Detect the tier change in the subscription update handler. SELECT the
  current tier before the UPDATE, compare old limits vs new limits.
- If contributor or community limits increased, notify org admins via:
  - **Slack group DM**: "Your plan now includes N contributor seats (was X).
    You have Y unassigned. Manage your team → [link to /team]"
  - **Email to org owners**: Same content with a direct link.

**Where**: Subscription update handler in `server/src/http.ts` (the
`COALESCE($8, membership_tier)` update path). Notification via
`org-group-dm.ts` (Slack) and email service.

**Implementation note**: The current webhook handler does a conditional
update. Insert a SELECT for the current tier before the UPDATE so we can diff
limits. This is straightforward but must happen in the same transaction.

### 3. Tier downgrade — over-allocated seats

**When**: A subscription change results in lower seat limits and current
usage exceeds the new limit (e.g., `company_icl` → `company_standard`,
dropping from 10 to 5 contributor seats while 8 are in use).

**What happens**:
- Detect the tier change the same way as Scenario 2 (old vs new limits).
- If current usage exceeds new limits, notify org admins via:
  - **Slack group DM**: "Your plan now includes N contributor seats, but you
    have X assigned. Please choose which members to move to community seats.
    Manage your team → [deep link to /team]"
  - **Email to org owners**: Same content, framed as action required.
- Existing contributors keep their access until the admin acts. No
  auto-demotion. `canAddSeat()` blocks new contributor additions until
  usage is within limits.
- If the admin doesn't act within 7 days, send a reminder (once).

**Where**: Same subscription update handler as Scenario 2.

### 4. Seat usage warnings

**When**: Seat usage crosses a threshold.

**Thresholds**:
- **80% used** (e.g., 4/5 contributor seats) — informational
- **100% used** (e.g., 5/5) — action needed
- Check on every seat-consuming event: invite accepted, seat type changed,
  Slack mapping created, working group membership created.

**Exclusion**: Individual tiers (`individual_professional`,
`individual_academic`) are excluded from percentage-based warnings. A 1-seat
plan is either 0% or 100% — the 80% threshold is meaningless.

**What happens**:

At 80%:
- **Slack group DM** to org admins: "You're using N of M contributor seats.
  Need more? Upgrade your plan → [link to /membership]"

At 100%:
- **Slack group DM**: "All N contributor seats are in use. New invitations
  will be limited to community seats until you upgrade. Manage your team →
  [link to /team]"
- **Email to org owners**: Same content.

**Deduplication**: Store `last_seat_warning_threshold` (0, 80, 100) per org
per seat type. Only notify when crossing upward. Use hysteresis: the 80%
threshold re-arms when usage drops below 60%, not when it drops below 80%.
This prevents oscillation notifications for orgs that hover near the
boundary.

**Atomicity**: The threshold check and update must happen inside the same
`FOR UPDATE` transaction that `canAddSeat()` already holds, or use
`UPDATE ... WHERE last_contributor_seat_warning < $threshold RETURNING *`
to make the update conditional.

### 5. Seat freed — notify admin

**When**: A contributor leaves the org (removed by admin or self-departed)
and the org was previously at or above 80% usage.

**What happens**:
- **Slack group DM**: "A contributor seat has freed up. You're now using N
  of M contributor seats."
- Reset the warning threshold appropriately (applying hysteresis).

**Where**: Member removal handler in `organizations.ts`. Check previous
warning threshold to decide whether to notify.

### 6. New member join — admin notification with seat context

**When**: A member joins the org (via invite acceptance, domain verification,
or manual addition).

**What happens**:
- Enhance `notifyMemberAdded()` in `org-group-dm.ts` to include:
  - The member's assigned seat type
  - Current seat usage after this join: "Contributor seats: N/M"
  - If the member is `community_only` and contributor seats are available:
    "Promote to contributor? She'll gain access to working groups, councils,
    and product summits. (deep link to /team with action=promote&user=EMAIL)"
- For domain-verified joins (where no explicit seat type was chosen at invite
  time), the notification becomes the primary prompt for the admin to act.

**Batching**: If multiple members join via domain verification within a
30-minute window, consolidate into a single notification: "3 new members
joined: Alice, Bob, Carol. All assigned as community. You have 2 contributor
seats available. Manage team → [link to /team]"

**Where**: `server/src/slack/org-group-dm.ts` — extend `notifyMemberAdded()`.

### 7. Member requests seat upgrade

**When**: A `community_only` member hits a contributor gate (working group
join, council, product summit).

**What happens**:
- Current behavior: "Working group membership requires a contributor seat.
  Ask your org admin to upgrade your access." — this is good.
- Add: A "Request access" button that creates a seat upgrade request and
  notifies org admins.
- Admin notification via **Slack group DM** with an interactive "Approve"
  button that calls the seat assignment API directly (not just a link to
  /team). Secondary "Review team" link to `/team` for context.
- Admin notification also via **email** with a direct approve link, since
  the member is blocked now and delays hurt.
- The member sees: "Request sent to your org admin." with a pending status
  visible on their profile/dashboard.
- Rate limit: one pending request per member per resource. A member blocked
  from Working Group A and Council B can request both — the limit is
  per-resource, not global. This respects engaged members hitting multiple
  gates.

**Authorization**: The `POST /api/organizations/:orgId/seat-requests`
endpoint must verify:
1. The requesting user is a member of the org
2. The requesting user's current seat type is `community_only`
3. The `resource_type` is from a known set (`working_group`, `council`,
   `product_summit`)
4. No pending request exists for this user + resource

**Member status visibility**: Members can see their pending requests and
their resolution status. If the admin doesn't act within 48 hours, send a
reminder to admins (once). If still no action after 7 days, notify the
member: "Your admin hasn't responded. You can reach out to them directly."

**Where**: Gate points in `committees.ts`, `events.ts`, etc. New endpoint:
`POST /api/organizations/:orgId/seat-requests`.

**Data model**:
```sql
CREATE TABLE seat_upgrade_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL REFERENCES organizations(workos_org_id),
  user_id TEXT NOT NULL REFERENCES users(workos_user_id),
  requested_seat_type TEXT NOT NULL DEFAULT 'contributor',
  resource_type TEXT NOT NULL CHECK (resource_type IN
    ('working_group', 'council', 'product_summit')),
  resource_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'denied')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT REFERENCES users(workos_user_id),
  UNIQUE (organization_id, user_id, resource_type, resource_id)
    WHERE (status = 'pending')
);
```

### 8. Member notified on seat change

**When**: A member's seat type changes (promotion, demotion, or request
approval/denial).

**What happens**:
- **Slack DM** to the member (if they have a Slack mapping):
  - Promotion: "You now have contributor access! You can join working groups,
    councils, and product summits."
  - Demotion: "Your access has been changed to community. You still have
    access to Addie, certification, training, and chapters."
  - Request approved: "Your request to join RESOURCE has been approved.
    You now have contributor access."
  - Request denied: "Your admin has reviewed your request. Your access
    remains community-only. Contact your admin for details."

**Where**: Seat type update handler in `organizations.ts` PATCH endpoint.
Request resolution handler for `seat_upgrade_requests`.

### 9. Upgrade nudge at seat limit

**When**: An admin tries to invite with a seat type that's full, or tries to
promote a member when contributor seats are exhausted.

**Current behavior**: Returns an error with "Upgrade at /membership to add
more." — this works but is abrupt.

**Enhancement**:
- Show a richer inline message: "All N contributor seats are in use. You can
  free a seat by switching someone to community, or upgrade to the next tier
  for M more seats (direct link to upgrade flow)"
- Include the price delta if available from Stripe metadata.
- Contributor list scoped to org admins only — never shown in member-facing
  responses.

**Where**: `canAddSeat()` response handling in `team.html` invite modal and
edit modal.

## Slack Channel Fallback

The existing `org-group-dm.ts` requires 2+ admin Slack users to create a
group DM. For single-admin orgs (common at Builder tier), all Slack
notifications silently fail.

**Fix**: When only one admin has a Slack mapping, fall back to a direct DM
instead of a group DM. When zero admins have Slack mappings, email becomes
the primary channel for all notifications (not just the ones that already
specify email).

This applies to all scenarios above.

## Security

- **Mrkdwn injection**: All user-supplied strings (member names, org names)
  interpolated into Slack messages must escape `<>&` characters. Add an
  `escapeSlackMrkdwn()` utility used by all notification functions.
- **Seat request authorization**: Endpoint verifies org membership, current
  seat type, and valid resource type before creating a request.
- **No information leakage**: Member-facing responses never reveal admin
  names, admin count, or notification channel. Contributor lists in upgrade
  nudges are admin-only.
- **Audit logging**: All seat changes continue to be logged with action type,
  old/new values, and acting user.

## Data Model Changes

### New columns on `organizations`

```sql
ALTER TABLE organizations
  ADD COLUMN last_contributor_seat_warning INT DEFAULT 0,
  ADD COLUMN last_community_seat_warning INT DEFAULT 0;
```

Tracks the last warning threshold sent (0, 80, 100) to prevent duplicate
notifications. Uses hysteresis for re-arming (see Scenario 4).

### New table: `seat_upgrade_requests`

See schema in Scenario 7 above. Includes FK constraints and a partial unique
index on pending requests per user per resource.

## Notification Functions

### `escapeSlackMrkdwn(text: string): string`

Utility function. Escapes `&`, `<`, `>` in user-supplied strings before
interpolation into Slack mrkdwn blocks. Used by all notification functions.

### `notifySeatWarning(orgId, seatType, threshold, usage, limit)`

New function in `org-group-dm.ts`. Sends Slack group DM (or direct DM for
single-admin orgs) with seat usage context and action links.

### `notifyTierChange(orgId, oldLimits, newLimits, currentUsage)`

New function. Called from subscription update handler. Handles both upgrades
(Scenario 2) and downgrades (Scenario 3) based on limit comparison.

### `notifySeatRequest(orgId, memberName, resourceType, resourceName)`

New function. Sends Slack message with interactive "Approve" button + email
to org owners. Called when a member requests a seat upgrade at a gate point.

### `notifyMemberSeatChanged(userId, newSeatType, context?)`

New function. Notifies the member via Slack DM when their seat type changes.
`context` includes reason (admin action, request approved/denied).

### Enhanced `notifyMemberAdded()`

Add `seatType`, `seatUsage`, and `seatLimits` to the existing function
signature. Include seat context and promotion prompt in the Slack message.
Support batching for domain-verified joins within a 30-minute window.

## Phases

### Phase 1: Notifications layer
- Add `escapeSlackMrkdwn()` utility, apply to all existing notification
  functions
- Implement single-admin Slack DM fallback
- Enhance `notifyMemberAdded()` with seat context and promotion deep links
- Add seat warning notifications (80%, 100% thresholds) with hysteresis
- Add seat-freed notification
- Add `last_*_seat_warning` columns
- Detect tier changes (up and down) in subscription handler, notify admins
- Add member notification on seat type change

### Phase 2: Admin action improvements
- Richer error messages in team.html when seats are full (Scenario 9)
- Deep-link support in team.html (`?action=promote&user=...`)
- Domain-verified join batching (30-minute consolidation window)
- Optional "Set up your team" onboarding step
- Enhance thank-you message with seat entitlement info

### Phase 3: Member-initiated requests
- `seat_upgrade_requests` table and migration
- `POST /api/organizations/:orgId/seat-requests` endpoint with auth checks
- "Request access" button at gate points
- Interactive "Approve" button in Slack notifications
- Member-facing request status visibility
- 48-hour admin reminder and 7-day member notification
- Request approval/denial notifications to members

## Success Criteria

- [ ] Thank-you message on signup includes seat entitlement info
- [ ] Tier upgrades trigger Slack + email notification with new seat counts
- [ ] Tier downgrades notify admins when usage exceeds new limits
- [ ] Seat usage at 80% triggers one-time Slack notification (company tiers
      only)
- [ ] Seat usage at 100% triggers Slack + email notification
- [ ] Threshold notifications don't repeat until usage drops below 60%
      (hysteresis)
- [ ] `notifyMemberAdded()` includes seat type, usage, and promotion prompt
- [ ] Domain-verified joins within 30 minutes are batched into one
      notification
- [ ] Single-admin orgs receive direct DMs instead of silent failures
- [ ] Community-only members at gate points can request a contributor seat
- [ ] Admins receive seat upgrade requests with one-click Approve in Slack
- [ ] Members see pending request status and get notified on resolution
- [ ] Members get notified when their seat type changes
- [ ] All user names in Slack messages are mrkdwn-escaped
- [ ] Seat request endpoint verifies org membership and current seat type
- [ ] All seat changes continue to be audit-logged

## What This Does NOT Include

- Auto-promotion of members (admin must always decide)
- Auto-demotion on tier downgrade (admin chooses who to move)
- Seat usage analytics dashboard (future work)
- Billing integration for mid-cycle proration (Stripe handles this)
- Changes to the contributor derivation logic (Slack mapping, working group
  membership continue to grant contributor access independently)
