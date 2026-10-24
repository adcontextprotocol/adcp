"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { execute, CORE } = require("./optional-product-collections.test.cjs");

for (const broken of [
  "domain",
  "missing_echo",
  "drop",
  "duplicate_echo",
  "extra_package",
  "reject_all",
  "wrong_product",
  "missing_product",
])
  test(`advertised broken support: ${broken} remains a raw failed grade`, async () => {
    for (const name of CORE) {
      const { result, graded } = await execute(name, { broken });
      assert.equal(result.overall_passed, false, JSON.stringify(result));
      assert.ok(graded.some((s) => s.disposition === "failed"));
      assert.equal(
        result.coverage_gaps?.some((g) => g.reason === "fixture_unsatisfied") ??
          false,
        false,
      );
    }
  });
for (const name of ["collection_selection", "owner_sold_channel_subset"])
  test(`${name}: silently widening a strict subset fails exact pair-set grading`, async () => {
    const { result } = await execute(name, { broken: "widen" });
    assert.equal(result.overall_passed, false);
    const failures = result.phases
      .flatMap((p) => p.steps.flatMap((s) => s.validations ?? []))
      .filter((v) => v.check === "collection_set_equals_context" && !v.passed);
    assert.ok(failures.length);
    for (const v of failures) {
      for (const key of [
        "check",
        "passed",
        "description",
        "error",
        "json_pointer",
        "expected",
        "actual",
        "request",
        "response",
        "schema_id",
        "schema_url",
      ])
        assert.ok(Object.hasOwn(v, key), key);
      // SDK16.3 omits authored context_key (SDK#3396). The unchanged normative
      // assertion and raw failed baseline are preserved separately; this case
      // qualifies failed grading and the remaining actual wire evidence only.
      assert.equal(v.schema_id, null);
      assert.equal(v.schema_url, null);
      assert.equal(
        v.json_pointer,
        "/packages/0/targeting_overlay/collection_selection/collections",
      );
      assert.equal(v.request.transport, "mcp");
      assert.equal(v.response.transport, "mcp");
    }
  });
