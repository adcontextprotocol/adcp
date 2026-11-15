---
"adcontextprotocol": minor
---

Add experimental `installment_refs` to the `assign` and `replace` operations of `sync_creatives` `assignment_operations` (`media_buy.installment_creative_assignment`, #8968). A buyer can now give each installment of a package its own creative, such as the awareness brief on a creator's first post and the offer on the second. Each entry is a `core/canonical-installment-ref.json`, with unique items and at most 500, matching a product's installments. Absent means every installment, as before.

- **Rotation.** Within one installment, weight, rotation and placement routing work unchanged over the assignments that apply to it. Placement routing and installment scope intersect. An installment no assignment applies to gets no creative scoped to another installment.
- **Seller rules.** Each ref MUST name an installment in the `installments` of the purchased product. Any other ref is rejected with `VALIDATION_ERROR`. An operation that changes an installment past its `deadlines.change_cutoff` is rejected with `CREATIVE_DEADLINE_EXCEEDED`, naming the installment, and is never accepted silently. No new error codes.
- **Scope changes.** A supplied list replaces the assignment's scope, and omission on an `assign` upsert keeps it. `replace` transfers the replaced assignment's scope unless it supplies one, and `merge` moves it. `unassign` and `merge` reject `installment_refs` by name.
- **Readback.** The same field appears on `get_media_buys` `packages[].creative_approvals[]` and `list_creatives` `assignments.assigned_packages[]`, and is omitted when the assignment applies to every installment.
- **Capability.** Buyers send the field only to sellers that list `media_buy.installment_creative_assignment` in `experimental_features`, because a seller that ignored it would run the creative on every installment (versioning rule 4). A seller that does not support it rejects it with `UNSUPPORTED_FEATURE`.

The field is not on `core/creative-assignment.json`, the deprecated `create_media_buy` and `update_media_buy` package rows, or the deprecated `sync_creatives` `assignments[]` row. 3.3 adds nothing to deprecated tasks (#8501). Date windows (`valid_from` / `valid_until`) for packages without installments are a follow-up.
