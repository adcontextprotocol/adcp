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

// Finds the oneOf branch whose `scope` discriminator is pinned to `scopeConst`
// (e.g. "standard" or "vendor") — the shared shape for every hand-maintained
// copy of the (scope, metric_id, qualifier) row.
function findScopeBranch(oneOf, scopeConst) {
  const branch = oneOf.find(
    (entry) => entry.properties && entry.properties.scope && entry.properties.scope.const === scopeConst
  );
  assert.ok(branch, `no oneOf branch found for scope=${scopeConst}`);
  return branch;
}

function keySet(qualifierSchema) {
  assert.ok(qualifierSchema, "qualifier schema missing");
  return Object.keys(qualifierSchema.properties).sort();
}

describe("metric qualifier parity across reporting surfaces", () => {
  const EXPECTED_KEYS = [
    "attribution_methodology",
    "attribution_window",
    "completion_source",
    "lift_dimension",
    "viewability_standard",
  ];

  it("has an identical standard-branch qualifier key set across every hand-maintained copy", () => {
    const committedMetric = readSchema("/schemas/core/committed-metric.json");
    const missingMetric = readSchema("/schemas/core/missing-metric.json");
    const deliveryMetricAggregate = readSchema(
      "/schemas/core/delivery-metric-aggregate.json"
    );
    const performanceFeedbackMetric = readSchema(
      "/schemas/core/performance-feedback-metric.json"
    );
    const performanceFeedback = readSchema("/schemas/core/performance-feedback.json");
    const packageRequest = readSchema("/schemas/media-buy/package-request.json");
    const canonicalMetricQualifier = readSchema(
      "/schemas/core/canonical-metric-qualifier.json"
    );

    const copies = {
      "committed-metric.json (standard)": keySet(
        findScopeBranch(committedMetric.oneOf, "standard").properties.qualifier
      ),
      "missing-metric.json (standard)": keySet(
        findScopeBranch(missingMetric.oneOf, "standard").properties.qualifier
      ),
      "delivery-metric-aggregate.json (standard)": keySet(
        findScopeBranch(deliveryMetricAggregate.oneOf, "standard").properties
          .qualifier
      ),
      "performance-feedback-metric.json (standard)": keySet(
        findScopeBranch(performanceFeedbackMetric.oneOf, "standard").properties
          .qualifier
      ),
      // Inline copy nested under properties.metric.oneOf.
      "performance-feedback.json (metric, standard)": keySet(
        findScopeBranch(performanceFeedback.properties.metric.oneOf, "standard")
          .properties.qualifier
      ),
      // package-request.json's committed_metrics array items carry their own
      // inline (scope, metric_id, qualifier) oneOf under properties.committed_metrics.items.
      "package-request.json (committed_metrics, standard)": keySet(
        findScopeBranch(
          packageRequest.properties.committed_metrics.items.oneOf,
          "standard"
        ).properties.qualifier
      ),
      "canonical-metric-qualifier.json": keySet(canonicalMetricQualifier),
    };

    for (const [label, keys] of Object.entries(copies)) {
      assert.deepEqual(keys, EXPECTED_KEYS, `${label} qualifier key set drifted`);
    }
  });

  it("gives vendor-branch qualifiers the same closed key set as the standard branch", () => {
    const vendorQualifiers = [];
    for (const uri of [
      "/schemas/core/committed-metric.json",
      "/schemas/core/missing-metric.json",
      "/schemas/core/delivery-metric-aggregate.json",
      "/schemas/core/performance-feedback-metric.json",
    ]) {
      const schema = readSchema(uri);
      vendorQualifiers.push([
        uri,
        findScopeBranch(schema.oneOf, "vendor").properties.qualifier,
      ]);
    }
    vendorQualifiers.push([
      "performance-feedback.json (metric, vendor)",
      findScopeBranch(
        readSchema("/schemas/core/performance-feedback.json").properties.metric
          .oneOf,
        "vendor"
      ).properties.qualifier,
    ]);
    vendorQualifiers.push([
      "package-request.json (committed_metrics, vendor)",
      findScopeBranch(
        readSchema("/schemas/media-buy/package-request.json").properties
          .committed_metrics.items.oneOf,
        "vendor"
      ).properties.qualifier,
    ]);
    // The delivery carrier: vendor-metric-value is a flat object, not a
    // scope-discriminated row, but its qualifier joins against the vendor
    // commitment on (vendor, metric_id, qualifier) and must stay in parity.
    vendorQualifiers.push([
      "vendor-metric-value.json",
      readSchema("/schemas/core/vendor-metric-value.json").properties.qualifier,
    ]);

    for (const [label, vendorQualifier] of vendorQualifiers) {
      assert.ok(vendorQualifier, `${label} missing qualifier`);
      assert.deepEqual(
        keySet(vendorQualifier),
        EXPECTED_KEYS,
        `${label} vendor qualifier key set does not match standard`
      );
      assert.equal(
        vendorQualifier.additionalProperties,
        false,
        `${label} vendor qualifier must be closed`
      );
    }
  });

  it("accepts a qualified vendor_metric_values delivery row", async () => {
    const validate = await compile(readSchema("/schemas/core/vendor-metric-value.json"));
    const row = {
      vendor: { domain: "attentionvendor.example" },
      metric_id: "attention_units",
      value: 4.2,
      qualifier: { attribution_window: { interval: 14, unit: "days" } },
    };
    assert.equal(validate(row), true, JSON.stringify(validate.errors));
    assert.equal(
      validate({ ...row, qualifier: { bogus: 1 } }),
      false,
      "unknown qualifier keys must be rejected"
    );
  });

  it("closes every qualifier copy with additionalProperties: false", () => {
    const committedMetric = readSchema("/schemas/core/committed-metric.json");
    const missingMetric = readSchema("/schemas/core/missing-metric.json");
    const deliveryMetricAggregate = readSchema(
      "/schemas/core/delivery-metric-aggregate.json"
    );
    const performanceFeedbackMetric = readSchema(
      "/schemas/core/performance-feedback-metric.json"
    );
    const performanceFeedback = readSchema("/schemas/core/performance-feedback.json");
    const packageRequest = readSchema("/schemas/media-buy/package-request.json");
    const canonicalMetricQualifier = readSchema(
      "/schemas/core/canonical-metric-qualifier.json"
    );

    const closedQualifiers = {
      "committed-metric.json (standard)": findScopeBranch(
        committedMetric.oneOf,
        "standard"
      ).properties.qualifier,
      "committed-metric.json (vendor)": findScopeBranch(
        committedMetric.oneOf,
        "vendor"
      ).properties.qualifier,
      "missing-metric.json (standard)": findScopeBranch(
        missingMetric.oneOf,
        "standard"
      ).properties.qualifier,
      "missing-metric.json (vendor)": findScopeBranch(missingMetric.oneOf, "vendor")
        .properties.qualifier,
      "delivery-metric-aggregate.json (standard)": findScopeBranch(
        deliveryMetricAggregate.oneOf,
        "standard"
      ).properties.qualifier,
      "delivery-metric-aggregate.json (vendor)": findScopeBranch(
        deliveryMetricAggregate.oneOf,
        "vendor"
      ).properties.qualifier,
      "performance-feedback-metric.json (standard)": findScopeBranch(
        performanceFeedbackMetric.oneOf,
        "standard"
      ).properties.qualifier,
      "performance-feedback.json (metric, standard)": findScopeBranch(
        performanceFeedback.properties.metric.oneOf,
        "standard"
      ).properties.qualifier,
      "package-request.json (committed_metrics, standard)": findScopeBranch(
        packageRequest.properties.committed_metrics.items.oneOf,
        "standard"
      ).properties.qualifier,
      "canonical-metric-qualifier.json": canonicalMetricQualifier,
    };

    for (const [label, qualifierSchema] of Object.entries(closedQualifiers)) {
      assert.equal(
        qualifierSchema.additionalProperties,
        false,
        `${label} qualifier must be closed`
      );
    }
  });

  describe("delivery-metric-aggregate vendor qualifier is usable", () => {
    let validateAggregate;

    before(async () => {
      validateAggregate = await compile(
        readSchema("/schemas/core/delivery-metric-aggregate.json")
      );
    });

    it("accepts a vendor row qualified with a structured attribution window", () => {
      const row = {
        scope: "vendor",
        vendor: { domain: "attentionvendor.example" },
        metric_id: "attention_units",
        qualifier: { attribution_window: { interval: 14, unit: "days" } },
        value: 4.2,
      };
      assert.equal(
        validateAggregate(row),
        true,
        JSON.stringify(validateAggregate.errors)
      );
    });

    it("accepts an empty vendor qualifier", () => {
      const row = {
        scope: "vendor",
        vendor: { domain: "attentionvendor.example" },
        metric_id: "attention_units",
        qualifier: {},
        value: 4.2,
      };
      assert.equal(
        validateAggregate(row),
        true,
        JSON.stringify(validateAggregate.errors)
      );
    });

    it("rejects an unknown vendor qualifier key", () => {
      const row = {
        scope: "vendor",
        vendor: { domain: "attentionvendor.example" },
        metric_id: "attention_units",
        qualifier: { bogus: 1 },
        value: 4.2,
      };
      assert.equal(validateAggregate(row), false);
    });
  });
});
