"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  execute,
  product,
  qualifying,
  READ,
  ALL,
  pairs,
} = require("./optional-product-collections.test.cjs");

for (const [label, offer, applicable] of [
  [
    "one fixed omitted pair",
    product("one-fixed", { flag: "omitted", pairs: 1 }),
    [
      "collection_default_materialization",
      "fixed_bundle_restatement",
      "collection_default_materialization_readback",
    ],
  ],
  [
    "one selectable pair",
    product("one-selectable", { pairs: 1 }),
    [
      "collection_default_materialization",
      "collection_default_materialization_readback",
    ],
  ],
  [
    "one cross-publisher fixed pair",
    product("one-cross", { flag: "omitted", pairs: 1, cross: true }),
    [
      "collection_default_materialization",
      "fixed_bundle_restatement",
      "owner_sold_channel_carriage",
      "collection_default_materialization_readback",
    ],
  ],
  [
    "two fixed false pairs",
    product("two-fixed", { flag: false }),
    [
      "collection_default_materialization",
      "fixed_bundle_enforcement",
      "fixed_bundle_restatement",
      "collection_default_materialization_readback",
    ],
  ],
])
  test(`independence: ${label} cannot be suppressed by a missing companion fixture`, async () => {
    for (const name of ALL) {
      const { result, calls } = await execute(name, {
        catalog: [structuredClone(offer)],
      });
      assert.equal(result.overall_passed, true, JSON.stringify(result));
      assert.equal(
        calls.some((c) => c.task === "create_media_buy"),
        applicable.includes(name),
        name,
      );
      assert.equal(
        result.coverage_gaps?.some((g) => g.reason === "fixture_unsatisfied") ??
          false,
        !applicable.includes(name),
        name,
      );
    }
  });
test("cross-publisher: one local-first pair and one retained external pair qualify independently", async () => {
  const offer = product("mixed", {
    collections: [
      { publisher_domain: "a-local.example", collection_ids: ["same"] },
      { publisher_domain: "z-external.example", collection_ids: ["same"] },
    ],
  });
  offer.publisher_properties = [
    { publisher_domain: "a-local.example", selection_type: "all" },
    { publisher_domain: "host-two.example", selection_type: "all" },
  ];
  for (const name of [
    "owner_sold_channel_carriage",
    "owner_sold_channel_subset",
  ]) {
    const { result, calls } = await execute(name, {
      catalog: [structuredClone(offer)],
    });
    assert.equal(result.overall_passed, true, JSON.stringify(result));
    const buys = calls.filter((c) => c.task === "create_media_buy");
    if (name.endsWith("subset"))
      assert.deepEqual(
        buys[0].request.packages[0].targeting_overlay.collection_selection
          .collections,
        [{ publisher_domain: "z-external.example", collection_ids: ["same"] }],
      );
    else {
      assert.deepEqual(
        buys[1].request.packages[0].targeting_overlay.collection_selection
          .collections,
        [{ publisher_domain: "z-external.example" }],
      );
      assert.equal(
        buys[2].request.packages[0].targeting_overlay.collection_selection
          .collections[0].publisher_domain,
        "z-external.example",
      );
      assert.equal(
        buys[3].request.packages[0].targeting_overlay.collection_selection
          .collections[0].collection_ids[0],
        "same",
      );
    }
  }
});
test("cross-publisher: namespaces appearing anywhere in product properties are not external", async () => {
  const offer = product("all-local", {
    collections: [
      { publisher_domain: "first.example", collection_ids: ["x"] },
      { publisher_domain: "second.example", collection_ids: ["y"] },
    ],
  });
  offer.publisher_properties = [
    { publisher_domain: "first.example", selection_type: "all" },
    { publisher_domain: "second.example", selection_type: "all" },
  ];
  for (const name of [
    "owner_sold_channel_carriage",
    "owner_sold_channel_subset",
  ]) {
    const { result, calls } = await execute(name, { catalog: [offer] });
    assert.ok(
      result.coverage_gaps.some((g) => g.reason === "fixture_unsatisfied"),
    );
    assert.equal(
      calls.some((c) => c.task === "create_media_buy"),
      false,
    );
  }
});
test("set semantics: legal catalog redundancy, empty and Unicode IDs stay concrete without duplicate wire entries", async () => {
  const collections = [
    { publisher_domain: "studio.example", collection_ids: ["", "é", "é"] },
    { publisher_domain: "studio.example", collection_ids: ["", "é", "é"] },
    { publisher_domain: "other.example", collection_ids: ["é"] },
  ];
  for (const name of [
    "collection_default_materialization",
    "fixed_bundle_restatement",
    "collection_selection",
  ]) {
    const offer = qualifying(name, { collections });
    const { result, calls } = await execute(name, { catalog: [offer] });
    assert.equal(result.overall_passed, true, JSON.stringify(result));
    if (name === "fixed_bundle_restatement") {
      const sent = calls.find((c) => c.task === "create_media_buy").request
        .packages[0].targeting_overlay.collection_selection.collections;
      assert.equal(sent.length, 3);
      assert.equal(
        new Set(sent.map((s) => JSON.stringify(s))).size,
        sent.length,
      );
      assert.deepEqual(pairs(sent), pairs(collections));
    }
  }
});

test("negative witnesses collision-check the COMPLETE selected product rather than a reserved-looking prefix", async () => {
  const { evaluateCollectionSelection } = require("@adcp/sdk/testing");
  const offer = product("collision-product", { cross: true });
  const initial = evaluateCollectionSelection(offer, {
    collection_targeting: "any",
    minimum_pairs: 1,
    require_cross_publisher_collection: true,
  }).witness;
  offer.collections[0].collection_ids.push(
    initial.undeclared_collection_id_selectors[0].collection_ids[0],
  );
  offer.collections.push(
    structuredClone(initial.undeclared_publisher_domain_selectors[0]),
  );
  const { result, calls } = await execute("owner_sold_channel_carriage", {
    catalog: [offer],
  });
  assert.equal(result.overall_passed, true, JSON.stringify(result));
  const negative = calls.filter((c) => c.task === "create_media_buy").slice(2);
  const declared = pairs(offer.collections);
  for (const call of negative)
    for (const pair of pairs(
      call.request.packages[0].targeting_overlay.collection_selection
        .collections,
    ))
      assert.equal(declared.has(pair), false);
  const sentDomain =
    negative[1].request.packages[0].targeting_overlay.collection_selection
      .collections[0].publisher_domain;
  assert.equal(
    offer.collections.some((s) => s.publisher_domain === sentDomain),
    false,
  );
});

test("root applicability: brief-only seller remains excluded in full and standalone without fixture contact", async () => {
  for (const name of ALL)
    for (const standalone of [false, true]) {
      const { result, calls, graded } = await execute(name, {
        standalone,
        buyingModes: ["brief"],
      });
      assert.equal(calls.length, 0, JSON.stringify(calls));
      assert.ok(
        graded.every((s) => s.disposition === "not_applicable"),
        JSON.stringify(result),
      );
    }
});

for (const name of READ)
  test(`${name}: stale caller tool caches cannot override the observed reader gate`, async () => {
    for (const standalone of [false, true]) {
      const absent = await execute(name, {
        standalone,
        reader: false,
        stepId: "read_selection",
        overrides: {
          agentTools: [
            "get_media_buys",
            "get_products",
            "create_media_buy",
            "comply_test_controller",
          ],
        },
      });
      assert.equal(absent.http.length, 0);
      assert.equal(absent.calls.length, 0);
      assert.ok(
        absent.graded.every((s) => s.disposition === "not_applicable"),
        JSON.stringify(absent.result),
      );
      const present = await execute(name, {
        standalone,
        stepId: "read_selection",
        overrides: { agentTools: [] },
      });
      assert.equal(
        standalone ? present.result.passed : present.result.overall_passed,
        true,
        JSON.stringify(present.result),
      );
    }
  });
