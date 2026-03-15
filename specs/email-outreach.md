# Addie proactive email outreach

## What we're building

Addie proactively emails prospects she owns who aren't reachable on Slack. These are companies discovered through prospect triage (domain enrichment from Slack users) where `prospect_owner = 'addie'` and `prospect_contact_email` exists. The goal: get them into the community or at least into a conversation.

This is the email equivalent of the existing Slack proactive outreach service. Same planner brain, different delivery channel.

## Design decisions

### 1. Extend the goal system with a `channel` field — planner chooses the channel

Do not create a parallel goal system. Add a `channel` column to `outreach_goals` with values `'slack' | 'email' | 'any'`.

- Existing goals default to `channel = 'slack'` (preserves current behavior)
- Email-specific goals (like "Cold Prospect Introduction") get `channel = 'email'`
- Goals that work on either channel get `channel = 'any'`

**The planner decides the channel, not the caller.** When the outreach scheduler runs, it doesn't separately query "Slack candidates" and "email candidates." It queries all reachable prospects/users and lets the planner determine the best channel for each:

- **Person is in Slack?** → Slack DM (existing behavior). More conversational, higher response rate.
- **Prospect has email but no Slack presence?** → Email. This is the new capability.
- **Person is in Slack AND has prospect email?** → Slack preferred (already in community). Email only if Slack outreach was exhausted or declined.

This prevents spam. One scheduler, one planner call per person, one channel selected. No parallel blasting.

### 2. Track email outreach in `user_goal_history` alongside Slack

Add a `channel` column to `user_goal_history`: `'slack' | 'email'`.

This lets the planner see cross-channel history. If Addie DMs someone on Slack about membership, she won't also email them about it. The `isAvailable` check already looks at goal history -- adding channel awareness means:

- Same goal + same channel within cooldown = blocked (existing behavior)
- Same goal + different channel within cooldown = blocked (prevents double-tap)
- Different goal + different channel = allowed (Slack DM about working groups, email about membership)

### 3. Prospect-centric context (not Slack-centric)

The Slack outreach system builds `PlannerContext` from `slack_user_mappings`. Email prospects often have no Slack presence at all. We need a parallel context builder that works from the `organizations` table:

```
organizations.prospect_contact_email  -> recipient
organizations.prospect_contact_name   -> display_name
organizations.name                    -> company name
organizations.company_type            -> company type
organizations.prospect_notes          -> context for Claude
organizations.prospect_status         -> eligibility filter
```

The `PlannerContext` interface stays the same. We just populate it differently.

### 4. Claude-composed emails, not templates

For Slack DMs, the outbound planner uses `message_template` with placeholder substitution (`{{user_name}}`, `{{company_name}}`). This works because Slack messages are short and informal.

Email needs a different approach:

- **Subject lines** need to be personalized and compelling (not "Join AgenticAdvertising.org")
- **Body copy** should reference what the company does, why the org is relevant to them
- **Tone** should be warmer and more contextual than a template allows

Use Claude (Sonnet — `ModelConfig.primary`) to compose each email. Outreach represents Addie and the organization; it needs to be careful and well thought through. Given:
- Prospect context (company name, type, enrichment data, contact name/title)
- Goal description and intent
- A style guide prompt (conversational, membership org, not enterprise sales)
- Constraints (CAN-SPAM requirements, length targets)

Store the generated subject and body in the goal history for auditability.

The style guide prompt should be a constant, not per-goal. Something like:

```
You are Addie, writing on behalf of AgenticAdvertising.org, a membership organization
for the ad tech and AI advertising industry. You are reaching out to someone who may
benefit from joining the community.

Write a short, personal email. Not a sales pitch. Think: a colleague letting someone
know about something relevant to their work.

Constraints:
- Subject line: 5-10 words, specific to the recipient's company/role
- Body: 3-5 short paragraphs max
- Include one clear call to action (reply, visit a link, or both)
- No marketing language ("exclusive", "limited time", "don't miss out")
- Sign off as "Addie" with no last name
- Reference something specific about their company when possible
```

### 5. Three-touch sequence, then stop

Email outreach for a given prospect follows a fixed cadence per goal:

| Touch | Timing | Purpose |
|-------|--------|---------|
| 1 | Day 0 | Introduction -- why AgenticAdvertising.org is relevant to them |
| 2 | Day 4 | Follow-up -- different angle, maybe reference a specific resource or event |
| 3 | Day 10 | Final -- brief, low-pressure, "happy to chat if interested" |

After 3 touches with no response, the goal status becomes `'declined'` (implicit). The prospect is not emailed again for that goal.

This maps cleanly onto the existing `max_attempts` and `days_between_attempts` fields on `outreach_goals`. For email-specific goals, set `max_attempts = 3` and `days_between_attempts` to the intervals above (we need to make this per-attempt rather than fixed -- see implementation notes).

If the prospect replies at any point, the interaction analyzer processes the response and updates the goal status. The sequence stops.

### 6. Start with one goal: "Membership Introduction"

Build the full system but seed it with a single email goal:

```
name: "Membership Introduction"
category: "invitation"
channel: "email"
description: "Introduce AgenticAdvertising.org to a prospect Addie owns"
success_insight_type: "membership_interest"
requires_company_type: []  -- any company type
base_priority: 70
max_attempts: 3
is_enabled: true
```

No templates on this goal. Claude composes every email fresh from prospect context.

Add more goals later (event invitations, content sharing, re-engagement) once we see how the first one performs.

### 7. CAN-SPAM compliance

Every outbound email must include:

- **Physical address**: AgenticAdvertising.org's address in the footer
- **Unsubscribe mechanism**: One-click opt-out link
- **Honest subject lines**: No deception (Claude's style guide handles this)
- **Sender identification**: `Addie from AgenticAdvertising.org <addie@agenticadvertising.org>`

For prospects without a `workos_user_id` (they haven't signed up), we can't use the existing `user_email_preferences` system which is keyed on `workos_user_id`. Instead:

- Create `prospect_email_preferences` table keyed on `email` with an `unsubscribe_token`
- Or extend `user_email_preferences` to work with email-only (no `workos_user_id` required)

The simpler option: extend the existing table. Make `workos_user_id` nullable, add a unique constraint on `email`, and look up preferences by email when no workos_user_id exists. When the prospect eventually signs up, merge the records.

### 8. No spam — one person, one channel, one conversation

The core anti-spam principle: **the planner picks one channel per person and commits to it.** There are no parallel outreach paths.

Safeguards:

1. **Single scheduler, unified candidate pool.** The outreach scheduler queries both Slack users and email-only prospects in a single pass. The planner sees the full picture and decides channel + goal together.

2. **Channel preference hierarchy.** Slack > Email. If someone is reachable on Slack, that's where Addie talks to them. Email is for prospects who aren't in the community yet.

3. **Cross-channel goal history.** If a goal was attempted on Slack, the planner sees it and won't re-attempt on email (and vice versa). The `isAvailable` check works across channels.

4. **Prospect status gates.** Email outreach only targets `'prospect'` or `'contacted'`. Anyone who has `'responded'`, `'interested'`, `'negotiating'` etc. from any channel is already in a conversation — the sequence stops.

5. **Domain-based dedup.** Before emailing a prospect, check if any Slack user from the same email domain has active goal history. If so, skip — someone at that company is already being engaged.

6. **Conservative rate limits.** Max 5 emails per scheduler run. The scheduler runs every 30 minutes but most runs will send 0-2 emails. Quality over quantity.

## Data model changes

### outreach_goals

```sql
ALTER TABLE outreach_goals
  ADD COLUMN channel TEXT NOT NULL DEFAULT 'any'
    CHECK (channel IN ('slack', 'email', 'any'));
```

### user_goal_history

```sql
ALTER TABLE user_goal_history
  ADD COLUMN channel TEXT NOT NULL DEFAULT 'slack'
    CHECK (channel IN ('slack', 'email')),
  ADD COLUMN prospect_org_id TEXT REFERENCES organizations(workos_organization_id),
  ADD COLUMN email_subject TEXT,
  ADD COLUMN email_body TEXT;
```

`prospect_org_id` links email outreach to the organization (since there's no `slack_user_id` for pure email prospects). For Slack outreach, this stays null.

The `slack_user_id` column on `user_goal_history` becomes nullable for email-only prospects. We need a check constraint: either `slack_user_id` or `prospect_org_id` must be set.

### prospect_email_optouts

```sql
CREATE TABLE prospect_email_optouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  unsubscribe_token TEXT NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(16), 'base64url'),
  opted_out_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source TEXT NOT NULL DEFAULT 'unsubscribe_link',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Separate from `user_email_preferences` because prospects aren't users. When a prospect signs up, check this table and honor existing opt-outs.

### organizations (existing -- add tracking columns)

```sql
ALTER TABLE organizations
  ADD COLUMN last_email_outreach_at TIMESTAMPTZ,
  ADD COLUMN email_outreach_count INTEGER NOT NULL DEFAULT 0;
```

## Core flow

The existing Slack outreach scheduler is extended to handle both channels. Not two schedulers.

```
Outreach scheduler runs (every 20 minutes, existing job)
  |
  v
Query unified candidate pool:
  Pool A (Slack): existing slack_user_mappings query (unchanged)
  Pool B (Email): Addie-owned prospects with contact email, no Slack presence
    - prospect_owner = 'addie'
    - prospect_contact_email IS NOT NULL
    - prospect_status IN ('prospect', 'contacted')
    - NOT in prospect_email_optouts
    - last_email_outreach_at IS NULL OR > 4 days ago
    - No Slack user from same email domain with active outreach
  |
  v
For each candidate (combined pool, limit 8 per run):
  |
  v
Build PlannerContext
  - Slack users: from slack_user_mappings (existing)
  - Email prospects: from organizations table (new)
  |
  v
OutboundPlanner.planNextAction(ctx)
  - Planner sees available_channels on context ('slack', 'email', or both)
  - Filters goals by compatible channel
  - Returns PlannedAction with selected channel
  |
  v
If goal found:
  |
  v
Route by channel:
  |
  +-- Slack: existing DM flow (unchanged)
  |
  +-- Email:
        Compose with Claude (Sonnet):
          - Input: prospect context + goal + style guide
          - Output: { subject, body }
        Send via Resend (from addie@agenticadvertising.org)
          - Unsubscribe link, physical address
          - Track in email_events
        Record in user_goal_history (channel='email', prospect_org_id)
        Update organizations.last_email_outreach_at
        Update organizations.prospect_status → 'contacted'
```

## Reply handling

Replies to `addie@agenticadvertising.org` already flow through the Resend inbound webhook. The existing `email-handler.ts` processes these reactively when Addie is explicitly invoked.

For prospect replies to outbound emails, we need to:

1. **Match the reply to the prospect.** Look up the sender's email in `organizations.prospect_contact_email` or match the email domain.

2. **Update goal history.** Find the most recent `user_goal_history` record for that prospect org where `channel = 'email'` and `status = 'sent'`. Update to `'responded'`.

3. **Run the interaction analyzer.** Extract sentiment, intent, and any insights from the reply. This already exists for Slack responses.

4. **Route the reply.** If the response indicates interest, update `prospect_status` to `'interested'` and create an action item for a human to follow up. If it's a question, Addie can respond conversationally using the existing email handler.

The key addition: when an inbound email arrives from a known prospect email, treat it as a response to the outbound sequence even if it doesn't explicitly mention Addie.

## Implementation plan

### Stage 1: Schema and planner changes
- Migration: add `channel` to `outreach_goals` and `user_goal_history`
- Migration: add `prospect_org_id`, `email_subject`, `email_body` to `user_goal_history`
- Migration: create `prospect_email_optouts`
- Migration: add `last_email_outreach_at`, `email_outreach_count` to `organizations`
- Update `OutboundPlanner` to accept `available_channels` on context and filter goals accordingly
- Add `PlannerContext` builder that works from organization data (email-only prospects)
- Seed the "Membership Introduction" goal with `channel = 'email'`

### Stage 2: Email composition
- Create `composeProspectEmail` function using Claude Sonnet (`ModelConfig.primary`)
- Style guide prompt constant
- Unsubscribe link generation for prospects (prospect_email_optouts table)
- HTML email rendering (reuse existing patterns from notifications/email.ts)

### Stage 3: Unified outreach scheduler
- Extend `runOutreachScheduler` to query email-only prospects alongside Slack users
- Route sends by channel based on planner decision (Slack DM or email)
- Domain-based dedup check before email sends
- Send + record flow for email channel

### Stage 4: Reply processing
- Extend inbound email webhook to match prospect replies to outbound sequences
- Update goal history on reply
- Run interaction analyzer on email responses
- Human escalation for interested prospects

### Stage 5: Admin visibility
- Add email outreach to the admin prospects view
- Show email history on prospect detail page
- Allow admin to trigger manual email outreach

## Success criteria

- [ ] Addie sends emails to prospects she owns who have contact emails
- [ ] Emails are personalized to the recipient's company and role
- [ ] Three-touch sequence respects timing (Day 0, Day 4, Day 10)
- [ ] Sequence stops on reply or after 3 touches
- [ ] CAN-SPAM compliant (unsubscribe, physical address, honest subjects)
- [ ] No overlap with Slack outreach for same company
- [ ] Replies are detected and update prospect status
- [ ] Admin can see email outreach history on prospect records
- [ ] Kill switch via `OUTREACH_ENABLED=false` applies to both channels

## What this does NOT include

- **Email templates in the admin UI.** Claude composes every email. If we want template editing later, that's a separate feature.
- **A/B testing.** Not enough volume to be meaningful yet. Revisit after 100+ sends.
- **Multi-contact sequences.** One contact per organization for now. If the contact bounces, mark the org and move on.
- **Warm handoff from email to Slack.** If a prospect replies positively, a human takes over. We don't auto-invite them to Slack (yet).
