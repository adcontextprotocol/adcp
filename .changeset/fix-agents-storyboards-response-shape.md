---
---

Fix "Failed to load storyboards" on the agents dashboard. The `/api/registry/agents/:url/applicable-storyboards` endpoint now returns `{ bundles, specialisms, supported_protocols, capabilities_probe_error, total_storyboards }`, but the dashboard still consumed the old `{ tools, storyboards, total_applicable, total_available }` shape and threw `TypeError` on every agent. Update `renderStoryboardPicker` to render `bundles` grouped by kind/id, and surface the real error (`needs_auth`, `unknown_specialism`, `error`, `reason`) instead of the bare "Failed to load storyboards." message.
