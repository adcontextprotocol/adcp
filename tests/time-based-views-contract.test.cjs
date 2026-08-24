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

describe("time-based video view metrics", () => {
  let validateDeliveryMetrics;
  let availableMetric;
  let sortMetric;
  let deliveryMetrics;
  let viewThresholdBasis;

  before(async () => {
    deliveryMetrics = readSchema("/schemas/core/delivery-metrics.json");
    availableMetric = readSchema("/schemas/enums/available-metric.json");
    sortMetric = readSchema("/schemas/enums/sort-metric.json");
    viewThresholdBasis = readSchema("/schemas/enums/view-threshold-basis.json");

    validateDeliveryMetrics = await compile(deliveryMetrics);
  });

  it("accepts time_based_views entries for both bases", () => {
    const value = {
      time_based_views: [
        { threshold_seconds: 2, basis: "play_time", views: 100 },
        { threshold_seconds: 2, basis: "in_view", views: 60 },
      ],
    };
    assert.equal(
      validateDeliveryMetrics(value),
      true,
      JSON.stringify(validateDeliveryMetrics.errors)
    );
  });

  it("rejects an entry missing basis", () => {
    assert.equal(
      validateDeliveryMetrics({
        time_based_views: [{ threshold_seconds: 2, views: 100 }],
      }),
      false
    );
  });

  it("rejects threshold_seconds of 0", () => {
    assert.equal(
      validateDeliveryMetrics({
        time_based_views: [
          { threshold_seconds: 0, basis: "play_time", views: 100 },
        ],
      }),
      false
    );
  });

  it("rejects negative views", () => {
    assert.equal(
      validateDeliveryMetrics({
        time_based_views: [
          { threshold_seconds: 2, basis: "play_time", views: -1 },
        ],
      }),
      false
    );
  });

  it("rejects an unknown basis value", () => {
    assert.equal(
      validateDeliveryMetrics({
        time_based_views: [
          { threshold_seconds: 2, basis: "viewable", views: 100 },
        ],
      }),
      false
    );
  });

  it("is in available-metric.json's enum and not in sort-metric.json's enum", () => {
    assert.ok(availableMetric.enum.includes("time_based_views"));
    assert.ok(!sortMetric.enum.includes("time_based_views"));
  });

  it("documents the de-duplication and non-summability contracts", () => {
    const timeBasedViews = deliveryMetrics.properties.time_based_views;
    assert.match(
      timeBasedViews.description,
      /MUST NOT emit the same pair twice/
    );
    assert.match(viewThresholdBasis.description, /MUST NOT be summed/);
  });
});
