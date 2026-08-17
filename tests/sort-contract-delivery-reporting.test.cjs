const fs = require("fs");
const path = require("path");
const Ajv = require("ajv");
const addFormats = require("ajv-formats");
const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

const SCHEMA_ROOT = path.join(__dirname, "..", "static", "schemas", "source");

const SORTABLE_DIMENSIONS = [
  "geo",
  "device_type",
  "device_platform",
  "audience",
  "demographic",
  "placement",
];

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

const BASE_PACKAGE = {
  package_id: "pkg_1",
  spend: 100,
  pricing_model: "cpm",
  rate: 12.5,
  currency: "USD",
};

describe("delivery reporting sort contract", () => {
  let validateRequest;
  let validateByPackage;
  let requestJson;
  let byPackageExtension;

  before(async () => {
    requestJson = readSchema(
      "/schemas/media-buy/get-media-buy-delivery-request.json"
    );
    const response = readSchema(
      "/schemas/media-buy/get-media-buy-delivery-response.json"
    );
    const byPackage =
      response.properties.media_buy_deliveries.items.properties.by_package.items;
    byPackageExtension = byPackage.allOf.find((schema) => schema.properties);

    [validateRequest, validateByPackage] = await Promise.all([
      compile(requestJson),
      compile(byPackage),
    ]);
  });

  it("accepts sort_direction on a breakdown request and rejects an invalid value", () => {
    // viewable_rate is a leaf metric identity resolving to
    // viewability.viewable_rate — the canonical bottom-N optimization query.
    assert.equal(
      validateRequest({
        reporting_dimensions: {
          placement: { sort_by: "viewable_rate", sort_direction: "asc" },
        },
      }),
      true,
      JSON.stringify(validateRequest.errors)
    );
    assert.equal(
      validateRequest({
        reporting_dimensions: {
          placement: { sort_by: "viewable_rate", sort_direction: "ascending" },
        },
      }),
      false
    );
  });

  for (const dimension of SORTABLE_DIMENSIONS) {
    it(`request schema declares both sort_by and sort_direction for ${dimension}`, () => {
      const dimensionSchema =
        requestJson.properties.reporting_dimensions.properties[dimension];
      assert.ok(dimensionSchema, `missing dimension schema for ${dimension}`);
      assert.equal(
        dimensionSchema.properties.sort_by.$ref,
        "/schemas/enums/sort-metric.json"
      );
      assert.equal(
        dimensionSchema.properties.sort_direction.$ref,
        "/schemas/enums/sort-direction.json"
      );
    });
  }

  for (const dimension of SORTABLE_DIMENSIONS) {
    it(`response echoes the applied sort for by_${dimension}`, () => {
      const sortedByField = `by_${dimension}_sorted_by`;
      const sortDirectionField = `by_${dimension}_sort_direction`;
      const properties = byPackageExtension.properties;

      assert.ok(properties[sortedByField], `missing ${sortedByField}`);
      assert.ok(properties[sortDirectionField], `missing ${sortDirectionField}`);

      assert.equal(
        validateByPackage({
          ...BASE_PACKAGE,
          [sortedByField]: "spend",
          [sortDirectionField]: "desc",
        }),
        true,
        JSON.stringify(validateByPackage.errors)
      );

      assert.equal(
        validateByPackage({
          ...BASE_PACKAGE,
          [sortedByField]: "spend",
          [sortDirectionField]: true,
        }),
        false
      );

      assert.match(
        properties[sortedByField].description,
        /MUST return this field whenever by_.+ is present/
      );
    });
  }

  it("spot has neither sort_by nor sort_direction", () => {
    const spotSchema =
      requestJson.properties.reporting_dimensions.properties.spot;
    assert.ok(spotSchema, "missing spot dimension schema");
    assert.equal(spotSchema.properties.sort_by, undefined);
    assert.equal(spotSchema.properties.sort_direction, undefined);
  });
});
