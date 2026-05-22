---
---

fix(addie): correct start_time shape in Addie's create_media_buy guidance

The call_adcp_task tool description and adcp-media-buy SKILL.md both
documented start_time as an object ({ type: "asap"|"scheduled" }) that
does not exist in the schema. start_time is a oneOf string: the literal
"asap" or an ISO 8601 datetime. Updates the quick-reference, SKILL.md
example, and the create_media_buy validator to reject object payloads early
with a clear error message. Fixes #4736.
