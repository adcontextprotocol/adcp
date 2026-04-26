---
---

docs(compliance): document v3_envelope_integrity in universal-storyboards tables

Adds the `v3_envelope_integrity` storyboard (introduced by #3045) to the two universal-storyboards tables in the docs. The doc-parity lint at `scripts/lint-universal-storyboard-doc-parity.cjs` was failing on main because #3045 added the YAML but didn't update the tables — every branch built off main has been failing `Build Check` / `Release` / `Deploy` since.
