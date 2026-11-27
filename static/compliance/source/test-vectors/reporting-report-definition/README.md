# Report definition package dimension

Reference verdicts for the `package_id` dimension rule on Reliable Reporting
report definitions (`core/reporting-report-definition.json`, #8971).

At `contract_version` `1.2`, a definition whose rows are scoped to a media buy
names that dimension `media_buy_id`, and a definition whose `dimensions` include
`media_buy_id` MUST include `package_id`, so every row carries the buyer-visible
package. A definition whose rows are not scoped to a media buy (an account-level
summary, for example) declares no `media_buy_id` and is exempt at every version.
Version `1.2` keeps every `1.1` rule. The naming rule and the `primary_keys` rule
in `core/reporting-report-definition.json` are prose and are not graded here.

Definitions at `1.0` and `1.1` keep validating unchanged. A grader SHOULD report a
`1.0` or `1.1` definition that includes `media_buy_id` but not `package_id` as
an advisory finding, never a failure. The `reporting-reconciliation` reference
fixture is such a definition and is deliberately left at `1.1`, so its bytes and
digests do not change.

## Integration

1. Load `report-definition-1-2.json` as the base definition.
2. For each case in `vectors.json`, apply `overrides` to a fresh copy of the
   base. Each override replaces a whole top-level member.
3. Validate the result against `core/reporting-report-definition.json` and
   compare with `expected.schema_valid`. For an invalid case,
   `expected.violations` names the rule it breaks, using `violation_codes`.
4. Apply the advisory rule and compare the findings with
   `expected.advisories`, using `advisory_codes`.

The dimension is named `package_id`, matching `media_buy_id`. Reporting
subscription selectors and offering `standard_dimensions` use the standard
vocabulary in `enums/reporting-dimension.json`, where the same breakdown is
`package`.
