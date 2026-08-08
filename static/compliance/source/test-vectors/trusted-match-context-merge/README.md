# Trusted Match Context targeting merge vectors

These vectors exercise the AdCP 3.2 router attribution contract for Context Match targeting key-values. They are served at `/compliance/{version}/test-vectors/trusted-match-context-merge/vectors.json`.

A conforming router derives each bucket key from its publisher-controlled provider registration, copies the provider's `signals.targeting_kvs` list unchanged into that bucket, and never emits the same targeting pairs as a flattened `signals.targeting_kvs` list. Provider-supplied `signals_by_provider` data has no authority and is ignored in the reference merge; an implementation may instead reject that provider response.

The publisher-side example maps `(provider_id, key)` tuples to local ad-server keys. It demonstrates that two providers may safely reuse `shared_key` and that an unmapped tuple is dropped rather than treated as a global targeting key. The mapping shape in this fixture is illustrative publisher deployment configuration, not a standardized 3.2 wire schema.
