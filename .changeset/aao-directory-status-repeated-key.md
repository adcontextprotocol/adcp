---
---

fix(aao): implement repeated-key status= encoding per #4858 spec

The directory endpoint at `/v1/agents/{agent_url}/publishers` shipped accepting `?status=authorized,revoked` (comma-separated). Spec PR #4858 pinned the encoding to repeated-key form (`?status=authorized&status=revoked`) with the comma form explicitly rejected. Updating the impl + OpenAPI registration + HTTP integration test to match.
