---
---

feat(compliance): add signals-specific universal storyboards for error_handling and core tracks

Adds `error-compliance-signals.yaml` and `schema-validation-signals.yaml` to
`static/compliance/source/universal/`, restoring error handling and schema
compliance coverage for signals-only agents. Fixes the regression from 5.13
where both tracks produced 0 steps for agents with `supported_protocols:
["signals"]` because the existing storyboards gate on `required_tools:
[get_products]`.

Related: #3350
