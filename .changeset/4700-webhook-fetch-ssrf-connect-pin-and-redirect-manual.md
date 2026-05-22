---
---

training-agent webhook-fetch: close SSRF gaps on steps 3 (connect-pin) + 4 (refuse redirects). Fixes #4700.

`server/src/training-agent/webhook-fetch.ts` previously implemented steps 1, 2, 5, 6 of `docs/building/by-layer/L1/security.mdx#webhook-url-validation-ssrf` but skipped two:

- **Step 3** — no DNS-rebinding-resistant connect pin. The pre-flight `assertPublicTarget` resolved the hostname and rejected private IPs, but the actual `globalThis.fetch` call re-resolved at TCP-connect time. A hostile authoritative server serving a public IP at validation and a private IP at connect bypassed the check.
- **Step 4** — no `redirect: 'manual'`. Default Node fetch follows up to 20 redirects, and the redirect target was never re-validated. A 302 from any buyer-controlled host to `http://169.254.169.254/...` slipped past the IP-range guard on the original URL.

Fix reuses the SSRF-safe dispatcher pattern already proven in `server/src/utils/url-security.ts` (`safeFetch`):

- Attach an `undici.Agent` whose `connect.lookup` hook delegates to the existing `ssrfSafeLookup` from `utils/url-security.ts`. The lookup re-validates the resolved IP at dial time and rejects private/loopback/link-local/IPv4-mapped-private addresses, closing the validation→connect TOCTOU window. SNI/cert verification continues to use the original hostname.
- Set `redirect: 'manual'` on every fetch call, in **every** environment (including `allowPrivateIp: true` sandbox mode). Redirect-follow is a security guard, not a routing affordance. 3xx responses are returned to the SDK emitter as-is, which then treats them as a delivery failure under its existing non-2xx handling.
- Lift the scheme refusal (`file://`, `ftp://`, etc.) out of `assertPublicTarget` so it applies unconditionally — a sandbox loopback receiver always uses http/https; rejecting non-http(s) URLs in dev is strictly tightening, never a footgun.

Two new unit tests pin the construction shape so a future refactor that drops the dispatcher or flips redirect-follow back on fails before the SSRF gap silently reopens.

Out of scope: a broader audit of other outbound-fetch call sites that share the same emitter (non-training-agent paths) — separate follow-up. No protocol changes; no schema changes.

Closes #4700.
