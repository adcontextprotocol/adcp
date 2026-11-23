---
"adcontextprotocol": patch
---

Docs: the 3.3 release notes and the 3.2-to-3.3 migration guide now date the closed-schema triage, and the schema opening that led to it (#8866), to `3.3.0-beta.6`, where they first shipped, instead of rc.0. The beta fields that leave or move, including `include_collections` and `collections` on `get_products`, are in the `3.3.0-beta.5` schemas and absent from `3.3.0-beta.6`. The `metric_id` withdrawal (#8854) still lands after rc.0. Documentation only; no schema change.
