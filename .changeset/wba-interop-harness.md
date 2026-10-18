---
"adcontextprotocol": patch
---

The `wba-profile` conformance vectors README says how the vectors are graded: by the judge in `tests/wba-interop/`, which is Cloudflare's `web-bot-auth` 0.2.0 and `http-message-sig` 0.3.0, run bare and with the profile's rules. It also points to `tests/wba-interop/run.mjs`, which grades a Web Bot Auth implementation through an adapter against the same judge, and to `tests/wba-interop/PROTOCOL.md`, which defines the adapter protocol.
