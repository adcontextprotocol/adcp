---
---

docs(building): caveat sidecar availability in schemas-and-sdks.mdx tarball table

Adds a one-line availability note to the .tgz.sig and .tgz.crt table rows clarifying
that sidecars are produced only by the cosign step in release.yml on changeset version bumps
and may be transiently absent during out-of-band republishes. Also extends the existing
checksum-only paragraph to cover this transient case alongside pre-signing releases.
