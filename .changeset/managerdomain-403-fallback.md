---
"adcontextprotocol": patch
---

Allow the ads.txt `managerdomain` fallback when a publisher's direct `adagents.json` fetch returns an S3/CloudFront-style `403` `AccessDenied` XML response as well as `404`, while preserving manager-side scoping checks.
