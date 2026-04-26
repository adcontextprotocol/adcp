---
---

Renumber `436_organization_membership_provisioning_source.sql` → `437_organization_membership_provisioning_source.sql` to break a third parallel-merge migration collision (after the 433 and 434 incidents earlier today). PR #3294 (`addie_prompt_telemetry`) merged at 16:09 UTC and PR #3295 (`organization_membership_provisioning_source`) at 16:19 UTC, both claiming version 436. Standard policy: rename the second-merged file. The CI fix from #3288 (which closes the parallel-merge gap) only catches *future* collisions; existing dups on main still need this manual unstick.
