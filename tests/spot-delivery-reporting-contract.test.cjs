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

describe("spot-level as-run delivery reporting", () => {
  let validateRequest;
  let validateSpot;

  before(async () => {
    const request = readSchema(
      "/schemas/media-buy/get-media-buy-delivery-request.json"
    );
    const response = readSchema(
      "/schemas/media-buy/get-media-buy-delivery-response.json"
    );
    const byPackage =
      response.properties.media_buy_deliveries.items.properties.by_package.items;
    const byPackageExtension = byPackage.allOf.find(
      (schema) => schema.properties
    );

    [validateRequest, validateSpot] = await Promise.all([
      compile(request),
      compile(byPackageExtension.properties.by_spot.items),
    ]);
  });

  it("accepts an opt-in complete spot log request and rejects invalid limits", () => {
    assert.equal(validateRequest({ reporting_dimensions: { spot: {} } }), true);
    assert.equal(
      validateRequest({ reporting_dimensions: { spot: { limit: 100 } } }),
      true
    );
    assert.equal(
      validateRequest({ reporting_dimensions: { spot: { limit: 0 } } }),
      false
    );
  });

  it("uses one channel-neutral row shape for TV and radio airings", () => {
    for (const row of [
      {
        aired_at: "2026-08-15T20:14:00Z",
        network: "USA Network",
        station: "WABC-TV",
        daypart: "prime_time",
        impressions: 40000,
        spend: 1250,
      },
      {
        aired_at: "2026-08-15T07:30:00Z",
        station: "WNYC-FM",
        daypart: "morning_drive",
        impressions: 18000,
      },
    ]) {
      assert.equal(validateSpot(row), true, JSON.stringify(validateSpot.errors));
    }
  });

  it("requires an RFC 3339 airing timestamp and impressions", () => {
    assert.equal(validateSpot({ aired_at: "2026-08-15T20:14:00Z" }), false);
    assert.equal(validateSpot({ aired_at: "not-a-time", impressions: 1 }), false);
    assert.equal(validateSpot({ impressions: 1 }), false);
  });

  it("advertises spot support on both reporting capability surfaces", () => {
    for (const uri of [
      "/schemas/core/reporting-capabilities.json",
      "/schemas/core/canonical-reporting-capabilities.json",
    ]) {
      const schema = readSchema(uri);
      assert.equal(
        schema.properties.supports_spot_breakdown.type,
        "boolean",
        uri
      );
    }
  });
});
