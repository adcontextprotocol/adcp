---
"adcontextprotocol": patch
---

Fix misleading "Professional tier or higher" copy across the public-listing UX. The code accepts four API-access tiers (Professional, Builder, Member, Leader), but error messages, dashboard tooltips, Addie's behavior rules, OpenAPI schema descriptions, and docs all said "Professional tier or higher" — readable as "Professional and tiers more expensive than it" rather than the intended "any paid tier". Addie repeatedly told Builder customers to upgrade to Professional, which is both wrong and a lower-priced tier. Replaces the phrase with explicit tier lists ("Professional, Builder, Member, or Leader" or "paying AAO members") across 11 surfaces. No behavior change.
