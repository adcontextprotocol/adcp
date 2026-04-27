---
---

Clarify format_id (structured object reference) vs format (full definition object) naming convention.

Adds normative docs, schema description updates, and llms.txt entries to prevent two recurring
implementation errors: setting format_id to a plain string, and putting a format_id object into a
format definition slot. No protocol wire change — purely additive docs and schema descriptions.
