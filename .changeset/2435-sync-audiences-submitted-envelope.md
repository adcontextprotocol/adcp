---
"adcontextprotocol": minor
---

spec(media-buy): extend three-shape submitted envelope to `sync_audiences`.

PR #2434 established the three-shape (`success | error | submitted`) response pattern on `sync_creatives` for operations whose ingestion may be queued before per-item results can be returned. `sync_audiences` is the next natural fit — audience matching is classically asynchronous (`capabilities.audience_targeting.matching_latency_hours` already declares it), and sellers whose pipeline batches ingestion, gates the upload behind governance review, or routes through an upstream clean-room cannot return the per-audience `audiences` array before the response is emitted.

`SyncAudiencesSubmitted` mirrors `SyncCreativesSubmitted` exactly: top-level `status: "submitted"` + `task_id`, optional `message`, optional advisory `errors[]`, no `audiences` array on the envelope. The synchronous success branch is tightened with the same triple-`not` guard (`errors`, `task_id`, `status: submitted`) so the three shapes are unambiguously mutually exclusive — preserving the structural parser invariant from adcp-client#649 across all three-shape `sync_*` responses.

This is purely additive on the success/error arms — per-audience asynchronous matching (an audience reported with `status: "processing"` while the rest of the sync resolves synchronously) continues to belong on the synchronous success branch via the existing `audience-status` enum; the submitted envelope is the less-common operation-level async case.

Files:
- `static/schemas/source/media-buy/sync-audiences-response.json` — third `SyncAudiencesSubmitted` arm; success/error arms tightened to forbid `task_id` / `status: submitted` so the discriminated union is mutually exclusive.
- `docs/media-buy/task-reference/sync_audiences.mdx` — `## Response shapes` documents the three branches; quick-start examples updated to discriminate `submitted` before reading `audiences`; new `## Async patterns` section names the per-audience-async vs operation-level-async distinction.
- `scripts/oneof-discriminators.baseline.json` — variant count bumped to 3.

`sync_accounts` and `sync_event_sources` were considered for the same treatment and deliberately left synchronous:

- `sync_accounts` — per-item `action` + `status` already cover the realistic async-of-records cases; no operation-level async pattern needed.
- `sync_event_sources` — deferred pending implementer input on whether seller-side validation of stream endpoints is a real latency source (filed as a follow-up RFC).

Closes #2435.
