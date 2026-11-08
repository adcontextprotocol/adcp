---
"adcontextprotocol": minor
---

A task response is either a success schema or an error schema, and the error contract lives once, in the shared envelope layer (DR-0038, proposed).

- `core/protocol-envelope.json` defines the task-level error list once, as `#/definitions/TaskErrors`: `errors[]` at the response root, an array of `core/error.json`. In 3.x the envelope doesn't declare `errors` among its properties, because that would change what stable task responses accept.
- New `core/task-error.json` states the failure rule once: a failed response carries at least one entry in `errors[]`. A task's `<task>-failed.json` exists only to add what is specific to its errors; it composes `core/task-error.json` and doesn't declare `errors` again.
- The schema build composes the shared error schema into the failed branch of every experimental task response. A task without a failed body of its own takes `core/task-error.json` as its failed body, and an error body's branch composes that body alone.

Experimental changes, under the experimental contract (6 weeks' notice):

- `status: failed` now requires at least one entry in `errors[]` and no longer accepts the success body on `check_governance`, `get_plan_audit_logs`, `report_plan_adjustment`, `report_plan_outcome`, `sync_plans`, `list_collections`, `list_proposals`, `si_get_offering`, `si_initiate_session`, `si_send_message` and `si_terminate_session`. `sync_reporting_receipts` and `sync_reporting_status` gain a failed response, which they had none of.
- `get_principal` and `sync_principal`: a failed or rejected response carries its errors at the response root (at most 16) and no `result`. The `result.kind: "failed"` branch is removed.
- `get_reporting_status`: the failed body composes `core/task-error.json`; `failure_kind` still selects between `lookup_unavailable` and `operational`.
- `acquire_rights`, `get_rights`, `search_brands` and `update_rights`: their failed bodies compose the shared error schema, and `status: failed` no longer accepts the success body. The failed bodies of `list_account_changes` and `request_account` compose it too, and accept what they accepted.
- The completed bodies of `get_reporting_status`, `list_account_changes`, `request_account` and the four `si_*` tasks refer to the envelope's `TaskErrors` instead of declaring their own copy.

Stable tasks keep exactly what their responses accept. The 20 stable failed bodies, and the shared `media-buy-commitment` failed body, that already required the same `errors` now compose `core/task-error.json` instead of declaring it; a comparison of the built responses of every stable task, flat, bundled and MCP-projected, finds no difference in what they accept. The 4.0 change for stable tasks is the `failed_task_errors_required_in_4_0` check in the AdCP 4.0 compatibility registry.

The training agent's `get_principal` and `sync_principal` send failures in the new format.

Minor, not patch: the release publishes a new schema identity (`core/task-error.json`) and a new definition on the protocol envelope.
