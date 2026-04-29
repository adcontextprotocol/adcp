---
---

fix(ipr): wrap comment body string in object for GitHub API calls

`createIssueComment` and `updateIssueComment` were passing the body text
directly as `options.body`, causing `JSON.stringify` to serialize a bare
string instead of `{"body":"..."}`. GitHub rejects bare strings with a 422
`links/0/schema` validation error.
