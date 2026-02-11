---
---

Add minItems: 1 to request-side arrays where empty arrays are semantically invalid. Formalizes the rule that if you include an optional array field, provide at least one value. Response arrays and replacement-semantic arrays (where [] means "clear all") are unchanged.
