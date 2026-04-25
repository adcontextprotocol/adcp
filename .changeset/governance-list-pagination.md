---
---

feat(training-agent): add cursor-based pagination to list_content_standards, list_collection_lists, and list_property_lists handlers

Fifth entry in the rolling pagination conformance series (#3095, #3100, #3109, #3110). Adds full cursor-based pagination to the three governance list handlers that previously emitted no `pagination` block or a stub `{ has_more: false }`.

**Handler changes:**
- `handleListContentStandards` — reads `req.pagination?.max_results` (default 50, cap 100), decodes cursor via `decodeOffsetCursor('content_standards', ...)`, slices the filtered result set, and emits a full `pagination` envelope including `total_count` and a continuation `cursor` when `has_more: true`.
- `handleListCollectionLists` — replaces the `{ has_more: false }` stub with a real offset-cursor implementation using kind `'collection_lists'`.
- `handleListPropertyLists` — same pattern, kind `'property_lists'`.

**inputSchema updates:** `pagination` property added to the `list_content_standards`, `list_collection_lists`, and `list_property_lists` MCP tool definitions, and to `LIST_COLLECTION_LISTS_SCHEMA` in `framework-server.ts` (Zod-validated path) so callers receive the field in tool descriptions.

**Storyboards:** three new universal storyboards mirror the `pagination-integrity-list-accounts` pattern (create-then-list bootstrap, three items, `max_results=2` two-page walk):
- `static/compliance/source/universal/content-standards-pagination-integrity.yaml`
- `static/compliance/source/universal/collection-lists-pagination-integrity.yaml`
- `static/compliance/source/universal/property-lists-pagination-integrity.yaml`

**Doc-parity:** both `docs/building/conformance.mdx` and `docs/building/compliance-catalog.mdx` updated with rows for the three new storyboards.

Non-protocol change (training agent server-side behavior only, `--empty` changeset per playbook).

Closes #3112.
