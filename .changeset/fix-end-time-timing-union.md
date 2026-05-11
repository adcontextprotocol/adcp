---
"adcontextprotocol": minor
---

Add object-form timing union to `start_time` and `end_time` on `create_media_buy` / `update_media_buy`.

Production (v3.2.4) already accepts `{"type":"asap"}` and `{"type":"scheduled","time":"..."}` object forms alongside legacy ISO 8601 strings. The JSON schemas were not updated at the time. This changeset brings the schemas in sync with production behavior.

New schemas:
- `core/start-timing.json` — extended to four variants: `"asap"` string, ISO 8601 string, `{"type":"asap"}` object, `{"type":"scheduled","time":"..."}` object.
- `core/end-timing.json` (new) — two variants: ISO 8601 string and `{"type":"scheduled","time":"..."}` object. The `asap` variant is intentionally absent from the end-time union; end_time must be a determinate future point.

Normalization contract: sellers MUST resolve object-form timing to an ISO 8601 datetime before storing; `get_media_buys` responses return the resolved string form.

Non-breaking: all previously-valid string values continue to validate. The change is additive (new accepted shapes only).
