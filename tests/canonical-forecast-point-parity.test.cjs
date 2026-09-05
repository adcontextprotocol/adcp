const fs = require("fs");
const path = require("path");
const Ajv = require("ajv");
const addFormats = require("ajv-formats");
const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const { isDeepStrictEqual } = require("node:util");

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

function withoutAnnotations(value) {
  if (Array.isArray(value)) {
    return value.map(withoutAnnotations);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !["description", "examples", "title"].includes(key))
        .map(([key, child]) => [key, withoutAnnotations(child)])
    );
  }
  return value;
}

function resolvedSemantics(propertySchema) {
  const normalized = withoutAnnotations(propertySchema);
  if (normalized.$ref && Object.keys(normalized).length === 1) {
    const { $schema, $id, ...referenced } = withoutAnnotations(readSchema(normalized.$ref));
    assert.ok($schema, `${normalized.$ref} missing $schema`);
    assert.ok($id, `${normalized.$ref} missing $id`);
    return referenced;
  }
  return normalized;
}

function exceptionalMetricProperties(metricSchema) {
  const fallback = resolvedSemantics(metricSchema.additionalProperties);
  return Object.fromEntries(
    Object.entries(metricSchema.properties).filter(
      ([, propertySchema]) =>
        !isDeepStrictEqual(resolvedSemantics(propertySchema), fallback)
    )
  );
}

// Extracts the {low, mid, high} maximum bounds from the compact
// allOf: [{$ref: forecast-range}, {properties: {...maximum...}}] pattern.
function rangeBounds(propertySchema, label) {
  assert.ok(propertySchema, `${label} missing`);
  propertySchema = resolvedSemantics(propertySchema);
  assert.ok(Array.isArray(propertySchema.allOf), `${label} lacks the bounded allOf pattern`);
  const constraint = propertySchema.allOf.find((entry) => entry.properties);
  assert.ok(constraint, `${label} allOf carries no constraint branch`);
  return ["low", "mid", "high"].map((key) => constraint.properties[key]?.maximum);
}

describe("canonical-forecast-point parity with forecast-point", () => {
  let source;
  let canonical;

  before(() => {
    source = readSchema("/schemas/core/forecast-point.json");
    canonical = readSchema("/schemas/core/canonical-forecast-point.json");
  });

  it("keeps exceptional metric constraints aligned while remaining compact", () => {
    const sourceMetrics = source.properties.metrics;
    const canonicalMetrics = canonical.properties.metrics;
    const exceptionalSourceProperties = exceptionalMetricProperties(sourceMetrics);

    assert.deepEqual(
      withoutAnnotations(canonicalMetrics.additionalProperties),
      withoutAnnotations(sourceMetrics.additionalProperties),
      "canonical metric fallback drifted from source"
    );
    assert.deepEqual(
      Object.keys(canonicalMetrics.properties).sort(),
      Object.keys(exceptionalSourceProperties).sort(),
      "canonical metrics must name every source metric with constraints beyond the fallback"
    );
    for (const [name, propertySchema] of Object.entries(exceptionalSourceProperties)) {
      assert.deepEqual(
        resolvedSemantics(canonicalMetrics.properties[name]),
        resolvedSemantics(propertySchema),
        `canonical metric ${name} drifted from source`
      );
    }
  });

  it("keeps viewability property schemas aligned (vendor identity differs by design)", () => {
    const sourceProperties = source.properties.viewability.properties;
    const canonicalProperties = canonical.properties.viewability.properties;

    assert.deepEqual(Object.keys(canonicalProperties).sort(), Object.keys(sourceProperties).sort());
    assert.equal(sourceProperties.vendor.$ref, "/schemas/core/brand-ref.json");
    assert.equal(canonicalProperties.vendor.$ref, "/schemas/core/brand-key.json");
    for (const name of Object.keys(sourceProperties).filter((key) => key !== "vendor")) {
      assert.deepEqual(
        resolvedSemantics(canonicalProperties[name]),
        resolvedSemantics(sourceProperties[name]),
        `canonical viewability property ${name} drifted from source`
      );
    }
  });

  it("carries the standard-required anyOf on both twins", () => {
    assert.ok(source.properties.viewability.anyOf, "source anyOf missing");
    assert.deepEqual(
      canonical.properties.viewability.anyOf,
      source.properties.viewability.anyOf,
      "canonical viewability anyOf drifted from source"
    );
  });

  it("keeps the rate bounds on both twins", () => {
    assert.deepEqual(
      rangeBounds(canonical.properties.viewability.properties.viewable_rate, "canonical viewable_rate"),
      rangeBounds(source.properties.viewability.properties.viewable_rate, "source viewable_rate")
    );
    assert.deepEqual(
      rangeBounds(canonical.properties.metrics.properties.coverage_rate, "canonical coverage_rate"),
      rangeBounds(source.properties.metrics.properties.coverage_rate, "source coverage_rate")
    );
  });

  describe("canonical twin enforces the restored constraints", () => {
    let validate;

    before(async () => {
      validate = await compile(readSchema("/schemas/core/canonical-forecast-point.json"));
    });

    it("accepts a bounded viewability row with a standard", () => {
      const row = {
        metrics: { impressions: { low: 1000, mid: 2000, high: 3000 } },
        viewability: {
          viewable_rate: { low: 0.5, mid: 0.6, high: 0.7 },
          measurable_impressions: { low: 900, mid: 1800, high: 2700 },
          standard: "mrc",
        },
      };
      assert.equal(validate(row), true, JSON.stringify(validate.errors));
    });

    it("rejects a viewable_rate above 1", () => {
      const row = {
        metrics: {},
        viewability: {
          viewable_rate: { low: 0.5, mid: 1.2, high: 1.3 },
          standard: "mrc",
        },
      };
      assert.equal(validate(row), false);
    });

    it("rejects viewability values without a standard", () => {
      const row = {
        metrics: {},
        viewability: {
          viewable_rate: { low: 0.5, mid: 0.6, high: 0.7 },
        },
      };
      assert.equal(validate(row), false);
    });

    it("rejects a coverage_rate above 1 while accepting other unbounded metrics", () => {
      assert.equal(
        validate({ metrics: { coverage_rate: { low: 0.2, mid: 1.4, high: 1.5 } } }),
        false
      );
      assert.equal(
        validate({ metrics: { impressions: { low: 100, mid: 200, high: 300 } } }),
        true,
        JSON.stringify(validate.errors)
      );
    });
  });
});
