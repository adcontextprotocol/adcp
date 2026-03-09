---
"adcontextprotocol": minor
---

Add disclosure persistence model for jurisdiction-specific render requirements.

New `disclosure-persistence` enum with values: `continuous` (must persist throughout content duration), `initial` (must appear at start for minimum duration), `flexible` (presence sufficient, publisher discretion). When multiple sources specify persistence for the same jurisdiction, most restrictive wins: `continuous > initial > flexible`.

Schema changes:

- `provenance.json`: new `declared_at` (date-time) recording when the provenance claim was made, distinct from `created_time`. Jurisdiction items in `disclosure.jurisdictions[]` gain `render_guidance` with `persistence`, `min_duration_ms`, and `positions` (ordered preference list).
- `format.json`: new `disclosure_capabilities` array — each entry pairs a disclosure position with its supported persistence modes. Supersedes `supported_disclosure_positions` for persistence-aware matching; the flat field is retained for backward compatibility. Formats should only claim persistence modes they can enforce.
- `creative-brief.json`: new optional `persistence` on `compliance.required_disclosures[]` items.
- `list-creative-formats-request.json` (media-buy and creative domains): new `disclosure_persistence` filter. Creative-domain request also gains `disclosure_positions` filter for parity with media-buy.
- `error-code.json`: `COMPLIANCE_UNSATISFIED` description updated to cover persistence mode mismatches.
