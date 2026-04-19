---
"adcontextprotocol": minor
---

Add `collection-lists` specialism covering program-level brand safety via collection-list CRUD. Closes #2330.

Collection lists operate on content programs (shows, series, podcasts) identified by platform-independent IDs (IMDb, Gracenote, EIDR), parallel to the `property-lists` specialism which operates on technical surfaces (domains, apps). The new specialism bundle exercises the full CRUD lifecycle — `create_collection_list`, `list_collection_lists`, `get_collection_list` (with `resolve: true`), `update_collection_list`, `delete_collection_list` — plus capability discovery.

**Scope (CRUD-only, by design).** Unlike `property-lists`, collection lists have no `validate_collection_delivery` counterpart yet. Enforcement is setup-time (the governance agent resolves the list, sellers cache it, delivery matches at serve time) rather than post-hoc. When `validate_collection_delivery` is added, a validation phase can be appended to this specialism.

**Additive enum value.** `collection-lists` is new — no existing agent declares it, so no migration required. Minor rather than major bump.

**Training agent fix.** Several property-list and collection-list tool definitions were missing `brand` (and `resolve` on `get_property_list`) from their inputSchema, even though the handlers already read those fields for session keying. MCP clients that strip undeclared fields were collapsing post-create calls to an empty session — making the CRUD lifecycle fail on the second call. Tool inputSchemas now declare these fields. This also repairs the `property-lists` storyboard smoke path, which was failing end-to-end against the deployed training agent for the same reason. An in-tree storyboard test (`server/tests/unit/collection-lists-storyboard.test.ts`) pins the invariant.
