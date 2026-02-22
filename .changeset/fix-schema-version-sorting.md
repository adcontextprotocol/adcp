---
"adcontextprotocol": patch
---

Fix schema version alias resolution for prereleases

- Fix prerelease sorting bug in schema middleware: `/v3/` was resolving to `3.0.0-beta.1` instead of `3.0.0-beta.3` because prereleases were sorted ascending instead of descending
- Update `sync_event_sources` and `log_event` docs to use `/v3/` schema links (these schemas were added in v3)
