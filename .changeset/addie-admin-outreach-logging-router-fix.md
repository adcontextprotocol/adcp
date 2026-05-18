---
---

fix(addie): add quick-match router pattern for admin outreach logging phrases

Adds a deterministic quick-match pattern for "I emailed/called/met with/spoke
with/contacted" phrasing so admin outreach reports reliably route to the admin
tool set and trigger log_conversation — instead of falling through to the LLM
router where the intent sometimes misfires.

Also updates log_conversation's usage_hints to make it clear all fields except
summary are optional and can be inferred from context.
