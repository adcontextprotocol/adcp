---
title: Hosted compliance bundle advancement
description: "Advance hosted compliance aliases without rewriting released artifacts or coupling deployment selection to scheduler health."
"og:title": "AdCP — Hosted compliance bundle advancement"
---

# Hosted compliance bundle advancement

Hosted compliance aliases are selected by `server/src/services/hosted-compliance-version.ts` from the intersection of immutable checked-in artifacts and `static/compliance/published-versions.json`. Scheduler health does not affect this selection.

Advance a hosted alias only when all of the following are true:

1. The exact `dist/compliance/<version>/index.json` and matching `dist/schemas/<version>/` release artifacts already exist. Never edit those released artifacts in the advancement change.
2. The version has release provenance and is explicitly added to `published_versions`. Do not promote an SDK-only entry implicitly.
3. The repository's pinned `@adcp/sdk` successfully loads the exact external bundle directory, and a selector regression test proves the alias resolves to it.
4. Exact version requests remain exact; advancing `3.1` must not change `3.1.20`, `3.1.22`, or other pinned targets.

Use `node scripts/check-published-compliance-versions.cjs` for publication-manifest validation and run the hosted selector tests before deployment. The selected bundle version is retained in compliance run provenance and in the heartbeat operational result.
