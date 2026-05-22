---
---

fix(aao): keep directory inverse-lookup under the registry /api/v1 path

Documents and exposes the AAO directory inverse-lookup at /api/v1/agents/:encodedUrl/publishers. The endpoint remains part of the registry API surface; no separate root /v1 service mount is added.
