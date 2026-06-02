---
---

docs(creative): buyer-attached input contract — the gate-vs-advisory governance distinction for `build_creative` inputs

Adds [`docs/creative/buyer-attached-inputs.mdx`](https://docs.adcontextprotocol.org/docs/creative/buyer-attached-inputs), a normative reference that defines — once — the contract every input a buyer attaches to `build_creative` shares, so each future pointer inherits it instead of relitigating governance.

**Two classes of buyer-attached input.**

- **Enforced capability input** (`transformer_id` + `config`): a typed contract the creative agent owns and prices per account. It gates — the agent MUST reject unknown / out-of-range `config` with field-attributed errors. Normative today (shipped in #5219).
- **Advisory context pointer** (`signal_ref`, `evaluator`, rights / provenance references): informs or steers production but MUST NOT hard-block it at the AdCP layer. Where enforcement exists, it lives in the layer that owns the thing — provider `generation_credentials` for rights, trafficking-compatibility checks for signals — not in the buyer's pointer.

**Shared shape** all buyer-attached inputs inherit: account-scoped discovery (`list_transformers`-style), per-account pricing, and a result envelope with a stable per-leaf anchor (`build_variant_id`).

**Rights are advisory at the pointer; enforcement is the credential.** Records the settled position against #5261's "`rights_tokens[]` as a hard creative-agent gate" proposal: hard-gating at the buyer pointer re-invents `generation_credentials` (provider-enforced at synthesis) plus `rights_constraint.verification_url` (live revocation). The pointer stays advisory / audit; the one real gap is structural — `voice_synthesis` carries no `rights_id` back-reference yet.

**Forward pointers** `signal_ref` (#5240) and `evaluator` (#5241) are referenced by governance class only — not yet in the schema.

Documentation only; no schema changes. Refs #5219, #5240, #5241, #5261.
