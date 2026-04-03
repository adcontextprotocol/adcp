---
---

Split engagement tracking into individual user journeys and org health dashboards

- Add `GET /api/me/journey` endpoint returning personal tier, points breakdown, certification, working groups, contributions, and suggested next steps
- Add `GET /api/me/org-health` endpoint returning org health score (0-100), per-person engagement table, champions, and persona-aware suggested actions
- Replace org journey stepper on member hub with individual tier stepper (Explorer → Connector → Champion → Pioneer at 0/50/200/500 points)
- Add health score, people table, and champions sections to org dashboard
- Add journey context (tier, credentials, working groups, notable colleagues) to Addie's RelationshipContext
- Add admin-targeted engagement opportunities: org_health_review, team_certification_push, next_certification_tier, second_working_group, first_contribution
- Add milestone celebrations, social proof signals, returning user "what changed" experience
- Add admin-to-Addie nudge for disengaged team members with rate limiting
