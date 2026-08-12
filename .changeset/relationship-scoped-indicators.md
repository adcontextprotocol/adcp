---
"adcontextprotocol": minor
---

Add a joined 3.2 warnings and indicators contract. Successful `create_media_buy` and `update_media_buy` responses may carry structured non-blocking warnings; continuing conditions appear as compact current indicators on media buys, packages, or package–creative assignments. Seven standard indicator types cover creative, audience, inventory, pacing, and budget risks or optimization opportunities that warrant buyer attention. Mixed publisher approvals use scoped outcomes. Every indicator-capable seller supports signed `indicators.changed` invalidations and complete `get_media_buys` repair. Assignment notifications remain independent: sellers without an indicator catalog may emit `creative.assignment_changed`, while creative-library sellers may independently expose bounded reverse assignment state through `list_creatives`. No indicator IDs, sub-versions, history API, automatic action dispatcher, or separate `get_indicators` task is introduced.
