---
"adcontextprotocol": patch
---

fix(compliance): stop hosted capability probes from sending the SDK's prerelease default version. `recommend_storyboards` now pins its probe to an explicit `compliance_target`. Probes that run before any target is chosen (`recommend_storyboards` without a target, `GET /registry/agents/:encodedUrl/applicable-storyboards`, and compliance-target selection with no stored versions) send only `adcp_major_version`, so a seller advertising only a stable release no longer rejects them with `VERSION_UNSUPPORTED`.
