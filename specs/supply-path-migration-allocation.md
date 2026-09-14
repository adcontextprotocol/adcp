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
`1467e46117e8d329f4116e548e9290be75d8e3b3`, the migration directories at all
50 open PR heads, and the coordinator's unpublished reservation inventory:

| Version | Owner                                                        | Migration / reservation                                                  |
| ------- | ------------------------------------------------------------ | ------------------------------------------------------------------------ |
| 588     | [#7433](https://github.com/adcontextprotocol/adcp/pull/7433) | `588_agent_compliance_runner_version.sql`                                |
| 589     | main                                                         | `589_compliance_run_publication.sql`                                     |
| 590     | main                                                         | `590_compliance_run_provenance.sql`                                      |
| 591     | [#7457](https://github.com/adcontextprotocol/adcp/pull/7457) | `591_compliance_refresh_authenticated_credential.sql`                    |
| 592     | [#7463](https://github.com/adcontextprotocol/adcp/pull/7463) | `592_email_mutations.sql`                                                |
| 593     | [#7464](https://github.com/adcontextprotocol/adcp/pull/7464) | `593_admin_credential_bind_operations.sql`; inherited unchanged by #7460 |
| 594     | unpublished Slack work                                       | Reserved; do not reallocate                                              |
| 595     | [#7501](https://github.com/adcontextprotocol/adcp/pull/7501) | `595_normalized_email_invariant.sql`                                     |
| 596     | unpublished grant lifecycle work                             | Reserved; do not reallocate                                              |
| 597     | [#7513](https://github.com/adcontextprotocol/adcp/pull/7513) | `597_supply_path_manifest_provenance.sql`                                |

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
