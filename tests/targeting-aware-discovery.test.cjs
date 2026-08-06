const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const Ajv = require("ajv");
const addFormats = require("ajv-formats");
const YAML = require("yaml");

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
      device_platform_exclude: ["fire_os"],
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
      device_platform_exclude: true,
    },
  };
  assert.equal(validate(payload), true, errors(validate));
});

test("device-platform exclusion is typed and independently discoverable", async () => {
  const [validateTargeting, validateRequirements, validateSupport] =
    await Promise.all([
      compile("/schemas/core/targeting.json"),
      compile("/schemas/core/targeting-overlay-requirements.json"),
      compile("/schemas/core/targeting-overlay-support.json"),
    ]);

  assert.equal(
    validateTargeting({
      device_platform: ["android", "fire_os"],
      device_platform_exclude: ["fire_os"],
    }),
    true,
    errors(validateTargeting)
  );
  assert.equal(
    validateTargeting({ device_platform_exclude: ["beos"] }),
    false,
    "platform exclusions use the canonical device-platform enum"
  );
  assert.equal(
    validateRequirements({ device_platform_exclude: true }),
    true,
    errors(validateRequirements)
  );
  assert.equal(
    validateSupport({ device_platform_exclude: true }),
    true,
    errors(validateSupport)
  );

  const targetingSchema = fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "static",
      "schemas",
      "source",
      "core",
      "targeting.json"
    ),
    "utf8"
  );
  assert.match(targetingSchema, /exclusion wins/i);
  assert.match(targetingSchema, /MUST reject/);
});

test("seller targeting rollups are explicit true-valued routing hints", async () => {
  const validate = await compile(
    "/schemas/protocol/get-adcp-capabilities-response.json"
  );
  const targetingRollups = {
    placement_selection: true,
    property_list: true,
    property_list_exclude: true,
    collection_list: true,
    collection_list_exclude: true,
  };
  const payload = {
    adcp_version: "3.2-beta",
    adcp_major_version: 3,
    status: "completed",
    adcp: {
      major_versions: [3],
      supported_versions: ["3.1", "3.2-beta"],
      idempotency: { supported: false },
    },
    supported_protocols: ["media_buy"],
    media_buy: {
      execution: { targeting: targetingRollups },
    },
  };

  assert.equal(validate(payload), true, errors(validate));

  const schema = JSON.parse(
    fs.readFileSync(
      path.join(
        SCHEMA_ROOT,
        "protocol",
        "get-adcp-capabilities-response.json"
      ),
      "utf8"
    )
  );
  const properties =
    schema.properties.media_buy.properties.execution.properties.targeting
      .properties;
  for (const field of Object.keys(targetingRollups)) {
    assert.equal(properties[field].type, "boolean");
    assert.match(properties[field].description, /When true/);
    assert.match(properties[field].description, /Product\.overlay_support/);
  }
});

test("3.2 targeting discovery is release-gated without a redundant feature flag", () => {
  const released31Root = path.join(
    __dirname,
    "..",
    "dist",
    "schemas",
    "3.1.10"
  );
  const releasedRequest = JSON.parse(
    fs.readFileSync(
      path.join(released31Root, "media-buy", "get-products-request.json"),
      "utf8"
    )
  );
  const releasedProduct = JSON.parse(
    fs.readFileSync(path.join(released31Root, "core", "product.json"), "utf8")
  );
  const latestRequest = JSON.parse(
    fs.readFileSync(
      path.join(SCHEMA_ROOT, "media-buy", "get-products-request.json"),
      "utf8"
    )
  );
  const latestProduct = JSON.parse(
    fs.readFileSync(path.join(SCHEMA_ROOT, "core", "product.json"), "utf8")
  );

  for (const field of ["targeting_overlay", "required_overlay_support"]) {
    assert.equal(releasedRequest.properties[field], undefined);
    assert.ok(latestRequest.properties[field]);
  }
  for (const field of ["overlay_support", "targeting_resolution"]) {
    assert.equal(releasedProduct.properties[field], undefined);
    assert.ok(latestProduct.properties[field]);
  }

  const capabilities = JSON.parse(
    fs.readFileSync(
      path.join(
        SCHEMA_ROOT,
        "protocol",
        "get-adcp-capabilities-response.json"
      ),
      "utf8"
    )
  );
  assert.equal(
    capabilities.properties.media_buy.properties.targeting_aware_discovery,
    undefined,
    "release negotiation, not a duplicate coarse flag, gates the 3.2 contract"
  );

  const migration = fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "docs",
      "reference",
      "migration",
      "targeting-aware-discovery.mdx"
    ),
    "utf8"
  );
  assert.match(migration, /There is no separate\s+`targeting_aware_discovery`/);
  assert.match(migration, /legacy implementation may accept and ignore/);
  assert.match(migration, /3\.2 seller receiving a 3\.1 pin/);
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

test("wholesale cache scope includes targeting-aware discovery inputs everywhere", () => {
  const requestSchema = fs.readFileSync(
    path.join(SCHEMA_ROOT, "media-buy", "get-products-request.json"),
    "utf8"
  );
  const responseSchema = fs.readFileSync(
    path.join(SCHEMA_ROOT, "media-buy", "get-products-response.json"),
    "utf8"
  );
  const taskReference = fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "docs",
      "media-buy",
      "task-reference",
      "get_products.mdx"
    ),
    "utf8"
  );

  for (const surface of [requestSchema, responseSchema, taskReference]) {
    assert.match(
      surface,
      /buying_mode, filters, targeting_overlay, required_overlay_support, deprecated property_list, catalog/,
      "wholesale version cache keys must distinguish concrete and future targeting"
    );
  }
});

test("targeting-aware storyboard grades filters and configured targeting end to end", () => {
  const scenario = (filename) =>
    YAML.parse(
      fs.readFileSync(
        path.join(
          __dirname,
          "..",
          "static",
          "compliance",
          "source",
          "protocols",
          "media-buy",
          "scenarios",
          filename
        ),
        "utf8"
      )
    );
  const storyboard = scenario("targeting_aware_discovery.yaml");
  const filterStoryboard = scenario("product_filter_behavior.yaml");
  const steps = storyboard.phases.flatMap((phase) => phase.steps);
  const filterSteps = filterStoryboard.phases.flatMap((phase) => phase.steps);
  const step = (id) => steps.find((candidate) => candidate.id === id);
  const filterStep = (id) =>
    filterSteps.find((candidate) => candidate.id === id);
  const hasCheck = (id, check, path, value) =>
    step(id).validations.some(
      (validation) =>
        validation.check === check &&
        validation.path === path &&
        (value === undefined || validation.value === value)
    );
  const hasFilterCheck = (id, check, path) =>
    filterStep(id).validations.some(
      (validation) => validation.check === check && validation.path === path
    );

  assert.equal(storyboard.introduced_in, "3.2");
  assert.deepEqual(
    storyboard.phases.find((phase) => phase.id === "release_downshift")
      .requires_capability,
    { path: "adcp.supported_versions", contains: "3.1" }
  );
  assert.equal(
    hasCheck(
      "get_products_at_3_1",
      "field_absent",
      "products[0].overlay_support"
    ),
    true,
    "a 3.1-pinned response must omit the 3.2 product capability shape"
  );
  assert.equal(
    hasCheck(
      "accept_equivalent_legacy_and_overlay_targeting",
      "field_present",
      "products[0]"
    ),
    true,
    "equivalent legacy and structured targeting remains accepted"
  );
  assert.equal(
    hasCheck(
      "reject_conflicting_legacy_and_overlay_targeting",
      "error_code"
    ),
    true,
    "conflicting legacy and structured targeting is rejected"
  );
  assert.equal(
    step("reject_conflicting_legacy_and_overlay_targeting").validations[0]
      .value,
    "INVALID_REQUEST"
  );

  assert.equal(filterStoryboard.fixtures.products.length, 3);
  assert.deepEqual(
    filterStoryboard.fixtures.products
      .slice(1)
      .map((product) => product.product_id),
    ["filter_behavior_negative_channel", "filter_behavior_negative_delivery"]
  );

  assert.equal(
    hasFilterCheck("get_filtered_brief_products", "field_absent", "products[1]"),
    true,
    "brief mode must grade exclusion of the negative-control product"
  );
  assert.equal(
    hasFilterCheck(
      "get_filtered_wholesale_products",
      "field_absent",
      "products[1]"
    ),
    true,
    "wholesale mode must grade exclusion of the negative-control product"
  );
  assert.equal(
    hasFilterCheck("filter_refined_product_out", "field_absent", "products[0]"),
    true,
    "refine mode must grade its replacement filters"
  );

  assert.deepEqual(
    step("get_exact_targeted_product").sample_request.targeting_overlay
      .device_platform_exclude,
    ["fire_os"]
  );
  for (const [id, path] of [
    ["create_feed_package", "packages[0].targeting_overlay.device_platform_exclude[0]"],
    [
      "read_updated_placement",
      "media_buys[0].packages[0].targeting_overlay.device_platform_exclude[0]",
    ],
  ]) {
    assert.equal(
      hasCheck(id, "field_value", path, "fire_os"),
      true,
      `${id} must grade persistence of the concrete platform exclusion`
    );
  }

  for (const [path, contextKey] of [
    ["media_buys[0].media_buy_id", "placement_media_buy_id"],
    ["media_buys[0].packages[0].package_id", "placement_package_id"],
  ]) {
    assert.ok(
      step("read_updated_placement").validations.some(
        (validation) =>
          validation.check === "field_equals_context" &&
          validation.path === path &&
          validation.context_key === contextKey
      ),
      `${path} must be grounded in the identity captured during create`
    );
  }

  for (const dimension of ["property_list", "collection_list"]) {
    assert.ok(
      step("get_exact_targeted_product").sample_request.targeting_overlay[
        dimension
      ],
      `${dimension} must participate in discovery-time targeting`
    );
    assert.ok(
      step("read_updated_placement").validations.some((validation) =>
        validation.path?.includes(`targeting_overlay.${dimension}.list_id`)
      ),
      `${dimension} must be graded on persisted readback`
    );
  }
});

test("3.2 compliance requires release-precision negotiation", () => {
  const versionStoryboard = YAML.parse(
    fs.readFileSync(
      path.join(
        __dirname,
        "..",
        "static",
        "compliance",
        "source",
        "universal",
        "version-negotiation.yaml"
      ),
      "utf8"
    )
  );
  const capabilityStep = versionStoryboard.phases[0].steps[0];
  for (const [check, path] of [
    ["field_present", "adcp.supported_versions"],
    ["envelope_field_present", "adcp_version"],
    ["envelope_field_pattern", "adcp_version"],
  ]) {
    const validation = capabilityStep.validations.find(
      (candidate) => candidate.check === check && candidate.path === path
    );
    assert.ok(validation, `${check} ${path} must be graded`);
    assert.equal(validation.severity, undefined);
    assert.equal(validation.permanent_advisory, undefined);
  }

  const errorStoryboard = YAML.parse(
    fs.readFileSync(
      path.join(
        __dirname,
        "..",
        "static",
        "compliance",
        "source",
        "universal",
        "error-compliance.yaml"
      ),
      "utf8"
    )
  );
  const unsupportedRelease = errorStoryboard.phases
    .flatMap((phase) => phase.steps)
    .find((step) => step.id === "unsupported_release_version");
  assert.ok(unsupportedRelease);
  assert.equal(unsupportedRelease.severity, undefined);
  assert.equal(unsupportedRelease.expect_error, true);
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
  const buyerSupplement = fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "docs",
      "learning",
      "supplements",
      "buyer-briefs-and-get-products.mdx"
    ),
    "utf8"
  );

  for (const teaching of [skill, addieKnowledge, buyerSupplement]) {
    assert.match(teaching, /targeting_overlay/);
    assert.match(teaching, /required_overlay_support/);
    assert.match(teaching, /targeting_resolution\.brief_targeting/);
    assert.match(teaching, /hard[^\n]*brief|hard[^\n]*prose/i);
  }
  for (const teaching of [skill, addieKnowledge, buyerSupplement]) {
    assert.match(
      teaching,
      /brief[^\n]*wholesale[^\n]*refine/,
      "buyer teaching must not imply that filters are wholesale-only"
    );
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
