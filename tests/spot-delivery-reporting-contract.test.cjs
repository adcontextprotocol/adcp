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
  let validateCapabilities;
  let spotSchema;

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
    spotSchema = byPackageExtension.properties.by_spot.items;

    [validateRequest, validateSpot, validateCapabilities] = await Promise.all([
      compile(request),
      compile(spotSchema),
      compile(readSchema("/schemas/core/reporting-capabilities.json")),
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
        spot_id: "spot_tv_001",
        creative_id: "creative_tv_30s",
        aired_at: "2026-08-15T20:14:00Z",
        network: "USA Network",
        station: "WABC-TV",
        daypart: "prime_time",
        impressions: 40000,
        spend: 1250,
      },
      {
        spot_id: "spot_radio_001",
        aired_at: "2026-08-15T07:30:00Z",
        station: "WNYC-FM",
        daypart: "morning_drive",
        impressions: 18000,
      },
    ]) {
      assert.equal(validateSpot(row), true, JSON.stringify(validateSpot.errors));
    }
  });

  it("optionally identifies the creative aired in each spot occurrence", () => {
    const spotFields = spotSchema.allOf.find(
      (schema) => schema.properties
    ).properties;
    assert.equal(spotFields.creative_id["x-entity"], "creative");

    const airing = {
      spot_id: "spot_rotation_001",
      creative_id: "creative_rotation_a",
      aired_at: "2026-08-15T20:14:00Z",
    };
    assert.equal(validateSpot(airing), true, JSON.stringify(validateSpot.errors));
    assert.equal(
      validateSpot({ ...airing, creative_id: "" }),
      false,
      "creative identity cannot be empty"
    );
    delete airing.creative_id;
    assert.equal(validateSpot(airing), true, "creative identity remains optional");
  });

  it("requires stable identity and an RFC 3339 airing timestamp, not impressions", () => {
    const asRunOnly = {
      spot_id: "spot_live_001",
      aired_at: "2026-08-15T20:14:00Z",
    };
    assert.equal(
      validateSpot(asRunOnly),
      true,
      JSON.stringify(validateSpot.errors)
    );
    assert.equal(
      validateSpot({ ...asRunOnly, impressions: 0 }),
      true,
      "measured zero is explicit"
    );
    assert.equal(
      validateSpot({ ...asRunOnly, impressions: null }),
      false,
      "unavailable is omitted, not null"
    );
    assert.equal(validateSpot({ spot_id: "spot_bad", aired_at: "not-a-time" }), false);
    assert.equal(validateSpot({ aired_at: "2026-08-15T20:14:00Z" }), false);
    assert.equal(validateSpot({ spot_id: "spot_missing_time" }), false);
  });

  it("advertises spot support on both reporting capability surfaces", () => {
    for (const uri of [
      "/schemas/core/reporting-capabilities.json",
      "/schemas/core/canonical-reporting-capabilities.json",
    ]) {
      const schema = readSchema(uri);
      assert.equal(
        schema.properties.supports_spot_breakdown.$ref,
        "/schemas/core/spot-reporting-capability.json",
        uri
      );
    }

    const capabilities = {
      available_reporting_frequencies: ["daily"],
      expected_delay_minutes: 60,
      timezone: "UTC",
      supports_webhooks: true,
      available_metrics: ["impressions", "spend"],
      date_range_support: "date_range",
      supports_spot_breakdown: { available_metrics: ["impressions"] },
    };
    assert.equal(
      validateCapabilities(capabilities),
      true,
      JSON.stringify(validateCapabilities.errors)
    );
    capabilities.supports_spot_breakdown.available_metrics = [];
    assert.equal(
      validateCapabilities(capabilities),
      true,
      "airing-only reporting is explicit"
    );
  });
});
