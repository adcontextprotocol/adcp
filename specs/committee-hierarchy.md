# Committee Hierarchy

## What We're Building

Let working groups nest under other working groups so we can consolidate a sprawl of dead committees into a coherent tree of five protocol areas. Dead WGs (like `wg-pmp-and-deals`, `wg-sponsored-intelligence`, the nine councils) become subgroups of a living parent without losing their members, documents, meetings, or history. Heavy "topics" that deserve their own members, channel, and docs graduate to first-class subgroups; lightweight tags stay as topics.

The five top-level parents are:

1. `wg-campaign-lifecycle` - discovery, proposals, execution, trafficking, pacing, makegoods, reconciliation
2. `wg-creative` - creative lifecycle, generative, governance, audit
3. `wg-signals-measurement` - audience signals, measurement, verification, attribution
4. `wg-governance` - brand.json, adagents.json, brand safety, compliance, policy
5. `wg-builders` - SDKs, tooling, integration help (not protocol design)

Everything else is either a subgroup of one of these five, archived, or a chapter/industry gathering (those remain top-level, not nested under the five).

## Scope

### Already built on this branch

- Migration `404_working_group_parent_id.sql` (self-FK with `ON DELETE SET NULL`).
- `WorkingGroup.parent_id` on `CreateWorkingGroupInput` / `UpdateWorkingGroupInput`.
- `WorkingGroupDatabase.listSubgroups(parentId)` and cycle validation in `assertValidParent`.
- Admin API `POST/PUT /api/admin/working-groups` accepts `parent_id`, returns 400 on cycles.
- Admin UI `admin-working-groups.html` parent selector and nested list rendering.

### This spec covers

Topic/subgroup decisions, public API and page changes, membership and Slack inheritance, permission model, Slack automation behavior, data migration for the five-parent consolidation, and rollout order.

---

## 1. Data Model Decisions

### 1.1 Topics stay. Some graduate to subgroups.

**Decision**: Keep the lightweight `working_groups.topics` JSONB. Add a tool to "graduate a topic to a subgroup" as an admin action. Do not auto-migrate all topics.

**Why**: Topics are filter tags on meetings, perspectives, and meeting series. They are cheap, they are subscribed-to via `working_group_topic_subscriptions.topic_slugs`, and `meeting_series.invite_mode = 'topic_subscribers'` depends on them. A subgroup is a heavier concept: it has its own membership list, its own documents, optionally its own Slack channel, its own leaders, and its own page. Most topics never need that.

**The graduate action** is defined in section 3 (Migration Strategy). It creates a new subgroup, reparents content, migrates subscribers to members, and removes the topic from the parent's `topics` array.

### 1.2 Membership is per-group, not inherited.

**Decision**: A subgroup member is not automatically a parent member. A parent member is not automatically a subgroup member. Each membership row stands alone.

**Why**: Councils have ~200 members each. If every council member became a member of `wg-governance`, governance would balloon to 1500+ members that never opted in. Notifications, digests, and quorum logic all break. Explicit opt-in keeps the data honest.

**Derived "family membership" for access control and counts**:

- Add `WorkingGroupDatabase.isFamilyMember(groupId, userId)` that returns true if the user is an active member of `groupId` or any of its descendants.
- Add `WorkingGroupDatabase.countFamilyMembers(groupId)` that returns distinct active members across a group and all descendants.
- Parent committee pages show `"234 members (412 across subgroups)"` using these.

**Private-group access control**: If the parent is private, subgroup access also requires parent membership OR subgroup membership. Public parent with private subgroup: subgroup access still requires subgroup membership. This matches how people expect nesting to work.

### 1.3 Slack channels are per-group, with a parent fallback for automation.

**Decision**: Each group has its own `slack_channel_id` or it does not. Channels are not structurally inherited in the DB. But for automated posting, we introduce `WorkingGroupDatabase.resolveNotificationChannel(groupId)` that:

1. Returns the group's own `slack_channel_id` if set.
2. Otherwise walks up `parent_id` until it finds one.
3. Returns null if nothing in the chain has a channel.

Any automation that "posts to a WG's channel" (spec-insight-post, wg-digest, meeting reminders, new-post notifications) uses `resolveNotificationChannel`. Human-facing UI (the group page's "Join our Slack channel" link) uses only the direct `slack_channel_id` - we don't want to tell users to join the parent's channel implicitly.

**Why**: Creating 20 new Slack channels for newly-graduated subgroups is a mess. We want to be able to create the subgroup first, post updates in the parent channel with a `#subgroup-name` prefix, and only spin up a dedicated channel when activity justifies it.

---

## 2. Public Page and API Changes

### 2.1 `GET /api/working-groups/:slug` response additions

Add three fields to the response body:

```json
{
  "working_group": {
    "...existing fields...",
    "parent": { "id": "...", "slug": "wg-campaign-lifecycle", "name": "Campaign Lifecycle" } | null,
    "subgroups": [
      {
        "id": "...",
        "slug": "wg-pmp-and-deals",
        "name": "PMPs and Deals",
        "description": "...",
        "member_count": 12,
        "slack_channel_url": "...",
        "last_activity_at": "2026-03-01T00:00:00Z"
      }
    ],
    "family_member_count": 412
  },
  "is_member": true,
  "is_family_member": true
}
```

`last_activity_at` is `GREATEST(last perspective.published_at, last meeting.start_time)` for the subgroup - computed in SQL, no new column. If no activity, return `null` and the UI renders "Quiet".

### 2.2 Posts and meetings aggregate up by default, filter down on demand

**Decision**: When viewing a parent WG's page, posts and meetings include content from all descendants, labeled with source. Subgroup pages show only that subgroup's content.

API changes to `GET /api/working-groups/:slug/posts` and `GET /api/working-groups/:slug/events`:

- New optional query param `include_subgroups` (default `true` for parent groups, ignored for leaf groups).
- Response items get an added `source_group` field: `{ id, slug, name }` identifying which group the post/event belongs to. For direct content, `source_group.id === group.id`.
- Backend query changes from `WHERE working_group_id = $1` to `WHERE working_group_id IN (SELECT id FROM working_groups WHERE id = $1 OR parent_id = $1 OR parent_id IN (SELECT id FROM working_groups WHERE parent_id = $1))`. Hardcode two-level descent - we do not plan to support arbitrary depth. (See section 1.4 below.)

### 2.3 Depth is capped at two.

**Decision**: Maximum hierarchy depth is 2. Top-level parent, and one level of subgroups. No grandchildren.

**Why**: This is an operational decision, not a schema one. We have five parents and a few dozen potential subgroups. Three-deep nesting creates UI headaches (breadcrumb rendering, post aggregation, membership derivation) without solving any real problem.

Enforce this in `assertValidParent`:

```ts
// In addition to cycle check
if (parentId) {
  const parent = await query<{ parent_id: string | null }>(
    'SELECT parent_id FROM working_groups WHERE id = $1',
    [parentId]
  );
  if (parent.rows[0]?.parent_id) {
    throw new Error('Working group hierarchy is limited to two levels');
  }
}
```

### 2.4 Detail page UI changes

On `working-groups/detail.html`:

**If the group has a parent** (subgroup page):

- Above the group title, render: `Subgroup of <a href="/working-groups/{parent.slug}">{parent.name}</a>`
- Do not render the subgroups list (a subgroup can't have its own subgroups).

**If the group has subgroups** (parent page):

- New section between the description and the posts feed, titled "Subgroups".
- Each subgroup renders as a card: name (linked to subgroup slug), description, member count, last activity.
- Posts and events are clearly labeled with `source_group` when they come from a subgroup: a small pill/chip reading "from Creative Audit" that links to the subgroup.
- Add a view toggle above the posts/events feed: "All (parent + subgroups)" (default) | "Just this group".

**Member counts display**: Parent pages show `"234 direct members - 412 across subgroups"`. Subgroup pages show their own count only.

**Subscribe / join**: The join button on a parent page only joins the parent. Joining a subgroup is a separate action on the subgroup page. We do not auto-join children.

---

## 3. Migration Strategy

Three migrations run in order. They are all in the `server/src/db/migrations/` pipeline.

### 3.1 Migration `405_seed_five_parents.sql`

Creates (if missing) the five top-level parent WGs. Idempotent:

```sql
INSERT INTO working_groups (name, slug, description, committee_type, status, display_order, is_private, topics)
VALUES
  ('Campaign Lifecycle', 'wg-campaign-lifecycle',
   'Discovery, proposals, execution, trafficking, pacing, makegoods, reconciliation.',
   'working_group', 'active', 10, false, '[]'),
  ('Creative', 'wg-creative',
   'Creative lifecycle, generative creative, governance, and audit.',
   'working_group', 'active', 20, false, '[]'),
  ('Signals and Measurement', 'wg-signals-measurement',
   'Audience signals, measurement, verification, attribution.',
   'working_group', 'active', 30, false, '[]'),
  ('Governance', 'wg-governance',
   'brand.json, adagents.json, brand safety, compliance, policy.',
   'governance', 'active', 40, false, '[]'),
  ('Builders', 'wg-builders',
   'SDKs, tooling, integration help. Not protocol design.',
   'working_group', 'active', 50, false, '[]')
ON CONFLICT (slug) DO NOTHING;
```

### 3.2 Migration `406_reparent_dead_committees.sql`

Data-only migration - no schema change. Reparents the dead committees. Uses slug lookups so it's safe to re-run:

```sql
-- Campaign Lifecycle subgroups
UPDATE working_groups SET parent_id = (SELECT id FROM working_groups WHERE slug = 'wg-campaign-lifecycle')
WHERE slug IN ('wg-pmp-and-deals', 'wg-sponsored-intelligence', 'council-media-buyers', 'council-sellers')
  AND parent_id IS NULL;

-- Creative subgroups
UPDATE working_groups SET parent_id = (SELECT id FROM working_groups WHERE slug = 'wg-creative')
WHERE slug IN ('wg-creative-agents', 'council-creative', 'council-agencies')
  AND parent_id IS NULL;

-- Signals and Measurement subgroups
UPDATE working_groups SET parent_id = (SELECT id FROM working_groups WHERE slug = 'wg-signals-measurement')
WHERE slug IN ('wg-measurement-verification-validation', 'wg-audience-signals',
               'council-measurement', 'council-data-providers')
  AND parent_id IS NULL;

-- Governance subgroups
UPDATE working_groups SET parent_id = (SELECT id FROM working_groups WHERE slug = 'wg-governance')
WHERE slug IN ('wg-arch-and-technical-standards', 'wg-brand-safety',
               'council-brands', 'council-publishers', 'council-policy')
  AND parent_id IS NULL;

-- Builders subgroups (when they exist)
UPDATE working_groups SET parent_id = (SELECT id FROM working_groups WHERE slug = 'wg-builders')
WHERE slug IN ('wg-sdk-ts', 'wg-sdk-python', 'wg-sdk-go', 'council-developers')
  AND parent_id IS NULL;

-- Archive subgroups that were already marked dead (keep them visible under parent history)
UPDATE working_groups SET status = 'archived'
WHERE slug IN ('wg-pmp-and-deals', 'wg-sponsored-intelligence',
               'wg-measurement-verification-validation', 'wg-arch-and-technical-standards')
  AND status = 'inactive';
```

**Rule**: Only write exact slugs we've verified exist in production. Any slug in the UPDATE list that doesn't exist is a no-op. Before merging this migration, the engineer implementing it must run against production DB to confirm the slug list - do not ship unverified slugs. Track the authoritative list in a comment at the top of the file.

### 3.3 Migration `407_drop_dead_topics.sql`

Not required at migration time. Topic cleanup happens via the `graduate_topic_to_subgroup` admin tool (section 5.2). We leave the topics as-is in the DB and do the work when someone manually triggers graduation per topic. Skip this migration.

### 3.4 Runtime tool: `graduate_topic_to_subgroup`

New admin endpoint `POST /api/admin/working-groups/:slug/topics/:topicSlug/graduate` that runs in a transaction:

1. Load the parent working group and confirm the topic exists in `topics` JSONB.
2. Create a new subgroup with `parent_id = parent.id`, `slug = <topicSlug>` (or `<parent-slug>-<topic-slug>` if collision), `name = topic.name`, `description = topic.description`, `slack_channel_id = topic.slack_channel_id`.
3. Copy all `working_group_topic_subscriptions` rows where `working_group_id = parent.id AND topicSlug = ANY(topic_slugs)` into `working_group_memberships` for the new subgroup (deduped).
4. Remove `topicSlug` from every user's `topic_slugs` array in the parent's subscriptions (and delete empty-array rows).
5. For `meeting_series` on the parent with `topicSlug = ANY(topic_slugs)`: move them to the new subgroup (`working_group_id = newSubgroupId`). If a series has multiple topic slugs, split: create one series per group (duplicate recurrence settings, Zoom/Calendar IDs stay with the primary series).
6. For `meetings` and `perspectives` on the parent with `topicSlug = ANY(topic_slugs)`: update `working_group_id = newSubgroupId` and strip `topicSlug` from their `topic_slugs` arrays.
7. Remove the topic from the parent's `topics` JSONB.
8. Return `{ subgroup_id, moved: { subscriptions, meetings, perspectives, series } }` for confirmation in the admin UI.

The UI adds a "Graduate to subgroup" button next to each topic in the edit modal. Clicking it opens a confirmation dialog showing the move counts before running.

**Notification to subscribers**: Send one Slack DM (or email if not on Slack) to everyone whose subscription was converted: "Your topic subscription to 'Brand Safety' is now a subgroup membership in AAO. Same notifications, different name. Manage at `/working-groups/<subgroup-slug>`." Rate-limit to 1 per user per hour to avoid spam if the admin does several in succession.

---

## 4. Permission Model

### 4.1 Who can reparent, who can create subgroups

**Admins only** can set or change `parent_id`. Not group leaders. Reparenting a group is a governance decision - who the group reports to - and can have large downstream effects (access control on private groups, notification routing). Keep it gated.

**Admins only** can create subgroups. Leaders of the parent can request subgroup creation through an existing admin tool but do not have direct API access. We could loosen this later; start tight.

### 4.2 Leader scope is per-group

**Decision**: A parent's leader does not automatically gain leader rights on subgroups. A subgroup's leader does not have any rights on the parent. Leadership is per-group, like membership.

**Why**: Same reason as membership. A leader of `wg-campaign-lifecycle` does not necessarily want to run `wg-pmp-and-deals`. Auto-leader rights create accountability gaps ("the parent leader will handle it").

Admin tooling that manages leader lists shows parent leaders in the subgroup page as a read-only "See also" section for discoverability.

### 4.3 Committee-type constraints

**Decision**: Any committee type can be a child of `working_group` or `governance`. `council`, `chapter`, and `industry_gathering` cannot have subgroups. Enforce in `assertValidParent`:

```ts
if (parentId) {
  const { rows } = await query<{ committee_type: string }>(
    'SELECT committee_type FROM working_groups WHERE id = $1',
    [parentId]
  );
  const parentType = rows[0]?.committee_type;
  if (parentType && !['working_group', 'governance'].includes(parentType)) {
    throw new Error(`Committee type '${parentType}' cannot have subgroups`);
  }
}
```

**Why**: Councils are representative bodies with their own membership logic; they should be children of a working group (they report up), not parents. Chapters are geographic and industry gatherings are time-bound events - neither is a protocol area.

---

## 5. Slack Integration

### 5.1 `resolveNotificationChannel` is the only entrypoint

Audit and migrate all existing channel lookups:

- `server/src/addie/jobs/spec-insight-post.ts` - currently uses `getWorkingGroupBySlug(TARGET_CHANNEL_SLUG).slack_channel_id`. Change to `resolveNotificationChannel(targetWg.id)`.
- `server/src/addie/templates/wg-digest.ts` and `wg-digest-prep.ts` - same substitution.
- `server/src/addie/services/wg-welcome.ts` - same.
- Any other code matching `\.slack_channel_id` in automation paths: grep the `server/src/addie` and `server/src/notifications` trees and convert.

Leave human-facing reads (the committee detail page's "Join Slack" link, admin UI channel display) on direct `slack_channel_id`.

### 5.2 Posting prefix convention

When a subgroup has no channel of its own and we post via the parent's channel, prefix the message with `[{subgroup.name}]`:

```
[PMPs and Deals] Something I've been thinking about...
```

This applies to spec-insight-post, digest posts, meeting reminders. Implement as a wrapper:

```ts
export async function postToGroupChannel(groupId: string, text: string, opts?: SlackSendOpts) {
  const { channelId, viaParent, group } = await resolveNotificationChannel(groupId);
  if (!channelId) return { ok: false, error: 'No channel in hierarchy' };
  const prefixedText = viaParent ? `[${group.name}] ${text}` : text;
  return sendChannelMessage(channelId, { ...opts, text: prefixedText });
}
```

### 5.3 Cross-group digest behavior

`wg-digest` currently runs per-group. When it runs on a parent, include a "From subgroups" section that lists the top N posts/meetings from subgroups with links. Don't duplicate: if a user is a member of both parent and a subgroup, deduplicate by group. Add a `seen_in_group_ids` parameter to the digest builder or track at the recipient level.

---

## 6. API Surface Changes

### Admin

| Route | Change |
|---|---|
| `POST /api/admin/working-groups` | Already accepts `parent_id`. Add two-level depth validation. |
| `PUT /api/admin/working-groups/:id` | Already accepts `parent_id`. Add two-level depth validation. |
| `POST /api/admin/working-groups/:slug/topics/:topicSlug/graduate` | **New**. See section 3.4. |
| `GET /api/admin/working-groups/:id/subgroups` | **New**. Admin view returning all subgroups including archived. |

### Public

| Route | Change |
|---|---|
| `GET /api/working-groups/:slug` | Add `parent`, `subgroups`, `family_member_count`, `is_family_member`. |
| `GET /api/working-groups/:slug/posts` | Add `include_subgroups` param (default true for parents). Each post gets `source_group`. |
| `GET /api/working-groups/:slug/events` | Same as posts. |
| `GET /api/working-groups` | List: each item gets `parent_id` (already in model) and a `subgroup_count` integer. UI can render hierarchy without second request. |

### Database

| Method | Change |
|---|---|
| `WorkingGroupDatabase.listSubgroups(parentId)` | Already exists. |
| `WorkingGroupDatabase.getDescendantIds(groupId)` | **New**. Returns `[groupId, ...childIds]` for content aggregation. Hardcoded two-level SQL. |
| `WorkingGroupDatabase.resolveNotificationChannel(groupId)` | **New**. Returns `{ channelId, viaParent, group }`. |
| `WorkingGroupDatabase.isFamilyMember(groupId, userId)` | **New**. Uses `getDescendantIds`. |
| `WorkingGroupDatabase.countFamilyMembers(groupId)` | **New**. `COUNT(DISTINCT workos_user_id)` across descendant memberships. |
| `WorkingGroupDatabase.graduateTopicToSubgroup(parentSlug, topicSlug)` | **New**. Transactional. See section 3.4. |

---

## 7. Edge Cases

- **Deleting a parent**: Existing FK is `ON DELETE SET NULL`. Children detach and become top-level groups. Admin UI must warn: "This will orphan 4 subgroups, which will become top-level committees. Consider archiving them first or reparenting." Do not cascade delete.
- **Events linked to a WG that becomes a subgroup**: Events remain linked via `linked_event_id`. No change needed. The committee filter on the event page shows the subgroup name.
- **`meeting_series.invite_mode = 'topic_subscribers'` for a topic that graduates**: Migration step 5 converts series to the subgroup and changes `invite_mode` to `'all_members'` of the new subgroup. All former subscribers are already added as members in step 3.
- **`display_order`**: Applies within a level. Subgroups of the same parent sort by `display_order, name`. Top-level groups sort by `display_order, name`. No global interleaving.
- **`is_private` inheritance**: A subgroup can be private under a public parent and vice versa. Access check on the subgroup uses the subgroup's own `is_private`. The parent page lists private subgroups only if the viewing user is a family member of that subgroup. Non-members see only public subgroups.
- **Archived subgroups under an active parent**: The parent page hides archived subgroups from the "Subgroups" section by default. An admin UI toggle shows them. Posts from archived subgroups still aggregate up by default (they're history).
- **Cycle on self-parent with `ON DELETE SET NULL`**: A group cannot be its own parent. Already enforced. After deletion of the root, the `SET NULL` cannot reintroduce a cycle because `parent_id` goes to `NULL`.
- **Committee type change after reparenting**: If an admin changes a parent's `committee_type` to `chapter` (which can't have children), block the change if subgroups exist. Add to the PUT validator.

---

## 8. Implementation Order

Work proceeds in discrete PRs. Each PR ships independently.

**PR 1 - Depth cap and committee-type constraint** (backend only, small)

- Extend `assertValidParent` with the two-level check and the committee-type check from section 4.3.
- Unit tests for: self-parent, cycle, grandchild rejected, chapter-as-parent rejected.

**PR 2 - Family membership and descendant helpers** (backend only)

- Implement `getDescendantIds`, `isFamilyMember`, `countFamilyMembers`, `resolveNotificationChannel`.
- Unit tests against a tree fixture.

**PR 3 - Public API hierarchy fields** (backend)

- Update `GET /api/working-groups/:slug` to include `parent`, `subgroups`, `family_member_count`, `is_family_member`.
- Update posts/events endpoints to include descendants with `source_group` and `include_subgroups` param.
- Update list endpoint to include `subgroup_count`.
- Integration tests hitting the HTTP endpoints.

**PR 4 - Public page rendering** (frontend only)

- `working-groups/detail.html`: parent breadcrumb on subgroup pages, subgroups section on parent pages, source labels on posts/events, view toggle, family member count.

**PR 5 - Slack automation** (backend)

- Grep audit of all `.slack_channel_id` reads in automation paths.
- Replace with `resolveNotificationChannel` and `postToGroupChannel` wrapper.
- Add `[SubgroupName]` prefixing when posting via parent channel.
- Unit tests for the wrapper. Manual verification against a test channel.

**PR 6 - Five-parent seeding** (migration only)

- Migration `405_seed_five_parents.sql`. Idempotent `ON CONFLICT DO NOTHING`.

**PR 7 - Reparenting migration** (migration + verification)

- Verify the slug list against production before merging.
- Migration `406_reparent_dead_committees.sql`.
- Archive flags applied in the same migration.
- Post-merge: smoke test the five parent pages in production.

**PR 8 - Topic graduation tool** (backend + admin UI)

- `POST /api/admin/working-groups/:slug/topics/:topicSlug/graduate` endpoint.
- Admin UI button in the edit modal with confirmation dialog showing move counts.
- Slack DM notification to affected subscribers.
- Unit tests for the transactional flow. Run once on a staging topic before enabling in production.

**PR 9 - Parent digest cross-surfacing** (backend)

- Update `wg-digest` builder to include "From subgroups" section on parent groups. Dedup by group per recipient.

Production rollout happens after PR 7. PR 8 and 9 are follow-ups that do not block the consolidation launch.

---

## Success Criteria

- [ ] A dead WG like `wg-pmp-and-deals` appears as a subgroup under `wg-campaign-lifecycle` on the public page, with its members and posts intact.
- [ ] Visiting `/working-groups/wg-campaign-lifecycle` shows the five subgroups, their member counts, and a feed that includes labeled posts from each.
- [ ] Visiting `/working-groups/wg-pmp-and-deals` shows "Subgroup of Campaign Lifecycle" and only that subgroup's content.
- [ ] `spec-insight-post` posting to a subgroup without its own channel correctly posts to the parent's channel with a `[Subgroup Name]` prefix.
- [ ] An admin can graduate a topic to a subgroup in one click, subscribers become members, and nothing sends duplicate notifications.
- [ ] `assertValidParent` rejects: cycles, self-parent, grandchildren, councils/chapters as parents.
- [ ] A user who is a member of only `wg-pmp-and-deals` shows as a family member of `wg-campaign-lifecycle` but does not appear in the parent's direct member count.
