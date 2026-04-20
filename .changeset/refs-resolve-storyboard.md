---
---

Document `refs_resolve` cross-step validation in `storyboard-schema.yaml` and wire it onto the `list_formats` step of `media_buy_seller`. Every `format_id` returned on products must resolve to a format in this agent's `list_creative_formats` response (matched on `{agent_url, id}`); scope filtering via `$agent_url` enforces integrity only for refs on the agent under test, and third-party refs surface as observations rather than failures. Closes adcontextprotocol/adcp#2597. Runtime support ships in `@adcp/client` 5.7.0 (adcp-client#671) — the existing `^5.5.0` range picks it up on install.
