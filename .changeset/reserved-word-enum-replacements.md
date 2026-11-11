---
"adcontextprotocol": minor
---

Schema: add reserved-word-safe replacements for eight enum values that collide with SDK target languages, and deprecate the originals (#8791). Each enum now accepts both spellings through 3.x; the original is deprecated in 3.3 and removed in 4.0.

- `pass` → `passed` in `enums/binary-verdict.json`, `get_media_buy_artifacts` `local_verdict`, and the registry feed's compliance `tracks` status. `pass` is a Python keyword.
- `global` → `agent` in the `RATE_LIMITED` details `scope`. `global` is a Python keyword.
- `name` → `full_name` in the signal definition `onboarder.match_keys`, on both `core/signal-definition.json` and `core/signal-definition-enrichment.json`. `name` collides with the enum member protocol in Python and Java.
- `brand.json` `color_ref.kind`: `name` → `palette_key` and `value` → `hex`. Each `oneOf` variant's `kind` changes from `const` to a two-value `enum`, so the old and new kinds select the same variant. The payload fields stay `name` and `value`.

Each deprecated value is listed in `x-deprecated-enum-values` and carries `deprecated: true`, `x-deprecated-in: "3.3.0"`, `x-removed-in: "4.0.0"`, and `x-superseded-by` in a per-value `enumMetadata` entry. The 4.0 compatibility registry lists every site. A 3.2 validator rejects the new values, so senders keep the original until the counterparty supports 3.3.
