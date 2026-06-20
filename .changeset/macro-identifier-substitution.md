---
---

Empty changeset: Document the `@adcp/sdk` macro translation helper in the universal macros guide. `docs/creative/universal-macros.mdx` gains an "Implementing translation with the SDK" example showing `universal_macro_translation` from `@adcp/sdk` (native tokens inserted raw, value entries RFC-3986 encoded, unmapped-macro params dropped, minted params untouched), plus guidance on which macros belong in each bucket and the trust boundary on `native` values. Depends on adcontextprotocol/adcp-client#2263, which ships the helper in `@adcp/sdk`.
