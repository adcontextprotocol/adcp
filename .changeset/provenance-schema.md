---
"adcontextprotocol": minor
---

Add AI provenance and disclosure schema for creatives and artifacts.

New schemas:
- `digital-source-type` enum — IPTC-aligned classification of AI involvement (with `enumDescriptions`)
- `provenance` core object — declares how content was produced, C2PA references, disclosure requirements, and verification results

Key design decisions:
- `verification` is an array (multiple services can independently evaluate content)
- `declared_by` identifies who attached the provenance claim, enabling trust assessment
- Provenance is a claim — the enforcing party should verify independently
- Inheritance uses full-object replacement (no field-level merging)
- IPTC vocabulary uses current values (`digital_creation`, `human_edits`)

Optional `provenance` field added to:
- `creative-manifest` (default for all assets in the manifest)
- `creative-asset` (default for the creative in the library)
- `artifact` (top-level and per inline asset type)
- All 11 typed asset schemas (image, video, audio, text, html, css, javascript, vast, daast, url, webhook)

Optional `provenance_required` field added to `creative-policy`.
