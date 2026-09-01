---
"adcontextprotocol": patch
---

Fix invalid channel value "video" in compliance fixture products. The Channel enum has never included "video"; the correct value is "olv" (online video). Affects 19 occurrences across 17 compliance source files.
