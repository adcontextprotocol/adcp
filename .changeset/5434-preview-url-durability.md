---
"adcontextprotocol": patch
---

spec(creative): clarify preview URL durability for generated creative previews.

Documents that `preview_url` is the browser/MCPUI-renderable resource in AdCP 3.x and must remain dereferenceable for its advertised lifetime: until `expires_at` when present, or until explicit out-of-band revocation when omitted. Also fixes the stale Creative Protocol overview wording that said `expires_at` was always required, which contradicted the current schema and schema test for non-expiring preview URLs.

This intentionally does not add `asset_ref`, `resource_uri`, or another durable-pointer field to `PreviewRender`; that naming and buyer-visible-vs-agent-internal decision remains a working-group question in #5434.
