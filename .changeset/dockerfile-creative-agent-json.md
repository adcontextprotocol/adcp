---
"adcontextprotocol": patch
---

Restore prod: copy all creative-agent JSON assets in Dockerfile (not just `reference-formats.json`), so `ui-element-formats.json` ships in the runtime image and `task-handlers.ts` boots. No protocol surface change.
