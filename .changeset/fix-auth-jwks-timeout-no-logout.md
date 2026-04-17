---
---

Auth middleware no longer logs users out when WorkOS JWKS fetch times out or other transient network errors hit during session validation. These transient failures now return 503 (retryable) instead of 401, preserving the session cookie so users stay logged in across infra blips.
