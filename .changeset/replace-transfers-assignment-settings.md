---
"adcontextprotocol": minor
---

`sync_creatives` `assignment_operations` `replace` now transfers the replaced assignment's authored settings to the replacement: `weight`, placement routing (`placement_ids`, `placement_refs`), `rotation_mode`, `group_id`, `sequence_position`, assignment `trackers`, and the `landing_page_url` override. A `weight` on the operation replaces the transferred weight, and `placement_ids` replaces the transferred placement routing entirely, including any `placement_refs`. Sellers validate the transferred settings against the replacement and reject the atomic request rather than drop or partially apply one; buyers change transferred trackers or the landing page with a following `assign`. Previously the spec was silent, so a swap could silently stop assignment measurement or revert clicks to the creative's own destination (#8687).
