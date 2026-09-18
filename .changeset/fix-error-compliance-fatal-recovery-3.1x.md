---
"adcontextprotocol": patch
---

Fix `VERSION_UNSUPPORTED` recovery value in error-compliance storyboards: `fatal` → `correctable`, matching `core/error.json` `enumMetadata`. Also corrects the general error-shape narrative enum list from `correctable, transient, or fatal` to `transient, correctable, or terminal`. Affects `error-compliance.yaml` and `error-compliance-signals.yaml`. Backport of #7376 to the 3.1.x line.
