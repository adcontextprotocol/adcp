---
---

chore(deps): bump `@adcp/client` 5.9.0 → 5.9.1

Picks up [adcp-client#752](https://github.com/adcontextprotocol/adcp-client/pull/752), which fixes the default `context.no_secret_echo` assertion's auth extraction so it actually catches leaks when callers pass structured `TestOptions.auth` objects (bearer / basic / oauth / oauth_client_credentials). Pre-5.9.1 the assertion did `secrets.add(options.auth)` on the raw object — `String.includes(obj)` coerced to `[object Object]` and matched nothing, making the check a silent no-op for every consumer using structured auth.

5.9.1 also adds `registerAssertion(spec, { override: true })` for consumers that want to replace SDK defaults with stricter local versions — we don't need it here since #2771 already dropped our local assertions in favor of the SDK defaults, but the patch bump is worth picking up for the bug fix alone.

Scoped bump — only `@adcp/client` resolution + integrity change in `package-lock.json`, no peer cascade, no code changes required.
