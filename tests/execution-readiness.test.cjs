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

function validationMessage(validate) {
  return JSON.stringify(validate.errors, null, 2);
}

const EVENT_SOURCE = { kind: "event_source", event_types: ["purchase"] };
const CATALOG = { kind: "catalog", catalog_types: ["app"] };
const CONNECTION = {
  kind: "downstream_connection",
  connection: {
    connection_type: "publisher_identity",
    scope: "identity",
    required_for: ["create_media_buy"],
  },
};

const ES_BINDING =
  "packages[].optimization_goals[].event_sources[].event_source_id";
const CATALOG_BINDING = "packages[].catalogs[]";

const READY_EVENT_SOURCE = {
  requirement: EVENT_SOURCE,
  status: "ready",
  binding_field: ES_BINDING,
  resolved: {
    resource_id: "es_main",
    name: "Main pixel",
  },
};
const SELECTION_EVENT_SOURCE = {
  requirement: EVENT_SOURCE,
  status: "selection_required",
  binding_field: ES_BINDING,
  candidates: [
    { resource_id: "es_main", name: "Main pixel" },
    { resource_id: "es_checkout", name: "Checkout pixel" },
  ],
};
const SETUP_EVENT_SOURCE = {
  requirement: EVENT_SOURCE,
  status: "setup_required",
  issues: [
    {
      severity: "error",
      message:
        "No event source on the account. Register one with sync_event_sources.",
    },
  ],
};
const INPUT_CATALOG = {
  requirement: CATALOG,
  status: "input_required",
  issues: [
    {
      severity: "info",
      message: "Supply an inline app catalog on the package.",
    },
  ],
};
const UNKNOWN_CATALOG = {
  requirement: CATALOG,
  status: "unknown",
  unknown_reason: "permission_denied",
};
const connection = (status, extra = {}) => ({
  requirement: CONNECTION,
  status: {
    connected: "ready",
    missing: "setup_required",
    pending: "setup_required",
    expired: "setup_required",
    revoked: "setup_required",
    unknown: "unknown",
  }[status],
  connection_state: {
    connection_type: "publisher_identity",
    provider: "social.example",
    scope: "identity",
    status,
    ...extra,
  },
  ...(status === "unknown" ? { unknown_reason: "platform_unavailable" } : {}),
});

// The documented rollup: the first blocking state any requirement reports.
const ROLLUP_ORDER = [
  "setup_required",
  "input_required",
  "selection_required",
  "unknown",
];
function rollup(requirements) {
  for (const status of ROLLUP_ORDER) {
    if (requirements.some((r) => r.status === status)) return status;
  }
  return "ready";
}

test("status enum is the five-value readiness vocabulary", () => {
  const schema = readJson("enums/execution-readiness-status.json");
  assert.deepEqual(schema.enum, [
    "ready",
    "setup_required",
    "selection_required",
    "input_required",
    "unknown",
  ]);
  assert.deepEqual(Object.keys(schema.enumDescriptions), schema.enum);
});

test("every requirement state has a valid shape", async () => {
  const validate = await compileSchema(
    "/schemas/core/execution-requirement-readiness.json",
  );
  const valid = [
    READY_EVENT_SOURCE,
    {
      requirement: CATALOG,
      status: "ready",
      binding_field: CATALOG_BINDING,
      resolved: { resource_id: "cat_app_1" },
    },
    SELECTION_EVENT_SOURCE,
    SETUP_EVENT_SOURCE,
    INPUT_CATALOG,
    UNKNOWN_CATALOG,
    { ...UNKNOWN_CATALOG, unknown_reason: "not_evaluated" },
    connection("connected", {
      resource_ref: { identity_id: "pg_1", handle: "Brand FR" },
    }),
    connection("missing", {
      authorization_url: "https://social.example/connect",
    }),
    connection("pending", { provider: "social.example" }),
    connection("expired", {
      authorization_url: "https://social.example/connect",
    }),
    connection("revoked", {
      authorization_url: "https://social.example/connect",
    }),
    connection("unknown"),
    {
      ...connection("connected"),
      connection_state: {
        connection_type: "advertiser_account",
        status: "not_required",
      },
    },
  ];
  for (const entry of valid) {
    assert.equal(
      validate(entry),
      true,
      `${JSON.stringify(entry)}\n${validationMessage(validate)}`,
    );
  }
});

test("could not check is distinct from lacks: unknown needs a reason and carries no resources", async () => {
  const validate = await compileSchema(
    "/schemas/core/execution-requirement-readiness.json",
  );
  const { unknown_reason: _omit, ...noReason } = UNKNOWN_CATALOG;
  const invalid = [
    [noReason, "unknown without unknown_reason"],
    [
      { ...UNKNOWN_CATALOG, unknown_reason: "no_pixel" },
      "unknown_reason is a closed vocabulary",
    ],
    [
      { ...UNKNOWN_CATALOG, resolved: { resource_id: "cat_app_1" } },
      "unknown must not carry a resolved resource",
    ],
    [
      { ...UNKNOWN_CATALOG, candidates: SELECTION_EVENT_SOURCE.candidates },
      "unknown must not carry candidates",
    ],
    [
      { ...SETUP_EVENT_SOURCE, unknown_reason: "permission_denied" },
      "unknown_reason is only for unknown",
    ],
  ];
  for (const [entry, why] of invalid) {
    assert.equal(validate(entry), false, why);
  }
});

test("status and resource fields stay consistent", async () => {
  const validate = await compileSchema(
    "/schemas/core/execution-requirement-readiness.json",
  );
  const { resolved: _resolved, ...readyWithoutResolved } = READY_EVENT_SOURCE;
  const invalid = [
    [
      readyWithoutResolved,
      "ready event_source must name the resolved resource it still has to bind",
    ],
    [
      {
        ...SELECTION_EVENT_SOURCE,
        candidates: [SELECTION_EVENT_SOURCE.candidates[0]],
      },
      "selection_required needs at least two candidates",
    ],
    [
      { ...SELECTION_EVENT_SOURCE, resolved: READY_EVENT_SOURCE.resolved },
      "selection_required must not also resolve one",
    ],
    [
      { ...SETUP_EVENT_SOURCE, candidates: SELECTION_EVENT_SOURCE.candidates },
      "candidates are only for selection_required",
    ],
    [
      { ...SETUP_EVENT_SOURCE, resolved: READY_EVENT_SOURCE.resolved },
      "resolved is only for ready",
    ],
    [
      { ...READY_EVENT_SOURCE, resolved: { name: "no id" } },
      "resolved needs a resource_id",
    ],
    [{ requirement: EVENT_SOURCE }, "status is required"],
    [{ status: "ready" }, "requirement is required"],
  ];
  for (const [entry, why] of invalid) {
    assert.equal(validate(entry), false, why);
  }
});

test("downstream_connection readiness derives from connection_state and has no candidates", async () => {
  const validate = await compileSchema(
    "/schemas/core/execution-requirement-readiness.json",
  );
  const connected = connection("connected");
  const missing = connection("missing", {
    authorization_url: "https://social.example/connect",
  });
  const { connection_state: _state, ...noState } = connected;
  const invalid = [
    [noState, "downstream_connection requires connection_state"],
    [
      {
        ...connected,
        status: "setup_required",
        connection_state: {
          connection_type: "advertiser_account",
          status: "not_required",
        },
      },
      "not_required connection is ready",
    ],
    [
      { ...connected, status: "setup_required" },
      "connected connection is ready",
    ],
    [{ ...missing, status: "ready" }, "missing connection is setup_required"],
    [
      { ...connection("pending"), status: "ready" },
      "pending connection is setup_required",
    ],
    [
      { ...connection("unknown"), status: "setup_required" },
      "unknown connection is unknown",
    ],
    [
      {
        ...connected,
        status: "selection_required",
        candidates: SELECTION_EVENT_SOURCE.candidates,
      },
      "no identity candidates in this slice",
    ],
    [
      { ...connected, status: "input_required" },
      "input_required applies to bound kinds only",
    ],
    [
      { ...connected, resolved: { resource_id: "pg_1" } },
      "no resolved resource for connections",
    ],
    [
      { ...connected, binding_field: "packages[].identity" },
      "connections have no binding field",
    ],
    [
      { ...READY_EVENT_SOURCE, connection_state: connected.connection_state },
      "connection_state is only for connection requirements",
    ],
    [
      {
        ...connected,
        connection_state: { connection_type: "publisher_identity" },
      },
      "connection_state needs a status",
    ],
  ];
  for (const [entry, why] of invalid) {
    assert.equal(validate(entry), false, why);
  }
});

test("product rollup is the first blocking state and is derivable", async () => {
  const validate = await compileSchema(
    "/schemas/core/product-execution-readiness.json",
  );
  const cases = [
    [[READY_EVENT_SOURCE, connection("connected")], "ready"],
    [[READY_EVENT_SOURCE, SELECTION_EVENT_SOURCE], "selection_required"],
    [[SELECTION_EVENT_SOURCE, UNKNOWN_CATALOG], "selection_required"],
    [[READY_EVENT_SOURCE, UNKNOWN_CATALOG], "unknown"],
    [[SELECTION_EVENT_SOURCE, INPUT_CATALOG], "input_required"],
    [[INPUT_CATALOG, SETUP_EVENT_SOURCE, UNKNOWN_CATALOG], "setup_required"],
  ];
  for (const [requirements, expected] of cases) {
    assert.equal(rollup(requirements), expected);
    assert.equal(
      validate({ status: expected, requirements }),
      true,
      validationMessage(validate),
    );
  }
  assert.equal(
    validate({ status: "ready", requirements: [] }),
    false,
    "requirements is non-empty",
  );
  assert.equal(
    validate({ requirements: [READY_EVENT_SOURCE] }),
    false,
    "status is required",
  );
});

test("the readiness map rides on a public-scope response", async () => {
  const validate = await compileSchema(
    "/schemas/media-buy/get-products-response.json",
  );
  const execution_readiness = {
    version: "er_7f3a",
    evaluated_at: "2026-10-06T12:00:00Z",
    products: {
      social_conversions: {
        status: "selection_required",
        requirements: [SELECTION_EVENT_SOURCE, connection("connected")],
      },
    },
  };
  const product = {
    product_id: "social_conversions",
    name: "Social conversions",
    description: "In-feed conversion placements.",
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
    conversion_tracking: { action_sources: ["website"] },
    execution_requirements: [EVENT_SOURCE, CONNECTION],
  };
  const base = {
    adcp_version: "3.3",
    status: "completed",
    products: [product],
    cache_scope: "public",
    wholesale_feed_version: "wf_1",
  };
  assert.equal(
    validate(base),
    true,
    `without the map\n${validationMessage(validate)}`,
  );
  assert.equal(
    validate({ ...base, execution_readiness }),
    true,
    `public cache_scope with the map\n${validationMessage(validate)}`,
  );
  assert.equal(
    validate({
      ...base,
      execution_readiness: { products: execution_readiness.products },
    }),
    false,
    "the map is versioned separately, so version is required",
  );
  assert.equal(
    validate({
      ...base,
      execution_readiness: {
        ...execution_readiness,
        products: { p: { status: "ready" } },
      },
    }),
    false,
    "a map entry needs requirements",
  );

  const schema = readJson("media-buy/get-products-response.json");
  assert.ok(
    !schema.required?.includes("execution_readiness"),
    "the map is optional",
  );
  assert.equal(
    schema.properties.execution_readiness["x-status"],
    "experimental",
  );
});

test("the request flag is optional, boolean, and experimental", async () => {
  const validate = await compileSchema(
    "/schemas/media-buy/get-products-request.json",
  );
  const request = {
    buying_mode: "wholesale",
    account: { account_id: "acct_1" },
  };
  assert.equal(validate(request), true, validationMessage(validate));
  assert.equal(
    validate({ ...request, include_execution_readiness: true }),
    true,
    validationMessage(validate),
  );
  assert.equal(
    validate({ ...request, include_execution_readiness: "yes" }),
    false,
  );
  const schema = readJson("media-buy/get-products-request.json");
  assert.deepEqual(schema.required, ["buying_mode"]);
  assert.equal(
    schema.properties.include_execution_readiness["x-status"],
    "experimental",
  );
});

test("schema examples validate against their own schemas", async () => {
  for (const uri of ["/schemas/core/execution-requirement-readiness.json"]) {
    const validate = await compileSchema(uri);
    const schema = await loadSchema(uri);
    assert.ok(schema.examples.length > 0, `${uri} should carry examples`);
    for (const example of schema.examples) {
      assert.equal(
        validate(example),
        true,
        `${uri}\n${validationMessage(validate)}`,
      );
    }
  }
});

test("requirement readiness mirrors the declared requirement kinds", async () => {
  const requirements = readJson("core/product-execution-requirement.json");
  const kinds = requirements.oneOf.map((v) => v.properties.kind.const);
  assert.deepEqual(kinds, ["event_source", "catalog", "downstream_connection"]);
  const validate = await compileSchema(
    "/schemas/core/execution-requirement-readiness.json",
  );
  assert.equal(
    validate({
      requirement: { kind: "lead_form" },
      status: "unknown",
      unknown_reason: "not_evaluated",
    }),
    false,
    "readiness cannot name a kind the requirement vocabulary does not declare",
  );
});
