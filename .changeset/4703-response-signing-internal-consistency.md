---
---

docs(security): designated-task payload-envelope response signing carve-out (#4703)

Resolves the internal spec inconsistency between `security.mdx`'s blanket "Sellers MUST NOT sign synchronous AdCP response bodies under any existing `adcp_use` value" rule (introduced in #3742) and the Brand Protocol's existing normative use of `adcp_use: "response-signing"` for `verify_brand_claim` / `verify_brand_claims` (introduced in #4540 and built out in #4602).

The Brand Protocol's response signing is a **JWS payload envelope** carried inside the response body, not RFC 9421 §2.2.9 transport response signing. The two are distinct primitives — #3742's MUST NOT was about transport-level signing; the brand-protocol's payload-envelope JWS is a different signing surface entirely. The spec text didn't draw that distinction, which (a) read as forbidding the brand-protocol's existing pattern and (b) gave SDKs reading the rule no help in seeing that RFC 9421 transport response signing remains undefined.

Tightens three primary places, plus back-links from two brand-protocol pages:

- `docs/building/by-layer/L1/security.mdx` — splits the "No symmetric response-signing profile" callout into (1) "No general-purpose RFC 9421 response-signing profile" carrying the transport-level MUST NOT, and (2) "Designated-task payload-envelope response signing" carving out the closed list (currently `verify_brand_claim` + `verify_brand_claims`) with admission criterion. Reserves `adcp_use: "response-signing"` for the payload-envelope primitive at the JWK layer; future major versions scoping RFC 9421 transport response signing MUST use a distinct `adcp_use` value so verifiers can disambiguate from the JWK alone.
- `docs/building/concepts/security-model.mdx` — updates "What gets signed" from four signing systems to five; tightens "synchronous responses NOT signed at the body level" → "NOT signed at the transport layer" with the designated-task carve-out.
- `docs/reference/known-limitations.mdx` — reframes the limitation entry to name RFC 9421 §2.2.9 as the specifically-undefined surface and acknowledge the payload-envelope exception in the title line.
- `docs/brand-protocol/tasks/verify_brand_claim.mdx` and `docs/brand-protocol/building-a-brand-agent.mdx` — back-link the brand-protocol response-signing description to the new designated-task framing in `security.mdx`; add non-repudiation disclaimer on the trust-model section; add a response-body-middleware caveat on the signing-setup section warning that JSON re-serialization breaks payload-envelope verification.

Three operational hardenings on the brand-protocol payload-envelope signing primitive are out of scope for this consistency PR and filed as 3.2 follow-ups: replay protection ([#4716](https://github.com/adcontextprotocol/adcp/issues/4716)), per-brand JWK uniqueness ([#4717](https://github.com/adcontextprotocol/adcp/issues/4717)), and tenant binding in the payload envelope ([#4718](https://github.com/adcontextprotocol/adcp/issues/4718)). The trust-model section carries an interim disclaimer pointing at these issues.
