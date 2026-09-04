# Reporting reconciliation fixture

This directory is the protocol-owned, portable fixture for managed-reporting
resource inspection, immutable post-official adjustments, and consumer receipts. SDKs consume the same
`scenario-index.json` and exact asset bytes; they do not copy or recreate the
manifests, report objects, canonicalization vectors, or receipt bodies.
The initial manifest, rows, row schema, report definition, and canonicalization
inputs were promoted from the TypeScript SDK revision recorded in the scenario
index; this protocol copy is authoritative for subsequent changes.

## Integration

1. Pin an immutable AdCP compliance version or protocol commit.
2. Validate `scenario-index.json` against `scenario-index.schema.json`.
3. Verify every cataloged asset's byte length, SHA-256, and SHA-512 before
   parsing it.
4. Load the obligation, revision, adjustment, materialization, manifest, report
   definition, row schema, and canonicalization contract named by `base_inputs`.
5. Apply each scenario's parameterized `mutation` operation to a fresh copy of
   those inputs, then reconcile it. `resource_reads` is the exact trace to
   assert, not a script that replaces the mutation recipe.
6. Assert the error classification, read count, outcome, and receipt behavior.
7. Validate receipt requests and acknowledgements with the schemas named in
   `protocol.schema_ids`.
8. Execute `post_official_adjustment`: retain the external billing system's supporting-evidence revision
   and original receipt unchanged, verify the adjustment's JCS digest, and
   record the exact accepted adjustment receipt.

`publish_order` is part of the fixture: data objects become visible before the
manifest, and the manifest is the commit point. A missing object after a valid,
complete manifest is therefore a permanent integrity failure. A manifest read
that fails before the commit point is retryable.

The canonicalization ordering vector intentionally supplies rows out of
primary-key order and object keys outside canonical order. `canonicalization.json`
identifies the required empty-report and ordering/encoding vectors by purpose.
Consumers must reproduce every vector before trusting the contract.

The `empty_report` and `ordering_encoding` properties are required named
vectors. The empty case is exactly `[]`. The ordering/encoding case has both
non-canonical row order and non-canonical JSON object member order so a row-sort
plus ordinary serializer cannot pass accidentally.

The accepted receipt retry uses the same receipt ID, idempotency key, and body.
The first committed write returns `recorded`; a retry after an uncertain write
returns the byte-pinned `unchanged` acknowledgement. Rejected receipts carry
stable rejection codes rather than human-message parsing.
