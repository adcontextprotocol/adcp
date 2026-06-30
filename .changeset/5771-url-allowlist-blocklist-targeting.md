---
---

Add `url_allowlist` and `url_blocklist` to the buyer's media-buy `targeting_overlay`. Buyers can now express "restrict delivery to this set of content URLs" or "never on this set of content URLs" via the same `{ type, value }` shape used by `ArtifactRef` (`type` is `url` for raw URLs the receiver canonicalizes, or `url_hash` for the pre-hashed Blake3-256 wire form). Targets content URLs only — never user-identifying URLs. Sellers MUST declare URL-allowlist / URL-blocklist support in `get_adcp_capabilities` and MUST reject media buys carrying an unsupported field. `url_blocklist` takes precedence over `url_allowlist`.
