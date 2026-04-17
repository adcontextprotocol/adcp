---
---

Sign `/protocol/{version}.tgz` with Sigstore (cosign keyless OIDC) during the
release workflow. Each released tarball now ships with `.sig` and `.crt`
sidecars in addition to the existing `.sha256`, letting consumers verify both
integrity and publisher identity (the GitHub Actions release workflow) with
`cosign verify-blob`. Defends against host compromise — TLS + sha256 alone
can't, since both live on the same origin. Closes #2272.
