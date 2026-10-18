---
"adcontextprotocol": patch
---

The `wba-profile` conformance vectors README says how the vectors are graded: by the judge in `tests/wba-interop/`, which is Cloudflare's `web-bot-auth` 0.2.0 and `http-message-sig` 0.3.0, run bare and with the profile's rules. It also points to `tests/wba-interop/run.mjs`, which grades a Web Bot Auth implementation through an adapter against the same judge, and to `tests/wba-interop/PROTOCOL.md`, which defines the adapter protocol.

`scenarios.json` gains seven scenarios, for 46 in all, so that each of the profile's rules decides at least one scenario on its own:

- `R19b` covers the whole `Signature-Agent` field as well as the member keyed to the label, and is accepted.
- `R21b` carries two `web-bot-auth` signatures over one `Signature-Agent` member, and is refused with `403`.
- `D09` serves a directory with status `203`, `D10` signs it with a tag other than `http-message-signatures-directory`, `D11` adds an Ed25519 key that does not sign, and `D12` holds only an unsigned P-256 key. Each is refused.
- `D13` adds an RSA-PSS key that does not sign, which a verifier ignores, and is accepted.

Two scenarios change without changing their expected outcome. `D03`, an unsigned directory, has tier `adcp` instead of `wba`, because Web Bot Auth only recommends signing a directory response and lets a verifier use its keys without a valid proof (Appendix B.1). `R18` sends `type=jwks_uri` with the serialized origin as its value, so only the rule that recognizes `type=directory` refuses it.
