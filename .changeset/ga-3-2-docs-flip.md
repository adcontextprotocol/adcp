---
"adcontextprotocol": patch
---

docs: flip the AdCP 3.2 documentation to general availability. 3.2 ships as release `3.2.1` (tag `v3.2.1`, wire pin `"3.2"`); `3.2.0` was never released. Rewrites the 3.2 release notes and What's new for GA (including the seller-optimized budget core contract and package-control capabilities, delivery dates on the seller's reporting timezone, the experimental account change feed, the `views` goal correction, and the 3.2 request-signing vectors), converts `reference/3-2-beta` into the 3.2 prerelease history (same URL) with an RC.7-to-3.2.1 change list, moves the 3.1 to 3.2 migration guide, versions, versioning, roadmap, intro, FAQ, SDK guidance, and task pages off release-candidate framing and onto `@adcp/sdk@14.0.0` / `adcp==8.0.0`, updates the docs banner, and describes the post-GA release topology in `RELEASING.md` and the agent playbook. Documentation only; no schema or normative changes.
