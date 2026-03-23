# Team certification tracking

## What we're building

When a user belongs to a non-personal organization, the Certification section on the main dashboard (`/dashboard#certification`) should show team certification progress alongside their individual progress. A champion who sold certification internally needs to see who started, who finished, and where the gaps are -- without leaving the dashboard.

The API already exists (`GET /api/organizations/:orgId/certification-summary`). The organization journey page already renders this data, but nobody finds it. This brings the data to where users already look.

## Origin

Celtra feedback: "if I could see who has done certification in this tab, currently the tab doesn't do much." They sold certification at a company kickoff, gave out logins, and want to track conversion. Reference: Amazon Ads Academy dashboard (summary stats, per-credential progress bars, certifications/users sub-tabs).

## Core flow

```
User opens dashboard → certification section loads
If user has a non-personal org:
  1. Fetch /api/me/certification/progress (existing, individual)
  2. Fetch /api/organizations/:orgId/certification-summary (existing, team)
  3. Render individual progress (existing behavior, unchanged)
  4. Render team overview below individual progress
```

No new pages. No new routes. One additional fetch call when an org exists.

## What the section looks like

The certification section currently shows:
- Earned credential badges
- X of 16 modules completed, Y in progress
- "Continue learning" / "Start learning" link

Below that, add a "Your team" panel (only when the user has a non-personal org):

### Summary row

Three stat cards in a horizontal row:

| Stat | Value | Source |
|------|-------|--------|
| Team certified | `members_with_credentials` / `total_members` | certification-summary |
| Credentials earned | sum of all `credentials_earned[].count` | certification-summary |
| Active learners | count of members where `modules_in_progress > 0` | certification-summary.members |

### Per-credential progress bars

For each entry in `credentials_earned`, show:

```
AdCP Basics          ████████░░░░░░  6 / 27
AdCP Practitioner    ███░░░░░░░░░░░  3 / 27
```

Bar width = `count / total_members`. Label is the credential name, count is `count` / `total_members`.

### Member list (collapsed by default)

A toggle-able table showing each member's status. Default: collapsed, showing "View team details" link. Expanded:

| Name | Credentials | Modules | Status |
|------|-------------|---------|--------|
| Alex Kim | Basics, Practitioner | 8 completed, 2 in progress | Active |
| Jordan Lee | Basics | 4 completed | Active |
| Sam Park | -- | 0 | Not started |

**Status** is derived:
- "Not started" = 0 modules completed and 0 in progress
- "Active" = modules_in_progress > 0
- "Completed" = has all available credentials (tier 1 + tier 2 at minimum)
- Otherwise show `N modules completed`

**Credentials column** currently returns IDs (e.g., `"basics"`, `"practitioner"`). See API change below.

## API change

### Add credential names to member records

The `members[].credentials` array currently returns credential IDs. The front-end needs display names without a separate lookup.

Change `OrgMemberCertification.credentials` from `string[]` to `Array<{ id: string; name: string; tier: number }>`.

In `getOrgCertificationSummary`, replace the credential ID list with objects:

```typescript
// current
credentials: credsByUser.get(m.workos_user_id) || [],

// change to
credentials: (credsByUser.get(m.workos_user_id) || []).map(id => {
  const cred = credsResult.rows.find(r => r.workos_user_id === m.workos_user_id && r.credential_id === id);
  return { id, name: cred?.credential_name || id, tier: cred?.tier || 0 };
}),
```

This also means changing the `credsByUser` map to store the full credential row instead of just the ID, which is cleaner. The `credentials_earned` array already has `credential` (name) and `tier`, so the top-level summary needs no changes.

Update `OrgMemberCertification`:

```typescript
export interface OrgMemberCertification {
  user_id: string;
  first_name: string;
  last_name: string;
  credentials: Array<{ id: string; name: string; tier: number }>;
  modules_completed: number;
  modules_in_progress: number;
}
```

No other API changes needed. The dashboard-organization page that consumes this endpoint only uses `credentials.length` for display, so the shape change is backward-compatible there (array length still works).

## Implementation

### dashboard.html changes

1. In `loadCertificationSection()`, after fetching individual progress, check if `currentOrg` exists and `!currentOrg.is_personal`.
2. If yes, fetch `/api/organizations/${currentOrg.id}/certification-summary`.
3. Render the team panel below the existing individual content.

The team panel uses the existing `.section-card` pattern with the existing cert CSS variables. New styles needed:

- `.cert-team` wrapper with a top border separator
- `.cert-team-stats` horizontal stat row (flexbox, gap)
- `.cert-team-stat` individual stat card (number + label)
- `.cert-team-bar` progress bar (same pattern as track progress bars on the certification page)
- `.cert-team-table` member list table
- `.cert-team-toggle` expand/collapse control

### certification-db.ts changes

Update `OrgMemberCertification` interface and the `credsByUser` map construction in `getOrgCertificationSummary` to store `{ id, name, tier }` objects instead of bare ID strings.

### dashboard-organization.html changes

Update any code that reads `member.credentials` to handle the new object shape. Check if it accesses `.length` (no change needed) or iterates over values (needs `.id` or `.name` access).

## Edge cases

- **User has no org**: Team panel does not render. Individual progress only.
- **User has a personal org**: Same as no org. Personal orgs are filtered out (`is_personal` check).
- **Org has 1 member** (just the viewer): Show the panel anyway. "Your team: 1 member" is accurate and prompts them to invite others.
- **Org has members but nobody started**: Show stats (0/N certified, 0 credentials) and the empty member table with "Not started" status for everyone. This is the "I gave out logins but nobody did anything" state -- the user needs to see this.
- **API fetch fails**: Log the error, skip the team panel silently. Individual progress still renders.
- **Large orgs (50+ members)**: The API already returns all members. For now this is fine -- the table is collapsed by default. If this becomes a problem, add pagination later.

## Out of scope

- Email nudges to team members who haven't started (belongs in relationship model)
- CSV export of team progress
- Admin vs. member permission differences (any org member can see team stats)
- Per-track breakdown (credentials are sufficient for now)
- Comparison to other organizations

## Success criteria

- [ ] User with a non-personal org sees team stats in the certification section
- [ ] Summary shows certified count, total credentials, active learners
- [ ] Per-credential progress bars reflect actual team adoption
- [ ] Member list shows each person's status with credential names (not IDs)
- [ ] Team panel does not appear for users without an org or with a personal org
- [ ] Existing individual progress display is unchanged
- [ ] dashboard-organization page still works with the updated API shape
