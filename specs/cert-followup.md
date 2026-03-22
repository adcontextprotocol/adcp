# Automated certification follow-up

## What we're building

Sage (via the relationship model) automatically follows up with people who are expected to certify but haven't started, or who started but stalled. The champion sees progress in the tracking panel but doesn't have to chase anyone — Sage does it.

This builds on three existing systems:
- **Team certification tracking** (`specs/team-cert-tracking.md`) — the panel that shows who's where
- **Certification expectations** (`specs/cert-invite-flow.md`) — the invite flow that creates trackable expectations
- **Abandoned learner outreach** — the existing `resume_certification` engagement opportunity in the engagement planner

## Why

A champion who invites 27 people to certify shouldn't have to manually follow up with each one. That's busywork that kills adoption. The pattern we've seen: champion announces at kickoff → 15 sign up that week → 8 start a module → 4 finish → champion loses track and gives up.

Automated follow-up keeps the funnel moving without the champion spending time on it.

## Follow-up tiers

Three tiers of follow-up, each handled differently:

### Tier 1: Invited but not started

**Who:** People with a `certification_expectations` record where status is `'invited'` or `'joined'` and no modules started.

**When:** 5 days after invitation (gives them time to act on their own).

**What:** A gentle nudge from Sage explaining what the certification covers and how long it takes.

**How:** New engagement opportunity in the engagement planner:

```typescript
{
  keyword: 'cert_invite_nudge',
  dimension: 'engagement',
  score: 66,  // below resume_certification (68), above continue_certification (65)
  condition: (ctx) =>
    ctx.certificationSummary?.expectationStatus === 'invited' ||
    (ctx.certificationSummary?.expectationStatus === 'joined' &&
     ctx.certificationSummary?.modulesCompleted === 0 &&
     ctx.certificationSummary?.modulesInProgress === 0),
  cooldown: 7 * 24 * 60 * 60 * 1000, // 7 days between nudges
  maxAttempts: 2  // nudge twice, then stop
}
```

**Message guidance for Sonnet compose prompt:**
- Mention that their team is working on AdCP certification
- State the time commitment (~45 minutes for A1)
- Include a direct link to start
- Don't mention who invited them (avoids pressure dynamics)
- Tone: helpful, not urgent

### Tier 2: Started but stalled

**Who:** People with modules in progress but no activity in 3+ days.

**How:** This already exists. The `resume_certification` engagement opportunity fires when `abandonedModuleTitle` is set in `CertificationSummary`. No changes needed to the engagement planner for this tier.

**Enhancement:** Add team context to the compose prompt when the person has a certification expectation. Sonnet can mention "Your team at [Company] is 60% through certification" as social proof, without being pushy.

To do this, extend `CertificationSummary` in the relationship context:

```typescript
interface CertificationSummary {
  // existing fields...
  abandonedModuleTitle?: string;

  // new fields
  expectationStatus?: 'invited' | 'joined' | 'started' | 'completed';
  teamCertProgress?: {
    certified: number;
    total: number;
  };
}
```

The compose prompt addition when `teamCertProgress` is present:
```
The person's team has ${certified} of ${total} members certified.
You may mention this as encouragement if it feels natural, but don't
make it the focus. The goal is helping them finish, not guilting them.
```

### Tier 3: Completed

**Who:** People who earn a credential matching their expectation.

**What:** Congratulations + next step suggestion.

**How:** New engagement opportunity:

```typescript
{
  keyword: 'cert_completion_congrats',
  dimension: 'recognition',
  score: 72,  // recognition opportunities score higher
  condition: (ctx) =>
    ctx.certificationSummary?.expectationStatus === 'completed' &&
    !ctx.certificationSummary?.completionCelebrated,
  cooldown: 0,  // fires once
  maxAttempts: 1
}
```

**Message guidance:**
- Congratulate them on earning the credential
- If there's a next tier available (A1 → A2), mention it
- If their team is close to 100%, mention that ("Your team is now 90% certified!")
- Link to their credential/badge

### No follow-up for declined

If someone explicitly opts out of certification (future feature) or the champion removes their expectation, no follow-up fires. The engagement planner checks `expectationStatus !== 'declined'` before generating cert-related opportunities.

## Channel selection

Follow-up messages go through the existing relationship model channel selection:

1. If the person is on Slack → Slack DM (continues existing thread)
2. If email only → email via Sage
3. Respect `contact_preference` on `person_relationships` if set

For Tier 1 (not yet in the org), the person may only have an email. That's fine — Sage sends email. When they join and get a Slack account, future messages shift to Slack.

## Data flow

```
certification_expectations table
  |
  v
loadCertificationSummary() — extended to include expectation data
  |
  v
EngagementContext.certificationSummary — now has expectationStatus + teamCertProgress
  |
  v
Engagement planner evaluates opportunities:
  - cert_invite_nudge (Tier 1)
  - resume_certification (Tier 2, existing)
  - cert_completion_congrats (Tier 3)
  |
  v
buildComposePrompt() — includes team cert context when available
  |
  v
Sonnet composes personalized message
  |
  v
Send via Slack DM or email
```

## What changes in code

### certification-db.ts

Add query to load expectation status for a person:

```typescript
async function getCertExpectation(
  orgId: string,
  email: string
): Promise<{ status: string; invitedAt: Date } | null>
```

### relationship-context.ts → loadCertificationSummary()

Extend to include:
- `expectationStatus` from `certification_expectations`
- `teamCertProgress` from the org certification summary (reuse existing query)
- `completionCelebrated` flag (check if `cert_completion_congrats` was already sent via goal/interaction history)

### engagement-planner.ts

Add two new engagement opportunities:
- `cert_invite_nudge` (Tier 1)
- `cert_completion_congrats` (Tier 3)

Extend compose prompt to include team certification context when available.

### No new scheduled jobs

All follow-up runs through the existing engagement planner scheduler. No separate cron job. The planner already evaluates every person on each run — it just gets two new opportunities to consider.

## Frequency and limits

- **Tier 1 (not started):** Max 2 nudges, 7 days apart. After that, stop. If they haven't started after two nudges, more messages won't help.
- **Tier 2 (stalled):** Existing `resume_certification` handles this. Currently fires once. Could increase to 2 attempts with existing cooldown logic.
- **Tier 3 (completed):** Exactly once. Celebration, not spam.
- **Global:** Respect the existing per-stage cooldowns in the engagement planner. Cert nudges don't bypass the overall contact frequency limits.

## Edge cases

- **Person has no relationship record yet (invited by email, not in system):** Create a `person_relationships` record at invite time (handled in `cert-invite-flow.md`). The engagement planner can then evaluate them on the next run.
- **Person is already engaged by Addie for other reasons:** The engagement planner picks the highest-scoring opportunity. If cert nudge scores lower than whatever else is pending, it waits. This is fine — we don't want to interrupt a working-group conversation to nag about certification.
- **Person completes certification before any nudge fires:** Tier 1 and 2 conditions won't match. Tier 3 fires. Clean.
- **Champion invites someone who already completed:** Expectation created with `'completed'` status. No nudges fire. Tier 3 might fire once if `completionCelebrated` is false, which is a nice touch.
- **Person opts out of Addie/Sage contact:** `person_relationships.opted_out = true` blocks all engagement opportunities, including cert follow-up. Respected.

## Out of scope

- Champion dashboard showing which nudges were sent (they see status changes, not message history)
- Configurable nudge timing per org
- Escalation to champion when someone is unresponsive
- Custom nudge messages set by champion
- Nudges for specific credential targets (treat all credentials equally for now)

## Success criteria

- [ ] People invited to certify who don't start receive a nudge after 5 days
- [ ] Nudges stop after 2 attempts for unresponsive people
- [ ] Stalled learners get re-engagement referencing their specific abandoned module (existing) + team context (new)
- [ ] Completed learners get a one-time congratulations with next-step suggestion
- [ ] Team progress ("your team is X% certified") appears in nudge messages when relevant
- [ ] All follow-up respects opt-out, contact preferences, and stage cooldowns
- [ ] No new scheduled jobs — runs through existing engagement planner
