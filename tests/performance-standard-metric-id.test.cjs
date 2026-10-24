/**
 * performance_standard.metric_id names which of the standard's vendor's
 * metrics is judged against threshold. It is optional, mirrored on every
 * performance-standard shape, and not allowed on viewability standards.
 */
const fs = require("fs");
const path = require("path");
const Ajv = require("ajv");
const addFormats = require("ajv-formats");
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const SCHEMA_ROOT = path.join(__dirname, "..", "static", "schemas", "source");
const readSchema = (uri) =>
  JSON.parse(fs.readFileSync(path.join(SCHEMA_ROOT, uri.slice("/schemas/".length)), "utf8"));

async function compile(schema) {
  const ajv = new Ajv({ allErrors: true, strict: false, loadSchema: async (ref) => readSchema(ref) });
  addFormats(ajv);
  return ajv.compileAsync(schema);
}

const VENDOR = { domain: "verification-vendor.example" };

const SHAPES = {
  legacy: () => compile(readSchema("/schemas/core/performance-standard.json")),
  canonical: () => compile(readSchema("/schemas/core/canonical-performance-standard.json")),
  offer_filter: () => {
    const filters = readSchema("/schemas/core/product-offer-filters.json");
    return compile({
      $id: "/schemas/test/offer-filter-performance-standard.json",
      ...filters.properties.required_performance_standards.items,
    });
  },
};

describe("performance standard metric_id", () => {
  for (const [name, load] of Object.entries(SHAPES)) {
    it(`${name}: accepts metric_id outside viewability`, async () => {
      const validate = await load();
      for (const metric of ["ivt", "brand_safety", "attention_score", "completion_rate"]) {
        const standard = { metric, threshold: 0.03, vendor: VENDOR, metric_id: "givt_rate" };
        assert.equal(validate(standard), true, `${metric}: ${JSON.stringify(validate.errors)}`);
      }
    });

    it(`${name}: stays optional`, async () => {
      const validate = await load();
      assert.equal(validate({ metric: "ivt", threshold: 0.03, vendor: VENDOR }), true);
      assert.equal(
        validate({ metric: "viewability", threshold: 0.7, standard: "mrc", vendor: VENDOR }),
        true,
        JSON.stringify(validate.errors)
      );
    });

    it(`${name}: rejects metric_id on viewability`, async () => {
      const validate = await load();
      const standard = { metric: "viewability", threshold: 0.7, standard: "mrc", vendor: VENDOR, metric_id: "viewable_rate" };
      assert.equal(validate(standard), false);
    });

    it(`${name}: metric_id uses the vendor-metric-id pattern`, async () => {
      const validate = await load();
      assert.equal(validate({ metric: "ivt", threshold: 0.03, vendor: VENDOR, metric_id: "GIVT Rate" }), false);
    });
  }

  it("canonical, legacy, and offer-filter standards declare the same properties", () => {
    const legacy = Object.keys(readSchema("/schemas/core/performance-standard.json").properties).sort();
    const canonical = Object.keys(readSchema("/schemas/core/canonical-performance-standard.json").properties).sort();
    const filter = Object.keys(
      readSchema("/schemas/core/product-offer-filters.json").properties.required_performance_standards.items.properties
    ).sort();
    assert.deepEqual(canonical, legacy);
    assert.deepEqual(filter, legacy);
  });
});
