# Individual and org journeys

## Problem

The community hub and membership hub both show organization-level journey stages
to individual users. A person at Acme Agency sees "Your journey: Participating"
because *someone* at Acme joined a working group — not because they personally
did anything. This creates three problems:

1. **Individual users can't see their own progression.** There's no "here's what
   you've done, here's what to do next" for a person. The journey stages on the
   hub are org-level milestones that most individuals don't control (agent
   registration, subscription billing, leadership appointments).

2. **Org admins can't see how their people are engaging.** The org journey is a
   single linear stage, but what matters is: how many of our people are
   certified? Who's in working groups? Are we getting value from this membership?

3. **Individual members (not part of an org) have no journey at all.** A solo
   consultant paying $250/year sees org-level stages that don't apply to them.

## Goal

Split engagement tracking into two linked tracks:

- **User journey** — personal progression through the community, shown on the
  community hub. Works the same whether you're at Acme Agency or you're
  independent.

- **Member dashboard** — org health and engagement, shown to org admins on the
  membership hub. Aggregates individual engagement into an org-level picture
  framed by what kind of company you are.

## Design principles

- The user journey is about *you*. What have you done, what could you do next.
- The member dashboard is about *your org's people*. Are they active, are they
  certified, are they showing up.
- Org health is a function of individual engagement, not a separate linear
  progression. There's no "org stage" to advance through — there's a health
  score based on how your people are engaging and whether your tech is
  integrated.
- Individual members (no org) get the user journey. That's their whole
  experience. It should be complete on its own.
- People don't churn from communities; companies do. Individual journeys create
  stickiness that survives company priority shifts.

## User journey (community hub)

### What it shows

The user journey tracks personal engagement across the community. It answers:
"what have I done, and what should I do next?"

**Progression areas** (not a linear stepper — more like a radar or checklist):

| Area | What it tracks | Data source |
|------|---------------|-------------|
| Certification | Modules completed, credentials earned, current track | `learner_progress`, `certification_attempts`, `user_credentials` |
| Working groups | Groups joined, sessions attended, leadership roles | `working_group_memberships`, `working_group_leaders` |
| Content | Perspectives published, status | `perspectives` by user |
| Community | Events attended, Slack activity, profile completeness | `MemberCapabilities` |
| Learning | Protocol familiarity, documentation engagement | Certification progress as proxy |

These are independent dimensions. A person can be deep in certification but not
in any working groups. That's fine — the hub shows what they've done and
suggests what's relevant next.

### Primary visual: tier stepper

The existing tier progression (explorer → connector → champion → pioneer) is
already individual and point-based. It stays as the primary progression visual
on the community hub. Thresholds:

| Tier | Points | What earns points |
|------|--------|-------------------|
| Explorer | 0 | Starting tier |
| Connector | 50 | Working group joined (10), event attended (25), connection made (10) |
| Champion | 200 | Content published (50), WG leadership (30), event registered (5) |
| Pioneer | 500 | Sustained contribution across all areas |

Points come from the `community_points` table, already per-user. Each action
is recorded with a reference to the source (working group ID, event ID, etc.),
so the hub can show *what* earned the points, not just a number.

The tier stepper answers "how far along am I overall." The detail cards
underneath answer "what have I done" and "what should I do next."

### Relationship stage as context

The `person_relationships.stage` (prospect, welcomed, exploring, participating,
contributing, leading) provides Addie with engagement context but is **not**
displayed on the hub. It's too abstract for users to care about. The tier
system is the user-facing progression; relationship stages are Addie's internal
model.

### Next step suggestions

Based on what the user hasn't done yet, surface 1-2 contextual nudges:

- No certification started → "Start your foundations certification"
- Not in any working group → "Join a working group" (with persona-based
  recommendations if available)
- No content contributed → "Share a perspective" (only after participating stage)
- Profile incomplete → "Complete your profile"

These replace the current org-level milestone achievements on the community hub.

### API: `GET /api/me/journey`

Returns individual user data (not org data):

```typescript
interface UserJourney {
  // Certification
  certification: {
    credentials: Array<{
      credential_id: string;
      name: string;
      awarded_at: string;
    }>;
    current_track: {
      track_id: string;
      track_name: string;
      modules_completed: number;
      modules_total: number;
    } | null;
    modules_completed: number;
  };

  // Working groups
  working_groups: {
    active: Array<{
      id: string;
      name: string;
      joined_at: string;
    }>;
    leadership_roles: Array<{
      group_id: string;
      group_name: string;
    }>;
  };

  // Content
  contributions: Array<{
    title: string;
    content_type: string;
    status: string;
    created_at: string;
  }>;

  // Community engagement
  community: {
    profile_completeness: number; // 0-100
    events_attended: number;
    member_since: string;
    last_active: string;
  };

  // What to do next (computed server-side)
  suggested_next_steps: Array<{
    action: string;      // e.g. "start_certification", "join_working_group"
    label: string;       // Human-readable label
    url: string;         // Where to go
    context?: string;    // Why this suggestion (e.g. "recommended for your role")
  }>;
}
```

### Data assembly

All of this data already exists in the database. No new tables needed. The
endpoint queries:

- `community_points` (by `workos_user_id`) — tier computation and point
  breakdown with action/reference details
- `learner_progress` + `certification_attempts` + `user_credentials` (by
  `workos_user_id`)
- `working_group_memberships` + `working_group_leaders` (by `workos_user_id`)
- `perspectives` (by `proposer_user_id`)
- `getMemberCapabilities()` (already computed per user)

The `community_points` table already records each action with its source
(`reference_id`, `reference_type`), so the journey endpoint can show "You
earned 25 points for attending the March creative council" — not just a total.

Next step suggestions are rule-based: check what's missing and suggest the
highest-value action. No LLM needed.

## Member dashboard (membership hub)

### What it shows

The member dashboard shows org admins how their organization is engaging with
the community. It answers: "are we getting value from our membership, and how
can we get more?"

**Org health score** — a single number (0-100) derived from:

| Signal | Weight | Source |
|--------|--------|--------|
| People certified (% of contributor seats) | High | `user_credentials` by org members |
| People in working groups | High | `working_group_memberships` by org members |
| Active users (logged in last 30d) | Medium | Login signals |
| Content contributions | Medium | `perspectives` by org members |
| Leadership roles held | Medium | `working_group_leaders` by org members |
| Tech integration (agents registered, briefs sent) | Medium | Org-level signals |
| Seat utilization (active seats / paid seats) | Low | `organization_memberships` |
| Aggregate community points | Low | `community_points` summed across org members |

The score replaces the linear org journey stepper. Instead of "you're at
participating," it's "your health score is 72 — here's what's driving it and
what would improve it."

Note: `community_points` already aggregates per-user across the org in the
engagement endpoint. The health score uses this as one signal among many —
the percentage-based breakdowns (cert %, group %, active %) matter more than
raw point totals for org health.

### Org type framing

Different orgs care about different things. An agency running buys cares about
agent registration and buyer certification. A publisher cares about seller
integration. A tech vendor cares about protocol compliance.

The dashboard doesn't change shape per org type, but the "how to improve"
suggestions should be relevant:

- Agency → "3 of 8 people are certified. Certify your media buyers."
- Publisher → "No seller agents registered. Connect your ad server."
- Tech vendor → "Join the integration working group."

Org type comes from `organizations.persona` (which maps to company type).

### People table

Show who's doing what:

| Person | Certified | Working groups | Last active | Contributions |
|--------|-----------|---------------|-------------|---------------|
| Pia    | Practitioner | Media buying, Creative | 2 days ago | 3 perspectives |
| Marco  | Basics | — | 14 days ago | — |
| Jan    | — | — | 45 days ago | — |

This makes engagement visible. The admin can see that Pia is a champion and Jan
has never engaged. This drives internal conversations about whether those seats
are being used.

### Champions

Identify people who are disproportionately engaged:

- Most credentials earned
- Most working groups
- Content contributors
- Leadership roles

Recognizing champions matters for two reasons: the org admin sees who's driving
value, and the individuals feel recognized.

### API: `GET /api/me/org-health`

Returns org-level aggregation (requires org admin or contributor seat):

```typescript
interface OrgHealth {
  organization: {
    name: string;
    membership_tier: string;
    persona: string | null;
    member_since: string;
  };

  health_score: number; // 0-100

  health_breakdown: {
    certification_pct: number;    // % of contributor seats certified
    working_group_pct: number;    // % of contributor seats in groups
    active_pct: number;           // % of seats active in last 30d
    content_contributions: number;
    leadership_roles: number;
    tech_integration: {
      agents_registered: number;
      briefs_sent_30d: number;
    };
  };

  people: Array<{
    name: string;
    email: string;
    seat_type: string;
    credentials: string[];
    working_groups: string[];
    last_active: string | null;
    contribution_count: number;
  }>;

  champions: Array<{
    name: string;
    highlights: string[]; // e.g. ["Practitioner certified", "Leads media buying group"]
  }>;

  suggested_actions: Array<{
    action: string;
    label: string;
    impact: string; // e.g. "Would increase health score by ~8 points"
  }>;
}
```

## How the two tracks connect

The member dashboard is the aggregation of individual journeys, not a separate
system.

```
Individual journeys (per person)
  ├── Pia: certified, 2 groups, contributing
  ├── Marco: basics cert, no groups
  └── Jan: nothing

          ↓ aggregation

Org health dashboard
  ├── 33% certified (1 of 3 contributor seats)
  ├── 33% in working groups
  ├── 67% active in last 30d
  └── Health score: 45
```

For individual members (no org), there is no member dashboard. Their user
journey is the complete experience.

For org members, both are available:
- Member hub (`/membership/hub.html`) → your personal journey
- Org dashboard (`/dashboard/organization`) → your org's health (admin/owner)

## Current state

The site already partially implements this split:

### Member hub (`membership/hub.html`) — mostly individual already

The hub is already personal: greeting by name, personal academy progress,
working group membership, profile completeness, content studio, and contextual
next step suggestions. **But it still renders the org journey stepper**
(aware → evaluating → joined → ... → advocating) using org-level milestone
data from `/api/me/engagement`. The "Score" shown in the header is the org's
aggregate community points, not the individual's.

### Org dashboard (`dashboard-organization.html`) — exists but incomplete

Already shows: contributor/community seat usage, team certified %, membership
tier badge, agent registration and compliance. **Missing**: health score,
health breakdown, people table, champions, suggested actions by org type.

### Dashboard nav (`dashboard-nav.js`) — already splits the two

Navigation already hides org sections (Team, Directory, Agents) from
non-admins and personal workspaces. The structure supports the two-track
model.

## What changes

### Member hub (`membership/hub.html`)

- **Remove**: Org journey stepper (the 8-stage `STAGES` array and
  `renderLevelProgress` function that shows aware → advocating)
- **Remove**: Org-level milestone achievements (has_working_groups,
  has_content_proposals, etc. tied to org journey stages)
- **Replace with**: Tier stepper (explorer → connector → champion → pioneer)
  using the user's personal `community_points` total and the 100/200/500
  thresholds. The tier data is already per-user in the `community_points`
  table.
- **Fix**: Header score should show personal community points, not org
  aggregate. The engagement endpoint currently sums across the org.
- **Keep**: Academy progress, working groups, profile, content studio, next
  step suggestions — all already individual

### Org dashboard (`dashboard-organization.html`)

- **Add**: Health score ring (reuse the SVG pattern from the member hub)
- **Add**: Health breakdown (certification %, group %, active %, etc.)
- **Add**: People table with per-person engagement
- **Add**: Champions section
- **Add**: Suggested actions framed by org type
- **Keep**: Seat usage, team cert %, membership tier, agents

### APIs

- **Add**: `GET /api/me/journey` — personal journey data (tier, points
  breakdown, certification, groups, contributions, next steps). Replaces the
  individual portions of `/api/me/engagement`.
- **Add**: `GET /api/me/org-health` — org health aggregation (health score,
  breakdown, people table, champions, suggested actions). Replaces the org
  portions of `/api/me/engagement`.
- **Deprecate**: `/api/me/engagement` once both new endpoints are live. Keep
  for backward compat during transition.

## UX considerations

### Empty state

New users with fewer than 2 completed actions should not see a scorecard of zeros. Lead
with "here's what to do first" and minimize the progress display. The empty
state is an invitation, not a report card.

### Tier visibility

Show only the current tier and next tier threshold. "Here's what Connectors do"
is motivating. "You're Explorer and there are three levels above you" is a
mountain.

### Returning inactive users

Users returning after inactivity should see "what changed since you were here"
(new working groups, new cert tracks, community activity) rather than evidence
of absence. Don't lead with "you haven't done anything in 45 days."

### Social proof (not leaderboards)

Surface anonymous community activity to create momentum without competition:
"12 people earned Practitioner this month," "3 new perspectives published this
week." These appear alongside next step suggestions to reinforce that others
are doing these things too.

### Milestone moments

When a user earns a credential, completes a module, or reaches a new tier, the
hub should acknowledge it prominently. This is the peak engagement moment —
don't waste it on a silent database update.

### Connecting the tracks

For non-admin org members, show one line connecting their individual progress
to the org: "You're one of 3 certified people at Acme." This creates both
social proof and a sense of contribution without requiring admin access.

### Health score trajectory

The member dashboard should show trajectory, not just a snapshot: "72, up from
58 last quarter." Score movement is more actionable than a static number.

## How Addie uses this data

### Journey context in outreach

Addie's `RelationshipContext` should include journey data: current tier,
certification progress with named tracks, working group names and tenure,
contributions, and the user's suggested next steps. Both reactive (user
messages Addie) and proactive (engagement planner) paths need this.

This means the user and Addie are looking at the same recommendations. When the
user sees "Start your foundations certification" on their hub and Addie
mentions it in a DM, it reinforces rather than surprises.

### Behavioral rules

- Reference achievements, not metrics. "You earned Basics" yes. "Your tier
  score is 34" no.
- Champions get brief, peer-tone messages. Ask for their help, don't guide
  them.
- Disengaged people get value first, asks second. One thing at a time.
- Individual members (no org) — their journey IS their membership value. Make
  it feel complete.
- Journey-aware tone: if they have credentials, don't explain basics they've
  certified on.

### Org-admin-specific engagement

The engagement planner needs admin-targeted opportunities:

- `org_health_review` — "Your team's engagement score went up 8 points since
  Pia got certified." Condition: `is_org_admin`, minStage: exploring.
- `team_certification_push` — "N of your people haven't started certification.
  Want me to send them an invite?" Condition: `is_org_admin` and
  `cert_pct < 50%`.
- `seat_utilization_check` — "N seats haven't logged in this month." Condition:
  `is_org_admin` and `active_pct < 50%`.

These don't exist in the opportunity catalog today.

### Cross-person context within an org

When Addie messages Jan at Acme, she should know that Pia is a champion at
Acme. `loadRelationshipContext()` should optionally include notable colleagues
— people at the same org who are more engaged — so Sonnet can reference them
naturally: "Your colleague Pia has been running sessions in the media buying
group."

### Champion-driven referrals

Champions who are contributing or leading are Addie's lightest-touch
relationships. Addie can broker introductions: "You've been one of the most
active people in the media buying group. A new member from [Company] just
joined and they're building something similar. Would you be open to a quick
intro?"

This uses champion identification from the org health data to create
cross-org connection opportunities.

### Admin-to-Addie delegation

The people table shows who's disengaged. There should be a mechanism for an
admin to request outreach: "nudge Marco about certification." This sets a
priority flag on the person's relationship record that the engagement planner
picks up. This closes the loop between the dashboard (which shows the data) and
Addie (who does the outreach).

### Expansion signals

Org health score creates natural moments for membership tier conversations:
- Individual ($250) with 5 active people → Builder ($2.5K) candidate
- Builder with high health scores and leadership roles → Member ($10K) candidate

The engagement planner should have a `suggest_membership_upgrade` opportunity
that fires when health signals indicate the org has outgrown its tier.

## What this does NOT include

- **Changing `person_relationships` stages.** The individual journey stages
  (prospect → leading) stay as Addie's internal engagement model. They're not
  displayed to users.
- **Changing org journey computation.** `journey-computation.ts` stays for
  internal use. The health score is a new, separate computation.
- **Billing or subscription management.** The member dashboard shows health, not
  invoices.
- **Cross-org views.** A person at multiple orgs sees the community hub for
  themselves. Org health is per-org. No cross-org aggregation.
- **Public leaderboards.** Champions are visible to org admins only, not
  publicly ranked.

## Success criteria

### User journey (community hub)
- [ ] Hub shows personal certification, working groups, contributions
- [ ] Tier stepper is the primary progression visual
- [ ] Individual members (no org) have a complete experience
- [ ] Empty state leads with action, not empty progress bars
- [ ] Milestone moments are acknowledged visually
- [ ] Social proof appears alongside suggestions ("12 people earned Practitioner
      this month")
- [ ] Org members see "You're one of N certified at [Company]"

### Member dashboard (membership hub)
- [ ] Health score replaces linear org journey stepper
- [ ] Health breakdown shows certification %, group %, active %, etc.
- [ ] Health score shows trajectory ("up from 58 last quarter")
- [ ] People table shows per-person engagement
- [ ] Champions are identified and highlighted
- [ ] Suggested actions are framed by org type
- [ ] Health score is derived from individual engagement (not manually set)

### Addie integration
- [ ] Journey data (tier, certs, groups, contributions, next steps) flows into
      RelationshipContext
- [ ] Engagement planner has admin-targeted opportunities (health review, cert
      push, seat utilization)
- [ ] Cross-person context: Addie knows about notable colleagues at same org
- [ ] Admin-to-Addie delegation: admin can request outreach for specific people
- [ ] Expansion signal: planner identifies orgs that have outgrown their tier
