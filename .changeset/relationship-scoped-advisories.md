---
"adcontextprotocol": minor
---

Add a joined 3.2 warnings and advisories contract. Successful `create_media_buy` and `update_media_buy` responses may carry structured non-blocking warnings; continuing conditions appear as compact current advisories on media buys, packages, or package–creative assignments. Seven standard advisory types cover creative, audience, inventory, pacing, and budget risks or optimization opportunities that warrant buyer attention. Mixed publisher approvals use scoped outcomes. Every advisory-capable seller supports signed `advisories.changed` invalidations and complete `get_media_buys` repair. Assignment notifications remain independent: sellers without an advisory catalog may emit `creative.assignment_changed`, while creative-library sellers may independently expose bounded reverse assignment state through `list_creatives`. No advisory IDs, sub-versions, history API, automatic action dispatcher, or separate `get_advisories` task is introduced.
