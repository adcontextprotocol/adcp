---
---

Training agent: `get_property_list`, `update_property_list`, `delete_property_list`, and `validate_property_delivery` now return a uniform error on unresolved `list_id` — `error.code` is `REFERENCE_NOT_FOUND` (was lowercase `not_found`), `error.message` is the generic `"Property list not found"` (was `"No property list with id '<id>'"`), and `error.field` is `list_id`. Closes #2739.

The probed id is no longer echoed back on the error path, so paired-probe uniform-response invariants (e.g. `@adcp/client` fuzz) now pass against the public test agent. This matters because the training agent is the reference implementors point conformance runs at; an echoing message there invalidates the signal for every downstream seller running the same invariant.
