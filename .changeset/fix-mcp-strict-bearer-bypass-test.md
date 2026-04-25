---
---

test(training-agent): fix /mcp-strict 401 test to omit bearer token

The `unsigned create_media_buy on /mcp-strict returns 401` test was failing because
`callTool` sends `Authorization: Bearer test-token-for-strict` by default. The SDK's
`requireAuthenticatedOrSigned` short-circuits on a successful bearer result before the
`required_for` gate runs — bearer bypass is intentional per SDK design (#2586).

Fix: pass `{ auth: false }` so the test simulates the actual grader scenario. Compliance
graders send no bearer token; they authenticate via RFC 9421 signature credentials only.
With no bearer and no signature, the `required_for: ['create_media_buy']` gate fires and
returns `401 request_signature_required` as expected.

Non-protocol change (server test only); changeset is `--empty`.

Closes #3080.
