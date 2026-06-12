---
---

fix(compliance): surface stripped request fields and filter-effectiveness advisories

Refs #5495. Adds `input_schema_field_stripped` as a canonical runner notice code and adds advisory filter-effectiveness checks to the creative-template `filter_by_type` storyboard so stripped list_creative_formats filters no longer disappear as console-only warnings.
