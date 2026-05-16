---
"adcontextprotocol": patch
---

docs(provenance): frame provenance as transport, not compliance; warn on `human_oversight` ↔ `disclosure.required` combo

Three honesty tightenings to the AI provenance and disclosure surface in response to external legal review of the regulatory framing:

- **`docs/creative/provenance.mdx`**: The intro `<Info>` callout previously read "AdCP's provenance metadata *provides* the structured, machine-readable disclosure that these regulations require." That overstates what a wire format can do — the legal obligation under EU AI Act Article 50(5) is a user-facing disclosure by the deployer at first exposure, not a transmission obligation on the supply chain. Rewrites to describe AdCP as the transport that carries the signals these regulations rely on, with the legal obligation remaining with the deployer.

- **`docs/creative/provenance.mdx`**: Adds a `<Warning>` in the Human oversight section noting that `human_oversight` and `disclosure.required` are independent — the protocol does not derive one from the other. Article 50(4) carve-outs for human-edited or human-directed AI output have factual prerequisites the schema cannot evaluate, so asserting `human_oversight: edited` or `directed` does not by itself justify `disclosure.required: false`. Sellers and governance agents may treat the combination as audit-worthy. Closes the obvious abuse vector a hostile reading would name first.

- **`docs/governance/creative/provenance-verification.mdx`**: Rewrites the Art 50 and SB 942 mapping paragraphs. Art 50 obligations sit on providers (50(2)) and deployers (50(4)/(5)), not the supply chain — the deployer in advertising is typically the advertiser or agency. SB 942 obligations sit on covered platforms (MAU threshold). In both cases, `disclosure.required` is the declaring party's claim, not a determination the protocol makes; a seller relying on `required: false` without verification is relying on a buyer's claim.

- **`static/schemas/source/core/provenance.json`**: Mirrors the warnings in the `human_oversight` and `disclosure.required` field descriptions so SDK consumers reading the schema get the same framing.

No wire changes; descriptions and prose only.
