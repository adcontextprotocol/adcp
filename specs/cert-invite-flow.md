# Team certification invite flow

## What we're building

A champion who wants their team to get certified can invite specific people directly from the team certification panel on the dashboard. Today, they copy a generic enrollment link and paste it into Slack or email. That works but loses signal — we don't know who was invited, who ignored the invite, or who the champion actually expects to certify.

This feature adds targeted invitations: the champion enters email addresses, each person gets a branded invite linking them straight to certification, and the tracking panel shows their status from "invited" through "completed."

## Why

Celtra's champion sold certification at their company kickoff and gave out ~27 logins. They want to track who has started. But there's a gap between "I told 27 people to do this" and "27 people showed up in the system." The generic enrollment link means:

- No record of who was told to certify
- No way to distinguish "hasn't signed up yet" from "doesn't know about it"
- Champion has to manually check with each person

The invite flow closes this gap.

## Core flow

```
Champion opens dashboard → certification tab → team panel
  |
  v
Clicks "Invite team members" button (below existing "Copy enrollment link")
  |
  v
Inline form appears: email input + "Send invites" button
  - Comma-separated or one-per-line email entry
  - Shows count: "3 invitations will be sent"
  |
  v
POST /api/organizations/:orgId/certification-invites
  - Validates emails
  - For each email:
    1. If person is already an org member → create cert expectation only
    2. If person is not an org member → send org invitation via WorkOS + create cert expectation
  |
  v
Tracking panel updates:
  - New status: "Invited" (person invited but hasn't signed up)
  - Existing statuses: "Not started" (signed up, no modules), "Active", "Inactive", "Completed"
```

## What changes

### New: `certification_expectations` table

```sql
CREATE TABLE certification_expectations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workos_organization_id TEXT NOT NULL REFERENCES organizations(workos_organization_id),
  email TEXT NOT NULL,
  invited_by TEXT NOT NULL,          -- workos_user_id of the champion
  workos_user_id TEXT,               -- set when the person signs up / is matched
  credential_target TEXT,            -- optional: specific credential they should earn (null = any)
  status TEXT NOT NULL DEFAULT 'invited'
    CHECK (status IN ('invited', 'joined', 'started', 'completed', 'declined')),
  invited_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  joined_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  UNIQUE(workos_organization_id, email)
);

CREATE INDEX idx_cert_expectations_org ON certification_expectations(workos_organization_id);
```

This is separate from `organization_memberships` because:
- An expectation can exist before the person joins the org
- Not every org member is expected to certify (only those the champion invites)
- It tracks certification-specific lifecycle, not org membership

### New: API endpoint

`POST /api/organizations/:orgId/certification-invites`

```typescript
// Request
{
  emails: string[]  // 1-50 emails
}

// Response
{
  invited: number,        // new invitations sent
  already_member: number, // already in org, cert expectation created
  already_invited: number // duplicate, skipped
}
```

Logic per email:
1. Check `certification_expectations` — if exists for this org+email, skip (already invited)
2. Check `organization_memberships` — if exists, create expectation with status `'joined'`, no org invite needed
3. Otherwise, send org invitation via existing WorkOS flow (`workos.userManagement.sendInvitation()`) and create expectation with status `'invited'`

Auth: caller must be org `admin` or `owner` (same check as existing invitation endpoint).

### Updated: certification summary API

`GET /api/organizations/:orgId/certification-summary`

Add to the response:
```typescript
{
  // existing fields...
  expectations: Array<{
    email: string;
    status: 'invited' | 'joined' | 'started' | 'completed' | 'declined';
    invited_at: string;
    invited_by_name: string;
  }>;
}
```

The tracking panel merges expectations with actual member data:
- Expectations with status `'invited'` show as "Invited (email)" in the member table
- Once matched to a `workos_user_id`, they merge with the existing member row and show real progress

### Updated: dashboard.html team panel

- "Invite team members" button below the "Copy enrollment link" button
- Clicking reveals an inline email input form (no modal)
- After sending, the member table refreshes and shows new "Invited" rows
- New status pill: `.cert-team-status--invited` (purple, distinguishes from "Not started")
- Summary stats update: "12 / 27 certified" becomes "12 / 27 certified (5 invited, not yet started)"

### Updated: relationship model integration

When a certification expectation is created, also create or update a `person_relationships` record for the invitee (if one doesn't exist). This ensures:
- Sage can send the invite email with relationship context
- The follow-up nudge system (see `cert-followup.md`) has a person to track
- If they eventually join Slack, the relationship is already there

## Matching invitees to members

When a new user joins an org (WorkOS webhook or membership sync), check `certification_expectations` for their email:
- If found with status `'invited'`, update to `'joined'`, set `workos_user_id` and `joined_at`
- The cert tracking panel now shows them as "Not started" instead of "Invited"

When a member completes a module or earns a credential, check if they have an expectation:
- First module started → update status to `'started'`, set `started_at`
- Credential earned matching `credential_target` (or any if null) → update to `'completed'`, set `completed_at`

These updates can be triggers on the existing `user_module_progress` and `user_credentials` tables, or checked on each certification summary API call (simpler, lower risk).

## Edge cases

- **Champion invites someone already in the org**: No WorkOS invite sent, just creates the cert expectation. Shows "Not started" immediately (not "Invited").
- **Champion invites someone who already has credentials**: Creates expectation with status `'completed'` immediately. Harmless — confirms they're done.
- **Email doesn't match anyone and they never join**: Stays as "Invited" indefinitely. Champion can see who hasn't responded.
- **Person declines the org invitation**: We don't get a decline webhook from WorkOS by default. The expectation stays as "Invited." Could add a manual "Remove" action later.
- **Champion invites 50+ people**: Cap at 50 per request. They can send multiple batches.
- **Non-admin tries to invite**: 403. Same permission model as existing org invitations.

## Out of scope

- Custom invitation email copy (use standard WorkOS invite email for now)
- Deadline setting ("complete by March 30")
- Removing/canceling an expectation
- Bulk CSV upload
- Manager/report hierarchy

## Success criteria

- [ ] Champion can enter emails and send certification invitations from the dashboard
- [ ] Invitees who aren't org members receive a WorkOS org invitation
- [ ] Invitees who are already org members get a cert expectation without a duplicate org invite
- [ ] Tracking panel shows "Invited" status for people who haven't joined yet
- [ ] When an invitee joins the org, their status updates from "Invited" to "Not started"
- [ ] When an invitee starts/completes certification, their expectation status updates
- [ ] Summary stats reflect invited-but-not-joined members
