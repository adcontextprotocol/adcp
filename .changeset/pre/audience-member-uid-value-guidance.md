---
"adcontextprotocol": minor
---

spec(audiences): `audience-member.json` `uids[].value` now states the wire form per `type`, so `sync_audiences` no longer fails silently with zero matches. For `uid2` and `euid`, `value` is the raw UID2/EUID, never the per-mint encrypted UID2 token, and senders and receivers MUST NOT case-fold or re-encode it. For `maid`, senders SHOULD send the lowercase hyphenated UUID and receivers SHOULD normalize case and hyphenation before matching. A `hashed_email` entry in `uids[]` follows the top-level `hashed_email` form, and the two MUST agree when both are present. All other types pass through unmodified. The shared `enums/uid-type.json` is unchanged, because UID2 tokens remain legitimate in TMP identity match.

Refs #6872.
