---
"adcontextprotocol": patch
---

The failed `create_content_standards` and `get_creative_features` responses list at least one error, as every other task error response does (a correction under DR-0036: every 3.2.12 task error branch that bounds `errors` sets `minItems: 1`).

Failed task responses have one definition, `core/task-error-response.json`. The error branches of 21 tasks, including `build_creative`'s and `sync_catalogs`', the media buy failed result, the media buy issue task failure, the `create_content_standards`, `update_content_standards`, and `get_creative_features` error branches, and the two `get_reporting_status` failed branches compose it and keep their own titles, guards, error item definitions, and fields. No payload's validity changes.

The `sync_catalogs` progress `current_step` is at most 500 characters, as every working task's current step is (a correction under DR-0036: 3.2.12 `core/compact-task-working.json` sets `maxLength: 500` on `current_step`).

The input-required payloads of `sync_creatives`, `sync_catalogs`, `update_media_buy`, and `get_products` compose `core/compact-task-input-required.json`, and the `get_creative_features` and `preview_creative` submitted responses compose the shared submitted body. Each keeps its own fields and reason codes. They now take the shared `errors` list, as the compact input-required and submitted payloads published in 3.2.12 declare it (a correction under DR-0036): an `errors` value that is not an array of errors is rejected there.

Submitted and working payloads have one definition each. `core/media-buy-submitted.json` and the `sync_audiences` submitted branch compose `core/task-submitted-response.json`; the `get_products` and `get_signals` submitted documents compose `core/compact-task-submitted.json`; and the `sync_creatives` and `sync_catalogs` working payloads compose `core/compact-task-working.json`. Each keeps its own fields and guards. No payload's validity changes.

`success` on the `update_content_standards` and `provide_performance_feedback` responses is deprecated (`x-deprecated-in: 3.3.0`, `x-removed-in: 4.0.0`): the envelope `status` is the single authoritative response state. Senders keep sending it through 3.x.

Each request-signing error code's `enumMetadata` names the header that carries it (`http_header`: `WWW-Authenticate`, scheme `Signature`, parameter `error`), and the compliance catalog lists every request-signing code with that header, its recovery, and its suggested action, generated from `enums/request-signing-error-code.json`.
