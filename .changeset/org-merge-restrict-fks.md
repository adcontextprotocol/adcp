---
---

fix(org-merge): handle the five RESTRICT-FK tables that referenced `organizations(workos_organization_id)` without `ON DELETE` and were silently breaking merges. `mergeOrganizations` now reparents `agent_contexts`, `person_relationships`, `certification_goals`, `certification_expectations`, and `user_goal_history`, with conflict-aware reparenting (keep primary on `(org, agent_url)` / `(org, credential_id)` / `(org, email)`) for the unique-constrained ones. `previewMerge` now counts these tables too.
