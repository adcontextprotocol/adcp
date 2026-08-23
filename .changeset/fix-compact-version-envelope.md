---
"adcontextprotocol": patch
---

Restore `adcp_major_version` in compact MCP request schemas.

The 3.2.0-beta.0 frozen snapshots for `buy-products`, `accept-proposal`,
and `control-media-buy` request schemas were published before the source
schemas gained the deprecated `adcp_major_version` field. Combined with
`additionalProperties: false`, this caused conforming SDK buyers to fail
MCP input validation when emitting both version fields (as the spec
requires through 3.x).

Patches the 18 affected dist schema files across all beta.0 output
paths (bundled, MCP, profiles, model-context) and adds lint coverage to
prevent the same drift in future version snapshots.

Refs #6649
