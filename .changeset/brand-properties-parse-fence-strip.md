---
---

Fix brand-builder smart-paste import returning "Could not parse identifiers from input" on every paste. Claude haiku consistently wraps the JSON response in a `\`\`\`json` markdown fence despite the prompt asking for raw JSON, causing `JSON.parse` to fail. The route now strips both `\`\`\`json` and bare `\`\`\`` fences before parsing. Caught end-to-end via Playwright; covered by two new integration test cases.
