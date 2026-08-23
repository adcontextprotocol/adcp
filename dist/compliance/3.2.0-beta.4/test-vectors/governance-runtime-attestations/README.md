# Governance runtime attestation vectors

These vectors compose the shared portable-attestation fixtures in `../attestations/vectors.json` with the `check_governance` signal-activation contract. They are served at `/compliance/{version}/test-vectors/governance-runtime-attestations/vectors.json`.

For each `cases[]` entry, load the named `presentation_vector`, attach its presentation to `base_request.runtime_attestations[]`, apply any subject override, and assert the normalized outcome, governance verdict, and outbound-request count. Resolve `payload.signal_agent_segment_id` through `known_agent_state.signal_subjects_by_activation_id` and reconcile the complete typed subject; an id match under another namespace is not sufficient. A governance response must contain one ordered `runtime_attestation_evaluations[]` item per presentation and a `runtime_attestation_binding_digest` computed exactly as specified in the fixture.

`deactivation_request` is a negative-policy vector: required activation-time evidence does not apply to `payload.action: deactivate`, and runtime attestations are structurally forbidden on that request. Deactivation must remain available when activation evidence is unavailable.

The non-empty `binding_vector` pins the finding-inclusive digest. Audit readback retains ordered `{ reference, evaluation }` pairs so a verifier can recompute every `reference_digest` before recomputing the binding digest, including all finding fields that were in the original preimage.

The cache-reuse vectors are normative: an evaluation can be reused only when the exact reference digest, plan hash, and governed action binding are unchanged and the evaluation remains within its validity/revocation window. A changed plan or check/action requires a new evaluation even when the credential reference is unchanged.
