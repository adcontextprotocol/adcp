# Unified relationship model

## What we're building

Replace Addie's goal-based outreach system with a relationship-based engagement model. Instead of picking a goal and firing a message, Addie maintains a single ongoing relationship with each person across every surface (Slack DM, email, web chat, video). The person's experience should feel like talking to one community manager who remembers everything, not receiving automated campaigns.

The current system treats each interaction as "pick goal, send template, track outcome." The new system treats each person as an ongoing relationship where Addie decides what to say next based on the full history of the relationship -- what she said, what they said back, where they are in their journey, and what's happening in the community right now.

## What a "relationship" is

A relationship is the complete record of Addie's engagement with one person. It is not a campaign, a funnel, or a sequence. It's a single row per person that tracks:

- **Who they are** (identity across surfaces)
- **Where they are in their journey** (stage, not goal status)
- **What Addie knows about them** (insights, preferences, interests)
- **What Addie has said to them** (conversation history, all surfaces)
- **What they've said back** (responses, sentiment, topics)
- **When Addie should reach out next** (timing, not a fixed cadence)

### How it differs from the current model

| Current (goal-based) | New (relationship-based) |
|---|---|
| Pick a goal per person | Understand the person, then decide what to say |
| Each outreach is a discrete event | Each message continues an ongoing conversation |
| Goal history tracks: attempted, succeeded, declined | Relationship tracks: the full arc of engagement |
| New Slack thread per interaction (within 7 days) | One DM thread, forever |
| Web chat has no shared context | Web chat loads the same relationship context |
| Planner doesn't know what Addie actually said | Every message and response is part of the relationship record |
| Template-based messages with placeholder substitution | Every proactive message composed by Sonnet with full context |

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

Every message between Addie and a person, on any surface, belongs to the same relationship. When Addie talks to someone on Slack, she knows what they discussed on web chat. When she sends an email, she knows what they said in Slack last week.

### How it works technically

The existing `addie_threads` and `addie_thread_messages` tables already store conversations across channels (Slack, web, a2a, email). The missing piece is linking them to a single person.

Today, threads are linked to a `user_id` (Slack user ID or WorkOS user ID) and a `user_type`. But there's no concept of "all threads belonging to one person across all identities." A Slack user and a WorkOS user might be the same person with two separate thread histories.

The relationship record is the glue. It holds a `person_id` and links all known identities. When loading context for any surface, Addie queries by `person_id` to get the full picture.

### Data model: `person_relationships`

```sql
CREATE TABLE person_relationships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identity links (at least one must be set)
  slack_user_id VARCHAR(255) UNIQUE,
  workos_user_id VARCHAR(255) UNIQUE,
  email VARCHAR(255),              -- primary email for email outreach
  prospect_org_id VARCHAR(255),    -- for email-only prospects not yet in Slack

  -- Display
  display_name VARCHAR(255),

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
CREATE INDEX idx_person_relationships_slack ON person_relationships(slack_user_id)
  WHERE slack_user_id IS NOT NULL;
CREATE INDEX idx_person_relationships_workos ON person_relationships(workos_user_id)
  WHERE workos_user_id IS NOT NULL;
```

### Linking threads to relationships

Add a `person_id` column to `addie_threads`:

```sql
ALTER TABLE addie_threads
  ADD COLUMN person_id UUID REFERENCES person_relationships(id);

CREATE INDEX idx_addie_threads_person ON addie_threads(person_id)
  WHERE person_id IS NOT NULL;
```

When creating or looking up a thread, resolve the person first. All subsequent context loading uses `person_id`.

## Context loading

When Addie talks to someone on any surface, she loads this context:

### 1. Relationship record (fast, single row)
```
person_relationships WHERE id = :person_id
```
Gives: stage, last interaction, sentiment trend, contact preference, interaction count.

### 2. Recent conversation summary (bounded)
```
addie_thread_messages
  JOIN addie_threads ON person_id = :person_id
  ORDER BY created_at DESC
  LIMIT 30
```
The last ~30 messages across all surfaces. Not the full history -- just enough for Addie to maintain conversational continuity. This is what goes into the Claude prompt as "conversation so far."

For the Slack DM surface specifically, Addie also has the native Slack thread history (users can scroll up). The database history supplements this with cross-surface context.

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
  recentMessages: ThreadMessage[];      // last 30, all surfaces
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
  personId: string,
  options?: { includeCommunity?: boolean }
): Promise<RelationshipContext>
```

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
- Their last ~10 messages with Addie (cross-surface)
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

Send the message on the chosen channel. Record it as a thread message linked to the `person_id`. Update `last_addie_message_at`. Set `next_contact_after` based on stage cooldown.

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
- Email body that references what was discussed before ("Last time we talked about X...")
- Reply-to chaining when possible (use `In-Reply-To` and `References` headers with previous `Message-ID`)

The relationship record tracks email state the same way as Slack. `last_addie_message_at` applies regardless of channel.

### Web chat: load the relationship

When someone opens web chat, resolve their identity (WorkOS user ID from session, or anonymous). If they have a relationship record, load the last N messages as conversation history. Addie picks up where she left off.

For anonymous users (not logged in), there's no relationship to load. That's fine -- web chat works as a standalone Q&A, same as today. If they later identify themselves (log in, link account), merge the anonymous session into their relationship.

## Cross-surface identity

### How we link a person across surfaces

The `person_relationships` table has columns for each identity type: `slack_user_id`, `workos_user_id`, `email`, `prospect_org_id`. At least one must be set.

Identity linking happens at these moments:

1. **Slack user discovered** -- Create relationship with `slack_user_id`. If their email domain matches a prospect org, link `prospect_org_id` too.

2. **Account linked** (Slack user links to website account) -- Update relationship with `workos_user_id`. If we had a prospect record for their org, link it.

3. **Email prospect created** -- Create relationship with `email` and `prospect_org_id`. If they later join Slack, link `slack_user_id`.

4. **Web session authenticated** -- Look up relationship by `workos_user_id`. If none exists, create one.

### Resolution function

```typescript
async function resolvePersonId(identifiers: {
  slack_user_id?: string;
  workos_user_id?: string;
  email?: string;
  prospect_org_id?: string;
}): Promise<string>  // returns person_id, creating if needed
```

This function:
1. Tries to find an existing relationship matching any provided identifier
2. If found, updates any missing identifiers on the record (identity merge)
3. If not found, creates a new relationship
4. Returns the `person_id`

Called at the start of every Addie interaction, regardless of surface.

## Migration path

This is a big change. It needs to happen incrementally, with the existing system continuing to work at each step.

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
5. Link existing `addie_threads` to `person_id` where possible

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

**Goal**: When Addie talks to someone (reactive or proactive), she loads the full relationship context.

1. Implement `loadRelationshipContext()`
2. Modify Addie's system prompt to include relationship context (stage, recent cross-surface messages, capabilities)
3. Web chat loads relationship context for authenticated users
4. Proactive outreach loads relationship context before composing messages

**Reuse**: `getMemberCapabilities()`, insights queries, thread message queries all stay. We're composing them into a unified context object.

### Stage 4: Relationship-driven proactive outreach

**Goal**: Replace goal-based planning with relationship-based engagement.

1. Implement the engagement planner (should-contact + compose-message flow)
2. Replace `initiateOutreachWithPlanner` with new `engageWithPerson` function
3. Proactive messages go through Sonnet with full relationship context
4. Record proactive messages as thread messages linked to `person_id`
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
- [ ] When someone messages Addie on web chat, she knows what they discussed on Slack
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
