---
---

Backfill member-registered sales agents that were flipped to `'buying'` by migration 387, and update the public registry UI (`server/public/agents.html`) so `'sales'` renders correctly and is filterable.

Migration 455 flips `member_profiles.agents[].type` from `'buying'` → `'sales'` only when the agent URL appears in `discovered_agents` with `agent_type = 'sales'` (PR #3496's migration 454 backfill is the authoritative source).

UI changes: add a "Sales" filter button, expand `typeLabel()` to handle `'sales'` → `"Sales"`, and scope the four hard-coded `agent.type === 'buying'` checks for publishers / properties / spec compliance to `agent.type === 'sales'` only — buying agents don't have publishers in adagents.json and don't expose `list_authorized_properties`.

Refs #3495. Merges after #3496.
