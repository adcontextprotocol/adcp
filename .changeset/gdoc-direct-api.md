---
---

Use Google Docs and Sheets APIs directly instead of routing all reads through
the Drive API. The drive.readonly OAuth scope is a Google "restricted" scope
that is silently blocked for unverified apps, causing all file operations to
return 404. The documents.readonly and spreadsheets.readonly scopes are
"sensitive" scopes that work without app verification.
