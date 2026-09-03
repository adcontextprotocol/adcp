const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const Ajv = require("ajv");
const YAML = require("yaml");

const ROOT = path.resolve(__dirname, "..");
const SOURCE = path.join(ROOT, "static", "schemas", "source");
const SALES_DOOH = path.join(
  ROOT,
  "static",
  "compliance",
  "source",
  "specialisms",
  "sales-dooh",
  "index.yaml"
);

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(SOURCE, relativePath), "utf8"));
}

async function loadSchema(uri) {
  if (!uri.startsWith("/schemas/"))
    throw new Error(`Unexpected schema URI: ${uri}`);
  return readJson(uri.slice("/schemas/".length));
}

async function compileSchema(uri) {
  const ajv = new Ajv({ allErrors: true, strict: false, loadSchema });
  return ajv.compileAsync(await loadSchema(uri));
}

test("identity-absent products cannot advertise identifier-backed frequency-cap execution", async () => {
  const storyboard = YAML.parse(fs.readFileSync(SALES_DOOH, "utf8"));
  const product = storyboard.fixtures.products[0];
  const validate = await compileSchema("/schemas/core/product.json");
  const completeProduct = {
    ...product,
    pricing_options: storyboard.fixtures.pricing_options.filter(
      (option) => option.product_id === product.product_id
    ),
  };

  assert.equal(
    validate(completeProduct),
    true,
    JSON.stringify(validate.errors)
  );
  assert.equal(
    validate({
      ...completeProduct,
      overlay_support: { frequency_cap: true },
    }),
    false,
    "identity absence must forbid frequency_cap support on the same product"
  );
  assert.equal(
    validate({
      ...completeProduct,
      identity: { ...completeProduct.identity, undeclared: true },
    }),
    false,
    "identity declaration remains a closed experimental object"
  );

  const identity = readJson("core/product-identity.json");
  assert.equal(identity["x-status"], "experimental");
  assert.equal(identity["x-added-in"], "3.2.0");
  assert.match(
    identity.properties.reach_methodology.description,
    /frequency-only/i
  );

  const validateCanonical = await compileSchema(
    "/schemas/core/canonical-product.json"
  );
  assert.equal(
    validateCanonical({
      product_id: "place_based_modeled",
      name: "Place-based modeled inventory",
      identity: completeProduct.identity,
      overlay_support: { geo_countries: true },
    }),
    true,
    JSON.stringify(validateCanonical.errors)
  );
  assert.equal(
    validateCanonical({
      product_id: "place_based_modeled",
      name: "Place-based modeled inventory",
      identity: completeProduct.identity,
      overlay_support: { frequency_cap: true },
    }),
    false,
    "list_products cannot advertise a frequency cap that the product cannot enforce"
  );
});

function identityAbsenceDeliveryCoherent(product, metrics) {
  if (product.identity?.persistent_identifier !== false) return true;

  const reportsReachOrFrequency =
    Object.hasOwn(metrics, "reach") || Object.hasOwn(metrics, "frequency");
  if (Object.hasOwn(metrics, "frequency") && !Object.hasOwn(metrics, "reach_unit")) {
    return false;
  }
  if (!Object.hasOwn(metrics, "reach_unit")) return true;
  if (!["individuals", "households", "custom"].includes(metrics.reach_unit)) {
    return false;
  }
  if (metrics.reach_unit !== "custom" || !reportsReachOrFrequency) return true;
  return typeof product.identity.reach_methodology === "string" &&
    product.identity.reach_methodology.trim().length > 0;
}

test("identity-absence delivery invariant keeps frequency-only rows unit-bearing", async () => {
  const validate = await compileSchema("/schemas/core/delivery-metrics.json");
  const storyboard = YAML.parse(fs.readFileSync(SALES_DOOH, "utf8"));
  const product = storyboard.fixtures.products[0];
  const constraint = readJson("core/product-identity.json")[
    "x-adcp-validation"
  ].verifier_constraints.identity_absence_delivery;

  assert.equal(
    validate({ frequency: 2.5, reach_unit: "custom" }),
    true,
    JSON.stringify(validate.errors)
  );
  assert.equal(
    validate({ frequency: 2.5 }),
    true,
    "stable delivery metrics retain the existing frequency-only wire shape"
  );
  assert.match(constraint.frequency_requires_reach_unit, /frequency-only row/);
  assert.match(constraint.frequency_requires_reach_unit, /package row/i);
  assert.match(constraint.when, /every contributing package/i);
  assert.deepEqual(constraint.permitted_reach_units, [
    "individuals",
    "households",
    "custom",
  ]);
  assert.equal(
    identityAbsenceDeliveryCoherent(product, { frequency: 2.5 }),
    false,
    "identity-absent frequency-only rows need a reach_unit"
  );
  assert.equal(
    identityAbsenceDeliveryCoherent(product, {
      frequency: 2.5,
      reach_unit: "custom",
    }),
    true
  );
  assert.equal(
    identityAbsenceDeliveryCoherent(product, {
      frequency: 2.5,
      reach_unit: "devices",
    }),
    false,
    "identity-absent products cannot label delivery with device reach"
  );
  assert.equal(
    identityAbsenceDeliveryCoherent(
      { identity: { persistent_identifier: false } },
      { frequency: 2.5, reach_unit: "custom" }
    ),
    false,
    "custom frequency reporting needs a disclosed methodology"
  );

  for (const row of [
    { frequency: 2.5, reach_unit: "custom" },
    { frequency: 2.5, reach_unit: "households" },
  ]) {
    assert.equal(
      identityAbsenceDeliveryCoherent(product, row),
      true,
      "package and product-bound breakdown rows follow the same frequency rule"
    );
  }
});

test("sales-dooh exercises discovery, cap rejection, valid buy, and identity-safe delivery", () => {
  const storyboard = YAML.parse(fs.readFileSync(SALES_DOOH, "utf8"));
  const phase = (id) =>
    storyboard.phases.find((candidate) => candidate.id === id);
  const product = storyboard.fixtures.products[0];
  const rejection = phase("identity_absence").steps.find(
    (step) => step.id === "reject_frequency_capped_buy"
  );
  const delivery = phase("delivery").steps.find(
    (step) => step.id === "get_delivery"
  );

  assert.deepEqual(product.identity, {
    persistent_identifier: false,
    reach_methodology:
      "Venue and dwell-modelled aggregate audience measurement; not identity-resolved.",
  });
  assert.deepEqual(product.overlay_support, { geo_countries: true });
  assert.equal(product.overlay_support?.frequency_cap, undefined);
  const discovery = phase("product_discovery").steps.find(
    (step) => step.id === "get_dooh_products"
  );
  assert.equal(
    discovery.validations.find(
      (validation) => validation.path === "products[0].overlay_support.geo_countries"
    ).value,
    true,
    "a supported overlay field remains visible alongside the absent cap"
  );
  assert.equal(
    discovery.validations.find(
      (validation) => validation.path === "products[0].overlay_support.frequency_cap"
    ).check,
    "field_absent"
  );
  assert.equal(
    storyboard.phases.findIndex(
      (candidate) => candidate.id === "identity_absence"
    ) <
      storyboard.phases.findIndex((candidate) => candidate.id === "create_buy"),
    true
  );
  assert.equal(rejection.expect_error, true);
  assert.equal(
    rejection.sample_request.packages[0].targeting_overlay.frequency_cap
      .max_impressions,
    3
  );
  assert.equal(
    rejection.validations.find(
      (validation) => validation.check === "error_code"
    ).value,
    "UNSUPPORTED_FEATURE"
  );
  assert.equal(
    rejection.validations.find(
      (validation) => validation.path === "errors[0].field"
    ).value,
    "packages[0].targeting_overlay.frequency_cap"
  );

  const totalsFrequency = delivery.validations.find(
    (candidate) => candidate.path === "media_buy_deliveries[0].totals.frequency"
  );
  assert.equal(totalsFrequency.value, 2.5);
  const totalsReachUnit = delivery.validations.find(
    (candidate) => candidate.path === "media_buy_deliveries[0].totals.reach_unit"
  );
  assert.equal(totalsReachUnit.check, "field_value");
  assert.equal(totalsReachUnit.value, "custom");

  for (const [path, value] of [
    ["media_buy_deliveries[0].by_package[0].frequency", 2.5],
    ["media_buy_deliveries[0].by_package[0].reach_unit", "custom"],
  ]) {
    const validation = delivery.validations.find(
      (candidate) => candidate.path === path
    );
    assert.equal(validation.check, "field_value");
    assert.equal(validation.value, value);
  }

  const fields = readJson("media-buy/product-fields.json");
  assert.ok(fields.items.enum.includes("identity"));
  assert.match(
    readJson("enums/reach-unit.json").enumDescriptions.custom,
    /Describe in ext\./
  );
  assert.match(
    readJson("compliance/comply-test-controller-request.json")
      .properties.params.properties.frequency.description,
    /including frequency-only delivery/i
  );
});
