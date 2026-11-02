"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  execute,
  qualifying,
  ALL,
} = require("./optional-product-collections.test.cjs");

for (const minimum of [undefined, 0, 5000])
  test(`same graph: later qualifying product and scoped price preserve minimum ${String(minimum)}`, async () => {
    for (const name of ALL) {
      const noPrice = qualifying(name, {
        prices: [
          {
            pricing_option_id: "auction-only",
            pricing_model: "cpm",
            currency: "USD",
            floor_price: 900,
          },
        ],
      });
      noPrice.product_id = "a-earlier-unusable";
      const selected = qualifying(name, { minimum });
      selected.product_id = "z-later-qualified";
      selected.pricing_options.unshift({
        pricing_option_id: "unrelated-auction",
        pricing_model: "cpm",
        currency: "USD",
        floor_price: 999,
      });
      const { result, calls } = await execute(name, {
        pages: [[noPrice], [selected]],
        context: {
          products: [noPrice],
          catalog_collection_budget: 1,
          catalog_collection_full_selectors: [
            { publisher_domain: "forged.example", collection_ids: ["forged"] },
          ],
        },
      });
      assert.equal(result.overall_passed, true, JSON.stringify(result));
      assert.deepEqual(
        calls
          .filter((c) => c.task === "get_products")
          .map((c) => c.request.pagination?.cursor),
        [undefined, "1"],
      );
      const buy = calls.find((c) => c.task === "create_media_buy").request;
      assert.equal(buy.packages[0].product_id, selected.product_id);
      assert.equal(buy.packages[0].pricing_option_id, "native-product-fixed");
      assert.equal(buy.packages[0].budget, Math.max(1000, minimum ?? 0));
    }
  });

for (const minimum of [undefined, 0, 5000])
  test(`selected snapshot faithfully exposes optional minimum ${String(minimum)}`, async () => {
    const offer = qualifying("collection_selection", { minimum });
    const { prepared } = await execute("collection_selection", {
      catalog: [offer],
      prepareOnly: true,
    });
    assert.equal(prepared.disposition.status, "resolved");
    const price = prepared.captures.__adcp_fixture_collection_price;
    assert.equal(
      Object.hasOwn(price, "min_spend_per_package"),
      minimum !== undefined,
    );
    assert.equal(price.min_spend_per_package, minimum);
    assert.equal(
      price.pricing_option_id,
      offer.pricing_options[0].pricing_option_id,
    );
    assert.equal(price.currency, "EUR");
    assert.equal(price.fixed_price, 17);
    // Public diagnostic views are detached copies; mutation cannot change the
    // SDK-owned selected snapshot used by consumers or future capture reads.
    price.fixed_price = 999;
    price.min_spend_per_package = 999;
    const fresh = prepared.captures.__adcp_fixture_collection_price;
    assert.equal(fresh.fixed_price, 17);
    assert.equal(
      Object.hasOwn(fresh, "min_spend_per_package"),
      minimum !== undefined,
    );
    assert.equal(fresh.min_spend_per_package, minimum);
  });
