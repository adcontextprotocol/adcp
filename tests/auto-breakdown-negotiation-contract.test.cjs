const fs = require("fs");
const path = require("path");
const Ajv = require("ajv");
const addFormats = require("ajv-formats");
const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

const SCHEMA_ROOT = path.join(__dirname, "..", "static", "schemas", "source");

const AUTO_BREAKDOWN_DIMENSIONS = ["creative", "keyword", "catalog_item"];

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

describe("automatic breakdown negotiation contract (RFC #6623)", () => {
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

  it("accepts an empty object to activate a negotiated creative breakdown", () => {
    assert.equal(
      validateRequest({ reporting_dimensions: { creative: {} } }),
      true,
      JSON.stringify(validateRequest.errors)
    );
  });

  it("accepts creative limit/sort_by/sort_direction together", () => {
    assert.equal(
      validateRequest({
        reporting_dimensions: {
          creative: { limit: 50, sort_by: "quartile_100", sort_direction: "desc" },
        },
      }),
      true,
      JSON.stringify(validateRequest.errors)
    );
  });

  it("accepts keyword with only limit", () => {
    assert.equal(
      validateRequest({
        reporting_dimensions: { keyword: { limit: 10 } },
      }),
      true,
      JSON.stringify(validateRequest.errors)
    );
  });

  it("accepts catalog_item with only sort_by", () => {
    assert.equal(
      validateRequest({
        reporting_dimensions: { catalog_item: { sort_by: "units_sold" } },
      }),
      true,
      JSON.stringify(validateRequest.errors)
    );
  });

  it("rejects a limit below the minimum", () => {
    assert.equal(
      validateRequest({
        reporting_dimensions: { creative: { limit: 0 } },
      }),
      false
    );
  });

  for (const dimension of AUTO_BREAKDOWN_DIMENSIONS) {
    it(`request schema declares limit, sort_by, and sort_direction for ${dimension}`, () => {
      const dimensionSchema =
        requestJson.properties.reporting_dimensions.properties[dimension];
      assert.ok(dimensionSchema, `missing dimension schema for ${dimension}`);
      assert.ok(dimensionSchema.properties.limit, `missing limit for ${dimension}`);
      assert.equal(dimensionSchema.properties.limit.type, "integer");
      assert.equal(dimensionSchema.properties.limit.minimum, 1);
      assert.equal(dimensionSchema.properties.limit.default, undefined);
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

  for (const dimension of AUTO_BREAKDOWN_DIMENSIONS) {
    it(`response validates the ${dimension} truncation flag and applied-sort echo`, () => {
      const truncatedField = `by_${dimension}_truncated`;
      const sortedByField = `by_${dimension}_sorted_by`;
      const sortDirectionField = `by_${dimension}_sort_direction`;
      const properties = byPackageExtension.properties;

      assert.ok(properties[truncatedField], `missing ${truncatedField}`);
      assert.ok(properties[sortedByField], `missing ${sortedByField}`);
      assert.ok(properties[sortDirectionField], `missing ${sortDirectionField}`);

      assert.equal(
        validateByPackage({
          ...BASE_PACKAGE,
          [truncatedField]: false,
          [sortedByField]: "spend",
          [sortDirectionField]: "desc",
        }),
        true,
        JSON.stringify(validateByPackage.errors)
      );

      assert.equal(
        validateByPackage({
          ...BASE_PACKAGE,
          [truncatedField]: "false",
        }),
        false
      );

      assert.match(
        properties[truncatedField].description,
        /MUST return this flag whenever by_.+ is present and the request included/
      );
    });
  }

  it("the reporting_dimensions container no longer claims these dimensions are uncontrolled", () => {
    const requestPath = path.join(
      SCHEMA_ROOT,
      "media-buy",
      "get-media-buy-delivery-request.json"
    );
    const raw = fs.readFileSync(requestPath, "utf8");
    assert.doesNotMatch(raw, /not controlled by this object/);
  });
});
