---
"adcontextprotocol": minor
---

Name five shapes the bundle repeated without ever naming them, and `$ref` them from the 332 sites that declared them inline (#8525). **No document's accepted set changes**: resolve every `$ref` this adds and each of the 215 touched documents comes back identical, which is checked over all of them rather than asserted.

New documents: `core/currency-code.json` (ISO 4217, 86 sites across 63 documents), `core/country-code.json` (ISO 3166-1 alpha-2, 72 sites / 50 documents), `core/idempotency-key.json` (67 sites / 67 documents), `core/domain-name.json` (57 sites / 45 documents) and `core/https-url.json` (50 sites / 35 documents).

Twelve shape-matching sites are deliberately **left alone**, because they mean something else. `^[A-Z]{3}$` is a currency code at 86 sites and an IATA airport code at `core/flight-item.json`'s `origin.airport_code` and `destination.airport_code`; the idempotency-key constraint is also the shape of ten reporting receipt and status identifiers, which are server-minted rather than client-generated. Naming the shape is what makes that distinction expressible at all — today the two are indistinguishable to anything reading the schema.

Each site keeps its own `description`, so no local wording is replaced by a generic sentence. `index.json` is unchanged: it is a curated discovery registry and 659 of the 1,099 source documents are already absent from it, so these five follow the prevailing convention for shared building blocks.

Why it matters outside the bundle: a code generator can see that 86 sites share one regex but cannot know the regex means "currency code", so it names the generated type after a hash of the pattern. In the Python SDK 85 of 160 constraint aliases are currently named by a hex digest, and a currency field reads `Annotated[StrMatching43E30B32, Field(description='ISO 4217 currency code')]` in 20 modules. The description knows what it is; the type cannot say so.
