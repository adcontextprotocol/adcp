---
"adcontextprotocol": minor
---

Buyers can now tell how current creative assignment and approval state is. Four optional `date-time` fields apply the `media_buys[].status_as_of` pattern to creative state:

- `get_media_buys` `packages[].creative_assignments_as_of`: when the seller last refreshed the package's assignment set (which creatives appear in `creative_approvals`). A creative's absence is asserted only as of that time.
- `get_media_buys` `packages[].creative_approvals[].approval_status_as_of`: when `approval_status`, `rejection_reason`, and `approval_scopes` were last refreshed.
- `list_creatives` `creatives[].status_as_of`: when creative `status` was last refreshed.
- `list_creatives` `assignments.assigned_packages[].approval_status_as_of`: the same relationship as seen by `list_creatives`.

Each value is the seller's last observation of its source of truth and never later than the oldest upstream observation that could affect it. Accepting an AdCP write does not advance it; observing the resulting state does, which is commit time for a seller whose AdCP store is the source of truth. A value earlier than the buyer's last accepted write means the seller has not yet confirmed that write, so "not known yet" needs no new status value. Omission makes no freshness assertion. Sellers SHOULD include these values when state is cached or confirmed asynchronously. A change that only advances an `*_as_of` value fires no `creative.assignment_changed` or `creative.status_changed` event and writes no account change record.

`approval_status_as_of` joins the fields `get_media_buys` and `list_creatives` MUST agree on for the same relationship, when both carry it. No new task: keeping state current stays the seller's job. All fields are optional, so existing sellers and buyers are unaffected.
