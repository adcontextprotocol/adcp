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

describe("spot-level as-run delivery reporting", () => {
  let validateRequest;
  let validateSpot;
  let validateCapabilities;
  let spotSchema;

  before(async () => {
    const request = readSchema(
      "/schemas/media-buy/get-media-buy-delivery-request.json"
    );
    const response = readSchema(
      "/schemas/media-buy/get-media-buy-delivery-response.json"
    );
    const byPackage =
      response.properties.media_buy_deliveries.items.properties.by_package.items;
    const byPackageExtension = byPackage.allOf.find(
      (schema) => schema.properties
    );
    spotSchema = byPackageExtension.properties.by_spot.items;

    [validateRequest, validateSpot, validateCapabilities] = await Promise.all([
      compile(request),
      compile(spotSchema),
      compile(readSchema("/schemas/core/reporting-capabilities.json")),
    ]);
  });

  it("accepts an opt-in complete spot log request and rejects invalid limits", () => {
    assert.equal(validateRequest({ reporting_dimensions: { spot: {} } }), true);
    assert.equal(
      validateRequest({ reporting_dimensions: { spot: { limit: 100 } } }),
      true
    );
    assert.equal(
      validateRequest({ reporting_dimensions: { spot: { limit: 0 } } }),
      false
    );
  });

  it("uses one channel-neutral row shape for TV and radio airings", () => {
    for (const row of [
      {
        spot_id: "spot_tv_001",
        creative_id: "creative_tv_30s",
        aired_at: "2026-08-15T20:14:00Z",
        network: "USA Network",
        station: "WABC-TV",
        daypart: "prime_time",
        impressions: 40000,
        spend: 1250,
      },
      {
        spot_id: "spot_radio_001",
        aired_at: "2026-08-15T07:30:00Z",
        station: "WNYC-FM",
        daypart: "morning_drive",
        impressions: 18000,
      },
    ]) {
      assert.equal(validateSpot(row), true, JSON.stringify(validateSpot.errors));
    }
  });

  it("optionally identifies the creative aired in each spot occurrence", () => {
    const spotFields = spotSchema.allOf.find(
      (schema) => schema.properties
    ).properties;
    assert.equal(spotFields.creative_id["x-entity"], "creative");

    const airing = {
      spot_id: "spot_rotation_001",
      creative_id: "creative_rotation_a",
      aired_at: "2026-08-15T20:14:00Z",
    };
    assert.equal(validateSpot(airing), true, JSON.stringify(validateSpot.errors));
    assert.equal(
      validateSpot({ ...airing, creative_id: "" }),
      false,
      "creative identity cannot be empty"
    );
    delete airing.creative_id;
    assert.equal(validateSpot(airing), true, "creative identity remains optional");
  });

  it("requires stable identity and an RFC 3339 airing timestamp, not impressions", () => {
    const asRunOnly = {
      spot_id: "spot_live_001",
      aired_at: "2026-08-15T20:14:00Z",
    };
    assert.equal(
      validateSpot(asRunOnly),
      true,
      JSON.stringify(validateSpot.errors)
    );
    assert.equal(
      validateSpot({ ...asRunOnly, impressions: 0 }),
      true,
      "measured zero is explicit"
    );
    assert.equal(
      validateSpot({ ...asRunOnly, impressions: null }),
      false,
      "unavailable is omitted, not null"
    );
    assert.equal(validateSpot({ spot_id: "spot_bad", aired_at: "not-a-time" }), false);
    assert.equal(validateSpot({ aired_at: "2026-08-15T20:14:00Z" }), false);
    assert.equal(validateSpot({ spot_id: "spot_missing_time" }), false);
  });

  it("advertises spot support on both reporting capability surfaces", () => {
    for (const uri of [
      "/schemas/core/reporting-capabilities.json",
      "/schemas/core/canonical-reporting-capabilities.json",
    ]) {
      const schema = readSchema(uri);
      assert.equal(
        schema.properties.supports_spot_breakdown.$ref,
        "/schemas/core/spot-reporting-capability.json",
        uri
      );
    }

    const capabilities = {
      available_reporting_frequencies: ["daily"],
      expected_delay_minutes: 60,
      timezone: "UTC",
      supports_webhooks: true,
      available_metrics: ["impressions", "spend"],
      date_range_support: "date_range",
      supports_spot_breakdown: { available_metrics: ["impressions"] },
    };
    assert.equal(
      validateCapabilities(capabilities),
      true,
      JSON.stringify(validateCapabilities.errors)
    );
    capabilities.supports_spot_breakdown.available_metrics = [];
    assert.equal(
      validateCapabilities(capabilities),
      true,
      "airing-only reporting is explicit"
    );
  });
});

describe("spot lifecycle, makegood linkage and break position (experimental, 3.3)", () => {
  const DIST_32 = path.join(__dirname, "..", "dist", "schemas", "3.2.3");
  let validateSpot;
  let validateSpot32;
  let validateCapabilities;

  function spotItem(response) {
    const byPackage =
      response.properties.media_buy_deliveries.items.properties.by_package.items;
    return byPackage.allOf.find((schema) => schema.properties).properties.by_spot
      .items;
  }

  before(async () => {
    const response = readSchema(
      "/schemas/media-buy/get-media-buy-delivery-response.json"
    );
    const response32 = JSON.parse(
      fs.readFileSync(
        path.join(DIST_32, "media-buy", "get-media-buy-delivery-response.json"),
        "utf8"
      )
    );
    const ajv32 = new Ajv({
      allErrors: true,
      strict: false,
      loadSchema: async (ref) =>
        JSON.parse(
          fs.readFileSync(
            path.join(
              DIST_32,
              ref.replace("https://adcontextprotocol.org/schemas/3.2.3/", "")
            ),
            "utf8"
          )
        ),
    });
    addFormats(ajv32);
    [validateSpot, validateSpot32, validateCapabilities] = await Promise.all([
      compile(spotItem(response)),
      ajv32.compileAsync(spotItem(response32)),
      compile(readSchema("/schemas/core/spot-reporting-capability.json")),
    ]);
  });

  // Clone a row, optionally setting fields; `undefined` removes the field.
  function row(base, changes = {}) {
    const copy = { ...base };
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) delete copy[key];
      else copy[key] = value;
    }
    return copy;
  }

  // Assert the row is rejected and that a `required` or `not` keyword names the field.
  function assertRejectedFor(spot, field, message) {
    assert.equal(validateSpot(spot), false, message);
    const hit = validateSpot.errors.some(
      (error) =>
        error.params?.missingProperty === field ||
        (error.keyword === "not" && JSON.stringify(spot).includes(`"${field}"`))
    );
    assert.equal(hit, true, `${message}: ${JSON.stringify(validateSpot.errors)}`);
  }

  const scheduled = {
    spot_id: "spot_plan_001",
    spot_status: "scheduled",
    scheduled_at: "2026-11-15T20:00:00Z",
    network: "Pinnacle One",
    grps: 2.1,
    break_position: { position_in_break: 2, spots_in_break: 5, break_id: "brk_2000" },
  };
  const aired = {
    spot_id: "spot_plan_001",
    spot_status: "aired",
    scheduled_at: "2026-11-15T20:00:00Z",
    aired_at: "2026-11-15T20:02:00Z",
    grps: 1.9,
  };
  const preempted = {
    spot_id: "spot_plan_002",
    spot_status: "preempted",
    scheduled_at: "2026-11-15T21:00:00Z",
  };
  const makegood = {
    spot_id: "spot_plan_009",
    spot_status: "makegood",
    aired_at: "2026-11-17T20:05:00Z",
    replaces_spot_id: "spot_plan_002",
  };

  it("tracks one spot_id from scheduled to aired, or to preempted with a makegood", () => {
    for (const row of [scheduled, aired, preempted, makegood]) {
      assert.equal(validateSpot(row), true, JSON.stringify(validateSpot.errors));
    }
  });

  it("keeps rows without spot_status valid and meaning aired", () => {
    const legacy = { spot_id: "spot_old_001", aired_at: "2026-08-15T20:14:00Z" };
    assert.equal(validateSpot(legacy), true);
    assert.equal(validateSpot32(legacy), true);
    assert.equal(validateSpot({ spot_id: "spot_old_002" }), false);
    assert.equal(validateSpot({ ...legacy, spot_status: "aired", aired_at: undefined }), false);
  });

  it("requires aired_at only on aired and makegood rows", () => {
    assertRejectedFor(row(aired, { aired_at: undefined }), "aired_at", "aired needs aired_at");
    assertRejectedFor(row(makegood, { aired_at: undefined }), "aired_at", "makegood needs aired_at");
    assertRejectedFor(
      row(scheduled, { aired_at: "2026-11-15T20:02:00Z" }),
      "aired_at",
      "scheduled forbids aired_at"
    );
    assertRejectedFor(
      row(preempted, { aired_at: "2026-11-15T21:02:00Z" }),
      "aired_at",
      "preempted forbids aired_at"
    );
    assert.equal(validateSpot(row(makegood, { scheduled_at: "2026-11-17T20:00:00Z" })), true);
  });

  it("requires scheduled_at on scheduled and preempted rows", () => {
    assertRejectedFor(row(scheduled, { scheduled_at: undefined }), "scheduled_at", "scheduled");
    assertRejectedFor(row(preempted, { scheduled_at: undefined }), "scheduled_at", "preempted");
  });

  it("carries replaces_spot_id on planned, preempted and made-good replacements", () => {
    const planned = row(scheduled, {
      scheduled_at: "2026-11-17T20:00:00Z",
      replaces_spot_id: "spot_plan_002",
    });
    assert.equal(validateSpot(planned), true, "planned makegood is linked before airing");
    assert.equal(
      validateSpot(row(planned, { spot_status: "preempted" })),
      true,
      "a preempted replacement keeps the chain to the original spot"
    );
  });

  it("requires replaces_spot_id on makegood rows and forbids it on aired rows", () => {
    assertRejectedFor(
      row(makegood, { replaces_spot_id: undefined }),
      "replaces_spot_id",
      "makegood needs the link"
    );
    assertRejectedFor(
      row(aired, { replaces_spot_id: "spot_plan_002" }),
      "replaces_spot_id",
      "aired forbids the link"
    );
    assertRejectedFor(
      { spot_id: "x", aired_at: "2026-11-15T20:02:00Z", replaces_spot_id: "y" },
      "replaces_spot_id",
      "absent status means aired"
    );
    assert.equal(validateSpot(row(makegood, { replaces_spot_id: "" })), false, "link cannot be empty");
  });

  it("annotates replaces_spot_id like spot_id and marks new fields experimental", () => {
    const fields = spotItem(
      readSchema("/schemas/media-buy/get-media-buy-delivery-response.json")
    ).allOf.find((schema) => schema.properties).properties;
    assert.equal(fields.replaces_spot_id["x-entity"], fields.spot_id["x-entity"]);
    for (const name of ["spot_status", "scheduled_at", "replaces_spot_id", "break_position"]) {
      assert.equal(fields[name]["x-status"], "experimental", name);
    }
    assert.equal(readSchema("/schemas/enums/spot-status.json")["x-status"], "experimental");
  });

  it("validates break_position bounds", () => {
    const base = { ...aired };
    assert.equal(validateSpot({ ...base, break_position: { position_in_break: 1, spots_in_break: 1 } }), true);
    assert.equal(validateSpot({ ...base, break_position: { position_in_break: 0, spots_in_break: 3 } }), false);
    assert.equal(validateSpot({ ...base, break_position: { position_in_break: 1.5, spots_in_break: 3 } }), false);
    assert.equal(validateSpot({ ...base, break_position: { position_in_break: 1 } }), false);
    assert.equal(validateSpot({ ...base, break_position: { spots_in_break: 3 } }), false);
    assert.equal(validateSpot({ ...base, spot_status: "bumped" }), false);
    assert.equal(validateSpot({ ...base, spot_status: null }), false);
  });

  it("shows why 3.2 callers must not receive non-aired rows, and tolerates new fields on aired rows", () => {
    assert.equal(validateSpot32(scheduled), false, "3.2 requires aired_at on every row");
    assert.equal(validateSpot32(preempted), false, "3.2 requires aired_at on every row");
    assert.equal(validateSpot32(aired), true, "aired rows stay 3.2-valid");
    assert.equal(validateSpot32(makegood), true, "makegood rows stay 3.2-valid");
  });

  it("declares which lifecycle fields the seller reports", () => {
    const base = { available_metrics: ["impressions"] };
    assert.equal(validateCapabilities(base), true);
    assert.equal(
      validateCapabilities({
        ...base,
        available_statuses: ["scheduled", "preempted", "makegood"],
        supports_break_position: true,
      }),
      true,
      JSON.stringify(validateCapabilities.errors)
    );
    assert.equal(validateCapabilities({ ...base, available_statuses: ["bumped"] }), false);
    assert.equal(validateCapabilities({ ...base, unknown_field: true }), false, "closed object");
    const capSchema = readSchema("/schemas/core/spot-reporting-capability.json");
    for (const name of ["available_statuses", "supports_break_position"]) {
      assert.equal(capSchema.properties[name]["x-status"], "experimental", name);
    }
    assert.equal(
      validateCapabilities({ ...base, available_statuses: ["scheduled", "scheduled"] }),
      false
    );
  });
});
