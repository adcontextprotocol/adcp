---
---

Three security-medium hardening items deferred from the PR #3448 review:

- **Sign the dev-session cookie.** Was the literal user key string ("admin"); anyone who could write a cookie on the domain could pick a privileged dev user. Now HMAC-signed with a per-process secret generated at boot — invalid signatures fail verification on read, and cookies don't survive a server restart. Format is `${userKey}.${base64url-hmac}`. Timing-safe comparison.
- **Audit-log dev-bypass attribution.** `resolveUserOrgMembership` now returns `via_dev_bypass: boolean`. Routes that write to `registry_audit_log` after resolving membership tag dev-bypass writes with `details.auth_method = 'dev-bypass'` so post-incident triage can distinguish them from real-user writes (synthetic `user_dev_*` IDs don't resolve in WorkOS). Applied to the highest-impact mutating routes (org rename, settings PATCH); pattern documented for new audit-log writers.
- **Document DB-isolation expectations.** New `ops/dev-mode-isolation.md` walks through the operational invariants the dev-mode bypass assumes (no shared dev/prod DB, no shared `.env.local`, prod-boot guard verification). Includes incident-response steps if dev mode ever activates in prod.
