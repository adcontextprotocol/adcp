---
---

Training agent protocol compliance fixes:

- **#2235**: `create_media_buy` and `update_media_buy` now persist `package.targeting.property_list`, `targeting.collection_list`, and `targeting.collection_list_exclude`; `get_media_buys` echoes them back. Targeting refs are validated (type, length, http(s) scheme) and malformed input returns `VALIDATION_ERROR` instead of being silently dropped. Added `MAX_PACKAGES_PER_BUY = 50` cap.
- **#2236**: `get_collection_list`, `update_collection_list`, and `delete_collection_list` now validate `list_id` (type and length) and return clean responses.
- **#2237**: Structured AdCP errors (handler returns `{ errors: [...] }`) now complete the task instead of marking it failed, so clients see `GOVERNANCE_DENIED`, `INVALID_REQUEST`, etc. in the response body rather than `MCP -32603: Task failed`. Only thrown exceptions mark tasks as failed. Task-created log includes `errorCode` so anomaly monitoring still distinguishes structured-error from successful operations.
- **#2238**: Central dispatcher validates `adcp_major_version` against `SUPPORTED_MAJOR_VERSIONS` ([3]) and returns `VERSION_UNSUPPORTED` for unsupported versions.
- **#2239**: `get_signals` returns the full catalog (capped) instead of `INVALID_REQUEST` when called without `signal_spec` or `signal_ids`, supporting browse-style discovery.
