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

describe("requested_metrics contract (get_media_buy_delivery)", () => {
  let validateRequest;
  let requestJson;
  let responseJson;
  let webhookJson;

  before(async () => {
    requestJson = readSchema(
      "/schemas/media-buy/get-media-buy-delivery-request.json"
    );
    responseJson = readSchema(
      "/schemas/media-buy/get-media-buy-delivery-response.json"
    );
    webhookJson = readSchema("/schemas/core/reporting-webhook.json");

    validateRequest = await compile(requestJson);
  });

  it("accepts a valid requested_metrics list of standard metrics", () => {
    assert.equal(
      validateRequest({
        requested_metrics: ["impressions", "spend", "quartile_100"],
      }),
      true,
      JSON.stringify(validateRequest.errors)
    );
  });

  it("accepts a requested_metrics list containing a leaf metric identity", () => {
    assert.equal(
      validateRequest({ requested_metrics: ["viewable_rate"] }),
      true,
      JSON.stringify(validateRequest.errors)
    );
  });

  it("rejects an empty requested_metrics array (minItems)", () => {
    assert.equal(validateRequest({ requested_metrics: [] }), false);
  });

  it("rejects a requested_metrics value outside the available-metric enum", () => {
    assert.equal(
      validateRequest({ requested_metrics: ["bogus_metric"] }),
      false
    );
  });

  it("rejects duplicate entries in requested_metrics (uniqueItems)", () => {
    assert.equal(
      validateRequest({ requested_metrics: ["clicks", "clicks"] }),
      false
    );
  });

  it("request field description states impressions and spend are always included", () => {
    assert.match(
      requestJson.properties.requested_metrics.description,
      /impressions and spend are always included/
    );
  });

  it("response missing_metrics description states requested_metrics narrowing MUST NOT be flagged", () => {
    const missingMetricsDescription =
      responseJson.properties.media_buy_deliveries.items.properties.by_package
        .items.allOf[1].properties.missing_metrics.description;

    assert.match(
      missingMetricsDescription,
      /MUST NOT list a committed metric here solely because the buyer excluded it/
    );
  });

  it("reporting_webhook still declares requested_metrics with available-metric items (parity guard)", () => {
    const webhookField = webhookJson.properties.requested_metrics;
    assert.ok(webhookField, "reporting-webhook.json is missing requested_metrics");
    assert.equal(webhookField.type, "array");
    assert.equal(
      webhookField.items.$ref,
      "/schemas/enums/available-metric.json"
    );
  });
});
