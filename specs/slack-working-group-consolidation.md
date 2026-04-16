# Slack and Working Group Consolidation

## The Problem

The organization has 35+ Slack channels and 25+ DB working groups that don't
connect to each other. Most channels are dead. None of the DB working groups
have `slack_channel_id` set, so the spec-insight-post job has zero targets.
The result: fragmented conversation, ghost channels with hundreds of silent
members, and automated tooling that can't reach anyone.

## What the Data Says

**Where people actually talk (last 30 days, human messages only):**

| Channel | Msgs | Members | What it actually is |
|---------|------|---------|---------------------|
| #exec-operating-group | 66 | 10 | Private ops (keep as-is) |
| #all-agentic-ads | 33 | 1683 | General announcements |
| #salesagent-users | 18 | 1087 | Product support |
| #wg-governance-protocols | 15 | 162 | brand.json, adagents.json, brand safety |
| #wg-community-events-mktg-education | 14 | 115 | Community/events |
| #wg-media-buy | 10 | 869 | Flagship protocol WG |
| #social | 10 | 1684 | Watercooler |

**Where people barely talk (1-9 msgs):**
#adcp-tools-dev (7), #salesagent-dev (6), #wg-signals (5), #wg-creative (4),
#wg-sponsored-intelligence (3), #chapter-dach (2), #mena-chapter (5)

**Completely dead (0 human msgs):**
#organizing-the-community (1192 members!), #wg-pmp-and-deals (206),
#wg-arch-and-technical-standards (40), #wg-measurement-verification-validation (36),
#policy-adcp (76), #collective-nyc (103), #collective-ldn, #collective-ams,
#industry-agentic-news (171 bot msgs, 0 human), #news, #talk-to-matt-and-randall,
#team-rmn, various expired event channels

## Diagnosis

1. **Too many channels for the energy available.** This is a volunteer community.
   Seven working groups, nine councils, five chapters, and a dozen misc channels
   means every conversation is diluted.

2. **Councils are aspirational, not operational.** Nine councils exist in the DB.
   Zero have Slack channels. Zero have chairs. They were created to signal scope,
   not because people showed up for them.

3. **DB and Slack are disconnected.** `slack_channel_id` is null on every
   working group row. The spec-insight-post job rotates across groups with
   Slack channels configured -- which is none of them.

4. **Product support mixed with protocol work.** #salesagent-users and
   #salesagent-dev are product channels for a specific implementation.
   They don't belong in the protocol namespace.

5. **#organizing-the-community is a monument to good intentions.** 1,192 members,
   zero messages. The meta-channel about community never became a community.

## The Plan

### Keep (6 public protocol channels)

These channels stay. Wire them to DB working groups via `slack_channel_id`.

| Slack Channel | DB Working Group | Notes |
|---------------|------------------|-------|
| #wg-media-buy | Media Buying Protocol | Flagship. This is where the protocol gets built. |
| #wg-governance-protocols | Brand Standards | Rename DB group to "Governance & Brand Standards" to match actual scope (brand.json, adagents.json, brand safety) |
| #wg-creative | Creative | Low activity but distinct scope. Give it 90 days. |
| #wg-signals | Signals & Data | Low activity but distinct scope. Give it 90 days. |
| #wg-community-events-mktg-education | Events & Thought Leadership | Rename DB group to "Community & Events" to match reality |
| #all-agentic-ads | *(no WG -- announcements channel)* | Not a working group. General broadcast. |

### Merge (collapse dead WGs into active ones)

| Dead Channel/WG | Merge Into | Rationale |
|-----------------|-----------|-----------|
| #wg-arch-and-technical-standards / Technical Standards WG | #wg-media-buy | Technical standards work happens in the buying protocol. There is no standalone "architecture" conversation. |
| #wg-pmp-and-deals | #wg-media-buy | Deals are part of media buying. |
| #wg-measurement-verification-validation | #wg-signals | Measurement is a signals problem. |
| #wg-sponsored-intelligence | #wg-media-buy | 3 messages. The topic lives inside media buying. |

**DB change:** Archive the Technical Standards WG. Its scope is covered by Media Buying Protocol and the Technical Steering Committee (governance). Remove the pretense of a separate group nobody attends.

### Archive (remove from Slack)

Archive these channels. Post a final message directing people to the right place.

**Dead working group channels:**
- #wg-arch-and-technical-standards
- #wg-pmp-and-deals
- #wg-measurement-verification-validation
- #wg-sponsored-intelligence

**Dead community channels:**
- #organizing-the-community (redirect to #all-agentic-ads)
- #collective-nyc, #collective-ldn, #collective-ams
- #industry-agentic-news (bot-only, no humans care)
- #news (redundant with #all-agentic-ads)
- #talk-to-matt-and-randall
- #policy-adcp (redirect to #wg-governance-protocols)
- #team-rmn
- #foundry-event and all expired event channels

**DB change:** Set chapter status to `inactive` for NYC, London, Amsterdam.
Keep Paris and Sydney in DB but inactive. Chapters can reactivate when someone
volunteers to run them.

### Separate (product channels)

#salesagent-users and #salesagent-dev are product channels for Scope3's
implementation. They should not be in the protocol workspace namespace.

**Options (pick one):**
1. **Rename with prefix:** #product-salesagent-users, #product-salesagent-dev
2. **Move to Scope3's workspace** if they have one
3. **Keep but don't wire to any WG** -- just make it clear these are product support, not protocol development

Recommendation: Option 1. Rename with `product-` prefix. Keeps them accessible
but signals they're not protocol work.

### Consolidate (dev channels)

- **#adcp-tools-dev** (7 msgs) -- Keep. This is where protocol tooling discussion
  should live. Wire it to Technical Steering Committee in the DB.
- **#salesagent-dev** (6 msgs) -- Product channel, see above.

### Councils: Don't Give Them Channels

Nine councils, zero activity. Councils should be **topics within working groups**,
not standalone entities.

**Proposal:** Councils become tags/topics on working group discussions, not
separate channels. When a CTV question comes up in #wg-media-buy, tag it
`ctv-council`. When retail media needs discussion in #wg-signals, tag it
`retail-media`.

**DB change:** Keep council rows in the DB (they're useful for member interest
tracking and website display). Do NOT create Slack channels for them. Add a
`has_slack_channel` boolean or just leave `slack_channel_id` null -- the absence
of a channel IS the design.

If a council generates enough conversation to justify a channel (sustained
discussion that drowns out the parent WG), spin one off. Not before.

### Private Channels: Leave Alone

These serve specific operational purposes and are active:
- #exec-operating-group
- #kitchen-cabinet
- #admin-editorial-review
- #mamamia-salesagent-testing, #scope3-kontext-integration (partner channels)

No changes needed.

### Training & Education WG

This WG exists in the DB but has no Slack channel. Training happens through
Sage (the certification agent) and the website. It doesn't need a Slack channel
unless someone asks for one. Leave it in DB, no Slack channel.

## Spec-Insight-Post Targeting

The spec-insight-post job posts weekly questions to working group Slack channels.
Currently it has zero targets because no WGs have `slack_channel_id` set.

**Target these channels (in rotation):**

1. **#wg-media-buy** -- Flagship. Highest protocol relevance.
2. **#wg-governance-protocols** -- Active, engaged audience.
3. **#wg-signals** -- Needs energy. Spec questions could spark discussion.
4. **#wg-creative** -- Same. Use spec questions to see if this group has life.

Do NOT target #wg-community-events-mktg-education (not protocol-focused) or
#all-agentic-ads (too broad, wrong audience for technical questions).

**Rotation:** 4 groups, weekly posts = each group gets a post monthly.

## DB Migration

One migration to wire it all up:

```sql
-- Wire active WGs to their Slack channels
UPDATE working_groups SET slack_channel_id = 'C09BK148CLU'  -- #wg-media-buy
WHERE slug = 'media-buying-protocol-wg';

UPDATE working_groups SET slack_channel_id = 'C09NUQS93DF'  -- #wg-governance-protocols
WHERE slug = 'brand-standards-wg';

UPDATE working_groups SET slack_channel_id = 'C09C7PLE5B8'  -- #wg-creative
WHERE slug = 'creative-wg';

UPDATE working_groups SET slack_channel_id = 'C09BF378H8A'  -- #wg-signals
WHERE slug = 'signals-data-wg';

UPDATE working_groups SET slack_channel_id = 'C09PK59GUCB'  -- #wg-community-events-mktg-education
WHERE slug = 'events-thought-leadership-wg';

UPDATE working_groups SET slack_channel_id = 'C09QYG1470S'  -- #adcp-tools-dev
WHERE slug = 'technical-steering';

-- Archive dead WGs
UPDATE working_groups SET status = 'archived'
WHERE slug IN ('technical-standards-wg');

-- Deactivate chapters with no activity
UPDATE working_groups SET status = 'inactive'
WHERE committee_type = 'chapter';

-- Rename to match actual scope
UPDATE working_groups SET name = 'Governance & Brand Standards Working Group'
WHERE slug = 'brand-standards-wg';

UPDATE working_groups SET name = 'Community & Events Working Group'
WHERE slug = 'events-thought-leadership-wg';
```

## Resulting Structure

**Public protocol channels (5):**
- #wg-media-buy
- #wg-governance-protocols
- #wg-creative
- #wg-signals
- #wg-community-events-mktg-education

**General (2):**
- #all-agentic-ads (announcements)
- #social (watercooler)

**Dev (1):**
- #adcp-tools-dev

**Product (2, renamed):**
- #product-salesagent-users
- #product-salesagent-dev

**Private ops (5, unchanged):**
- #exec-operating-group
- #kitchen-cabinet
- #admin-editorial-review
- Partner-specific channels as needed

**Event channels:** Created and archived per event lifecycle. No change.

**Total public channels: 10** (down from 25+)

## Success Criteria

- [ ] Every active DB working group has `slack_channel_id` set
- [ ] Spec-insight-post job successfully posts to 4 WG channels on rotation
- [ ] Dead channels archived with redirect messages
- [ ] No channel with 0 human messages in 30 days remains active (except event channels not yet past their date)
- [ ] Product channels clearly separated from protocol channels

## Risks

- **Archiving channels with hundreds of members might cause complaints.**
  Mitigation: Post a clear redirect message before archiving. Members auto-join
  the target channel.

- **Renaming DB working groups breaks website links.**
  Mitigation: Keep slugs unchanged. Only change display names.

- **Councils feel demoted.**
  Mitigation: They never had channels. This isn't a demotion, it's an honest
  acknowledgment. Frame it as "councils inform working groups" not "councils
  got killed."

## Implementation Order

1. Look up Slack channel IDs for the 6 channels we're wiring up
2. Write and run the DB migration
3. Post redirect messages in channels about to be archived
4. Archive dead channels
5. Rename product channels
6. Verify spec-insight-post job picks up the new targets
7. Monitor for 30 days, archive #wg-creative and #wg-signals if still dead
