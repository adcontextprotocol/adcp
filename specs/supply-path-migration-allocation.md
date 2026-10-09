# Supply-path provenance migration allocation

Migration `597_supply_path_manifest_provenance.sql` adds the nullable JSONB
`publishers.supply_path_provenance` column. Existing manifests remain untrusted
until a successful provenance-aware refresh writes both the manifest and its
provenance. Replaying the migration preserves those successful observations.

## Allocation and protected neighbors

The [coordinator hold on #7513](https://github.com/adcontextprotocol/adcp/pull/7513#issuecomment-5668561258)
identified that its original 591 filename collided with #7457's earlier
reservation. The correction changes only the filename: the SQL remains blob
`f6629447ccfecb28834380e9efe4863099454555`. Do not apply the obsolete
`591_supply_path_manifest_provenance.sql` filename or rewrite an existing
591 ledger entry to disguise a collision.

The 2026-09-14 allocation audit used main
`70a91fe9f7eab38910e0877f56cf0e3332a21a78`, the migration directories at all
50 open PR heads, and the coordinator's unpublished reservation inventory:

| Version | Owner                                                        | Migration / reservation                                                        |
| ------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| 588     | [#7433](https://github.com/adcontextprotocol/adcp/pull/7433) | `588_agent_compliance_runner_version.sql`                                      |
| 589     | main                                                         | `589_compliance_run_publication.sql`                                           |
| 590     | main                                                         | `590_compliance_run_provenance.sql`                                            |
| 591     | [#7457](https://github.com/adcontextprotocol/adcp/pull/7457) | `591_compliance_refresh_authenticated_credential.sql`                          |
| 592     | [#7463](https://github.com/adcontextprotocol/adcp/pull/7463) | `592_email_mutations.sql`; inherited unchanged by #7499                       |
| 593     | [#7464](https://github.com/adcontextprotocol/adcp/pull/7464) | `593_admin_credential_bind_operations.sql`; inherited unchanged by #7460       |
| 594     | unpublished Slack work                                       | `594_slack_identity_binding_operations.sql`; reserved, do not reallocate       |
| 595     | [#7501](https://github.com/adcontextprotocol/adcp/pull/7501) | `595_normalized_email_invariant.sql`                                           |
| 596     | unpublished grant lifecycle work                             | `596_organization_credential_grant_lifecycle.sql`; reserved, do not reallocate |
| 597     | [#7513](https://github.com/adcontextprotocol/adcp/pull/7513) | `597_supply_path_manifest_provenance.sql`                                      |

#7457's protected 591 SQL is blob
`207b23673abb6fff82b36dc1adcdd1c9de9f894b` at commit
`be9cd83508bd4b00b7eaafac63b1fba84c92c396`. The open-PR audit found no other
597 file. Repeat the live main/open-PR/reservation audit immediately before
publishing; this snapshot does not inventory undisclosed worktrees.

## Dependencies and qualification

597 depends only on the existing `publishers` table. It has no SQL or
application dependency on the #6827 identity chain and can be applied before
or after that chain. Preserve the chain's required internal order:
**591 → 592 → 593 → 594 → 595 → 596**. No file or reservation in that chain
is imported, renumbered, or changed by #7513.

The migrator identifies applied entries by version and filename, rejects
duplicate version files before applying them, and fails on a conflicting
modern ledger filename. Missing lower-numbered migrations can still be applied
when their owning changes subsequently land; 597 does not advance a high-water
mark that skips them.

Qualification requires migration naming/duplicate validation, a clean database
apply and no-op replay, and a combined 588–597 apply/replay using the exact
reserved SQL in order. The dedicated PostgreSQL regression
`server/tests/integration/supply-path-manifest-provenance-migration.test.ts`
checks that historical/new rows remain untrusted and that repeated application
preserves the full successful manifest provenance. Keep the PR Draft with
auto-merge off until independent exact-head review and human maintainer
approval clear the coordinator hold.

## Combined replay evidence

The reservation owners supplied read-only SQL inputs, independently verified
against their Git blobs and SHA-256 digests before use:

- 594: commit `21cbb4ffd8e889ef5ac56a69770ea793462585ac`, blob
  `eb85dbf1271d278936b9d602abc9401fff6e100f`, 1518 bytes, SHA-256
  `19ee60aaa9f52b1abe3022d6b2533f05d4c61156edc1b405987c08ed0921158c`.
- 596: commit `9052790e34e461093f64c1149457488d8cdd13e3`, blob
  `ed920189da8ea6519def714b80de8a4b5cc19017`, 22999 bytes, SHA-256
  `b3eb30a00e8d1fbaff679d75193bb4fc43c3bff4416bc8536a0e2b49210d0396`.

The 2026-09-14 PostgreSQL composition check applied 579 ordinary migrations
from an empty database, including every version 588–597 in order. Evaluator-only
584/585 retained their existing external-provisioning exclusion. Replaying
preserved every ledger row, timestamp, and the full schema dump hash.

A second database started with main plus 597, then applied the still-pending
588 and 591–596 in order. It preserved the existing 597 ledger entry and a
successful manifest/provenance pair; replay again made no changes. Its schema
diff against the fresh database consisted only of the physical column position
of `agent_compliance_runs.runner_capability_version`: reserved 588 arrived
after main's already-applied 589/590. All other schema dump bytes matched.

Negative controls in isolated databases reproduced both the duplicate 591
file and an incorrect modern 591 ledger filename. The first failed before any
migration was applied; the second failed without modifying the existing ledger
or schema. No production/shared database ledger was repaired or rewritten.
These SQL checks do not approve the held parent application compositions or
replace fresh final-head CI, independent review, or human maintainer approval.
