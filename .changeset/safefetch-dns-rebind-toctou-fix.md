---
---

fix(server): close DNS-rebind TOCTOU window in `safeFetch`

`safeFetch`'s pre-flight `validateFetchUrl` resolved the hostname, but
`fetch()` re-resolved DNS independently — a hostile authoritative server
with a short TTL could return a public IP at validation and a private IP
(AWS metadata `169.254.169.254`, RFC1918, loopback) at fetch time. The fix
pins the TCP connect step to a custom `dns.lookup` callback (via undici
`Agent({ connect: { lookup } })`) that re-checks the resolved address and
rejects private IPs at dial time. Each redirect hop dials through the same
SSRF-safe dispatcher. TLS SNI/cert verification continues to use the
original hostname, so HTTPS keeps validating against the public cert.
Closes #3599.
