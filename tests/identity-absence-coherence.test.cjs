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
    }),
    true,
    JSON.stringify(validateCanonical.errors)
  );
});

test("frequency-only delivery remains unit-bearing", async () => {
  const validate = await compileSchema("/schemas/core/delivery-metrics.json");

  assert.equal(
    validate({ frequency: 2.5, reach_unit: "custom" }),
    true,
    JSON.stringify(validate.errors)
  );
  assert.equal(
    validate({ frequency: 2.5 }),
    false,
    "frequency needs a reach_unit even when reach is absent"
  );
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
  assert.equal(product.overlay_support?.frequency_cap, undefined);
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

  for (const path of [
    "media_buy_deliveries[0].totals.reach_unit",
    "media_buy_deliveries[0].by_package[0].reach_unit",
  ]) {
    const validation = delivery.validations.find(
      (candidate) => candidate.path === path
    );
    assert.equal(validation.check, "field_value_or_absent");
    assert.deepEqual(validation.allowed_values, [
      "individuals",
      "households",
      "custom",
    ]);
  }
});
