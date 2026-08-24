---
"adcontextprotocol": minor
---

Define a normative VAST validation contract for `vast` creative assets. Today the entire format-layer contract for a VAST asset is the `vast_version` string in `vast-asset-requirements.json`: nothing in the spec requires parsing the document, checking for an `<Ad>` or `<MediaFile>`, verifying the version attribute, or bounding wrapper chains, and `error-code.json` has no VAST codes, so a structurally valid manifest can carry an unplayable tag that fails silently at serve time.

This change adds:

- `creative_specs.vast_validation` on `get_adcp_capabilities` (`structural` | `document` | `wrapper`, default `structural`), following the capability-gating pattern of `media_buy.governance_aware`: sellers that do not inspect VAST documents keep the default and are unaffected.
- A "VAST Validation" section in the video channel docs specifying the checks at each level: document parse, root element and `<VAST version>` agreement with the declared `vast_version` / format requirement / seller `vast_versions`, `<Ad>` and `<MediaFile>` presence, HTTPS URLs, wrapper resolution bounded by the format's existing `max_wrapper_depth`, loop detection, per-hop timeout, and terminal-document checks. Validation runs at `sync_creatives` (including `dry_run`); `validate_input` stays manifest-structure-only. A passing preflight is explicitly not approval of future responses from a decisioning endpoint.
- Three error codes with `enumDescriptions` and `enumMetadata`: `VAST_PARSE_FAILED`, `VAST_VERSION_MISMATCH`, `VAST_WRAPPER_DEPTH_EXCEEDED` (all correctable, with `error.details.reason` discriminators).

Macro correctness and substitution verification are explicitly out of scope (in-flight WG work on click-tracker insertion and decisioning-time substitution). Additive; no change for sellers that do not declare the capability.
