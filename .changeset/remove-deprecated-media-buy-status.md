---
"adcontextprotocol": minor
---

Remove the deprecated top-level media-buy lifecycle `status` property from synchronous `create_media_buy` and `update_media_buy` success payloads for AdCP 3.2. Lifecycle state now uses only `media_buy_status`; top-level `status` remains reserved for the protocol task envelope. This intentionally uses a minor changeset so the approved same-major removal in #4906 is released as 3.2 rather than being mechanically retargeted to 4.0.
