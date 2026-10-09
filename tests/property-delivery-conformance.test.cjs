const fs = require("fs");
const path = require("path");
const Ajv = require("ajv");
const addFormats = require("ajv-formats");
const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

const SOURCE = path.join(__dirname, "..", "static");
const SCHEMA_ROOT = path.join(SOURCE, "schemas", "source");
const SCENARIO_DIR = path.join(SOURCE, "compliance", "source", "protocols", "media-buy", "scenarios");

function readSchema(uri) {
  assert.match(uri, /^\/schemas\//);
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_ROOT, uri.slice(9)), "utf8"));
}

async function compile(schema) {
  const ajv = new Ajv({ allErrors: true, strict: false, loadSchema: async ref => readSchema(ref) });
  addFormats(ajv);
  return ajv.compileAsync(schema);
}

function readScenario(name) {
  // The scenarios are simple enough that a line scan beats adding a YAML dependency.
  return fs.readFileSync(path.join(SCENARIO_DIR, `${name}.yaml`), "utf8");
}

const PROPERTY_ROW = {
  publisher_domain: "acme-news.example",
  identifier: { type: "domain", value: "acme-news.example" },
  impressions: 5000,
  spend: 25,
};
const INSTALLMENT_ROW = {
  installment_ref: {
    collection_ref: { publisher_domain: "studio-network.example", collection_id: "nightly_news" },
    installment_id: "ep_101",
  },
  publisher_domain: "streamhaus.example",
  identifier: { type: "domain", value: "streamhaus.example" },
  impressions: 4000,
  spend: 40,
};

describe("property-grain delivery conformance", () => {
  let validateController;
  let validateFeatures;

  before(async () => {
    validateController = await compile(readSchema("/schemas/compliance/comply-test-controller-request.json"));
    validateFeatures = await compile(readSchema("/schemas/core/media-buy-features.json"));
  });

  const simulate = params => ({
    scenario: "simulate_delivery",
    params: { media_buy_id: "mb-789", ...params },
    account: { sandbox: true },
  });

  it("accepts injected property and installment-property rows that reuse the response row schemas", () => {
    assert.equal(validateController(simulate({ property_delivery: [PROPERTY_ROW] })), true, JSON.stringify(validateController.errors));
    assert.equal(
      validateController(simulate({ installment_property_delivery: [INSTALLMENT_ROW] })),
      true,
      JSON.stringify(validateController.errors),
    );
  });

  it("rejects rows that would not be valid response rows or are empty", () => {
    const noDomain = { ...PROPERTY_ROW };
    delete noDomain.publisher_domain;
    assert.equal(validateController(simulate({ property_delivery: [noDomain] })), false);
    assert.equal(validateController(simulate({ property_delivery: [] })), false);
    assert.equal(validateController(simulate({ installment_property_delivery: [PROPERTY_ROW] })), false);
    assert.equal(validateController(simulate({ installment_property_delivery: [] })), false);
  });

  it("keeps the inline controller row shape aligned with the response row schemas", () => {
    // The controller schema describes rows by shape instead of $ref-ing the row
    // schemas so the MCP projection stays under the parity compile limit; the
    // training agent validates against the real row schemas.
    const params = readSchema("/schemas/compliance/comply-test-controller-request.json").properties.params.properties;
    for (const [field, rowSchema] of [
      ["property_delivery", "/schemas/core/property-delivery-metrics.json"],
      ["installment_property_delivery", "/schemas/core/installment-property-delivery-metrics.json"],
    ]) {
      const rowRequired = readSchema(rowSchema).allOf.find(part => part.required).required;
      assert.deepEqual([...params[field].items.required].sort(), [...rowRequired].sort(), field);
    }
  });

  it("declares seller-wide rollups as booleans named like the per-product flags", () => {
    assert.equal(validateFeatures({ supports_property_breakdown: true, supports_installment_property_breakdown: false }), true);
    assert.equal(validateFeatures({ supports_property_breakdown: "yes" }), false);
    const features = readSchema("/schemas/core/media-buy-features.json").properties;
    const reporting = readSchema("/schemas/core/reporting-capabilities.json").properties;
    for (const flag of ["supports_property_breakdown", "supports_installment_property_breakdown"]) {
      assert.ok(features[flag], `${flag} rollup missing from media-buy-features.json`);
      assert.ok(reporting[flag], `${flag} per-product flag missing from reporting-capabilities.json`);
    }
  });

  for (const [id, flag, dimension, rows] of [
    ["property_delivery_reporting", "supports_property_breakdown", "property", "property_delivery"],
    [
      "installment_property_delivery_reporting",
      "supports_installment_property_breakdown",
      "installment_property",
      "installment_property_delivery",
    ],
  ]) {
    it(`${id} is gated on the seller rollup, seeds the per-product flag, and injects rows`, () => {
      const source = readScenario(id);
      assert.match(source, new RegExp(`requires_capability:\\n  path: media_buy\\.features\\.${flag}\\n  equals: true`));
      assert.match(source, new RegExp(`reporting_capabilities:[\\s\\S]*\\n        ${flag}: true`));
      assert.match(source, new RegExp(`\\n            ${rows}:\\n`));
      assert.match(source, new RegExp(`reporting_dimensions:\\n            ${dimension}:`));
      assert.match(source, new RegExp(`by_${dimension}_suppressed`));
      const index = fs.readFileSync(path.join(SCENARIO_DIR, "..", "index.yaml"), "utf8");
      assert.ok(index.includes(`media_buy_seller/${id}`), `${id} must be registered in the media-buy index`);
    });
  }
});
