---
---

Add `docs/trusted-match/impression-tracker-implementation.mdx` — non-normative implementation reference for the impression tracker that sits behind the cap-fire boundary contract. Covers cross-identity dedup via `impression_id`, the `fcap_keys` label model, the log-based reference data model from `adcp-go/targeting/`, SDK primitives (`decodeTmpx` + `writeExposure`), production topology, and two end-to-end conformance scenarios (multi-identity dedup and cross-seller advertiser cap). Cross-links from `identity-match-implementation.mdx` so readers can find it.

This re-introduces, as non-normative impl reference, the impression-tracker mechanics that were originally proposed as normative architecture in `bokelley/idmatch-design` but were superseded on `main` by the narrower cap-fire boundary contract (#4070). The boundary contract stays normative; this page documents one valid way to implement the impression tracker behind it.
