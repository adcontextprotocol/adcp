---
"adcontextprotocol": patch
---

Accept unsubstituted ad-server macros in VAST/DAAST tag URLs.

`vast-asset.json` and `daast-asset.json` validated the `delivery_type: "url"` branch's `url` field with `format: "uri"` (strict RFC 3986). Real-world tags carry unsubstituted macros — VAST-style `[OMIDPARTNER]` / `[BUNDLEID]` placeholders and `${GDPR_CONSENT}`-style privacy macros — whose square brackets and curly braces are illegal unencoded in an RFC 3986 URI. Any verification-wrapped CTV tag (IAS, DV, MOAT wrappers) therefore failed `create_media_buy` validation even though the tag is valid per the IAB VAST spec, where players substitute macros before treating the string as a URL. Pre-encoding the delimiters is not a workaround: players and verification vendors match the literal macro token, so an encoded `%5BOMIDPARTNER%5D` never gets substituted.

Both fields now use `format: "uri-template"` (RFC 6570), the same convention `url-asset.json` already uses for AdCP universal macros. RFC 6570 permits `[` / `]` as literal characters and parses `${MACRO}` as a literal `$` followed by a `{MACRO}` expression, so macro-laden tags validate while malformed strings (raw spaces, control characters, unbalanced braces) are still rejected. Schema descriptions now state that buyers MUST NOT pre-encode macro delimiters.

Known limitation: GAM-style `%%MACRO%%` placeholders still fail (a bare `%` must be percent-encoded under RFC 6570). VAST 4.x official macros use `[MACRO]` and privacy conventions use `${...}`, so the common cases are covered; widening further would mean dropping `format` validation entirely.

Adds a regression test validating a real verification-wrapped CTV tag against both asset schemas, with a negative case confirming malformed URLs are still rejected.
