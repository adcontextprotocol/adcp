const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const Ajv = require("ajv");
const addFormats = require("ajv-formats");

const ROOT = path.join(__dirname, "..");
const SCHEMA_ROOT = path.join(ROOT, "static", "schemas", "source");

async function loadSchema(uri) {
  if (!uri.startsWith("/schemas/")) {
    throw new Error(`Unexpected schema URI: ${uri}`);
  }
  return JSON.parse(
    fs.readFileSync(path.join(SCHEMA_ROOT, uri.slice("/schemas/".length)), "utf8")
  );
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

function countryPrefixesMatch(value) {
  return Object.entries(value.countries).every(([country, selection]) =>
    !selection.values || selection.values.every((code) => code.startsWith(`${country}-`))
  );
}

function requirementMatches(requirement, support) {
  if (support === true) return true;
  if (requirement === true) return Boolean(support);

  return Object.entries(requirement.countries).every(([country, requested]) => {
    const offered = support.countries[country];
    if (!offered) return false;
    if (requested.all_values) return offered.all_values === true;
    if (offered.all_values) return true;
    const offeredValues = new Set(offered.values || []);
    return requested.values.every((value) => offeredValues.has(value));
  });
}

test("region requirements and support are country/value aware", async () => {
  const [validateRequirement, validateSupport] = await Promise.all([
    compile("/schemas/core/geo-region-requirement.json"),
    compile("/schemas/core/geo-region-support.json"),
  ]);

  const requirement = {
    countries: {
      US: { all_values: true },
      FR: { values: ["FR-49", "FR-2A", "FR-971"] },
    },
  };
  const support = {
    countries: {
      US: { all_values: true },
      FR: { values: ["FR-49", "FR-2A", "FR-971", "FR-ARA"] },
    },
    catalog_version: "2026-08",
    as_of: "2026-08-01",
    max_values_per_package: 50,
  };

  assert.equal(validateRequirement(requirement), true, errors(validateRequirement));
  assert.equal(validateSupport(support), true, errors(validateSupport));
  assert.equal(countryPrefixesMatch(requirement), true);
  assert.equal(countryPrefixesMatch(support), true);
  assert.equal(requirementMatches(requirement, support), true);

  for (const schemaUri of [
    "/schemas/core/geo-region-requirement.json",
    "/schemas/core/geo-region-support.json",
  ]) {
    const schema = await loadSchema(schemaUri);
    const annotation = schema["x-adcp-validation"];
    assert.deepEqual(
      annotation.verifier_constraints.country_prefix_matches_map_key,
      { map_field: "countries", values_field: "values" }
    );
    assert.match(annotation.spec, /targeting\.mdx#geo_regions$/);
  }

  assert.equal(
    validateRequirement({ countries: { FR: { all_values: true, values: ["FR-49"] } } }),
    false,
    "country selection cannot mix exhaustive and finite claims"
  );
  assert.equal(
    validateSupport({ countries: { FR: { values: [] } } }),
    false,
    "finite support is never empty"
  );
  assert.equal(
    validateSupport({ countries: { France: { all_values: true } } }),
    false,
    "country keys use ISO alpha-2 codes"
  );
  assert.equal(
    countryPrefixesMatch({ countries: { FR: { values: ["US-CA"] } } }),
    false,
    "conformance validation rejects a subdivision under the wrong country key"
  );
});

test("region requirement matching uses exact containment", () => {
  const finite = {
    countries: {
      FR: { values: ["FR-49", "FR-2A", "FR-971"] },
    },
  };
  const exhaustive = { countries: { FR: { all_values: true } } };

  assert.equal(
    requirementMatches({ countries: { FR: { values: ["FR-49", "FR-971"] } } }, finite),
    true
  );
  assert.equal(
    requirementMatches({ countries: { FR: { values: ["FR-ARA"] } } }, finite),
    false
  );
  assert.equal(
    requirementMatches({ countries: { FR: { values: ["FR-ARA"] } } }, exhaustive),
    true
  );
  assert.equal(requirementMatches({ countries: { FR: { all_values: true } } }, finite), false);
  assert.equal(requirementMatches({ countries: { FR: { all_values: true } } }, exhaustive), true);
  assert.equal(requirementMatches(true, finite), true);
  assert.equal(requirementMatches(exhaustive, true), true);
});

test("targeting-aware discovery accepts structured region include and exclude support", async () => {
  const [validateRequest, validateProduct] = await Promise.all([
    compile("/schemas/media-buy/get-products-request.json"),
    compile("/schemas/core/product.json"),
  ]);

  const request = {
    buying_mode: "brief",
    brief: "Regional campaign with deferred holdouts",
    targeting_overlay: { geo_regions: ["FR-49"] },
    required_overlay_support: {
      geo_regions: { countries: { FR: { values: ["FR-2A", "FR-971"] } } },
      geo_regions_exclude: { countries: { FR: { all_values: true } } },
    },
  };
  assert.equal(validateRequest(request), true, errors(validateRequest));

  const product = {
    product_id: "configured_fr_regions",
    name: "Configured French regional inventory",
    description: "A fictional region-targetable product.",
    publisher_properties: [
      {
        publisher_domain: "pinnacle-media.example",
        selection_type: "by_id",
        property_ids: ["regional_display"],
      },
    ],
    delivery_type: "non_guaranteed",
    is_custom: true,
    expires_at: "2026-08-14T12:00:00Z",
    format_ids: [
      { agent_url: "https://creative.example", id: "display_300x250" },
    ],
    pricing_options: [
      {
        pricing_option_id: "fr_region_cpm",
        pricing_model: "cpm",
        currency: "EUR",
        floor_price: 4.25,
      },
    ],
    overlay_support: {
      geo_regions: {
        countries: { FR: { values: ["FR-2A", "FR-49", "FR-971"] } },
        max_values_per_package: 20,
      },
      geo_regions_exclude: {
        countries: { FR: { all_values: true } },
      },
    },
    reporting_capabilities: {
      available_reporting_frequencies: ["daily"],
      expected_delay_minutes: 60,
      timezone: "UTC",
      supports_webhooks: false,
      available_metrics: ["impressions", "spend"],
      date_range_support: "date_range",
    },
  };
  assert.equal(validateProduct(product), true, errors(validateProduct));
});

test("region include and exclude identities are disjoint", async () => {
  const validateTargeting = await compile("/schemas/core/targeting.json");
  assert.equal(
    validateTargeting({ geo_regions: ["FR-49"], geo_regions_exclude: ["FR-44"] }),
    true,
    errors(validateTargeting)
  );

  const targetingSchema = await loadSchema("/schemas/core/targeting.json");
  const rule = targetingSchema.properties.geo_regions_exclude["x-adcp-validation"];
  assert.equal(rule.disjoint_with, "geo_regions");
  assert.match(rule.spec, /targeting\.mdx#geo_regions_exclude$/);
  const overlap = (overlay) =>
    overlay.geo_regions_exclude.some((value) => overlay.geo_regions.includes(value));
  assert.equal(
    overlap({ geo_regions: ["FR-49"], geo_regions_exclude: ["FR-49"] }),
    true,
    "conformance tooling rejects the same subdivision in both directions"
  );
});

test("seller capabilities retain boolean compatibility and add precise region directions", async () => {
  const [validate, capabilitiesSchema, supportSchema] = await Promise.all([
    compile("/schemas/protocol/get-adcp-capabilities-response.json"),
    loadSchema("/schemas/protocol/get-adcp-capabilities-response.json"),
    loadSchema("/schemas/core/geo-region-support.json"),
  ]);
  const base = {
    status: "completed",
    adcp: { major_versions: [3], idempotency: { supported: false } },
    supported_protocols: ["media_buy"],
  };

  assert.equal(
    validate({
      ...base,
      media_buy: { execution: { targeting: { geo_regions: true } } },
    }),
    true,
    errors(validate)
  );

  assert.equal(
    validate({
      ...base,
      media_buy: {
        execution: {
          targeting: {
            geo_regions: {
              countries: {
                US: { all_values: true },
                FR: { values: ["FR-49", "FR-2A", "FR-971", "FR-ARA"] },
              },
              catalog_version: "2026-08",
              as_of: "2026-08-01",
            },
            geo_regions_exclude: {
              countries: { FR: { values: ["FR-49", "FR-971"] } },
            },
          },
        },
      },
    }),
    true,
    errors(validate)
  );

  const targetingProperties =
    capabilitiesSchema.properties.media_buy.properties.execution.properties.targeting.properties;
  for (const field of ["geo_regions", "geo_regions_exclude"]) {
    assert.match(targetingProperties[field].description, /individually supported/);
    assert.match(targetingProperties[field].description, /joint composability/);
    assert.match(targetingProperties[field].description, /same execution route or account/);
    assert.match(targetingProperties[field].description, /Only Product\.overlay_support/);
  }
  assert.match(supportSchema.description, /each declared value is individually supported/);
  assert.match(supportSchema.description, /binding set of executable targeting permissions/);
  assert.match(supportSchema.description, /does not itself guarantee inventory/);
});

test("region documentation binds exact execution and deterministic recovery", () => {
  const targeting = fs.readFileSync(
    path.join(ROOT, "docs", "media-buy", "advanced-topics", "targeting.mdx"),
    "utf8"
  );
  const issueSpec = fs.readFileSync(
    path.join(ROOT, "specs", "targeting-aware-product-discovery.md"),
    "utf8"
  );
  for (const phrase of [
    "configured discovery or refinement is the authoritative value-level preflight",
    "UNSUPPORTED_FEATURE",
    "INVALID_REQUEST",
    "PRODUCT_UNAVAILABLE",
    "REQUOTE_REQUIRED",
  ]) {
    assert.match(targeting, new RegExp(phrase));
  }
  assert.match(targeting, /MUST NOT silently widen/);
  assert.match(targeting, /REQUOTE_REQUIRED` remains update-only/);
  assert.match(
    targeting,
    /does not automatically include values introduced by a later catalog revision/
  );
  assert.match(issueSpec, /Inclusion and exclusion match independently/);
  assert.doesNotMatch(targeting, /TARGETING_TOO_NARROW/);
  assert.doesNotMatch(targeting, /resolve_geo_regions/);
});
