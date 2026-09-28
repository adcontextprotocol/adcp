---
"adcontextprotocol": patch
---

Release tooling: 3.2 GA ships as `3.2.1` over the permanently withdrawn `3.2.0` (the reverted 2026-06-30 accidental cut whose artifacts remain on the CDN). A reviewed `.changeset/withdrawn-release.json` marker makes the pre-exit Version Packages cut produce `3.2.1`, and `npm run version` now refuses to generate any withdrawn/unpublished version. Release discovery keeps `3.2.0` and `3.2.0-rc.5` unpublished consistently across generated schemas, the server, and the CDN worker, and prerelease `superseded_by` now points at the first selectable stable release on the line (so the 3.2 candidates stop naming `3.2.0`). The wire pin stays `"3.2"`.
