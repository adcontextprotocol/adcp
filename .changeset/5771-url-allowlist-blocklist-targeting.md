---
"adcontextprotocol": minor
---

Add `url_allowlist` and `url_blocklist` to the buyer's media-buy `targeting_overlay`, with matching `url_allowlist` / `url_blocklist` capability declarations on `get-adcp-capabilities-response`. Buyers can now express "restrict delivery to this set of content URLs" or "never on this set of content URLs" via the same `{ type, value }` shape used by `ArtifactRef` (`type` is `url` for raw URLs the receiver canonicalizes, or `url_hash` for the pre-hashed Blake3-256 wire form). Each capability declares `supported_types` so a seller can opt into one or both entry forms (accepting only pre-hashed values keeps raw URLs off the wire). Targets content URLs only — never user-identifying URLs. Sellers MUST declare URL-allowlist / URL-blocklist support in `get_adcp_capabilities` and MUST reject media buys carrying an unsupported field or an entry whose `type` is outside `supported_types`. `url_blocklist` takes precedence over `url_allowlist`.
