---
---

Adds `GET /publisher/{domain}/.well-known/adagents.json`. Returns the
canonical adagents.json document for publishers who opted into AAO hosting
(public hosted-property row). Other publishers / unknown domains 404.

Lets a publisher choose between pasting the snippet on their own site and
pointing a CNAME / redirect at AAO's hosted URL.
