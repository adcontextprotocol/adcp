# New Member Announcements

## Problem

When a new company joins AAO, there's no automated path to a public welcome on Slack or LinkedIn. The internal Stripe webhook posts a private ops notification (`notifyNewSubscription` in `server/src/notifications/slack.ts:115`) but nothing reaches `#all-agentic-ads` or member networks.

The deeper blocker: many new members never publish their `member_profile` or brand.json, so we can't write a meaningful announcement even if we wanted to. The announcement work is downstream of profile completion.

## Goal

Two coupled workflows:

1. **Profile completion nudge** — Addie nudges new paying members on a fixed cadence to publish their profile and brand.json. Stops as soon as both exist.
2. **Auto-announce on publish** — when a member's profile flips to public AND they have a brand.json, Addie drafts a welcome announcement (Slack + LinkedIn copy) and routes it to the editorial working group for approval. On approve, the Slack post goes to `#all-agentic-ads`; LinkedIn copy is included for human paste.

## Design Principles

- **Consent by action.** Members opt in by publishing their public profile. No surprise announcements. No scraped logos.
- **Visual is theirs.** Corp logo from their own brand.json. Individual portrait from `portrait-generator.ts`. AAO mark as fallback. Never Brandfetch.
- **Human-in-the-loop for v1.** Drafts go to `#admin-editorial-review`. No silent auto-publish.
- **LinkedIn is copy-paste.** Building OAuth + Marketing API isn't worth it for v1. Approval message includes the LinkedIn copy ready to paste.
- **Nudge then stop.** Day 3, 7, 14, 30. After day 30, silence. No re-engagement loop.

## Workflow A — Profile completion nudge

### Trigger

A paying member is "incomplete" if either is true:
- No `member_profiles` row, OR `member_profiles.is_public = false`
- No brand.json manifest exists for their `primary_brand_domain` (community-hosted: `brands` row with `brand_manifest` containing at least one published agent; self-hosted: discovered + verified manifest)

### Cadence

Days **3, 7, 14, 30** measured from `subscription_status` becoming `active` (Stripe webhook timestamp). After day 30, stop. Manual re-trigger possible via admin.

### Channel

Addie Slack DM (primary). Email fallback if no Slack identity is linked.

### Content

Each nudge tells the member exactly what's missing and links to the editor:

- **Missing profile**: "Your AAO profile isn't published yet. Add a tagline, set your primary domain, and mark it public at `/me/profile` so people can find you."
- **Missing brand.json**: "Almost there — publish at least one agent in your brand.json so we can verify your domain. Editor: `/me/profile#agents`."
- **Both missing**: combine into one message.

Tone matches existing Addie nudges (`event-recap-nudge.ts`). Acknowledges if they're early in their week, doesn't lecture.

### Stop conditions

- Both gates met → stop, transition to Workflow B
- Day 30 reached → stop silently
- Member responds asking to opt out → stop, set `member_profiles.metadata.no_announcement = true`

### Implementation

New file: `server/src/addie/jobs/profile-completion-nudge.ts`

Pattern matches `server/src/addie/jobs/event-recap-nudge.ts`:
- Hourly job, business-hours gate
- Query: paying orgs where `subscription_status = 'active'` AND not announce-ready AND days-since-activation in {3, 7, 14, 30} (with idempotency via `org_activities` log)
- Send DM via existing `sendDirectMessage` in `server/src/slack/client.ts`
- Log each nudge to `org_activities` so we don't double-send

Register in `server/src/addie/jobs/job-definitions.ts`.

## Workflow B — Auto-announce on publish

### Trigger

Member transitions to **announce-ready**:
- `member_profiles.is_public = true`
- Brand.json manifest exists for `primary_brand_domain`
- `member_profiles.metadata.no_announcement` is not set
- No prior announcement for this org (idempotency via `org_activities`)

The PUT handler at `server/src/routes/member-profiles.ts:391` doesn't emit any event today. Add a check at the end of the handler: if the update transitions `is_public` from false → true, enqueue an announcement job.

### Draft generation

New service: `server/src/services/announcement-drafter.ts`. Wraps the Anthropic SDK using the same client setup as `server/src/addie/claude-client.ts`.

Inputs:
- Org: name, tier, headquarters, primary_brand_domain
- Profile: tagline, description, offerings
- Brand.json: agents (types, descriptions), brands (if present)
- Visual: resolved logo URL or portrait URL

Outputs:
- `slack_text` — single-paragraph welcome with company name, tagline, what they bring (from offerings/agents), link to their profile page
- `linkedin_text` — slightly longer, more LinkedIn-native (hashtags, line breaks, no Slack-isms)

System prompt rules:
- Write as AgenticAdvertising.org, not as the member
- Pull facts only from inputs — never fabricate
- If tagline is generic, lean on offerings + agent types for specificity
- No hyperbole. No "thrilled to welcome." Match Addie's existing voice.

### Visual resolution

```
if tier in (company_standard, company_icl):
  logo = brand_manifest.logo_url  // their self-claimed logo
  if not logo: logo = AAO_FALLBACK_MARK
elif tier in (individual_professional, individual_academic):
  portrait = portrait_db.getByMemberProfile(profile.id)
  if portrait and portrait.status == 'approved':
    visual = portrait.image_url
  else:
    visual = AAO_FALLBACK_MARK
```

### Editorial review

Post draft to `#admin-editorial-review` with Slack Block Kit:
- Header: "New member announcement ready: {Company}"
- Section: visual preview (image block)
- Section: Slack draft text
- Section: LinkedIn draft text (in code block for clean paste)
- Actions block: **Approve & Post** | **Edit Draft** | **Skip**

Handler routes:
- `Approve & Post` → posts `slack_text` + visual to `#all-agentic-ads`, marks org as announced in `org_activities`
- `Edit Draft` → opens a Slack modal with editable text fields, on submit posts the edited version
- `Skip` → marks org as `announcement_skipped`, no future re-trigger

Requires Slack app interactivity endpoint. Verify scopes in `server/src/slack/` setup before building.

### Backfill

One-shot script: `server/src/scripts/backfill-member-announcements.ts`

- Query the last ~10–15 already-announce-ready orgs by `created_at` desc
- For each, generate a draft and post to `#admin-editorial-review` with a `[BACKFILL]` tag in the header
- Same approval flow. Editorial team can space them out over a week to avoid a content dump.

Don't try to backfill everyone. Curated retroactive wave only.

## Data Model

### Migration: `org_activities`

Already exists per the explorer pass. Add new activity types:

- `profile_nudge_sent` (with `nudge_day` in metadata)
- `announcement_draft_posted`
- `announcement_published` (with `slack_ts`, channel, approver_user_id)
- `announcement_skipped` (with skipper_user_id)

These give us idempotency and an audit trail without a new table.

### Migration: `member_profiles.metadata`

No schema change — `metadata` is already JSONB. Reserved keys for this work:

- `no_announcement: true` — member opted out of announcement
- `nudge_history: [{ day: 3, sent_at: "..." }, ...]` — optional, redundant with `org_activities` but cheap to keep

## What exists vs. what to build

| Component | Status | Path |
|---|---|---|
| Stripe webhook (subscription activation) | Reuse | `server/src/http.ts:3636` |
| Internal ops Slack notification | Reuse (unchanged) | `server/src/notifications/slack.ts:115` |
| Member profile / brand.json sync | Reuse | `server/src/routes/member-profiles.ts:577-665` |
| Brand logo from brand.json | Reuse | `server/src/db/brand-db.ts` |
| Member portrait | Reuse | `server/src/services/portrait-generator.ts`, `db/portrait-db.ts` |
| Slack channel + DM posting | Reuse | `server/src/slack/client.ts`, `notifications/slack.ts` |
| Addie scheduled-job framework | Reuse (template) | `server/src/addie/jobs/event-recap-nudge.ts` |
| Anthropic SDK client | Reuse (pattern) | `server/src/addie/claude-client.ts` |
| **`profile-completion-nudge.ts` job** | Build | `server/src/addie/jobs/` |
| **Profile-publish event hook** | Build | `server/src/routes/member-profiles.ts` PUT handler |
| **`announcement-drafter.ts` service** | Build | `server/src/services/` |
| **Editorial review Slack flow + interactivity handler** | Build | `server/src/slack/` |
| **Backfill script** | Build | `server/src/scripts/` |
| LinkedIn API posting | Out of scope | Copy-paste in approval message |

## Implementation stages

1. **Workflow A first** (nudge). It's the higher-leverage half — nothing else works until members actually publish. Ship behind a feature flag scoped to test orgs.
2. **Profile-publish event emit** in `member-profiles.ts` PUT. Wire into `org_activities` for audit.
3. **`announcement-drafter.ts`** with unit tests against fixture profiles.
4. **Editorial review Slack flow** with the three-button approval. Test with a synthetic announcement before pointing at real members.
5. **Wire B end-to-end**, ship to test orgs first, then promote.
6. **Backfill script** runs last, after the live flow has produced a few clean announcements and the editorial team is comfortable with the format.

## Out of scope (v1)

- LinkedIn API auto-posting. Copy-paste only.
- Twitter/X.
- Personalized member-driven copy (that's `member-social-drafts.md`, distinct).
- Re-engagement after day 30. If a member ignores all four nudges, that's a signal.
- Automatic announcement for individual members without a portrait or AAO mark fallback — they get the AAO mark.
- Slack reply threading or follow-ups (e.g. "introduce yourself in the thread"). Could be a v2 enhancement.

## Open questions

1. **Self-hosted brand.json verification**: does "manifest exists" require the verification check to have passed, or is intent (`is_public=true` agents on profile) enough? Default: require verified.
2. **Editorial WG channel name**: `#admin-editorial-review` per `specs/slack-working-group-consolidation.md`. Confirm before wiring.
3. **Slack app scopes**: confirm interactivity endpoint and `chat:write` to `#all-agentic-ads` are configured. May need an app config update.
4. **Visual delivery**: post visual as Slack image block (URL) or upload as file? URL is simpler if logos/portraits are publicly served; file upload if we want to keep them gated.
5. **AAO fallback mark**: where does the canonical "AAO mark" image live? May need to add a static asset.

## Success criteria

- Paying members who haven't published get nudged on day 3/7/14/30, then stop
- Member publishing their profile + brand.json triggers a draft within 5 minutes
- Editorial team can approve/edit/skip in one Slack interaction
- Approved announcements land in `#all-agentic-ads` with the correct visual
- LinkedIn copy is paste-ready (no editing needed for format)
- No surprise announcements — every published post had human approval
- Backfill produces a curated wave of 10–15 retroactive welcomes spread over a week
