---
---

Fix `enums/error-code.json`: add missing `enumMetadata` entries for `AUTH_MISSING` and `AUTH_INVALID`, introduced by #3739 in `enum` + `enumDescriptions` but never added to `enumMetadata`. The schema lint (`Build` step → `npm run build:schemas` → `scripts/build-schemas.cjs`) catches this and fails CI on every PR until the metadata is consistent. SDKs read `enumMetadata` for recovery classification — drift here ships as recovery bugs in every downstream consumer.

Metadata mirrors the descriptions on the same codes: `AUTH_MISSING` is correctable (provide credentials and retry), `AUTH_INVALID` is terminal (credentials presented and rejected; rotate or escalate — OAuth refresh-once is documented in the description but the default disposition is terminal).
