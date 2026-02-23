---
"adcontextprotocol": minor
---

Add property list check and enhancement to the AAO registry API.

Registry:
- New `blocked_domains` table with typed entries (`ad_server`, `intermediary`, `cdn`, `tracker`), seeded with ~60 known ad tech infrastructure domains
- New `property_check_reports` table stores full check results by UUID for 7 days

API:
- `POST /api/properties/check` — accepts up to 10,000 domains, returns remove/modify/assess/ok buckets and a report ID
- `GET /api/properties/check/:reportId` — retrieve a stored report

Tools:
- `check_property_list` MCP tool — runs the check and returns a compact summary + report URL (avoids flooding agent context with thousands of domain entries)
- `enhance_property` MCP tool — analyzes a single unknown domain: WHOIS age check (< 90 days = high risk), adagents.json validation, AI site structure analysis, submits as pending registry entry for Addie review
