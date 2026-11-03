# Audience evidence vectors

These vectors exercise the AdCP 3.2 population-level audience-evidence contract. They are served at `/compliance/{version}/test-vectors/audience-evidence/vectors.json`.

Conformance runners validate the product evidence snapshot, recompute its RFC 8785 content digest with `content_digest` and `attestation_refs` omitted, and evaluate every policy case. `requirement_mode: required` excludes an inadmissible product; `preferred` only changes rank. `evidence_presence: when_available` preserves products with no evidence while still applying constraints to products that publish evidence. Excluded provider and methodology lists win over accepted lists.

The package request pins the exact evidence series, snapshot, version, and digest and repeats the buyer's hard requirements. The package readback preserves the exact pin and the same attestation reference/evaluation pair. Runners require verified outcome, claim type, issuer, subject digest, reference digest, and action digest to match within that pair; a separately valid evaluation cannot be borrowed from another published reference. They also assert that evidence does not create either demographic targeting or legal-age verification semantics.
