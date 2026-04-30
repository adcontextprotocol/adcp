---
---

docs(accounts): add buyer retry-disambiguation guidance for SCOPE_INSUFFICIENT and READ_ONLY_SCOPE

Adds normative buyer-side guidance for handling `SCOPE_INSUFFICIENT` within the 300s authorization refresh window. A single response with this code is observationally indistinguishable between cross-replica flicker (transient, will resolve) and a legitimate scope reduction (persistent, must surface). Buyers MAY exhaust a bounded retry budget (≤3 attempts, 1–5s jittered backoff) as disambiguation logic before escalating; after retries exhaust, MUST surface the error and MUST NOT autonomously continue retrying.

`READ_ONLY_SCOPE` follows the same bounded-retry logic for grant-propagation lag, with a caveat on the revocation direction. `FIELD_NOT_PERMITTED` is explicitly carved out — the agent-autonomous strip-and-resubmit path supersedes any retry consideration.

Cross-references between `docs/accounts/overview.mdx` and `docs/building/implementation/error-handling.mdx`. No schema changes. Refs #3674.
