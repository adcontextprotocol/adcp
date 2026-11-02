"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  execute,
  qualifying,
  load,
} = require("./optional-product-collections.test.cjs");

for (const fault of [
  "transport",
  "protocol",
  "schema",
  "pagination",
  "loop",
  "invalid_version",
])
  for (const name of ["collection_selection", "owner_sold_channel_subset"])
    for (const standalone of [false, true])
      test(`discovery: ${name} ${fault} standalone=${standalone} cannot become an unsupported-feature skip`, async () => {
        {
          const { result, graded, calls } = await execute(name, {
            standalone,
            fault,
          });
          assert.ok(
            graded.some((s) => s.disposition === "failed"),
            JSON.stringify(result),
          );
          assert.equal(
            calls.some((c) => c.task === "create_media_buy"),
            false,
          );
          assert.equal(
            result.coverage_gaps?.some(
              (g) => g.reason === "fixture_unsatisfied",
            ) ?? false,
            false,
          );
          assert.ok(
            result.fixture_resolutions.some((r) => r.status === "failed"),
          );
        }
      });
test("setup: a mandatory selected-entity capture failure stays failed with its producer evidence", async () => {
  const doc = load("collection_selection");
  doc.fixture_resolution.products[0].context_outputs.push({
    key: "__adcp_fixture_required_missing",
    path: "nonexistent_capture",
  });
  const { result, graded, calls } = await execute("collection_selection", {
    doc,
  });
  assert.ok(
    graded.some((s) => s.disposition === "failed"),
    JSON.stringify(result),
  );
  assert.equal(
    calls.some((c) => c.task === "create_media_buy"),
    false,
  );
  assert.ok(result.fixture_resolutions.some((r) => r.status === "failed"));
});
for (const name of [
  "collection_default_materialization",
  "collection_selection_readback",
])
  test(`${name}: hosted response cap leaves oversize discovery failed`, async () => {
    const { result, calls } = await execute(name, {
      hosted: true,
      responsePadding: 1024 * 1024 + 128,
    });
    assert.equal(result.overall_passed, false, JSON.stringify(result));
    assert.equal(
      calls.some((c) => c.task === "create_media_buy"),
      false,
    );
    assert.equal(
      result.coverage_gaps?.some((g) => g.reason === "fixture_unsatisfied") ??
        false,
      false,
    );
  });

for (const malformed of [
  "bulk_product",
  "plural_property",
  "wrong_flag",
  "empty_ids",
])
  test(`invalid catalog: ${malformed} fails schema instead of fixture_unsatisfied`, async () => {
    const offer = qualifying("owner_sold_channel_carriage");
    if (malformed === "bulk_product")
      offer.collections = [{ publisher_domain: "studio.example" }];
    if (malformed === "plural_property")
      offer.publisher_properties[0].publisher_domains = ["forbidden.example"];
    if (malformed === "wrong_flag") offer.collection_targeting_allowed = null;
    if (malformed === "empty_ids") offer.collections[0].collection_ids = [];
    const { result, graded, calls } = await execute(
      "owner_sold_channel_carriage",
      { catalog: [offer] },
    );
    assert.ok(
      graded.some((s) => s.disposition === "failed"),
      JSON.stringify(result),
    );
    assert.equal(
      result.coverage_gaps?.some((g) => g.reason === "fixture_unsatisfied") ??
        false,
      false,
    );
    assert.equal(
      calls.some((c) => c.task === "create_media_buy"),
      false,
    );
  });
