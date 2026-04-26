---
---

Fix `scripts/sign-protocol-tarball.sh` to emit raw PEM certificates instead of base64-wrapped PEM. Cosign's `sign-blob --output-certificate` writes the cert base64-encoded by convention; downstream tooling (adcp-go's `download.sh`, anything doing a PEM header sniff before handing the cert to `cosign verify-blob`) expects raw PEM. Decode in place after signing so `.crt` on disk matches the Sigstore standard layout. Also re-writes the already-shipped `dist/protocol/3.0.0.tgz.crt` to raw PEM (same underlying cert bytes; `cosign verify-blob` accepts both formats, so signatures continue to verify). Closes adcp#2900.
