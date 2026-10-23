---
"adcontextprotocol": minor
---

Account change feed (experimental): `account-change.json` records whose `origin.kind` is `adcp` can echo the originating request's `idempotency_key`, so a buyer recognizes its own changes. The seller includes it only on records served to the principal that sent that request; every other reader sees an otherwise identical record without it, and `account.change_recorded` never carries it. `changed_paths` is now required (non-empty) when `origin.kind` is `adcp` or `seller_operator`, and stays best-effort for `seller_system` and `connected_platform`.
