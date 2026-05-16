---
---

ci: add `oneOf` discriminator audit and baseline (adcp#3917).

`scripts/audit-oneof.mjs` walks `static/schemas/source/` and classifies every `oneOf` as discriminated, structurally narrowable, dangerous, or scalar. CI runs the script in `--check` mode against `scripts/oneof-discriminators.baseline.json` and fails on any new undiscriminated union or any regression in an existing one. Use `--update` to ratchet the baseline after fixes land. No spec changes — this only freezes current state so unfixed unions can't grow.
