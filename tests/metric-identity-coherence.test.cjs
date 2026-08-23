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

// Leaf metric identities address one numeric value nested inside an
// object-shaped delivery metric. The nested object stays the canonical
// carrier; the identity exists so commitments, aggregates, and sorts can
// reference the single value.
const LEAF_IDENTITIES = {
  quartile_25: ["quartile_data", "q1_views"],
  quartile_50: ["quartile_data", "q2_views"],
  quartile_75: ["quartile_data", "q3_views"],
  quartile_100: ["quartile_data", "q4_views"],
  viewable_rate: ["viewability", "viewable_rate"],
  viewable_impressions: ["viewability", "viewable_impressions"],
  measurable_impressions: ["viewability", "measurable_impressions"],
  viewed_seconds: ["viewability", "viewed_seconds"],
};

const STRUCTURED_IDENTITIES = {
  viewed_seconds_percentiles: ["viewability", "viewed_seconds_percentiles", "object"],
  viewed_seconds_histogram: ["viewability", "viewed_seconds_histogram", "array"],
};

// Package-grain survey/model-based estimates: reportable and committable,
// but excluded from row sorting per sort-metric.json's description.
const SORT_EXCLUDED_LIFT_METRICS = [
  "incremental_sales_lift",
  "brand_lift",
  "foot_traffic",
  "conversion_lift",
  "brand_search_lift",
];

describe("metric identity coherence", () => {
  let deliveryMetrics;
  let availableMetrics;
  let sortMetrics;

  before(() => {
    deliveryMetrics = readSchema("/schemas/core/delivery-metrics.json");
    availableMetrics = new Set(readSchema("/schemas/enums/available-metric.json").enum);
    sortMetrics = new Set(readSchema("/schemas/enums/sort-metric.json").enum);
  });

  function flatNumericDeliveryMetrics() {
    return Object.entries(deliveryMetrics.properties)
      .filter(([, schema]) => {
        const types = Array.isArray(schema.type) ? schema.type : [schema.type];
        return types.includes("number") || types.includes("integer");
      })
      .map(([name]) => name);
  }

  it("declares every flat numeric delivery metric in available-metric", () => {
    for (const name of flatNumericDeliveryMetrics()) {
      assert.ok(availableMetrics.has(name), `${name} missing from available-metric.json`);
    }
  });

  it("makes every flat numeric delivery metric sortable except lift estimates", () => {
    for (const name of flatNumericDeliveryMetrics()) {
      if (SORT_EXCLUDED_LIFT_METRICS.includes(name)) {
        assert.ok(
          !sortMetrics.has(name),
          `${name} is documented as sort-excluded but present in sort-metric.json`
        );
        continue;
      }
      assert.ok(sortMetrics.has(name), `${name} missing from sort-metric.json`);
    }
  });

  it("keeps sort-metric a subset of available-metric", () => {
    for (const name of sortMetrics) {
      assert.ok(availableMetrics.has(name), `${name} sortable but not declarable`);
    }
  });

  it("resolves every leaf identity to an existing nested numeric value", () => {
    for (const [leaf, [container, field]] of Object.entries(LEAF_IDENTITIES)) {
      assert.ok(availableMetrics.has(leaf), `${leaf} missing from available-metric.json`);
      assert.ok(sortMetrics.has(leaf), `${leaf} missing from sort-metric.json`);
      const nested = deliveryMetrics.properties[container];
      assert.ok(nested, `${container} missing from delivery-metrics.json`);
      const target = nested.properties[field];
      assert.ok(target, `${container}.${field} missing from delivery-metrics.json`);
      const types = Array.isArray(target.type) ? target.type : [target.type];
      assert.ok(
        types.includes("number") || types.includes("integer"),
        `${container}.${field} is not numeric`
      );
      // No duplicate flat field: the leaf identity must not also exist as a
      // top-level delivery-metrics property (the nested value is canonical).
      assert.equal(
        deliveryMetrics.properties[leaf],
        undefined,
        `${leaf} must not exist as a flat delivery-metrics field`
      );
    }
  });

  it("resolves structured identities without making them sortable or flat", () => {
    for (const [identity, [container, field, type]] of Object.entries(STRUCTURED_IDENTITIES)) {
      assert.ok(availableMetrics.has(identity), `${identity} missing from available-metric.json`);
      assert.ok(!sortMetrics.has(identity), `${identity} must not be sortable`);
      const target = deliveryMetrics.properties[container]?.properties?.[field];
      assert.equal(target?.type, type, `${container}.${field} must be a nested ${type}`);
      assert.equal(
        deliveryMetrics.properties[identity],
        undefined,
        `${identity} must not exist as a flat delivery-metrics field`
      );
    }
  });

  it("validates viewed-seconds distributions at the same reporting grain", async () => {
    const validate = await compile(deliveryMetrics);
    const valid = {
      viewability: {
        measurable_impressions: 100,
        viewed_seconds: 4.25,
        viewed_seconds_percentiles: {
          p25: 1,
          p50: 2.5,
          p75: 5,
          p90: 9,
          p95: 12,
        },
        viewed_seconds_histogram: [
          { lower_bound_seconds: 0, upper_bound_seconds: 1, impressions: 20 },
          { lower_bound_seconds: 1, upper_bound_seconds: 5, impressions: 55 },
          { lower_bound_seconds: 5, impressions: 25 },
        ],
        standard: "mrc",
      },
    };
    assert.equal(validate(valid), true, JSON.stringify(validate.errors));

    assert.equal(
      validate({
        viewability: {
          measurable_impressions: 100,
          viewed_seconds_percentiles: valid.viewability.viewed_seconds_percentiles,
        },
      }),
      false,
      "percentiles without viewed_seconds must be rejected"
    );
    assert.equal(
      validate({
        viewability: {
          viewed_seconds: 4.25,
          viewed_seconds_histogram: valid.viewability.viewed_seconds_histogram,
        },
      }),
      false,
      "histogram without measurable_impressions must be rejected"
    );
    assert.equal(
      validate({
        viewability: {
          measurable_impressions: 100,
          viewed_seconds: 4.25,
          viewed_seconds_percentiles: { p25: 1, p50: 2.5, p75: 5, p90: 9 },
        },
      }),
      false,
      "partial percentile summaries must be rejected"
    );
  });

  it("only conditions delivery-metric-aggregate on representable metric_ids", () => {
    const aggregate = readSchema("/schemas/core/delivery-metric-aggregate.json");
    const standardBranch = aggregate.oneOf.find(
      (branch) =>
        branch.properties &&
        branch.properties.scope &&
        branch.properties.scope.const === "standard"
    );
    assert.ok(standardBranch, "no standard-scope branch in delivery-metric-aggregate");
    for (const conditional of standardBranch.allOf) {
      const metricId = conditional.if.properties.metric_id.const;
      assert.ok(
        availableMetrics.has(metricId),
        `delivery-metric-aggregate conditions on unrepresentable metric_id ${metricId}`
      );
    }
  });

  it("validates the shipped committed_metrics example against its own schema", async () => {
    const validate = await compile(readSchema("/schemas/core/committed-metric.json"));
    const pkg = readSchema("/schemas/core/package.json");
    const example = pkg.properties.committed_metrics.examples[0];
    for (const entry of example) {
      assert.equal(
        validate(entry),
        true,
        `${JSON.stringify(entry)} -> ${JSON.stringify(validate.errors)}`
      );
    }
  });

  it("validates the shipped metric_aggregates example against its own schema", async () => {
    const validate = await compile(
      readSchema("/schemas/core/delivery-metric-aggregate.json")
    );
    const response = readSchema(
      "/schemas/media-buy/get-media-buy-delivery-response.json"
    );
    const example =
      response.properties.aggregated_totals.properties.metric_aggregates.examples[0];
    for (const entry of example) {
      assert.equal(
        validate(entry),
        true,
        `${JSON.stringify(entry)} -> ${JSON.stringify(validate.errors)}`
      );
    }
  });
});
