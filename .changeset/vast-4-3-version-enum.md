---
"adcontextprotocol": minor
---

Add VAST 4.3 to the VAST version enum. IAB Tech Lab released VAST 4.3 in December 2022, but `vast-version.json` stopped at 4.2, so a buyer trafficking a 4.3 tag had to declare a version the document does not carry. `vast_version` mirrors the `version` attribute on a VAST document's root element, and the enum already carries 2.0 and 3.0, so the roster is the published-version list rather than a curated feature set. The two schemas that restated the list inline (`core/requirements/vast-asset-requirements.json` and `formats/canonical/video_vast.json`) now `$ref` the shared enum, per the Enum Consolidation rule in `docs/spec-guidelines.md`. VAST 4.4 is deliberately excluded: its XSD is annotated "DRAFT for working group discussion" and is not a published specification.
