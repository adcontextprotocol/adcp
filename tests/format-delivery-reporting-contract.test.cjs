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

describe("canonical format delivery reporting", () => {
  let validateRequest;
  let validateFormatRow;
  let validateCapabilities;

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

    [validateRequest, validateFormatRow, validateCapabilities] =
      await Promise.all([
        compile(request),
        compile(byPackageExtension.properties.by_format.items),
        compile(readSchema("/schemas/core/reporting-capabilities.json")),
      ]);
  });

  it("accepts an opt-in format breakdown request and rejects invalid limits", () => {
    assert.equal(validateRequest({ reporting_dimensions: { format: {} } }), true);
    assert.equal(
      validateRequest({
        reporting_dimensions: {
          format: { limit: 10, sort_by: "impressions" },
        },
      }),
      true,
      JSON.stringify(validateRequest.errors)
    );
    assert.equal(
      validateRequest({ reporting_dimensions: { format: { limit: 0 } } }),
      false
    );
  });

  it("requires canonical format identity plus impressions and spend", () => {
    for (const row of [
      { format_kind: "video_hosted", impressions: 40000, spend: 1250 },
      { format_kind: "image", impressions: 18000, spend: 450 },
      { format_kind: "custom", impressions: 1200, spend: 90 },
    ]) {
      assert.equal(
        validateFormatRow(row),
        true,
        JSON.stringify(validateFormatRow.errors)
      );
    }

    assert.equal(
      validateFormatRow({ format_kind: "video", impressions: 10, spend: 1 }),
      false,
      "format rows use canonical format_kind rather than a coarse media family"
    );
    assert.equal(
      validateFormatRow({ format_kind: "image", impressions: 10 }),
      false,
      "spend is required"
    );
  });

  it("advertises format support on both reporting capability surfaces", () => {
    for (const uri of [
      "/schemas/core/reporting-capabilities.json",
      "/schemas/core/canonical-reporting-capabilities.json",
    ]) {
      const schema = readSchema(uri);
      assert.equal(
        schema.properties.supports_format_breakdown.type,
        "boolean",
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
      supports_format_breakdown: true,
    };
    assert.equal(
      validateCapabilities(capabilities),
      true,
      JSON.stringify(validateCapabilities.errors)
    );
  });
});
