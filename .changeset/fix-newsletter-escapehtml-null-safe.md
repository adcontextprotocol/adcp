---
---

Fix newsletter admin crash when a content item has a missing/undefined field. `escapeHtml` in the shared email layout now tolerates `null` / `undefined` input and coerces values to strings, so a single malformed decision/spotlight/release no longer returns a 500 for `/editions/current`.
