---
---

Detect HTTP_PROXY / HTTPS_PROXY / lowercase variants at module load in `server/src/utils/url-security.ts` and log a warning. The DNS-rebind defense added in PR #3609 routes through undici's `Agent({ connect: { lookup } })` — but if the deploy environment routes outbound HTTP through a proxy and a future caller honors the env var (or wraps to `ProxyAgent`), the proxy becomes the DNS resolver and our lookup hook never fires.

Closes #3620.
