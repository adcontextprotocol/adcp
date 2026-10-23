"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { execute, READ } = require("./optional-product-collections.test.cjs");

for (const broken of ["accept_invalid", "wrong_error"])
  test(`negative assertions: ${broken} cannot pass by rejecting everything or accepting invalid selectors`, async () => {
    for (const name of [
      "collection_selection",
      "fixed_bundle_enforcement",
      "owner_sold_channel_carriage",
    ]) {
      const { result } = await execute(name, { broken });
      assert.equal(result.overall_passed, false, JSON.stringify(result));
      assert.equal(
        result.phases[0].steps[0].passed,
        true,
        "same-product affirmative control ran before negatives",
      );
      assert.ok(
        result.phases
          .flatMap((p) => p.steps)
          .some((s) =>
            s.validations?.some((v) => v.check === "error_code" && !v.passed),
          ),
      );
    }
  });
for (const name of [
  "collection_default_materialization",
  "collection_default_materialization_readback",
])
  test(`${name}: default must materialize concrete selectors`, async () => {
    const { result } = await execute(name, {
      broken: "default_unmaterialized",
    });
    assert.equal(result.overall_passed, false);
  });
for (const broken of [
  "read_identity",
  "read_product",
  "read_missing_product",
  "read_package",
  "read_widen",
  "read_missing",
])
  test(`persisted readback: ${broken} fails full and standalone when reader is advertised`, async () => {
    for (const name of READ)
      for (const standalone of [false, true]) {
        const { result, graded } = await execute(name, {
          standalone,
          stepId: "read_selection",
          broken,
        });
        assert.equal(
          standalone ? result.passed : result.overall_passed,
          false,
          JSON.stringify(result),
        );
        assert.ok(
          graded.some(
            (s) => s.step_id === "read_selection" && s.disposition === "failed",
          ),
        );
      }
  });

for (const name of READ)
  test(`${name}: standalone read requires every prior identity and concrete committed set`, async () => {
    const complete = {
      collection_media_buy_id: "prior-buy",
      collection_package_id: "prior-package",
      collection_committed_product_id: "prior-product",
      collection_committed_selectors: [
        { publisher_domain: "studio.example", collection_ids: ["episode-a"] },
      ],
    };
    for (const missing of Object.keys(complete)) {
      const context = structuredClone(complete);
      delete context[missing];
      const { error, http } = await execute(name, {
        standalone: true,
        stepId: "read_selection",
        context,
        skipPriorCreate: true,
        expectLocalError: true,
      });
      assert.match(
        error.message,
        /requires trusted prior buy, package, product and concrete committed-selector context/,
      );
      assert.equal(http.length, 0);
    }
  });

for (const name of READ)
  test(`${name}: a failed create never reaches persisted readback in a full run`, async () => {
    for (const broken of ["domain", "wrong_product"]) {
      const { result, calls } = await execute(name, { broken });
      assert.equal(result.overall_passed, false, JSON.stringify(result));
      assert.equal(
        calls.some((c) => c.task === "get_media_buys"),
        false,
      );
    }
  });
