const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const Ajv = require("ajv");
const addFormats = require("ajv-formats");

const ROOT = path.join(__dirname, "..");
const SCHEMA_ROOT = path.join(ROOT, "static", "schemas", "source");

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), "utf8"));
}

async function loadSchema(uri) {
  if (!uri.startsWith("/schemas/")) throw new Error(`Unexpected schema URI: ${uri}`);
  return JSON.parse(
    fs.readFileSync(path.join(SCHEMA_ROOT, uri.slice("/schemas/".length)), "utf8")
  );
}

async function compile(uri) {
  const ajv = new Ajv({ allErrors: true, strict: false, loadSchema });
  addFormats(ajv);
  return ajv.compileAsync(await loadSchema(uri));
}

function errors(validate) {
  return JSON.stringify(validate.errors || []);
}

const account = { account_id: "acct_acmecorp" };
const identity = {
  catalog_id: "product-feed",
  catalog_generation: "catgen_01K2ABCD",
  item_id: "SKU-12345",
};

test("availability requests require immutable identity, revision guards, and valid transitions", async () => {
  const validate = await compile("/schemas/media-buy/sync-catalogs-request.json");
  const request = {
    idempotency_key: "d4a8f1b2-0123-489f-a123-45678901234d",
    account,
    item_availability_updates: [
      {
        ...identity,
        expected_overlay_revision: 0,
        action: "suppress",
        reason: "out_of_stock",
      },
    ],
    item_availability_queries: [identity],
  };

  assert.equal(validate(request), true, errors(validate));
  assert.equal(validate({ ...request, dry_run: true }), false);

  for (const missing of ["catalog_generation", "expected_overlay_revision"]) {
    const update = { ...request.item_availability_updates[0] };
    delete update[missing];
    assert.equal(validate({ ...request, item_availability_updates: [update] }), false);
  }

  const badOther = {
    ...request.item_availability_updates[0],
    reason: "other",
  };
  assert.equal(validate({ ...request, item_availability_updates: [badOther] }), false);

  const wrongDirection = {
    ...request.item_availability_updates[0],
    action: "restore",
    reason: "out_of_stock",
  };
  assert.equal(
    validate({ ...request, item_availability_updates: [wrongDirection] }),
    false
  );

  const expiringRestore = {
    ...request.item_availability_updates[0],
    action: "restore",
    reason: "back_in_stock",
    expires_at: "2027-08-16T12:00:00Z",
  };
  assert.equal(
    validate({ ...request, item_availability_updates: [expiringRestore] }),
    false
  );

  const queryWithoutGeneration = { ...identity };
  delete queryWithoutGeneration.catalog_generation;
  assert.equal(
    validate({
      idempotency_key: "e5b9a2c3-1234-48af-b234-56789012345e",
      account,
      item_availability_queries: [queryWithoutGeneration],
    }),
    false
  );
});

test("availability success is terminal and results expose exact correlation and state", async () => {
  const validate = await compile("/schemas/media-buy/sync-catalogs-response.json");
  const applied = {
    request_index: 0,
    ...identity,
    action: "suppress",
    status: "applied",
    availability: "suppressed",
    overlay_revision: 1,
    applied_at: "2026-08-16T08:30:00Z",
  };
  const success = {
    status: "completed",
    catalogs: [],
    item_availability_updates: [applied],
  };
  assert.equal(validate(success), true, errors(validate));

  for (const status of ["submitted", "working", "failed"]) {
    assert.equal(
      validate({ ...success, status }),
      false,
      `availability success cannot carry task status ${status}`
    );
  }

  const unchanged = {
    ...applied,
    status: "unchanged",
    availability: "suppressed",
  };
  delete unchanged.applied_at;
  assert.equal(
    validate({ ...success, item_availability_updates: [unchanged] }),
    true,
    errors(validate)
  );
  assert.equal(
    validate({
      ...success,
      item_availability_updates: [{ ...unchanged, availability: "active" }],
    }),
    false,
    "a successful suppress result must report suppressed state"
  );

  const failed = {
    request_index: 0,
    ...identity,
    action: "suppress",
    status: "failed",
    errors: [
      {
        code: "REFERENCE_NOT_FOUND",
        message: "Catalog item not found",
        recovery: "correctable",
      },
    ],
  };
  assert.equal(
    validate({ ...success, item_availability_updates: [failed] }),
    true,
    errors(validate)
  );
  for (const badError of [
    { ...failed.errors[0], message: "Hidden catalog exists" },
    { ...failed.errors[0], details: { catalog_exists: true } },
    { ...failed.errors[0], retry_after: 1 },
  ]) {
    assert.equal(
      validate({
        ...success,
        item_availability_updates: [{ ...failed, errors: [badError] }],
      }),
      false,
      "REFERENCE_NOT_FOUND has one closed, non-enumerating error shape"
    );
  }
  assert.equal(
    validate({
      ...success,
      item_availability_updates: [
        {
          ...failed,
          errors: [
            failed.errors[0],
            { code: "INVALID_REQUEST", message: "Hidden catalog exists" },
          ],
        },
      ],
    }),
    false,
    "a second error cannot leak metadata beside a reference failure"
  );
  assert.equal(
    validate({
      ...success,
      item_availability_updates: [{ ...failed, secret_platform_id: "leak" }],
    }),
    false,
    "failed update results cannot add resource metadata beside errors"
  );
  assert.equal(
    validate({
      ...success,
      item_availability_updates: [{ ...failed, overlay_revision: 1 }],
    }),
    false,
    "failed results cannot imply persisted state"
  );

  const state = {
    request_index: 0,
    ...identity,
    status: "found",
    availability: "active",
    overlay_revision: 2,
    updated_at: "2026-08-16T08:35:00Z",
  };
  assert.equal(
    validate({
      status: "completed",
      catalogs: [],
      item_availability_states: [state],
    }),
    true,
    errors(validate)
  );
  assert.equal(
    validate({
      status: "completed",
      catalogs: [],
      item_availability_states: [{ ...state, expires_at: "2027-01-01T00:00:00Z" }],
    }),
    false,
    "only suppressed state can carry an expiry"
  );

  const failedState = {
    request_index: 0,
    ...identity,
    status: "failed",
    errors: [failed.errors[0]],
  };
  assert.equal(
    validate({
      status: "completed",
      catalogs: [],
      item_availability_states: [failedState],
    }),
    true,
    errors(validate)
  );
  assert.equal(
    validate({
      status: "completed",
      catalogs: [],
      item_availability_states: [
        { ...failedState, errors: [{ ...failed.errors[0], catalog_exists: true }] },
      ],
    }),
    false,
    "query failures cannot expose resource-existence metadata"
  );
  assert.equal(
    validate({
      status: "completed",
      catalogs: [],
      item_availability_states: [
        {
          ...failedState,
          errors: [
            failed.errors[0],
            { code: "INVALID_REQUEST", message: "Hidden item exists" },
          ],
        },
      ],
    }),
    false,
    "a second query error cannot leak metadata beside a reference failure"
  );

  const strictFailure = {
    status: "failed",
    errors: [failed.errors[0]],
  };
  assert.equal(validate(strictFailure), true, errors(validate));
  assert.equal(
    validate({ ...strictFailure, secret_platform_id: "leak" }),
    false,
    "strict reference failures cannot add top-level resource metadata"
  );
  assert.equal(
    validate({ ...strictFailure, message: "Catalog exists in another account" }),
    false,
    "strict reference failures cannot leak through the envelope message"
  );
  assert.equal(
    validate({
      ...strictFailure,
      errors: [{ ...failed.errors[0], message: "Catalog generation is stale" }],
    }),
    false,
    "strict failures use the same normalized reference error"
  );
  assert.equal(
    validate({
      ...strictFailure,
      errors: [
        failed.errors[0],
        { code: "INVALID_REQUEST", message: "Hidden catalog exists" },
      ],
    }),
    false,
    "strict failures cannot append a leaking diagnostic error"
  );
  assert.equal(
    validate({
      ...strictFailure,
      adcp_error: { code: "INVALID_REQUEST", message: "Hidden catalog exists" },
    }),
    false,
    "strict failures cannot leak through a parallel adcp_error"
  );
  assert.equal(
    validate({
      status: "failed",
      errors: [
        {
          code: "REFERENCE_NOT_FOUND",
          message: "Catalog not found",
          field: "catalog_ids",
          recovery: "correctable",
        },
      ],
    }),
    true,
    "catalog-only filter errors retain their established diagnostic field"
  );
});

test("buyer feature filters stay concise while seller declarations retain dependencies", async () => {
  const validate = await compile("/schemas/core/media-buy-features.json");
  assert.equal(
    validate({ catalog_item_availability_updates: true }),
    true,
    "required_features can request availability support without seller output metadata"
  );
  const capabilities = readJson(
    "static/schemas/source/protocol/get-adcp-capabilities-response.json"
  );
  const sellerFeatures =
    capabilities.properties.media_buy.properties.features.allOf;
  assert.ok(
    sellerFeatures.some(
      (entry) =>
        entry.then?.properties?.catalog_management?.const === true &&
        entry.then?.required?.includes("catalog_management")
    ),
    "seller capability output still requires catalog_management with availability support"
  );
});

test("normative text closes identity, privacy, atomicity, replay, and correlation gaps", () => {
  const request = readJson("static/schemas/source/media-buy/sync-catalogs-request.json");
  const response = readJson("static/schemas/source/media-buy/sync-catalogs-response.json");
  const catalog = readJson("static/schemas/source/core/catalog.json");
  const update = readJson(
    "static/schemas/source/core/catalog-item-availability-update.json"
  );

  assert.match(request.properties.item_availability_updates.description, /stage the entire request/i);
  assert.match(request.properties.item_availability_updates.description, /commit.*atomically/i);
  assert.match(request.properties.validation_mode.description, /message exactly 'Catalog item not found'/i);
  assert.match(request.properties.validation_mode.description, /materially distinguishable timing/i);
  assert.match(request.properties.validation_mode.description, /CONFLICT without mutation/i);
  assert.match(request.properties.item_availability_queries.description, /historical snapshot/i);
  assert.match(request.properties.item_availability_queries.description, /post-upsert\/post-update candidate state/i);
  assert.match(response.oneOf[0].properties.item_availability_updates.description, /array length MUST equal/i);
  assert.match(response.oneOf[0].properties.item_availability_states.description, /replayed response is historical/i);
  assert.match(catalog.properties.ids.description, /listing_id/);
  assert.match(catalog.properties.ids.description, /program_id/);
  assert.match(update.properties.catalog_generation.description, /deleted-and-recreated/i);
  assert.equal(update.properties.catalog_generation["x-entity"], "catalog_generation");
  assert.equal(update.properties.item_id["x-entity"], "catalog_item");
});
