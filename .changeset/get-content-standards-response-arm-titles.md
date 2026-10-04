---
"adcontextprotocol": patch
---

Title the two `oneOf` arms of `content-standards/get-content-standards-response.json` as `GetContentStandardsSuccess` and `GetContentStandardsError`, matching the `[Operation][Outcome]` convention used by sibling responses such as `update-content-standards-response.json` and `create-media-buy-response.json`. Code generators previously had nothing to name these arms with and fell back to positional names (`GetContentStandardsResponse1`, `GetContentStandardsResponse2`). `title` is an annotation only: no wire, validation or required-field change.
