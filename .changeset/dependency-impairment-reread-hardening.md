---
---

Empty changeset: Harden the `dependency_impairment` / `dependency_impairment_cardinality` storyboards (follow-up to #5675). Declare `list_creatives` in `required_tools` (the re-read steps invoke it, so a seller without it is screened at the applicability layer instead of hard-failing the step); assert each re-read returned the intended creative via `creatives[0].creative_id` (so the cardinality re-reads prove they observed the right creative, not any rejected library entry); and update the capability-gate comment to note that default-`snapshot` sellers (those omitting `propagation_surfaces`) are graded only on `@adcp/sdk >= 9.2.0`, which materializes capability-gate schema defaults (adcp-client#2278).
