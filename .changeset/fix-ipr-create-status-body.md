---
---

Fix `scripts/ipr/github.mjs` `createStatus` — payload was being passed
at the wrong level of the `request()` option bag, so `state`/`context`
never reached the GitHub statuses API.

`request(method, path, { body, query })` reads the payload from
`options.body`. `createIssueComment` and `updateIssueComment` already
wrap correctly (`{ body }`). `createStatus` was passing `{ state,
context, description, target_url }` directly at the top level, so the
outgoing request had an empty body and GitHub responded with
`422 Validation Failed: State is not included in the list`.

Impact: the IPR Agreement check has been failing on every PR since
the workflow rewrite in #3011 landed — both the "awaiting signature"
pending status and the "signed" success status were hitting the same
failure path. Fix wraps the payload in `{ body: { ... } }` so the
state actually ships.
