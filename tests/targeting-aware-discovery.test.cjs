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

test("split discovery tasks carry targeting through shared criteria", async () => {
  const [validateList, validateRequest, validateRefine] = await Promise.all([
    compile("/schemas/media-buy/list-products-request.json"),
    compile("/schemas/media-buy/request-proposals-request.json"),
    compile("/schemas/media-buy/refine-proposals-request.json"),
  ]);
  const criteria = {
    offer_filters: { channels: ["olv"], pricing_currencies: ["USD"] },
    targeting_overlay: { geo_countries: ["US"] },
    required_overlay_support: {
      geo_metros: { systems: ["nielsen_dma"] },
      placement_selection: true,
    },
  };

  assert.equal(
    validateList({ brand: { domain: "acme.example" }, criteria }),
    true,
    errors(validateList)
  );
  assert.equal(
    validateRequest({
      idempotency_key: "550e8400-e29b-41d4-a716-446655441201",
      brand: { domain: "acme.example" },
      brief: "Reach outdoor enthusiasts with premium video.",
      criteria,
    }),
    true,
    errors(validateRequest)
  );
  assert.equal(
    validateRefine({
      idempotency_key: "550e8400-e29b-41d4-a716-446655441202",
      refinements: [
        {
          proposal_id: "proposal_123",
          action: "revise",
          criteria: { targeting_overlay: { geo_countries: ["CA"] } },
        },
      ],
    }),
    true,
    errors(validateRefine)
  );
  assert.equal(
    validateRefine({
      idempotency_key: "550e8400-e29b-41d4-a716-446655441203",
      refinements: [{ proposal_id: "proposal_123", action: "revise" }],
    }),
    false,
    "a refinement still needs structured criteria or semantic instructions"
  );
  assert.equal(
    validateRefine({
      idempotency_key: "550e8400-e29b-41d4-a716-446655441204",
      refinements: [{
        proposal_id: "proposal_123",
        action: "finalize",
        criteria: { targeting_overlay: { geo_countries: ["CA"] } },
      }],
    }),
    false,
    "finalization must not change structured targeting"
  );
});

test("split proposal responses expose brief targeting resolution", async () => {
  const [validateRequestResponse, validateRefineResponse] = await Promise.all([
    compile("/schemas/media-buy/request-proposals-response.json"),
    compile("/schemas/media-buy/refine-proposals-response.json"),
  ]);

  const requestSchema = JSON.parse(
    fs.readFileSync(
      path.join(SCHEMA_ROOT, "media-buy", "request-proposals-response.json"),
      "utf8"
    )
  );
  const refineSchema = JSON.parse(
    fs.readFileSync(
      path.join(SCHEMA_ROOT, "media-buy", "refine-proposals-response.json"),
      "utf8"
    )
  );
  assert.equal(
    requestSchema.properties.targeting_resolution.$ref,
    "/schemas/media-buy/get-products-targeting-resolution.json"
  );
  assert.equal(
    refineSchema.properties.results.items.properties.targeting_resolution.$ref,
    "/schemas/media-buy/get-products-targeting-resolution.json"
  );
  assert.equal(typeof validateRequestResponse, "function");
  assert.equal(typeof validateRefineResponse, "function");
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

test("browser-family inclusion and exclusion are typed and independently discoverable", async () => {
  const [validateTargeting, validateRequirements, validateSupport] =
    await Promise.all([
      compile("/schemas/core/targeting.json"),
      compile("/schemas/core/targeting-overlay-requirements.json"),
      compile("/schemas/core/targeting-overlay-support.json"),
    ]);
  const canonicalFamilies = [
    "chrome",
    "safari",
    "firefox",
    "edge",
    "opera",
    "samsung_internet",
    "android_webview",
    "other",
    "unknown",
  ];

  assert.equal(
    validateTargeting({
      browser: canonicalFamilies,
      browser_exclude: ["safari", "unknown"],
    }),
    true,
    errors(validateTargeting)
  );
  for (const invalid of [
    { browser: [] },
    { browser: ["internet_explorer"] },
    { browser: ["chrome", "chrome"] },
    { browser_exclude: [] },
    { browser_exclude: ["chromium"] },
  ]) {
    assert.equal(
      validateTargeting(invalid),
      false,
      `invalid browser targeting must fail: ${JSON.stringify(invalid)}`
    );
  }
  assert.equal(
    validateRequirements({ browser: true, browser_exclude: true }),
    true,
    errors(validateRequirements)
  );
  assert.equal(
    validateRequirements({
      browser: { families: ["chrome", "firefox"] },
      browser_exclude: { families: ["unknown"] },
    }),
    true,
    errors(validateRequirements)
  );
  assert.equal(
    validateSupport({ browser: true, browser_exclude: true }),
    true,
    errors(validateSupport)
  );
  assert.equal(
    validateSupport({
      browser: { families: ["chrome", "firefox"] },
      browser_exclude: { families: ["unknown"] },
    }),
    true,
    errors(validateSupport)
  );
  for (const invalid of [
    { browser: {} },
    { browser: { families: [] } },
    { browser: { families: ["internet_explorer"] } },
    { browser_exclude: { families: ["unknown", "unknown"] } },
  ]) {
    assert.equal(
      validateRequirements(invalid),
      false,
      `invalid browser requirement must fail: ${JSON.stringify(invalid)}`
    );
    assert.equal(
      validateSupport(invalid),
      false,
      `invalid browser support must fail: ${JSON.stringify(invalid)}`
    );
  }
  assert.equal(
    validateRequirements({ browser: false }),
    false,
    "browser support requirements are positive capabilities"
  );
  assert.equal(
    validateSupport({ browser: true }),
    true,
    errors(validateSupport)
  );
  assert.equal(
    validateSupport({ browser_exclude: true }),
    true,
    errors(validateSupport)
  );

  const browserEnum = JSON.parse(
    fs.readFileSync(
      path.join(SCHEMA_ROOT, "enums", "browser-family.json"),
      "utf8"
    )
  );
  assert.deepEqual(browserEnum.enum, canonicalFamilies);
  assert.match(browserEnum.description, /other means a seller-recognized/i);
  assert.match(browserEnum.description, /unknown means the seller cannot classify/i);
  assert.match(browserEnum.description, /impression delivery and rendering environment/i);
  assert.match(browserEnum.description, /MUST NOT be inferred solely/i);
  assert.match(browserEnum.description, /android_webview means an impression reliably classified/i);

  const targeting = JSON.parse(
    fs.readFileSync(path.join(SCHEMA_ROOT, "core", "targeting.json"), "utf8")
  );
  assert.match(targeting.properties.browser.description, /families not listed are ineligible/i);
  assert.match(targeting.properties.browser.description, /exclusion wins/i);
  assert.match(targeting.properties.browser.description, /Browser and device constraints intersect/i);
  assert.match(targeting.properties.browser.description, /not the post-click landing-page browser/i);
  assert.match(targeting.properties.browser.description, /MUST reject/i);
  assert.match(targeting.properties.browser_exclude.description, /exclusion wins/i);
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
  assert.deepEqual(
    step("get_exact_targeted_product").sample_request.targeting_overlay.browser,
    ["chrome", "safari", "unknown"],
    "exact discovery must exercise named, overlapping, and unclassifiable browser families"
  );
  assert.deepEqual(
    step("get_exact_targeted_product").sample_request.targeting_overlay
      .browser_exclude,
    ["safari"],
    "exact discovery must exercise exclusion-wins semantics"
  );
  assert.deepEqual(
    step("get_exact_targeted_product").sample_request.required_overlay_support
      .browser,
    { families: ["chrome", "firefox"] },
    "discovery must require later browser inclusion for the selected families"
  );
  assert.deepEqual(
    step("get_exact_targeted_product").sample_request.required_overlay_support
      .browser_exclude,
    { families: ["unknown"] },
    "discovery must require later browser exclusion independently"
  );
  assert.deepEqual(
    step("get_exact_targeted_product").sample_request.required_overlay_support
      .keyword_targets,
    { supported_match_types: ["exact"] },
    "an object requirement must be graded against unrestricted true support"
  );
  assert.equal(
    hasCheck(
      "get_exact_targeted_product",
      "field_value",
      "products[0].overlay_support.placement_selection.max_values_per_package",
      2
    ),
    true,
    "requirement true must match constrained object support without comparing numeric limits"
  );
  assert.equal(
    hasCheck(
      "get_exact_targeted_product",
      "field_value",
      "products[0].overlay_support.keyword_targets",
      true
    ),
    true,
    "support true must satisfy an object requirement"
  );
  for (const field of [
    "browser",
    "browser_exclude",
  ]) {
    const validation = step("get_exact_targeted_product").validations.find(
      (candidate) =>
        candidate.check === "field_value" &&
        candidate.path === `products[0].overlay_support.${field}`
    );
    assert.deepEqual(
      validation?.value,
      { families: ["chrome", "safari", "firefox", "unknown"] },
      `${field} support must be graded independently by family`
    );
  }
  assert.deepEqual(
    storyboard.fixtures.products[0].browser_inventory,
    {
      forecastable_families: ["chrome", "firefox", "unknown"],
      unavailable_families: ["safari"],
      platform_compatibility: { safari: ["ios", "macos"] },
    },
    "browser discovery outcomes must be grounded in deterministic seeded inventory"
  );

  assert.deepEqual(
    step("get_modified_age_product").sample_request.targeting_overlay.browser,
    ["chrome", "safari"]
  );
  assert.equal(
    hasCheck(
      "get_modified_age_product",
      "field_value",
      "products[0].targeting_resolution.modifications[1].operation",
      "remove_values"
    ),
    true,
    "browser alternatives must use sparse set removal"
  );
  assert.equal(
    hasCheck(
      "get_modified_age_product",
      "field_value",
      "products[0].targeting_resolution.modifications[1].path",
      "/browser"
    ),
    true,
    "the browser modification path must be graded"
  );
  assert.equal(
    hasCheck(
      "create_from_modified_product",
      "field_absent",
      "packages[0].targeting_overlay.browser[1]"
    ),
    true,
    "booked readback must prove the removed browser was not restored"
  );

  const briefConfirmation = step("get_brief_targeted_product").validations.find(
    (validation) =>
      validation.check === "field_present" &&
      validation.path === "targeting_resolution.brief_targeting"
  );
  assert.ok(briefConfirmation);
  assert.equal(briefConfirmation.severity, undefined);
  assert.equal(briefConfirmation.permanent_advisory, undefined);

  assert.equal(
    hasCheck(
      "discover_fixed_placement_set",
      "field_absent",
      "products[0].overlay_support.placement_selection"
    ),
    true,
    "fixed placement equality must not require selectable placement support"
  );
  assert.equal(
    hasCheck(
      "create_fixed_placement_set",
      "field_contains",
      "packages[0].targeting_overlay.placement_selection.placement_refs[*]"
    ),
    true,
    "the fixed placement rule must be graded at create without assuming set order"
  );
  assert.equal(
    step("create_fixed_placement_set").validations.filter(
      (validation) =>
        validation.check === "field_contains" &&
        validation.path ===
          "packages[0].targeting_overlay.placement_selection.placement_refs[*]"
    ).length,
    2,
    "both members of the complete fixed placement set must be graded"
  );
  assert.equal(
    hasCheck(
      "create_fixed_placement_set",
      "field_absent",
      "packages[0].targeting_overlay.placement_selection.placement_refs[2]"
    ),
    true,
    "create must grade the fixed set's cardinality"
  );
  assert.equal(
    hasCheck("exclude_partial_fixed_placement_set", "field_value", "products"),
    true,
    "discovery must exclude a partial fixed placement match"
  );
  for (const id of [
    "reject_partial_fixed_placement_create",
    "reject_partial_fixed_placement_update",
  ]) {
    assert.equal(
      hasCheck(id, "error_code", undefined, "UNSUPPORTED_FEATURE"),
      true,
      `${id} must reject partial selection`
    );
  }
  assert.equal(
    hasCheck(
      "read_fixed_placement_after_rejected_update",
      "field_equals_context",
      "media_buys[0].packages[0].package_id"
    ),
    true,
    "rejected fixed-placement update must be followed by grounded readback"
  );
  assert.equal(
    hasCheck(
      "read_fixed_placement_after_rejected_update",
      "field_absent",
      "media_buys[0].packages[0].targeting_overlay.placement_selection.placement_refs[2]"
    ),
    true,
    "atomicity readback must grade exact fixed-set cardinality"
  );
  assert.equal(
    hasCheck("update_fixed_placement_set", "field_contains", "affected_packages[*]"),
    true,
    "the fixed placement rule must be graded at update"
  );
  assert.equal(
    hasCheck(
      "update_fixed_placement_set",
      "field_absent",
      "affected_packages[0].targeting_overlay.placement_selection.placement_refs[2]"
    ),
    true,
    "update must grade the fixed set's cardinality"
  );
  assert.equal(
    hasCheck("create_expired_configured_product", "error_code", undefined, "PRODUCT_EXPIRED"),
    true,
    "recognized expired configured IDs must be graded as PRODUCT_EXPIRED"
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
  for (const [id, path, value] of [
    ["create_feed_package", "packages[0].targeting_overlay.browser[*]", "chrome"],
    ["create_feed_package", "packages[0].targeting_overlay.browser[*]", "safari"],
    ["create_feed_package", "packages[0].targeting_overlay.browser[*]", "unknown"],
    ["create_feed_package", "packages[0].targeting_overlay.browser_exclude[*]", "safari"],
    ["read_updated_placement", "media_buys[0].packages[0].targeting_overlay.browser[*]", "chrome"],
    ["read_updated_placement", "media_buys[0].packages[0].targeting_overlay.browser[*]", "firefox"],
    ["read_updated_placement", "media_buys[0].packages[0].targeting_overlay.browser_exclude[*]", "unknown"],
  ]) {
    assert.equal(
      hasCheck(id, "field_contains", path, value),
      true,
      `${id} must grade browser value ${value}`
    );
  }
  for (const [id, path] of [
    ["create_feed_package", "packages[0].targeting_overlay.browser[3]"],
    ["create_feed_package", "packages[0].targeting_overlay.browser_exclude[1]"],
    ["update_to_short_video", "affected_packages[0].targeting_overlay.browser[2]"],
    ["update_to_short_video", "affected_packages[0].targeting_overlay.browser_exclude[1]"],
    ["read_updated_placement", "media_buys[0].packages[0].targeting_overlay.browser[2]"],
    ["read_updated_placement", "media_buys[0].packages[0].targeting_overlay.browser_exclude[1]"],
  ]) {
    assert.equal(
      hasCheck(id, "field_absent", path),
      true,
      `${id} must grade browser set cardinality at ${path}`
    );
  }
  assert.deepEqual(
    step("update_to_short_video").sample_request.packages[0].targeting_overlay.browser,
    ["chrome", "firefox"],
    "update must exercise later package-level browser selection"
  );
  assert.deepEqual(
    step("update_to_short_video").sample_request.packages[0].targeting_overlay
      .browser_exclude,
    ["unknown"],
    "update must exercise later package-level browser exclusion"
  );
  assert.equal(
    hasCheck(
      "reject_incompatible_browser_platform",
      "error_code",
      undefined,
      "UNSUPPORTED_FEATURE"
    ),
    true,
    "an unenforceable browser and device intersection must be rejected"
  );
  assert.deepEqual(
    step("reject_incompatible_browser_platform").sample_request.packages[0]
      .targeting_overlay,
    {
      geo_countries: ["US"],
      device_platform: ["android"],
      device_platform_exclude: ["fire_os"],
      browser: ["safari"],
      browser_exclude: ["unknown"],
      property_list: {
        agent_url: "https://governance.pinnacle-agency.example",
        list_id: "acme_outdoor_allowlist_v1",
      },
      collection_list: {
        agent_url: "https://governance.pinnacle-agency.example",
        list_id: "acme_outdoor_collections_v1",
      },
      placement_selection: {
        mode: "selected",
        placement_refs: [
          {
            publisher_domain: "pinnacle-media.example",
            placement_id: "short_video",
          },
        ],
      },
    },
    "the negative vector must be otherwise-complete replacement targeting"
  );

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
        {
          operation: "remove_values",
          path: "/device_platform_exclude",
          values: ["fire_os"],
          reason: "The configured offer cannot preserve this exclusion.",
        },
        {
          operation: "remove_values",
          path: "/browser",
          values: ["safari"],
          reason: "No forecastable Safari inventory is available for the discovery scope.",
        },
        {
          operation: "remove_values",
          path: "/browser_exclude",
          values: ["unknown"],
          reason: "The configured offer cannot preserve this exclusion.",
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
  const [validate, validateSupport] = await Promise.all([
    compile("/schemas/core/targeting-overlay-requirements.json"),
    compile("/schemas/core/targeting-overlay-support.json"),
  ]);

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
  for (const zeroCapability of [
    { geo_postal_areas: {} },
    { geo_postal_areas: { us_zip: false } },
    {
      geo_proximity: {
        radius: false,
        travel_time: false,
        geometry: false,
      },
    },
  ]) {
    assert.equal(
      validate(zeroCapability),
      false,
      `requirements reject zero-capability object ${JSON.stringify(zeroCapability)}`
    );
    assert.equal(
      validateSupport(zeroCapability),
      false,
      `support rejects zero-capability object ${JSON.stringify(zeroCapability)}`
    );
  }
  assert.equal(
    validateSupport({ geo_proximity: { ext: { vendor: "hint" } } }),
    false,
    "extension-only support cannot satisfy a capability requirement"
  );
  assert.equal(
    validateSupport({ geo_proximity: { radius: true } }),
    true,
    errors(validateSupport)
  );

  const requirements = JSON.parse(
    fs.readFileSync(
      path.join(SCHEMA_ROOT, "core", "targeting-overlay-requirements.json"),
      "utf8"
    )
  );
  const support = JSON.parse(
    fs.readFileSync(
      path.join(SCHEMA_ROOT, "core", "targeting-overlay-support.json"),
      "utf8"
    )
  );
  for (const description of [requirements.description, support.description]) {
    assert.match(description, /requirement value of true|requirement true/i);
    assert.match(description, /support true|matches true/i);
    assert.match(description, /numeric seller limits|numeric limits/i);
  }
});

test("product identity and forecast semantics distinguish wholesale from custom offers", () => {
  const product = JSON.parse(
    fs.readFileSync(path.join(SCHEMA_ROOT, "core", "product.json"), "utf8")
  );
  assert.match(product.properties.product_id.description, /non-custom wholesale/i);
  assert.match(product.properties.product_id.description, /cache_scope/);
  assert.match(product.properties.product_id.description, /is_custom: true/);
  assert.match(product.properties.forecast.description, /discovery\/default scope/);
  assert.match(product.properties.forecast.description, /concrete targeting_overlay/);
  assert.match(product.properties.pricing_options.description, /Fixed prices/);
  assert.match(product.properties.pricing_options.description, /price_guidance/);
  assert.match(product.properties.pricing_options.description, /uniform-price promise/);
  assert.match(product.properties.product_id.description, /new pricing_option_id/);
  assert.match(product.properties.expires_at.description, /PRODUCT_NOT_FOUND/);
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

test("targeting resolution requires expiration without tightening legacy custom products", async () => {
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
    true,
    "a legacy is_custom product without targeting_resolution remains schema-valid"
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
