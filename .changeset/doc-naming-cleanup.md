---
---

docs: Simplify signals documentation titles and fix schema alignment

- Simplify page titles from "Protocol Specification" to "Specification" and "Signals Protocol Overview" to "Overview"
- Fix activate_signal requirements to use `is_live` (boolean) matching the actual schema instead of incorrect `status` field
- Add $schema reference to JSON example for CI validation
- Remove invalid `tasks` field from capabilities example
