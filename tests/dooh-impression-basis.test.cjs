const fs = require("fs");
const path = require("path");
const Ajv = require("ajv");
const addFormats = require("ajv-formats");
const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

// DOOH impression basis (media_buy.dooh_impression_basis, RFC #7253): discovery, forecast and
// delivery payloads of a product mixing sensor-equipped screens and screens without a sensor.

const ROOT = path.join(__dirname, "..");
const SCHEMA_ROOT = path.join(ROOT, "static", "schemas", "source");
const FIXTURES = path.join(__dirname, "fixtures", "dooh-impression-basis");
const FEATURE_ID = "media_buy.dooh_impression_basis";

function readSchema(uri) {
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_ROOT, uri.slice("/schemas/".length)), "utf8"));
}

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8"));
}

const clone = (value) => JSON.parse(JSON.stringify(value));

// A declared multiplier and the counts it relates agree to within half a percent.
function assertMultiplier(multiplier, impressions, plays, where) {
  assert.ok(plays > 0, `${where}: plays`);
  const ratio = impressions / plays;
  assert.ok(Math.abs(ratio - multiplier) / ratio < 0.005, `${where}: ${impressions} / ${plays} = ${ratio}, declared ${multiplier}`);
}

// Breakdown entries: at least two, one per tier, summing exactly to the row's counts, each
// multiplier consistent. Draft-07 cannot count matches, so distinct tiers are checked here.
function assertBreakdown(entries, plays, impressions, where) {
  const tiers = entries.map((entry) => entry.impression_basis);
  assert.ok(entries.length >= 2, `${where}: at least two entries`);
  assert.equal(new Set(tiers).size, tiers.length, `${where}: one entry per tier`);
  assert.equal(entries.reduce((sum, entry) => sum + entry.plays, 0), plays, `${where}: plays sum`);
  assert.equal(entries.reduce((sum, entry) => sum + entry.impressions, 0), impressions, `${where}: impressions sum`);
  for (const entry of entries)
    if (entry.audience_multiplier !== undefined)
      assertMultiplier(entry.audience_multiplier, entry.impressions, entry.plays, `${where} ${entry.impression_basis}`);
}

// A row's counts per tier: its breakdown entries, or its single tier holding all its counts.
function tierCounts(dooh, plays, impressions) {
  const entries = dooh.impression_basis_breakdown ?? [{ impression_basis: dooh.impression_basis, plays, impressions }];
  return Object.fromEntries(entries.map((entry) => [entry.impression_basis, { plays: entry.plays, impressions: entry.impressions }]));
}

// Each tier entry of a parent row is the sum of its children's entries for that tier.
function assertParentSumsChildren(parent, children, where) {
  const sum = {};
  for (const child of children)
    for (const [tier, counts] of Object.entries(tierCounts(child.dooh_metrics, child.plays, child.impressions))) {
      sum[tier] ??= { plays: 0, impressions: 0 };
      sum[tier].plays += counts.plays;
      sum[tier].impressions += counts.impressions;
    }
  assert.deepEqual(tierCounts(parent.dooh_metrics, parent.plays, parent.impressions), sum, `${where}: tiers sum over children`);
}

// Every delivery row: either a single tier or a breakdown, a consistent multiplier (none blended
// across tiers), and a basis_metric that joins a vendor_metric_values row of the same object.
function assertDeliveryRow(row, where) {
  const dooh = row.dooh_metrics;
  assert.ok(dooh, `${where}: dooh_metrics`);
  assert.ok((dooh.impression_basis === undefined) !== (dooh.impression_basis_breakdown === undefined), `${where}: impression_basis xor impression_basis_breakdown`);
  if (dooh.audience_multiplier !== undefined)
    assertMultiplier(dooh.audience_multiplier, row.impressions, row.plays, where);
  if (dooh.impression_basis_breakdown) {
    assertBreakdown(dooh.impression_basis_breakdown, row.plays, row.impressions, where);
    assert.equal(dooh.audience_multiplier, undefined, `${where}: no multiplier blended across tiers`);
  }
  if (dooh.basis_metric) {
    const joined = (row.vendor_metric_values ?? []).find((value) =>
      value.vendor.domain === dooh.basis_metric.vendor.domain && value.metric_id === dooh.basis_metric.metric_id);
    assert.ok(joined, `${where}: basis_metric joins a vendor_metric_values row`);
    const sensor = dooh.impression_basis_breakdown?.find((entry) => entry.impression_basis === "sensor_measured");
    if (sensor) {
      assert.equal(joined.measurable_plays, sensor.plays, `${where}: the sensor covers the sensor_measured plays`);
      assert.equal(joined.value, sensor.impressions, `${where}: the persons counted are the sensor_measured impressions`);
    }
  }
}

describe("DOOH impression basis schemas", () => {
  it("adds an experimental four-tier enum", () => {
    const basis = readSchema("/schemas/enums/impression-estimation-basis.json");
    assert.equal(basis["x-status"], "experimental");
    assert.equal(basis["x-added-in"], "3.3.0");
    assert.deepEqual(basis.enum, ["currency_measured", "seller_modeled", "sensor_measured", "hybrid"]);
    assert.deepEqual(Object.keys(basis.enumDescriptions), basis.enum);
  });

  it("marks every new property experimental under one feature id", () => {
    const dooh = readSchema("/schemas/core/delivery-metrics.json").properties.dooh_metrics;
    const venue = dooh.properties.venue_breakdown.items.properties;
    const point = readSchema("/schemas/core/forecast-point.json").properties;
    const product = readSchema("/schemas/core/placement.json").definitions.ProductDoohPlacementAttributes.properties;
    const canonical = readSchema("/schemas/core/canonical-placement.json").definitions.CanonicalDoohPlacementAttributes.properties;
    const nodes = [
      dooh.properties.impression_basis, dooh.properties.audience_multiplier, dooh.properties.basis_metric,
      dooh.properties.impression_basis_breakdown, venue.impression_basis, venue.audience_multiplier,
      point.impression_basis, point.audience_multiplier, point.impression_basis_breakdown,
      product.impression_basis, product.audience_multiplier, canonical.impression_basis, canonical.audience_multiplier,
      readSchema("/schemas/core/impression-basis-breakdown-entry.json"),
    ];
    for (const node of nodes) {
      assert.equal(node["x-status"], "experimental");
      assert.equal(node["x-added-in"], "3.3.0");
      assert.ok(node.description.startsWith(`Experimental (${FEATURE_ID}).`), node.description);
    }
  });

  it("leaves the stable dooh_metrics block and the experimental ooh_metrics block as they were", () => {
    const metrics = readSchema("/schemas/core/delivery-metrics.json").properties;
    assert.equal(metrics.dooh_metrics["x-status"], undefined);
    assert.equal(metrics.dooh_metrics.additionalProperties, true);
    assert.deepEqual(metrics.ooh_metrics.properties.estimation_basis.enum, ["currency_measured", "seller_modeled"]);
  });

  it("keeps the multiplier out of the forecastable metrics", () => {
    const point = readSchema("/schemas/core/forecast-point.json");
    assert.equal(point.properties.metrics.properties.audience_multiplier, undefined);
    assert.ok(!readSchema("/schemas/enums/forecastable-metric.json").enum.includes("audience_multiplier"));
  });

  it("requires two or more entries and never a breakdown beside a row-level tier", () => {
    const dooh = readSchema("/schemas/core/delivery-metrics.json").properties.dooh_metrics;
    const point = readSchema("/schemas/core/forecast-point.json");
    const exclusion = { impression_basis_breakdown: { not: { required: ["impression_basis"] } } };
    for (const schema of [dooh, point]) {
      assert.equal(schema.properties.impression_basis_breakdown.minItems, 2);
      assert.deepEqual(schema.dependencies, exclusion);
    }
  });

  it("lists the feature id in the experimental-status table", () => {
    const doc = fs.readFileSync(path.join(ROOT, "docs", "reference", "experimental-status.mdx"), "utf8");
    assert.match(doc, /^\| `media_buy\.dooh_impression_basis` \|/m);
  });
});

describe("DOOH impression basis fixtures: a product mixing sensor-measured and seller-modeled screens", () => {
  let validateProduct, validateForecast, validateDelivery, validateEntry;

  before(async () => {
    const ajv = new Ajv({ allErrors: true, strict: false, loadSchema: async (ref) => readSchema(ref) });
    addFormats(ajv);
    // A schema another one already pulled in is compiled from the instance, not added twice.
    const compile = async (id) => ajv.getSchema(id) ?? ajv.compileAsync(readSchema(id));
    validateProduct = await compile("/schemas/core/product.json");
    validateForecast = await compile("/schemas/core/delivery-forecast.json");
    validateDelivery = await compile("/schemas/media-buy/get-media-buy-delivery-response.json");
    validateEntry = await compile("/schemas/core/impression-basis-breakdown-entry.json");
  });

  it("discovery: each placement declares its planned tier and multiplier", () => {
    const product = fixture("discovery-product.json");
    assert.equal(validateProduct(product), true, JSON.stringify(validateProduct.errors, null, 2));
    const tiers = product.placements.map((placement) => placement.dooh_placement_attributes.impression_basis);
    assert.deepEqual(tiers, ["sensor_measured", "seller_modeled"]);
  });

  // The concourse's sensor screens are expected to fall back on 30% of their plays, the share
  // of fallback plays on sensor screens in the adopter's production data (9% of 30%).
  it("forecast: the expected split, fallback included, reconciles with the midpoints", () => {
    const forecast = fixture("forecast.json");
    assert.equal(validateForecast(forecast), true, JSON.stringify(validateForecast.errors, null, 2));
    for (const point of forecast.points) {
      const plays = point.metrics.plays.mid;
      const impressions = point.metrics.impressions.mid;
      assertBreakdown(point.impression_basis_breakdown, plays, impressions, point.label);
      assert.equal(point.audience_multiplier, undefined, `${point.label}: no multiplier blended across tiers`);
    }
    const [sensor, modeled] = forecast.points[0].impression_basis_breakdown;
    const platformPlays = 58300;
    assert.equal(sensor.plays / (sensor.plays + modeled.plays - platformPlays), 0.7, "concourse: 70% sensor plays, 30% fallback");
  });

  it("delivery: totals, package and placements carry a consistent basis, including a sensor screen that fell back", () => {
    const delivery = fixture("delivery.json");
    assert.equal(validateDelivery(delivery), true, JSON.stringify(validateDelivery.errors, null, 2));
    for (const buy of delivery.media_buy_deliveries) {
      assertDeliveryRow(buy.totals, "totals");
      assertParentSumsChildren(buy.totals, buy.by_package, "totals");
      for (const pkg of buy.by_package) {
        assertDeliveryRow(pkg, pkg.package_id);
        for (const placement of pkg.by_placement)
          assertDeliveryRow(placement, placement.placement_id);
        assertParentSumsChildren(pkg, pkg.by_placement, pkg.package_id);
      }
    }
    const fallback = delivery.media_buy_deliveries[0].by_package[0].by_placement[0].dooh_metrics.impression_basis_breakdown;
    assert.deepEqual(fallback.map((entry) => entry.impression_basis), ["sensor_measured", "seller_modeled"]);
  });

  describe("rejects", () => {
    const placementRow = () => fixture("delivery.json").media_buy_deliveries[0].by_package[0].by_placement[0];
    const reject = (mutate) => {
      const delivery = fixture("delivery.json");
      mutate(delivery.media_buy_deliveries[0].by_package[0].by_placement[0].dooh_metrics);
      return validateDelivery(delivery);
    };

    it("an unknown tier", () => {
      assert.equal(reject((dooh) => { dooh.impression_basis_breakdown[0].impression_basis = "panel_measured"; }), false);
    });

    it("a negative multiplier", () => {
      assert.equal(reject((dooh) => { dooh.audience_multiplier = -1; }), false);
    });

    it("a breakdown entry without its tier", () => {
      assert.equal(reject((dooh) => { delete dooh.impression_basis_breakdown[1].impression_basis; }), false);
    });

    it("a breakdown with fewer than two entries", () => {
      assert.equal(reject((dooh) => { dooh.impression_basis_breakdown = [dooh.impression_basis_breakdown[0]]; }), false);
      assert.equal(reject((dooh) => { dooh.impression_basis_breakdown = []; }), false);
      const point = fixture("forecast.json");
      point.points[0].impression_basis_breakdown.pop();
      assert.equal(validateForecast(point), false);
    });

    it("a breakdown repeating a tier", () => {
      // Draft-07 cannot count the entries of one tier: the rule is prose, checked here.
      const row = placementRow();
      const entries = row.dooh_metrics.impression_basis_breakdown.map((entry) => ({ ...entry, impression_basis: "sensor_measured" }));
      assert.throws(() => assertBreakdown(entries, row.plays, row.impressions, row.placement_id), /one entry per tier/);
    });

    it("a row carrying both a tier and a breakdown", () => {
      assert.equal(reject((dooh) => { dooh.impression_basis = "sensor_measured"; }), false);
      const forecast = fixture("forecast.json");
      forecast.points[0].impression_basis = "seller_modeled";
      assert.equal(validateForecast(forecast), false);
    });

    it("a basis_metric without its metric_id", () => {
      assert.equal(reject((dooh) => { delete dooh.basis_metric.metric_id; }), false);
    });

    it("a breakdown entry without its counts", () => {
      const entry = clone(placementRow().dooh_metrics.impression_basis_breakdown[0]);
      delete entry.plays;
      assert.equal(validateEntry(entry), false);
    });

    it("an unknown planned tier on a placement", () => {
      const product = fixture("discovery-product.json");
      product.placements[0].dooh_placement_attributes.impression_basis = "panel_modeled";
      assert.equal(validateProduct(product), false);
    });
  });
});
