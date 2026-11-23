---
"adcontextprotocol": patch
---

The failed `create_content_standards` and `get_creative_features` responses list at least one error, as every other task error response does (a correction under DR-0036: every 3.2.12 task error branch that bounds `errors` sets `minItems: 1`).

Failed task responses have one definition, `core/task-error-response.json`. The error branches of 21 tasks, including `build_creative`'s and `sync_catalogs`', the media buy failed result, the media buy issue task failure, the `create_content_standards`, `update_content_standards`, and `get_creative_features` error branches, and the two `get_reporting_status` failed branches compose it and keep their own titles, guards, error item definitions, and fields. No payload's validity changes.

The `sync_catalogs` progress `current_step` is at most 500 characters, as every working task's current step is (a correction under DR-0036: 3.2.12 `core/compact-task-working.json` sets `maxLength: 500` on `current_step`).
