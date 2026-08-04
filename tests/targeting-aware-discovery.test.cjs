const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const Ajv = require("ajv");
const addFormats = require("ajv-formats");

const SCHEMA_ROOT = path.join(__dirname, "..", "static", "schemas", "source");

async function loadSchema(uri) {
  if (!uri.startsWith("/schemas/"))
    throw new Error(`Unexpected schema URI: ${uri}`);
  const filename = path.resolve(SCHEMA_ROOT, uri.slice("/schemas/".length));
  if (!filename.startsWith(`${SCHEMA_ROOT}${path.sep}`))
    throw new Error(`Schema path escape: ${uri}`);
  return JSON.parse(fs.readFileSync(filename, "utf8"));
}

async function compile(uri) {
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    discriminator: true,
    loadSchema,
  });
  addFormats(ajv);
  return ajv.compileAsync(await loadSchema(uri));
}

function errors(validate) {
  return (validate.errors || [])
    .map((error) => `${error.instancePath}: ${error.message}`)
    .join("; ");
}

test("get_products accepts real targeting and future overlay support", async () => {
  const validate = await compile(
    "/schemas/media-buy/get-products-request.json"
  );
  const payload = {
    buying_mode: "brief",
    brief: "Premium national video",
    filters: { channels: ["olv"], pricing_currencies: ["USD"] },
    targeting_overlay: {
      geo_countries: ["US"],
      placement_selection: {
        mode: "selected",
        placement_refs: [
          { publisher_domain: "pinnacle-media.example", placement_id: "feed" },
        ],
      },
    },
    required_overlay_support: {
      geo_metros: { systems: ["nielsen_dma"] },
      placement_selection: true,
      property_list: true,
      collection_list: true,
    },
  };
  assert.equal(validate(payload), true, errors(validate));
});

test("product filters are valid in brief, wholesale, and refine modes", async () => {
  const validate = await compile(
    "/schemas/media-buy/get-products-request.json"
  );
  const filters = { channels: ["olv"], delivery_type: "non_guaranteed" };
  const requests = [
    { buying_mode: "brief", brief: "Premium video", filters },
    { buying_mode: "wholesale", filters },
    {
      buying_mode: "refine",
      refine: [{ scope: "product", product_id: "prod_configured_123" }],
      filters,
    },
  ];

  for (const request of requests) {
    assert.equal(validate(request), true, errors(validate));
  }
});

test("buyer teaching surfaces explain structured-first targeting", () => {
  const skill = fs.readFileSync(
    path.join(__dirname, "..", "skills", "adcp-media-buy", "SKILL.md"),
    "utf8"
  );
  const addieKnowledge = fs.readFileSync(
    path.join(__dirname, "..", "server", "src", "addie", "rules", "knowledge.md"),
    "utf8"
  );
  const certificationTools = fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "server",
      "src",
      "addie",
      "mcp",
      "certification-tools.ts"
    ),
    "utf8"
  );

  for (const teaching of [skill, addieKnowledge]) {
    assert.match(teaching, /targeting_overlay/);
    assert.match(teaching, /required_overlay_support/);
    assert.match(teaching, /targeting_resolution\.brief_targeting/);
    assert.match(teaching, /hard[^\n]*brief|hard[^\n]*prose/i);
  }
  assert.match(skill, /fewer tokens/);
  assert.match(addieKnowledge, /No targeting-resolution echo confirms only/);
  assert.match(certificationTools, /3\.2 targeting-aware objectives with schema fixtures/);
  assert.match(certificationTools, /issues\/6199/);
  assert.match(
    certificationTools,
    /learning\/supplements\/buyer-briefs-and-get-products/
  );
});

test("purchased placement selection requires publisher-scoped non-empty refs", async () => {
  const validate = await compile("/schemas/core/placement-selection.json");

  assert.equal(
    validate({
      mode: "selected",
      placement_refs: [
        {
          publisher_domain: "pinnacle-media.example",
          placement_id: "short_video",
        },
      ],
    }),
    true,
    errors(validate)
  );

  assert.equal(
    validate({
      mode: "selected",
      placement_refs: [{ placement_id: "short_video" }],
    }),
    false
  );

  assert.equal(validate({ mode: "selected", placement_refs: [] }), false);
  assert.equal(validate({ mode: "default" }), true, errors(validate));
  assert.equal(validate({ mode: "default", placement_refs: [] }), false);
});

test("targeting modifications are sparse and use semantic set operations", async () => {
  const validate = await compile("/schemas/core/product-targeting-resolution.json");

  assert.equal(
    validate({
      modifications: [
        {
          operation: "replace",
          path: "/demographics/age",
          applied: { min: 25, max: 34, include_unknown: false },
          reason: "Product executes seller-defined age intervals.",
        },
        {
          operation: "remove_values",
          path: "/geo_postal_areas",
          selector: { country: "US", system: "zip" },
          values: ["10007", "10013"],
          reason: "No forecastable inventory for the requested flight.",
        },
      ],
    }),
    true,
    errors(validate)
  );

  assert.equal(
    validate({
      modifications: [
        {
          operation: "replace",
          path: "demographics.age",
          applied: {},
          reason: "Not a JSON pointer.",
        },
      ],
    }),
    false
  );

  assert.equal(
    validate({
      modifications: [
        {
          operation: "add_values",
          path: "/geo_countries",
          values: ["CA"],
          reason: "Broadening must use a complete replace proposal.",
        },
      ],
    }),
    false
  );

  assert.equal(validate({ brief_targeting: { geo_countries: ["US"] } }), false);
  assert.equal(validate({}), false, "an empty targeting resolution must fail");
});

test("brief-derived targeting is confirmed once at response level", async () => {
  const validate = await compile(
    "/schemas/media-buy/get-products-targeting-resolution.json"
  );
  assert.equal(
    validate({
      brief_targeting: {
        geo_countries: ["US"],
        demographics: {
          age: { min: 18, max: 44, include_unknown: false },
        },
      },
    }),
    true,
    errors(validate)
  );
  assert.equal(validate({}), false);
});

test("required overlay requirements exclude seller limit fields", async () => {
  const validate = await compile(
    "/schemas/core/targeting-overlay-requirements.json"
  );

  assert.equal(
    validate({ geo_metros: { systems: ["nielsen_dma"] } }),
    true,
    errors(validate)
  );
  assert.equal(
    validate({
      geo_metros: {
        systems: ["nielsen_dma"],
        max_values_per_package: 20,
      },
    }),
    false,
    "seller maxima are response-only"
  );
  assert.equal(
    validate({ future_unknown_dimension: true }),
    false,
    "unknown hard requirements must not be ignored"
  );
});

test("product and package targeting resolutions reject cross-lifecycle fields", async () => {
  const validateProduct = await compile(
    "/schemas/core/product-targeting-resolution.json"
  );
  const validatePackage = await compile(
    "/schemas/core/package-targeting-resolution.json"
  );
  const demographics = {
    requested: {
      age: { min: 18, max: 44, include_unknown: false },
    },
    applied: {
      age: { min: 18, max: 44, include_unknown: false },
    },
    equivalent: true,
    execution: { type: "continuous_bounds" },
  };

  assert.equal(validateProduct({ demographics }), false);
  assert.equal(validateProduct({ brief_targeting: { geo_countries: ["US"] } }), false);
  assert.equal(validatePackage({ brief_targeting: { geo_countries: ["US"] } }), false);
  assert.equal(validatePackage({ demographics }), true, errors(validatePackage));
});

test("configured products with targeting resolution require expiration", async () => {
  const validate = await compile("/schemas/core/product.json");
  const base = {
    product_id: "prod_configured_age_456",
    name: "Configured video",
    description: "Configured video inventory",
    publisher_properties: [
      {
        publisher_domain: "pinnacle-media.example",
        selection_type: "by_id",
        property_ids: ["video_network"],
      },
    ],
    channels: ["olv"],
    format_ids: [{ agent_url: "https://creative.example", id: "video_30s" }],
    placements: [
      {
        kind: "publisher_ref",
        publisher_domain: "pinnacle-media.example",
        placement_id: "feed",
        mode: "targetable",
      },
    ],
    property_targeting_allowed: true,
    collection_targeting_allowed: true,
    overlay_support: {
      placement_selection: true,
      property_list: true,
      collection_list: true,
    },
    delivery_type: "non_guaranteed",
    pricing_options: [
      {
        pricing_option_id: "video_cpm",
        pricing_model: "cpm",
        currency: "USD",
        floor_price: 12,
      },
    ],
    reporting_capabilities: {
      available_reporting_frequencies: ["daily"],
      expected_delay_minutes: 60,
      timezone: "UTC",
      supports_webhooks: false,
      available_metrics: ["impressions", "spend"],
      date_range_support: "date_range",
    },
    targeting_resolution: {
      modifications: [
        {
          operation: "replace",
          path: "/demographics/age",
          applied: { min: 25, max: 34, include_unknown: false },
          reason: "Product executes seller-defined age intervals.",
        },
      ],
    },
    is_custom: true,
  };

  assert.equal(
    validate(base),
    false,
    "targeting_resolution without expires_at must fail"
  );
  const valid = { ...base, expires_at: "2026-08-05T12:00:00Z" };
  assert.equal(validate(valid), true, errors(validate));

  const missingCustomMarker = { ...valid };
  delete missingCustomMarker.is_custom;
  assert.equal(
    validate(missingCustomMarker),
    false,
    "targeting_resolution requires the request-specific custom marker"
  );

  const exactConfigured = {
    ...base,
  };
  delete exactConfigured.targeting_resolution;
  assert.equal(
    validate(exactConfigured),
    false,
    "an exact request-specific configured product still requires expires_at"
  );
  assert.equal(
    validate({ ...exactConfigured, expires_at: "2026-08-05T12:00:00Z" }),
    true,
    errors(validate)
  );

  const missingPropertyCapability = { ...valid };
  delete missingPropertyCapability.property_targeting_allowed;
  assert.equal(
    validate(missingPropertyCapability),
    false,
    "declared property-list support requires property_targeting_allowed"
  );

  const mixedFixedAndSelectable = structuredClone(valid);
  mixedFixedAndSelectable.placements.push({
    kind: "publisher_ref",
    publisher_domain: "pinnacle-media.example",
    placement_id: "stories",
    mode: "included",
  });
  assert.equal(
    validate(mixedFixedAndSelectable),
    false,
    "a complete selectable placement set cannot hide an included placement"
  );
  delete mixedFixedAndSelectable.overlay_support.placement_selection;
  assert.equal(
    validate(mixedFixedAndSelectable),
    true,
    errors(validate)
  );
});
