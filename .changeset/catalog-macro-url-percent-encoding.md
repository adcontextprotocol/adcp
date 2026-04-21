---
"adcontextprotocol": patch
---

spec(creative): require URL percent-encoding and prohibit nested expansion for catalog-item macro substitution (closes #2558)

`docs/creative/universal-macros.mdx` defined the `{MACRO_NAME}` syntax and the catalog-item family (`{GTIN}`, `{JOB_ID}`, `{SKU}`, etc.) but specified no escaping contract or nested-expansion rule. Catalog-item macros are the one macro class where buyer-controlled data (the catalog feed) expands at impression time into publisher-controlled contexts (tracker URLs, landing URLs, VAST tags) — an attacker-adjacent flow.

This change adds a "Substitution safety" subsection under Catalog Item Macros with three normative rules:

- **Percent-encode every octet not in the RFC 3986 `unreserved` set.** Sales agents MUST percent-encode such that only `ALPHA / DIGIT / "-" / "." / "_" / "~"` remain unescaped before substitution into URL contexts. Non-ASCII octets MUST be percent-encoded after UTF-8 encoding per RFC 3986 §2.5. This is the `encodeURIComponent`-equivalent contract — broader than "reserved characters only," so CR/LF (header-smuggling vector), space, control characters, and Unicode bidi overrides (audit-log spoofing vector) are all escaped. Encoding is applied exactly once at substitution time; downstream VAST players and ad servers fire URLs verbatim without re-decoding.
- **Nested macro expansion is prohibited.** Catalog-item values are not re-scanned after substitution for AdCP's `{...}` syntax. A `{JOB_ID}` value containing `{DEVICE_ID}` produces the literal `%7BDEVICE_ID%7D` in the emitted URL. The rule binds AdCP syntax only; downstream ad-server syntaxes (`%%GAM%%`, `${XANDR}`, `[VAST]`, `{{KEVEL}}`) remain the sales agent's responsibility to neutralize — percent-encoding per the rule above typically suffices, since `%`, `$`, `[`, and `{` all land outside `unreserved`.
- **Scope is URL contexts only** — impression trackers, click trackers, VAST tracking events, AND landing/clickthrough URLs (the full Overview substitution target set). HTML-attribute contexts are out of scope; when a catalog-item value is rendered into an HTML attribute server-side, the renderer MUST additionally apply HTML-attribute escaping — the two encodings are layered, not alternatives, because the value must survive both the URL parser and the HTML attribute parser.

Adds a 6-vector conformance fixture at `static/test-vectors/catalog-macro-substitution.json` pinning reserved-char breakout, nested-expansion literal preservation, CRLF injection, non-ASCII UTF-8, mixed path/query contexts, and bidi-override neutralization. All expected outputs match `encodeURIComponent` byte-for-byte.

Scope deliberately narrow: buyer-controlled catalog-item macros only. Non-catalog macros (`{MEDIA_BUY_ID}`, `{DEVICE_ID}`, `{GEO}`, etc.) are populated from publisher/seller/ad-server-mediated state; their encoding is governed by the ad-server integration (OpenRTB, VAST) which percent-encodes by convention. Universal canonicalization across all macros would be scope creep pre-GA.

No schema change. Sales agents that already use `encodeURIComponent`-equivalent encoding on catalog values stay conformant; agents using a "reserved characters only" or raw-passthrough encoding need to change before 3.0 GA.
