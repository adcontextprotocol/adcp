---
"adcontextprotocol": patch
---

Docs: DR-0036 states the closed-schema rule and the two kinds of correction it allows: opening a schema that the published text keeps open, and applying a bound or required name that the published text already sets. It also allows named exceptions that a declared capability gates. `scripts/lint-additive-minor-corrections.json` is the only list of corrections, and the additive-minor check no longer reads correction tables from the decision record. The 3.3 release notes, What's new, the 3.2 to 3.3 and 3.1 to 3.2 migration guides, the 3.3 beta program page, and the versioning page describe the corrections by kind. No schema changes.
