# Unified relationship model

## What we're building

Replace Addie's goal-based outreach system with a relationship-based engagement model. Instead of picking a goal and firing a message, Addie maintains a single ongoing relationship with each person across every surface (Slack DM, email, web chat, video). The person's experience should feel like talking to one community manager who remembers the context they have permitted Addie to use, not receiving automated campaigns.

The current system treats each interaction as "pick goal, send template, track outcome." The new system treats each person as an ongoing relationship where Addie decides what to say next based on the relationship history permitted in the current context -- what she said, what they said back, where they are in their journey, and what's happening in the community right now.

## What a "relationship" is

A relationship is the complete record of Addie's engagement with one person. It is not a campaign, a funnel, or a sequence. It's a single row per person that tracks:

- **Who they are** (identity across surfaces)
- **Where they are in their journey** (stage, not goal status)
- **What Addie knows about them** (insights, preferences, interests, with source provenance)
- **What Addie has said to them** (conversation history, fenced by surface and organization context)
- **What they've said back** (responses, sentiment, topics, fenced by their original consent context)
- **When Addie should reach out next** (timing, not a fixed cadence)

### How it differs from the current model

| Current (goal-based) | New (relationship-based) |
|---|---|
| Pick a goal per person | Understand the person, then decide what to say |
| Each outreach is a discrete event | Each message continues an ongoing conversation |
| Goal history tracks: attempted, succeeded, declined | Relationship tracks: the full arc of engagement |
| New Slack thread per interaction (within 7 days) | One DM thread, forever |
| Web chat has no shared context | Web chat loads privacy-fenced relationship context |
| Planner doesn't know what Addie actually said | Every message and response is part of the relationship record |
| Template-based messages with placeholder substitution | Every proactive message composed by Sonnet with full context |

## Person identity and state ownership

The relationship record is an engagement facet of a person. It is not the
person's login, employer membership, billing account, or authorization
principal. Keeping those concepts separate is what lets a person change email
or employer without either losing their own state or retaining access they no
longer have.

### Canonical concepts

| Concept | Meaning | Authorization effect |
|---|---|---|
| `identity` | Durable internal person identifier across verified credentials | None by itself |
| credential binding | A WorkOS user, verified email, Slack identity, or other external identifier linked to the person | Authentication only; never unions organization grants |
| `person_relationships` | Addie's engagement state for the person | None |
| identity profile | Person-managed community profile and preferences | Controls display/communication choices, not access |
| organization membership | Current membership, role, and seat in one organization | Grants only that organization's scoped capabilities |
| billing account/subscription | Organization or persistent personal billing boundary | Grants only the capabilities defined by that subscription |
| affiliation | Current or historical employment/consulting profile fact | None; never substitutes for organization membership |

`identities.id` is the canonical person identifier. The existing
`identity_workos_users` table binds one or more WorkOS credentials to it. Over
time, `person_relationships` becomes a one-to-one engagement facet keyed by
`identity_id`; it must not remain a second, competing person authority.

Identity rows are durable across credential and employer changes, but
"durable" does not mean immortal. Credential deletion, identity erasure,
legal-retention records, and anonymization have distinct lifecycle rules below.

### Ownership and provenance matrix

| Data family | Canonical owner | Provenance retained | Link behavior | Unlink/split behavior |
|---|---|---|---|---|
| WorkOS users, verified emails, Slack IDs, authentication history | Credential or identifier binding | Provider, verification method/time, binding actor, original external ID | Add a binding after proof of control or an audited admin action | Move only the selected binding; never infer another binding from matching attributes |
| Community profile: slug, headline, bio, avatar, expertise, interests, social links, directory/contact preferences, country/timezone | `identity_id` | Last editor plus source where a value was imported | Resolve conflicts explicitly; never last-write-wins across two populated profiles | Assign the profile to one identity or resolve fields explicitly; do not silently clone it |
| Community points and person-level badges | `identity_id` aggregate over append-only source events | Source credential/channel, reference, action, and award time | Recompute/deduplicate from source events | Partition attributable events; require explicit resolution for unattributable events |
| Engagement score and person journey stage | `identity_id`, derived | Inputs and computation version | Recompute after link | Recompute after split; do not copy a cached total/stage to both sides |
| Certifications and assessments | Originating credential/attempt, aggregated in a person view | Full assessment, issuer, and credential provenance | Union for an authorized person view; do not rewrite issuance history | Follow proven source ownership; disputed records require review |
| Organization memberships, roles, seats, invitations, and organization authority | Organization membership/account | Organization, grantor, seat source, effective dates | **Never merged or unioned by identity linkage** | Remain with their original membership; revoke through the organization authority |
| Billing customers, subscriptions, invoices, refunds, and tax records | Organization or persistent personal billing account | Original payer/account and immutable billing references | Never reassign from an email/identity match alone | Remain with the billing account, subject to billing correction procedures |
| Conversations, insights, consent, and contact preferences | Originating relationship/thread/surface scope | Surface, organization context, participants, consent purpose/time | May resolve to the same identity but remain fenced until policy permits use | Remain source-scoped; unlink removes future cross-identity visibility |
| Audit and security events | Immutable event | Authenticated credential, resolved identity at the time, organization context, actor, reason | Append a link event; never rewrite historical actors | Append an unlink/split event; preserve the historical resolution |

"Champion" has two meanings that must not share one portable flag:

- A person-level community journey or reputation status may follow the person.
- Organization-specific champion, contact, administrator, or representative
  authority stays with that organization and ends when its grant ends.

### Link, merge, unlink, and split rules

**Linking credentials** requires proof of control of both sides or an explicit,
audited administrator action. Email similarity, name similarity, employer,
domain, Stripe email, or model confidence may suggest a candidate but can never
execute a link.

A link operation:

1. records the authenticated actor, evidence, reason, and both pre-link identities;
2. binds credentials to one identity without copying organization grants;
3. resolves conflicting person-owned profile values explicitly;
4. deduplicates derived reputation from source events rather than adding cached totals; and
5. invalidates affected authentication and context caches.

An unlink/split operation:

1. creates or selects the destination identity before moving a credential;
2. previews profile, reputation, credentials, organization memberships,
   conversations, certifications, and billing records without silently
   reassigning provenance-bound records;
3. assigns non-partitionable person-owned values explicitly;
4. recomputes derived state from attributable source events; and
5. appends an immutable before/after audit event.

The system must not claim that a merge is reversible if it has already erased
the provenance required to partition state again.

### Deletion and anonymization

- Deleting one credential removes that authentication path. The identity and
  person-owned state survive when another verified credential remains.
- Deleting an identity removes or anonymizes person-owned profile and
  relationship state according to the retention policy.
- Organization memberships and permissions are revoked through their
  organization authority; identity deletion is not a substitute for
  offboarding.
- Billing, certification, security, and audit records retained for legal or
  integrity reasons keep the minimum necessary pseudonymous linkage and their
  original provenance.
- Public profile and former-employer data must be removed or anonymized when
  required even if internal anti-fraud/audit records are retained.

### Request authorization context

Every authenticated request that consumes person state resolves an explicit
context tuple:

```text
(authenticated credential, identity_id, surface, selected organization?)
```

The credential proves the login. `identity_id` selects person-owned state. The
optional selected organization selects exactly one organization authorization
context. Code must not build a privilege union from every organization linked
to the identity. Personal-subscription capabilities are evaluated separately
from the selected organization's seat capabilities.

## Relationship lifecycle

People don't move through "goals." They move through a journey. The stages are not states to be managed -- they're observations about where someone is, used to inform how Addie engages.

### Stages

```
prospect -> welcomed -> exploring -> participating -> contributing -> leading
```

**prospect** -- We know they exist but haven't talked to them yet. They joined Slack, or we have their email from prospect triage. No Addie interaction has happened.

**welcomed** -- Addie has introduced herself. The welcome message has been sent (Slack DM or email). This is the "Hi, welcome to AgenticAdvertising.org" moment. It only happens once.

**exploring** -- They've responded to Addie at least once, or they've taken an action (linked account, visited the site, joined a channel). Addie is learning about them -- what they care about, what their company does, what brought them here.

**participating** -- They're engaged. They're in working groups, attending events, using the platform. Addie shifts from introducing features to being helpful -- sharing relevant updates, connecting them with people, surfacing opportunities.

**contributing** -- They're creating value. Leading sessions, sharing content, helping other members. Addie's role is support and recognition.

**leading** -- Committee leaders, council members, community champions. Addie is a tool for them, not a guide.

Stages advance automatically based on observed behavior (account linking, message count, group membership, event attendance). They never regress. The stage informs Addie's tone and content, not whether she contacts someone.

### Stage transitions

Stage transitions are derived from existing data. No manual promotion needed.

```
prospect -> welcomed:      Addie sends first message
welcomed -> exploring:     Person responds OR links account OR joins a channel
exploring -> participating: In 1+ working groups AND engagement_score > 20
participating -> contributing: 30d message count > 20 OR leading a session
contributing -> leading:    is_committee_leader OR council_count > 0
```

## Unified conversation history

### The core idea

Every message between Addie and a person can resolve to the same identity and relationship, but resolution is not permission to disclose or reuse every message on every surface. Each thread and message retains its surface, organization context, participants, and consent provenance. The privacy fence determines which subset is available for a given request.

When the fence permits cross-surface continuity, Addie may use an appropriately attributed summary of a prior conversation. When it does not, she behaves as though that source-scoped history is unavailable. She must never surprise someone with employer-confidential, billing, or private-conversation context merely because two credentials were linked.

### How it works technically

The existing `addie_threads` and `addie_thread_messages` tables already store conversations across channels (Slack, web, a2a, email). The missing piece is linking them to a single person.

Today, threads are linked to a `user_id` (Slack user ID or WorkOS user ID) and a `user_type`. But there's no concept of "all threads belonging to one person across all identities." A Slack user and a WorkOS user might be the same person with two separate thread histories.

The canonical `identity_id` is the glue. Credential/identifier bindings resolve the authenticated surface identity to it. `person_relationships` stores Addie's engagement facet for that identity. Context loading starts from `identity_id`, then applies the request's surface, selected-organization, and consent fence before reading messages or insights.

### Target seam: identity bindings and `person_relationships`

The original migration stored one Slack ID, one WorkOS ID, and one email
directly on `person_relationships`. Those singular columns are transitional;
they cannot represent multiple verified credentials or reversible provenance.
The target relationship facet is one-to-one with the canonical identity:

```sql
CREATE TABLE person_relationships (
  identity_id UUID PRIMARY KEY REFERENCES identities(id),

  -- Display
  display_name VARCHAR(255),       -- transitional; target lives in identity profile

  -- Journey stage
  stage VARCHAR(50) NOT NULL DEFAULT 'prospect'
    CHECK (stage IN ('prospect', 'welcomed', 'exploring', 'participating', 'contributing', 'leading')),
  stage_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Engagement state
  last_addie_message_at TIMESTAMPTZ,     -- when Addie last spoke to them
  last_person_message_at TIMESTAMPTZ,    -- when they last spoke to Addie
  last_interaction_channel VARCHAR(50),   -- which surface was last used
  next_contact_after TIMESTAMPTZ,        -- don't reach out before this time
  contact_preference VARCHAR(50),        -- 'slack', 'email', or NULL (let Addie decide)

  -- Slack DM state (single thread model)
  slack_dm_channel_id VARCHAR(255),      -- cached DM channel ID
  slack_dm_thread_ts VARCHAR(255),       -- the ONE thread ts, forever

  -- Relationship quality
  sentiment_trend VARCHAR(20) DEFAULT 'neutral'
    CHECK (sentiment_trend IN ('positive', 'neutral', 'negative', 'disengaging')),
  interaction_count INTEGER NOT NULL DEFAULT 0,
  opted_out BOOLEAN NOT NULL DEFAULT FALSE,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_person_relationships_stage ON person_relationships(stage);
CREATE INDEX idx_person_relationships_next_contact ON person_relationships(next_contact_after)
  WHERE opted_out = FALSE;
```

External identifiers live in constrained binding tables, beginning with the
existing `identity_workos_users`. Slack and email bindings require the same
properties: provider-scoped uniqueness, verification/provenance metadata,
binding status, and an append-only link/unlink audit trail. A billing customer
is not an identity binding; it belongs to its billing account.

Email outreach chooses from verified email bindings plus communication consent
and preference. It does not store an unqualified "primary email" on the
relationship row.

### Linking threads to relationships

Converge thread ownership on `identity_id`:

```sql
ALTER TABLE addie_threads
  ADD COLUMN identity_id UUID REFERENCES identities(id);

CREATE INDEX idx_addie_threads_identity ON addie_threads(identity_id)
  WHERE identity_id IS NOT NULL;
```

When creating or looking up a thread, resolve the identity first and record the
surface and organization context on the thread. Subsequent context loading
uses `identity_id` plus the privacy fence; `identity_id` alone is not a
cross-surface disclosure grant.

## Context loading

When Addie talks to someone on any surface, she first resolves the request
authorization tuple and privacy fence, then loads only the allowed context:

### 1. Relationship record (fast, single row)
```
person_relationships WHERE identity_id = :identity_id
```
Gives: stage, last interaction, sentiment trend, contact preference, interaction count.

### 2. Recent conversation summary (bounded)
```
addie_thread_messages
  JOIN addie_threads ON identity_id = :identity_id
  WHERE privacy_fence_allows(thread, :request_context)
  ORDER BY created_at DESC
  LIMIT 30
```
The last ~30 messages from permitted sources. Not the full history -- just
enough for Addie to maintain allowed conversational continuity. Every summary
keeps source/surface attribution; raw content from an unrelated organization
or unacknowledged linked identity is excluded.

For the Slack DM surface specifically, Addie also has the native Slack thread history (users can scroll up). The database history supplements this only with cross-surface context permitted for Slack.

### 3. Person profile (existing data, assembled)
- Insights from `member_user_insights`
- Capabilities from `getMemberCapabilities()`
- Company info from `organizations`
- Goal history from `user_goal_history` (legacy, read-only during migration)

### 4. Community context (what's happening now)
- Upcoming events relevant to their location or groups
- Recent activity in their working groups
- New members from similar companies
- Announcements or deadlines

This is not loaded per-message. It's loaded when Addie is deciding whether and how to proactively reach out (see next section).

### Context loading function

```typescript
interface RelationshipContext {
  relationship: PersonRelationship;
  recentMessages: ThreadMessage[];      // last 30 permitted by the fence
  profile: {
    insights: Insight[];
    capabilities: MemberCapabilities;
    company?: CompanyInfo;
  };
  community?: {                         // only for proactive outreach decisions
    upcomingEvents: Event[];
    groupActivity: GroupUpdate[];
    relevantAnnouncements: string[];
  };
}

async function loadRelationshipContext(
  identityId: string,
  requestContext: {
    authenticatedCredentialId: string;
    surface: 'slack' | 'web' | 'email' | 'a2a';
    selectedOrganizationId?: string;
  },
  options?: { includeCommunity?: boolean }
): Promise<RelationshipContext>
```

The context formatter renders facts with source labels. Response policy lives
in Addie's rules, not in hydrated person data. New fields must be added to both
the hydration path and prompt formatting so the two data planes do not drift.

## Proactive engagement model

### What replaces the goal/planner system

The current system: Scheduler runs -> picks candidates -> OutboundPlanner picks a goal -> sends a template.

The new system: Scheduler runs -> picks candidates -> loads relationship context -> Sonnet composes a message appropriate for this person at this moment.

The key shift: **goals become suggestions, not the organizing primitive.** Addie still knows about available actions (link account, join working group, complete profile, attend event). But she doesn't "pick a goal and execute it." She looks at the full relationship and decides what to say, which might touch on one of these topics, or might just be a genuine check-in.

### The engagement planner

Replace `OutboundPlanner` with a simpler decision flow:

**Step 1: Should Addie reach out to this person right now?**

Rule-based check (fast, no LLM):
- `opted_out = true` -> no
- `next_contact_after > NOW()` -> no
- Stage is `prospect` and no welcome sent -> yes (always welcome new people)
- `last_addie_message_at` within cooldown period for their stage -> no
- Not business hours in their timezone -> no

Cooldown periods by stage:
- `prospect`: 0 (welcome immediately when discovered)
- `welcomed`: 3 days (give them time to respond before following up)
- `exploring`: 7 days
- `participating`: 14 days (they're engaged, don't nag)
- `contributing`/`leading`: 30 days (only reach out when there's something specific)

**Step 2: What should Addie say?**

This is where the LLM comes in. Pass Sonnet the full relationship context and ask it to compose an appropriate message.

The prompt includes:
- The person's relationship record (stage, history, sentiment)
- Their last ~10 messages with Addie permitted in the current surface/organization context
- Their capabilities (what they have and haven't done)
- Available actions they could take (the old "goals" reframed as options)
- Community context (upcoming events, group activity)
- Tone guidance based on stage

Sonnet decides what to say. It might:
- Welcome a new person and ask what brought them here
- Follow up on something they mentioned last time
- Suggest a working group relevant to their interests
- Share an upcoming event in their city
- Congratulate them on completing their profile
- Simply check in because it's been a while

The message is composed in full by Sonnet. No templates. Every message is personal.

**Step 3: Which channel?**

Hierarchy:
1. If person has `contact_preference` set, use that
2. If person has `slack_user_id`, use Slack DM
3. If person has `email` but no Slack, use email
4. If neither, skip (shouldn't happen, but don't crash)

**Step 4: Send and record**

Send the message on the chosen channel. Record it as a thread message linked to the `identity_id` with its surface/organization provenance. Update `last_addie_message_at`. Set `next_contact_after` based on stage cooldown.

### What happens to goals?

Goals don't disappear overnight. During migration, the existing goal system continues to function. Goals become a reference list of "things Addie can suggest" rather than the driving force of outreach. The `outreach_goals` table stays but is consumed differently:

- Goals inform the Sonnet prompt: "Here are actions this person could take: [list of eligible goals]"
- Goal history is still tracked for admin visibility
- The goal-based admin UI keeps working

Over time, goals can be simplified into a checklist of capabilities (which `MemberCapabilities` already is).

## Single thread model

### Slack: one DM thread, forever

When Addie first messages someone on Slack, she opens a DM and sends a message. That message's `thread_ts` becomes the permanent thread for this relationship. All future proactive messages from Addie go as replies in this same thread. The person can respond at any time, and the conversation continues.

Technical details:
- `person_relationships.slack_dm_channel_id` and `slack_dm_thread_ts` store the permanent thread coordinates
- On first outreach: open DM channel, send message, save both IDs
- On subsequent outreach: send as reply using saved `thread_ts`
- If the Slack API rejects the `thread_ts` (channel deleted, etc.), start a new thread and update the record

This means a person's DM with Addie reads like one long conversation over time. Early messages are the welcome. Later messages are about working groups, events, profile help. The context is always there when you scroll up.

**What about when people message Addie first?** If someone opens a DM with Addie (or uses the Slack assistant), check for an existing relationship + thread. If found, continue in the same thread. If not, create the relationship and start the thread.

### Email: thread-like continuity

Email doesn't have persistent threads, but we can create the feeling of continuity:
- Same sender address (`addie@updates.agenticadvertising.org`)
- Subject lines that reference previous conversations ("Following up on..." or just a fresh topic)
- Email body may reference a prior discussion only when the privacy fence permits that source on email
- Reply-to chaining when possible (use `In-Reply-To` and `References` headers with previous `Message-ID`)

The relationship record tracks email state the same way as Slack. `last_addie_message_at` applies regardless of channel.

### Web chat: load the relationship

When someone opens web chat, resolve their authenticated credential to an
identity (or treat the session as anonymous). If they have a relationship
record, load the last N messages permitted for the web and selected-organization
context. Addie picks up only from that allowed context.

For anonymous users (not logged in), there's no relationship to load. That's
fine -- web chat works as a standalone Q&A, same as today. If they later
identify themselves, attaching anonymous history requires an explicit account
action and applicable consent; it is not an automatic fuzzy merge.

## Cross-surface identity

### How we resolve and link a person across surfaces

Resolution and linking are different operations:

- **Resolution** looks up one already-bound external identifier and returns its
  `identity_id`. It does not mutate bindings.
- **Linking** joins two credentials/identifiers only after proof of control or
  an audited administrator decision. It records evidence and applies the
  ownership rules above.
- **Suggestion** may surface a possible duplicate to an administrator. It may
  use name, domain, or email similarity, but it never mutates identity state.

Surface-specific rules:

1. **Slack user discovered** -- Create a singleton identity plus Slack binding
   when none exists. Email or employer-domain similarity may suggest a link but
   cannot execute one.
2. **Slack account linking** -- The authenticated web credential and Slack
   identity must both participate in the verified linking flow.
3. **Email prospect created** -- Create a singleton identity/relationship with
   sourced contact information. Later signup does not auto-link solely because
   the email or domain matches.
4. **Web session authenticated** -- Resolve the WorkOS user through
   `identity_workos_users`. A new WorkOS user receives a singleton identity.
5. **Existing accounts linked** -- Require control of both credentials or the
   guarded admin merge workflow; preview state before consolidation.

### Resolution function

```typescript
async function resolveIdentity(input: {
  provider: 'workos' | 'slack' | 'verified_email';
  providerTenantId?: string;
  externalId: string;
}): Promise<{ identityId: string; bindingId: string }>
```

This function:
1. normalizes only according to the provider's identifier rules;
2. finds an active, uniquely constrained binding;
3. returns the bound identity without adding other identifiers; or
4. creates a singleton identity and sourced binding only when the caller is an
   authorized provisioning path.

The separate `linkIdentities`/`splitIdentity` operations require their own
authorization, evidence, preview, audit, and cache invalidation. Generic
request resolution must never perform a merge as a side effect.

## Migration path

This is a big change. It needs to happen incrementally, with the existing system continuing to work at each step.

### Current implementation status

The original relationship migration and the later credential-identity
foundation landed in different sequences:

- `person_relationships` exists with transitional singular Slack/WorkOS/email
  columns.
- `identities` and `identity_workos_users` exist and auth resolves a linked
  non-primary WorkOS credential through the identity's primary credential.
- Admin bind, link, unlink, and primary-promotion flows exist.
- Most person-owned application state still uses the primary
  `workos_user_id`; the auth ID swap is a compatibility layer, not the target
  ownership model.

The next migration sequence is therefore:

1. approve this ownership/provenance contract and the cross-surface privacy fence;
2. add safe self-service recovery credential management;
3. migrate community profile state to `identity_id` with bounded dual read/write;
4. migrate reputation events/aggregates while retaining source provenance;
5. make merge/split genuinely reversible before removing compatibility fields; and
6. move MemberContext and relationship/thread reads onto the fenced identity model.

The historical stages below describe the relationship-driven outreach rollout.
Where they refer to the transitional `person_relationships.id`, new work uses
the canonical `identity_id` seam defined above.

### Stage 1: Create the relationship table and backfill

**Goal**: Every Slack user and email prospect gets a `person_relationships` row.

1. Create the `person_relationships` table (migration)
2. Backfill from `slack_user_mappings`: one row per Slack user, copying `slack_user_id`, `workos_user_id`, `display_name`
3. Backfill from `organizations` where `prospect_owner = 'addie'` and `prospect_contact_email IS NOT NULL`: one row per email prospect
4. Calculate initial `stage` from existing data:
   - Has `user_goal_history` with status `sent`? -> `welcomed`
   - Has `workos_user_id` linked? -> `exploring`
   - In working groups? -> `participating`
   - Committee leader? -> `leading`
   - Otherwise -> `prospect`
5. Link existing `addie_threads` to `identity_id` where evidence permits, retaining surface provenance

The old system still runs. Goals still fire. The relationship table is read-only at this stage.

**Reuse**: All existing tables stay. `person_relationships` is additive.

### Stage 2: Single thread model for Slack DMs

**Goal**: Stop creating new threads per outreach. One thread per person.

1. Modify `resolveThreadAndSendMessage` to check `person_relationships.slack_dm_thread_ts` first
2. If a permanent thread exists, always reply there (remove the 7-day window logic)
3. If no permanent thread, send a new message and save the `thread_ts` to the relationship
4. When someone DMs Addie, resolve their relationship and use the permanent thread

**Reuse**: `openDmChannel` and `sendDmMessage` stay. Only the thread resolution logic changes.

### Stage 3: Relationship context in conversations

**Goal**: When Addie talks to someone (reactive or proactive), she loads the relationship context permitted for that request.

1. Implement `loadRelationshipContext()`
2. Modify Addie's system prompt to include privacy-fenced relationship context (stage, permitted recent messages, capabilities)
3. Web chat loads relationship context for authenticated users
4. Proactive outreach loads relationship context before composing messages

**Reuse**: `getMemberCapabilities()`, insights queries, thread message queries all stay. We're composing them into a unified context object.

### Stage 4: Relationship-driven proactive outreach

**Goal**: Replace goal-based planning with relationship-based engagement.

1. Implement the engagement planner (should-contact + compose-message flow)
2. Replace `initiateOutreachWithPlanner` with new `engageWithPerson` function
3. Proactive messages go through Sonnet with privacy-fenced relationship context
4. Record proactive messages as thread messages linked to `identity_id` with source provenance
5. Keep recording goal history in parallel for admin visibility (dual-write)

**Reuse**: Business hours check, rate limiting, email sending, Slack DM sending all stay. Only the decision logic changes.

### Stage 5: Deprecate goal-driven outreach

**Goal**: Remove the old planner once the relationship model is proven.

1. Stop dual-writing to `user_goal_history`
2. Convert the admin outreach dashboard to show relationship-based data
3. Remove `OutboundPlanner` class
4. Archive `outreach_goals` and `goal_outcomes` tables (don't delete -- useful for analysis)

**Reuse**: The admin UI layout and routes can be adapted. The rehearsal system can be rebuilt on top of relationships if needed.

## What we can reuse vs rebuild

### Keep as-is
- `addie_threads` and `addie_thread_messages` (the thread model is good)
- `getMemberCapabilities()` (the capability queries are solid)
- `InsightsDatabase` (insights are still valuable)
- `isBusinessHours()` and timezone logic
- `openDmChannel()` and `sendDmMessage()` (low-level Slack API wrappers)
- Email sending infrastructure (`sendProspectEmail`, Resend integration)
- `canContactUser()` (eligibility checks stay)
- Rate limiting and kill switches

### Modify
- `resolveThreadAndSendMessage()` -- use permanent thread from relationship
- `buildPlannerContext()` -- becomes `loadRelationshipContext()`
- `runOutreachScheduler()` -- queries relationships instead of raw slack_user_mappings
- Thread service `getUserRecentThread()` -- replaced by relationship-based lookup

### Rebuild
- `OutboundPlanner` -- replaced by relationship-aware engagement planner
- Goal selection logic -- replaced by Sonnet composing messages from context
- Template-based message building -- replaced by LLM composition

### Archive (keep data, stop writing)
- `outreach_goals` table (goals become suggestions in the prompt, not database-driven)
- `goal_outcomes` table
- `user_goal_history` table (eventually -- dual-write during migration)
- `rehearsal_sessions` table

## Success criteria

- [ ] Every Slack user and email prospect has a `person_relationships` row
- [ ] Addie maintains one DM thread per person on Slack (no new threads for each outreach)
- [ ] When someone messages Addie on web chat, she can use an attributed Slack summary only when the privacy fence permits it
- [ ] Proactive messages reference previous conversations ("Last time you mentioned...")
- [ ] Welcome messages only happen once per person, ever
- [ ] Stage transitions happen automatically based on behavior
- [ ] Outreach frequency scales with engagement (active people get less proactive contact, not more)
- [ ] Every proactive message is composed by Sonnet, not a template
- [ ] Admin can see the full relationship timeline for any person

## What this does NOT include

- **Video chat integration.** The relationship model supports it (video is a channel type), but we're not building the video surface now.
- **Multi-person threads.** Relationships are 1:1 (Addie to person). Group conversations stay separate.
- **Automated A/B testing of messages.** Sonnet composes each message individually. If we want to test approaches, we adjust the prompt, not run experiments.
- **Real-time presence awareness.** We don't check if someone is online before messaging. Business hours are sufficient.
- **CRM-style pipeline management.** Relationships are not deals. There's no "close" action. The journey is open-ended.
