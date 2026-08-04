---
"adcontextprotocol": minor
---

Add a joined 3.2 warnings and insights contract. Successful `create_media_buy` and `update_media_buy` responses may carry structured non-blocking warnings; continuing conditions appear as compact current insights on media buys, packages, or package–creative assignments. Seven standard insight types cover creative, audience, inventory, pacing, and budget opportunities. Mixed publisher approvals use scoped outcomes. Every insight-capable seller supports signed `insights.changed` invalidations and `get_media_buys` repair; creative-library sellers may additionally mirror bounded assignment state through `list_creatives` with `creative.assignment_changed`. No insight IDs, sub-versions, history API, automatic action dispatcher, or separate `get_insights` task is introduced.
