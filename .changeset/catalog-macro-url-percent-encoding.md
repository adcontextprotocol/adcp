---
"adcontextprotocol": patch
---

spec(creative): require URL percent-encoding and prohibit nested expansion for catalog-item macro substitution (closes #2558)

`docs/creative/universal-macros.mdx` defined the `{MACRO_NAME}` syntax and the catalog-item family (`{GTIN}`, `{JOB_ID}`, `{SKU}`, etc.) but specified no escaping contract or nested-expansion rule. Catalog-item macros are the one macro class where buyer-controlled data (the catalog feed) expands at impression time into publisher-controlled contexts (tracker URLs, landing URLs, VAST tags) — an attacker-adjacent flow.

This change adds a "Substitution safety" subsection under Catalog Item Macros with three normative rules:

- Sales agents MUST apply RFC 3986 percent-encoding of reserved characters to catalog-item values before substitution into URL contexts. A raw `&` or `#` in a `{GTIN}` value that would otherwise break out of the surrounding query string is escaped at substitution time.
- Nested macro expansion is prohibited — catalog-item values are not re-scanned after substitution. A `{JOB_ID}` value containing `{DEVICE_ID}` produces the literal string in the emitted URL, not a second-round expansion.
- The normative scope is explicitly URL contexts only. Publishers rendering catalog-item values into HTML-attribute contexts (banner templates) are responsible for HTML-attribute escaping in addition to percent-encoding — the AdCP contract bounds to the URL surface AdCP governs.

Scope deliberately narrow: buyer-controlled catalog-item macros only. Non-catalog macros (`{MEDIA_BUY_ID}`, `{DEVICE_ID}`, `{GEO}`) are populated from publisher/seller-controlled state and remain trusted within the substitution pass. Universal canonicalization across all macros would be scope creep pre-GA; this narrow rule closes the concrete attacker-adjacent surface.

No schema change, no vector change. Sales agents that already percent-encode catalog-item values stay conformant; those that pass raw values need to add encoding before 3.0 GA.
