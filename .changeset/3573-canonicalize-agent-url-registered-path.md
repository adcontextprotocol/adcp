---
---

fix(registry): canonicalize `agent_url` on the registered path (issue #3573).

The crawler/discovered path already canonicalized `agent_url`; the member-side registered path did not. POST/PATCH/DELETE on `/api/me/agents`, the bulk `PUT /api/me/member-profile`, and Addie's `save_agent`/`remove_saved_agent` wrote raw URLs into `member_profiles.agents` JSONB and `agent_registry_metadata`, so two writes for the same logical agent differing only in case or trailing slash landed as separate rows — silently dropping the member badge off any discovered authorization whose URL differed only in case or trailing slash. Application-layer fix: canonicalize at every member-side write boundary, plus canonical-key + `?? raw` fallback in the JS read sites in `FederatedIndexService`. Forward-only — pre-existing non-canonical rows continue to match canonical inputs via the read-side fallback.
