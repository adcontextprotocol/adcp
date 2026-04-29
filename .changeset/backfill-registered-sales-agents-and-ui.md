---
---

Backfill member-registered sales agents that were flipped to `'buying'` by migration 387, and update the public registry UI (`server/public/agents.html`) so `'sales'` renders correctly and is filterable.

Migration 454 conservatively flips `member_profiles.agents[].type` from `'buying'` → `'sales'` only when (a) the agent URL appears in `discovered_agents` with `agent_type = 'sales'` (PR #3496's migration 453 backfill is the authoritative source), or (b) the member's `offerings` declares `'sales_agent'` and does not declare `'buyer_agent'`. Members offering both are skipped to avoid misclassifying legitimate buyer agents — those will be corrected by the prevention layer in PR #3.

UI changes: add a "Sales" filter button, expand `typeLabel()` to handle `'sales'` → `"Sales"`, and replace the four hard-coded `agent.type === 'buying'` checks with an `isCommerceType()` helper that covers both sell-side and buy-side commerce agents (publishers, properties, products, and AdCP spec checks apply to both).

Refs #3495. Merges after #3496.
