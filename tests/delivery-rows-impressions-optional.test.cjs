const fs = require("fs");
const path = require("path");
const Ajv = require("ajv");
const addFormats = require("ajv-formats");
const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

const SCHEMA_ROOT = path.join(__dirname, "..", "static", "schemas", "source");

function readSchema(uri) {
  assert.match(uri, /^\/schemas\//);
  return JSON.parse(
    fs.readFileSync(path.join(SCHEMA_ROOT, uri.slice("/schemas/".length)), "utf8")
  );
}

async function compile(schema) {
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    loadSchema: async (ref) => readSchema(ref),
  });
  addFormats(ajv);
  return ajv.compileAsync(schema);
}

const COLLECTION_REF = { publisher_domain: "example.com", collection_id: "show_1" };
const PLACEMENT_IDENTITY = {
  kind: "publisher_ref",
  publisher_domain: "example.com",
  placement_id: "plc_1",
};
const PROPERTY = {
  publisher_domain: "example.com",
  identifier: { type: "domain", value: "example.com" },
};
const INSTALLMENT_REF = { collection_ref: COLLECTION_REF, installment_id: "ep_1" };

// Standalone row schemas. `identity` lists the keys that must stay required.
const ROW_SCHEMAS = [
  ["installment-delivery-metrics", { installment_ref: INSTALLMENT_REF }],
  ["installment-property-delivery-metrics", { installment_ref: INSTALLMENT_REF, ...PROPERTY }],
  ["collection-delivery-metrics", { collection_ref: COLLECTION_REF }],
  ["collection-property-delivery-metrics", { collection_ref: COLLECTION_REF, ...PROPERTY }],
  ["placement-delivery-metrics", { placement_id: "plc_1" }],
  [
    "placement-property-delivery-metrics",
    { placement_id: "plc_1", placement_identity: PLACEMENT_IDENTITY, ...PROPERTY },
  ],
  ["property-delivery-metrics", { ...PROPERTY }],
  ["geo-delivery-metrics", { geo_level: "country", geo_code: "US" }],
  ["keyword-delivery-metrics", { keyword: "running shoes", match_type: "exact" }],
  ["creative-delivery-metrics", { creative_id: "cr_1" }],
  ["catalog-item-delivery-metrics", { content_id: "sku_1" }],
].map(([name, identity]) => ({
  name,
  identity,
  schema: () => readSchema(`/schemas/core/${name}.json`),
}));

// Inline rows in get-media-buy-delivery-response.json.
const BY_PACKAGE = (r) =>
  r.properties.media_buy_deliveries.items.properties.by_package.items;
const byPackageProps = (r) =>
  BY_PACKAGE(r).allOf.find((s) => s.properties).properties;
const INLINE_ROWS = [
  [
    "media_buy_deliveries[].daily_breakdown",
    (r) => r.properties.media_buy_deliveries.items.properties.daily_breakdown.items,
    { date: "2026-09-01" },
  ],
  [
    "by_package[].daily_breakdown",
    (r) => byPackageProps(r).daily_breakdown.items,
    { date: "2026-09-01" },
  ],
  [
    "by_package[].by_format",
    (r) => byPackageProps(r).by_format.items,
    { format_kind: "video_hosted" },
  ],
  [
    "by_package[].by_device_type",
    (r) => byPackageProps(r).by_device_type.items,
    { device_type: "mobile" },
  ],
  [
    "by_package[].by_device_platform",
    (r) => byPackageProps(r).by_device_platform.items,
    { device_platform: "ios" },
  ],
  [
    "by_package[].by_audience",
    (r) => byPackageProps(r).by_audience.items,
    { audience_id: "aud_1", audience_source: "synced" },
  ],
  [
    "by_package[].by_demographic",
    (r) => byPackageProps(r).by_demographic.items,
    { demographic: "P25-54", demographic_system: "nielsen" },
  ],
].map(([name, pick, identity]) => ({ name, pick, identity }));

function assertRowContract({ name, validate, identity }) {
  const full = { ...identity, impressions: 1000, spend: 25 };
  assert.equal(validate(full), true, `${name} with impressions: ${JSON.stringify(validate.errors)}`);

  const { impressions: _omitted, ...withoutImpressions } = full;
  assert.equal(
    validate(withoutImpressions),
    true,
    `${name} must validate without impressions: ${JSON.stringify(validate.errors)}`
  );

  const { spend: _spend, ...withoutSpend } = full;
  assert.equal(validate(withoutSpend), false, `${name} must still require spend`);

  for (const key of Object.keys(identity)) {
    const { [key]: _key, ...withoutKey } = full;
    assert.equal(validate(withoutKey), false, `${name} must still require ${key}`);
  }
}

describe("delivery rows may omit impressions (#8089)", () => {
  let response;
  const inlineValidators = new Map();
  const rowValidators = new Map();

  before(async () => {
    response = readSchema("/schemas/media-buy/get-media-buy-delivery-response.json");
    for (const row of INLINE_ROWS) {
      inlineValidators.set(row.name, await compile(row.pick(response)));
    }
    for (const row of ROW_SCHEMAS) {
      rowValidators.set(row.name, await compile(row.schema()));
    }
  });

  for (const row of ROW_SCHEMAS) {
    it(`${row.name} validates without impressions and keeps identity and spend required`, () => {
      assertRowContract({
        name: row.name,
        validate: rowValidators.get(row.name),
        identity: row.identity,
      });
    });
  }

  for (const row of INLINE_ROWS) {
    it(`${row.name} validates without impressions and keeps identity and spend required`, () => {
      assertRowContract({
        name: row.name,
        validate: inlineValidators.get(row.name),
        identity: row.identity,
      });
    });
  }

  it("points the by_package dimension arrays at the standalone row schemas", () => {
    const props = byPackageProps(response);
    for (const [field, schema] of [
      ["by_geo", "geo-delivery-metrics"],
      ["by_keyword", "keyword-delivery-metrics"],
      ["by_creative", "creative-delivery-metrics"],
      ["by_catalog_item", "catalog-item-delivery-metrics"],
      ["by_placement", "placement-delivery-metrics"],
      ["by_property", "property-delivery-metrics"],
      ["by_collection", "collection-delivery-metrics"],
      ["by_installment", "installment-delivery-metrics"],
      ["by_placement_property", "placement-property-delivery-metrics"],
      ["by_collection_property", "collection-property-delivery-metrics"],
      ["by_installment_property", "installment-property-delivery-metrics"],
    ]) {
      assert.equal(props[field].items.$ref, `/schemas/core/${schema}.json`, field);
    }
  });

  it("keeps aggregated_totals requiring impressions", async () => {
    const aggregated = response.properties.aggregated_totals;
    assert.ok(aggregated.required.includes("impressions"));
    const validate = await compile(aggregated);
    assert.equal(validate({ spend: 10, media_buy_count: 1 }), false);
    assert.equal(validate({ impressions: 5, spend: 10, media_buy_count: 1 }), true);
  });

  it("states the absence and no-substitution rules once, on impressions", () => {
    const description = readSchema("/schemas/core/delivery-metrics.json").properties
      .impressions.description;
    assert.match(description, /not mean zero/);
    assert.match(description, /MUST NOT treat absence as zero/);
    assert.match(description, /MUST NOT put views, plays, downloads/);
    assert.match(description, /pinned below AdCP 3\.3/);
    assert.match(description, /no declared pin is treated as pinned below 3\.3/);
  });
});
