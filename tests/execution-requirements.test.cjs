const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const Ajv = require("ajv");
const addFormats = require("ajv-formats");

const ROOT = path.resolve(__dirname, "..");
const SOURCE = path.join(ROOT, "static", "schemas", "source");

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
  addFormats(ajv);
  return ajv.compileAsync(await loadSchema(uri));
}

const BASE_PRODUCT = {
  product_id: "social_app_installs",
  name: "Social app installs",
  description: "In-feed app-install placements optimized to installs.",
  publisher_properties: [
    { publisher_domain: "social.example", selection_type: "all" },
  ],
  delivery_type: "non_guaranteed",
  format_ids: [
    {
      agent_url: "https://creative.adcontextprotocol.org",
      id: "display_300x250",
    },
  ],
  pricing_options: [
    {
      pricing_option_id: "cpm_auction",
      pricing_model: "cpm",
      currency: "USD",
      floor_price: 2,
    },
  ],
  reporting_capabilities: {
    available_reporting_frequencies: ["daily"],
    expected_delay_minutes: 60,
    timezone: "UTC",
    supports_webhooks: false,
    available_metrics: ["impressions"],
    date_range_support: "date_range",
  },
};

const APP_INSTALL_REQUIREMENTS = [
  { kind: "event_source", event_types: ["app_install"] },
  { kind: "catalog", catalog_types: ["app"] },
  {
    kind: "downstream_connection",
    connection: {
      connection_type: "publisher_identity",
      scope: "identity",
      required_for: ["create_media_buy"],
    },
  },
];

function validationMessage(validate) {
  return JSON.stringify(validate.errors, null, 2);
}

test("base product fixture is valid without execution requirements", async () => {
  const validate = await compileSchema("/schemas/core/product.json");
  assert.equal(validate(BASE_PRODUCT), true, validationMessage(validate));
});

test("a product can declare every requirement kind alongside the capabilities they bind to", async () => {
  const validate = await compileSchema("/schemas/core/product.json");
  const product = {
    ...BASE_PRODUCT,
    catalog_types: ["app"],
    conversion_tracking: { action_sources: ["app"] },
    execution_requirements: APP_INSTALL_REQUIREMENTS,
  };
  assert.equal(validate(product), true, validationMessage(validate));
});

test("an event_source requirement requires conversion_tracking on the product", async () => {
  const validate = await compileSchema("/schemas/core/product.json");
  assert.equal(
    validate({
      ...BASE_PRODUCT,
      execution_requirements: [{ kind: "event_source" }],
    }),
    false,
    "event_source requirement without conversion_tracking must be rejected",
  );
});

test("a catalog requirement requires catalog_types on the product", async () => {
  const validate = await compileSchema("/schemas/core/product.json");
  assert.equal(
    validate({
      ...BASE_PRODUCT,
      execution_requirements: [{ kind: "catalog", catalog_types: ["app"] }],
    }),
    false,
    "catalog requirement without catalog_types must be rejected",
  );
});

test("requirement variants reject malformed entries", async () => {
  const validate = await compileSchema(
    "/schemas/core/product-execution-requirement.json",
  );
  for (const requirement of APP_INSTALL_REQUIREMENTS) {
    assert.equal(validate(requirement), true, validationMessage(validate));
  }
  const invalid = [
    { kind: "catalog" },
    { kind: "catalog", catalog_types: [] },
    { kind: "catalog", catalog_types: ["not_a_catalog_type"] },
    { kind: "event_source", event_types: [] },
    { kind: "event_source", event_types: ["not_an_event_type"] },
    { kind: "downstream_connection" },
    { kind: "downstream_connection", connection: {} },
    { kind: "lead_form" },
  ];
  for (const requirement of invalid) {
    assert.equal(
      validate(requirement),
      false,
      `expected invalid: ${JSON.stringify(requirement)}`,
    );
  }
});

test("schema examples validate against their own schemas", async () => {
  for (const uri of [
    "/schemas/core/product-execution-requirement.json",
    "/schemas/error-details/execution-requirement-unmet.json",
  ]) {
    const validate = await compileSchema(uri);
    const schema = await loadSchema(uri);
    assert.ok(schema.examples.length > 0, `${uri} should carry examples`);
    for (const example of schema.examples) {
      assert.equal(validate(example), true, validationMessage(validate));
    }
  }
});

test("unmet-requirement details require the binding field, reason, and echoed requirement", async () => {
  const validate = await compileSchema(
    "/schemas/error-details/execution-requirement-unmet.json",
  );
  const entry = {
    product_id: "social_app_installs",
    field: "packages[0].catalogs",
    reason: "ineligible",
    requirement: { kind: "catalog", catalog_types: ["app"] },
  };
  assert.equal(
    validate({ unmet_requirements: [entry] }),
    true,
    validationMessage(validate),
  );
  assert.equal(validate({ unmet_requirements: [] }), false);
  for (const key of ["product_id", "field", "reason", "requirement"]) {
    const { [key]: _omitted, ...partial } = entry;
    assert.equal(
      validate({ unmet_requirements: [partial] }),
      false,
      `${key} must be required`,
    );
  }
  assert.equal(
    validate({ unmet_requirements: [{ ...entry, reason: "missing" }] }),
    false,
    "reason is a closed vocabulary",
  );
});

test("canonical products and field projection carry execution_requirements", async () => {
  const canonical = readJson("core/canonical-product.json");
  assert.ok(canonical.properties.execution_requirements);
  assert.equal(
    canonical.properties.execution_requirements["x-status"],
    "experimental",
  );
  const fields = readJson("media-buy/product-fields.json");
  assert.ok(fields.items.enum.includes("execution_requirements"));
  const validate = await compileSchema("/schemas/core/canonical-product.json");
  const compact = {
    product_id: BASE_PRODUCT.product_id,
    name: BASE_PRODUCT.name,
    execution_requirements: [{ kind: "catalog", catalog_types: ["app"] }],
  };
  assert.equal(
    validate({ ...compact, catalog_types: ["app"] }),
    true,
    validationMessage(validate),
  );
  assert.equal(
    validate(compact),
    false,
    "compact catalog requirement without catalog_types must be rejected",
  );
});

test("connection requirements stay account-independent", async () => {
  const validate = await compileSchema(
    "/schemas/core/product-execution-requirement.json",
  );
  const base = {
    kind: "downstream_connection",
    connection: { connection_type: "publisher_identity" },
  };
  assert.equal(validate(base), true, validationMessage(validate));
  assert.equal(
    validate({
      ...base,
      connection: { ...base.connection, status: "unknown" },
    }),
    true,
    validationMessage(validate),
  );
  assert.equal(
    validate({
      ...base,
      connection: { ...base.connection, status: "connected" },
    }),
    false,
    "account-observed connection status must not appear on a product declaration",
  );
  assert.equal(
    validate({
      ...base,
      connection: {
        ...base.connection,
        resource_ref: { identity_id: "page_123" },
      },
    }),
    false,
    "resource_ref discloses an account resource and must be omitted",
  );
});
