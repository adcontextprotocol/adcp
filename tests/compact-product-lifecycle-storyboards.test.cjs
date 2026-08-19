const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const Ajv = require("ajv");
const addFormats = require("ajv-formats");
const yaml = require("js-yaml");

const ROOT = path.join(__dirname, "..");
const SCHEMA_ROOT = path.join(ROOT, "static", "schemas", "source");
const STORYBOARD_ROOT = path.join(
  ROOT,
  "static",
  "compliance",
  "source",
  "protocols",
  "media-buy",
  "scenarios"
);

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

function readStoryboard(name) {
  return yaml.load(fs.readFileSync(path.join(STORYBOARD_ROOT, `${name}.yaml`), "utf8"));
}

function steps(storyboard) {
  return storyboard.phases.flatMap((phase) => phase.steps);
}

function validation(step, check, path) {
  return (step.validations || []).find(
    (candidate) => candidate.check === check && candidate.path === path
  );
}

test("compact lifecycle controller requests require operation-specific identities", async () => {
  const validate = await compile(
    "/schemas/compliance/comply-test-controller-request.json"
  );
  const base = {
    account: { sandbox: true },
    scenario: "compact_product_lifecycle_probe",
  };

  assert.equal(
    validate({
      ...base,
      params: { operation: "prepare", product_id: "compact_lifecycle_video" },
    }),
    true,
    JSON.stringify(validate.errors)
  );
  assert.equal(validate({ ...base, params: { operation: "prepare" } }), false);
  assert.equal(
    validate({
      ...base,
      params: {
        operation: "prepare",
        product_id: "compact_lifecycle_video",
        proposal_id: "proposal_123",
      },
    }),
    false,
    "prepare accepts only the product identity"
  );
  assert.equal(
    validate({
      ...base,
      params: { operation: "expire_proposal", proposal_id: "proposal_123" },
    }),
    true,
    JSON.stringify(validate.errors)
  );
  assert.equal(
    validate({
      ...base,
      params: {
        operation: "expire_proposal",
        proposal_id: "proposal_123",
        product_id: "compact_lifecycle_video",
      },
    }),
    false,
    "expire_proposal accepts only the proposal identity"
  );
  assert.equal(
    validate({
      ...base,
      params: {
        operation: "expire_proposal",
        proposal_id: "proposal_123",
        expires_at: "2099-03-31T00:00:00Z",
      },
    }),
    false,
    "the controller derives expiry from the stored proposal deadline"
  );
  assert.equal(validate({ ...base, params: { operation: "advance_time" } }), false);
  assert.equal(
    validate({
      ...base,
      scenario: "catalog_item_availability_probe",
      params: {
        operation: "prepare",
        catalog_id: "catalog_123",
        item_id: "item_123",
      },
    }),
    false,
    "compact lifecycle operations cannot leak into the catalog probe"
  );
});

test("all compact lifecycle storyboards are deterministic and capability-gated", () => {
  const products = {
    compact_product_lifecycle: "compact_lifecycle_video",
    declined_proposal_refinement: "decline_refinement_video",
    declined_proposal_execution: "decline_execution_video",
    expired_proposal_execution: "proposal_expiry_video",
  };

  for (const [name, productId] of Object.entries(products)) {
    const storyboard = readStoryboard(name);
    assert.deepEqual(storyboard.requires_capability, {
      path: "compliance_testing.scenarios",
      contains: "compact_product_lifecycle_probe",
    });
    assert.ok(storyboard.required_tools.includes("comply_test_controller"));

    const prepare = steps(storyboard).find(
      (step) =>
        step.task === "comply_test_controller" &&
        step.sample_request?.params?.operation === "prepare"
    );
    assert.ok(prepare, `${name} prepares deterministic lifecycle behavior`);
    assert.equal(prepare.sample_request.scenario, "compact_product_lifecycle_probe");
    assert.equal(prepare.sample_request.params.product_id, productId);
  }
});

test("accepted compact proposal is controlled and read back without legacy mutation tools", () => {
  const storyboard = readStoryboard("compact_product_lifecycle");
  const allSteps = steps(storyboard);
  const byTask = (task) => allSteps.find((step) => step.task === task);
  const accept = byTask("accept_proposal");
  const control = byTask("control_media_buy");
  const readback = byTask("get_media_buys");
  const phasesById = new Map(storyboard.phases.map((phase) => [phase.id, phase]));

  assert.deepEqual(new Set(storyboard.required_tools), new Set([
    "list_products",
    "request_proposals",
    "refine_proposals",
    "accept_proposal",
    "control_media_buy",
    "get_media_buys",
    "comply_test_controller",
  ]));
  for (const legacy of ["create_media_buy", "update_media_buy"]) {
    assert.equal(storyboard.required_tools.includes(legacy), false);
    assert.equal(allSteps.some((step) => step.task === legacy), false);
  }

  assert.ok(accept && control && readback);
  assert.deepEqual(phasesById.get("accept_commitment").depends_on, ["finalize_draft"]);
  assert.deepEqual(phasesById.get("control_accepted_buy").depends_on, [
    "accept_commitment",
  ]);
  assert.deepEqual(phasesById.get("read_accepted_buy").depends_on, [
    "control_accepted_buy",
  ]);
  assert.deepEqual(
    new Map(accept.context_outputs.map(({ name, path: outputPath }) => [name, outputPath])),
    new Map([
      ["accepted_media_buy_id", "media_buy_id"],
      ["accepted_media_buy_revision", "revision"],
      ["accepted_media_buy_status", "media_buy_status"],
    ])
  );
  assert.equal(
    validation(accept, "field_equals_context", "accepted_proposal.proposal_id")
      ?.context_key,
    "committed_proposal_id"
  );
  assert.equal(
    validation(accept, "field_equals_context", "accepted_proposal.terms_digest")
      ?.context_key,
    "committed_terms_digest"
  );
  assert.deepEqual(
    validation(accept, "field_contains", "available_actions[*]")?.value,
    {
      task: "control_media_buy",
      action: "decrease_budget",
      mode: "self_serve",
    }
  );

  assert.equal(control.sample_request.media_buy_id, "$context.accepted_media_buy_id");
  assert.equal(control.sample_request.revision, "$context.accepted_media_buy_revision");
  assert.equal(control.sample_request.daily_budget_cap, 100);
  assert.match(control.sample_request.idempotency_key, /^\$generate:uuid_v4#/);
  assert.equal(
    validation(control, "field_equals_context", "media_buy_status")?.context_key,
    "accepted_media_buy_status"
  );

  assert.equal(
    readback.sample_request.media_buy_ids[0],
    "$context.proposal_controlled_media_buy_id"
  );
  assert.equal(readback.sample_request.include_history, 2);
  assert.equal(
    validation(readback, "field_equals_context", "media_buys[0].revision")
      ?.context_key,
    "proposal_controlled_revision"
  );
  assert.equal(
    validation(readback, "field_equals_context", "media_buys[0].status")
      ?.context_key,
    "proposal_controlled_status"
  );
  assert.equal(
    validation(readback, "field_equals_context", "media_buys[0].history[0].revision")
      ?.context_key,
    "proposal_controlled_revision"
  );
  assert.equal(
    validation(readback, "field_equals_context", "media_buys[0].history[1].revision")
      ?.context_key,
    "accepted_media_buy_revision"
  );
  assert.equal(
    validation(readback, "field_less_than", "media_buys[0].history[1].revision")
      ?.context_key,
    "proposal_controlled_revision"
  );
  assert.equal(
    validation(readback, "field_value", "media_buys[0].daily_budget_cap")?.value,
    100
  );
  assert.equal(
    validation(readback, "field_equals_context", "media_buys[0].accepted_proposal_id")
      ?.context_key,
    "committed_proposal_id"
  );
  assert.equal(
    validation(
      readback,
      "field_equals_context",
      "media_buys[0].accepted_proposal_terms_digest"
    )?.context_key,
    "committed_terms_digest"
  );
  assert.equal(
    validation(
      readback,
      "field_equals_context",
      "media_buys[0].accepted_proposal.proposal_id"
    )?.context_key,
    "committed_proposal_id"
  );
  assert.equal(
    validation(
      readback,
      "field_equals_context",
      "media_buys[0].accepted_proposal.terms_digest"
    )?.context_key,
    "committed_terms_digest"
  );
});

test("direct-buy controller preparation is product-scoped", async () => {
  const validate = await compile(
    "/schemas/compliance/comply-test-controller-request.json"
  );
  const base = {
    account: { sandbox: true },
    scenario: "compact_direct_buy_lifecycle_probe",
  };

  assert.equal(
    validate({
      ...base,
      params: { operation: "prepare", product_id: "compact_direct_buy_video" },
    }),
    true,
    JSON.stringify(validate.errors)
  );
  assert.equal(
    validate({ ...base, params: { operation: "prepare" } }),
    false,
    "direct-buy preparation requires the product identity"
  );
  assert.equal(
    validate({
      ...base,
      params: {
        operation: "prepare",
        product_id: "compact_direct_buy_video",
        proposal_id: "proposal_123",
      },
    }),
    false,
    "direct-buy preparation rejects proposal-lifecycle identity"
  );
});

test("compact direct-buy lifecycle threads versioned offers through control readback", () => {
  const storyboard = readStoryboard("compact_direct_buy_lifecycle");
  const allSteps = steps(storyboard);
  const byTask = (task) => allSteps.find((step) => step.task === task);
  const list = byTask("list_products");
  const buy = byTask("buy_products");
  const control = byTask("control_media_buy");
  const readback = byTask("get_media_buys");
  const phasesById = new Map(storyboard.phases.map((phase) => [phase.id, phase]));

  assert.deepEqual(storyboard.requires_capability, {
    path: "compliance_testing.scenarios",
    contains: "compact_direct_buy_lifecycle_probe",
  });
  assert.deepEqual(new Set(storyboard.required_tools), new Set([
    "list_products",
    "buy_products",
    "control_media_buy",
    "get_media_buys",
    "comply_test_controller",
  ]));
  for (const deprecated of ["get_products", "create_media_buy", "update_media_buy"]) {
    assert.equal(storyboard.required_tools.includes(deprecated), false);
    assert.equal(allSteps.some((step) => step.task === deprecated), false);
  }

  assert.ok(list && buy && control && readback);
  assert.deepEqual(phasesById.get("purchase_direct_offer").depends_on, [
    "discover_direct_offer",
  ]);
  assert.deepEqual(phasesById.get("control_direct_buy").depends_on, [
    "purchase_direct_offer",
  ]);
  assert.deepEqual(phasesById.get("read_controlled_buy").depends_on, [
    "control_direct_buy",
  ]);
  assert.deepEqual(
    new Map(list.context_outputs.map(({ name, path: outputPath }) => [name, outputPath])),
    new Map([
      ["direct_product_id", "products[0].product_id"],
      ["direct_pricing_option_id", "products[0].pricing_options[0].pricing_option_id"],
      ["direct_feed_version", "feed_version"],
    ])
  );
  assert.equal(buy.sample_request.feed_version, "$context.direct_feed_version");
  assert.equal(buy.sample_request.pricing_version, undefined);
  assert.equal(
    buy.sample_request.purchases[0].product_id,
    "$context.direct_product_id"
  );
  assert.equal(
    buy.sample_request.purchases[0].pricing_option_id,
    "$context.direct_pricing_option_id"
  );
  assert.match(buy.sample_request.idempotency_key, /^\$generate:uuid_v4#/);
  assert.equal(
    validation(
      buy,
      "field_equals_context",
      "accepted_proposal.commercial_terms.source_feed_version"
    )?.context_key,
    "direct_feed_version"
  );
  assert.equal(
    validation(
      buy,
      "field_equals_context",
      "accepted_proposal.commercial_terms.purchases[0].product_id"
    )?.context_key,
    "direct_product_id"
  );
  assert.equal(
    validation(
      buy,
      "field_equals_context",
      "accepted_proposal.commercial_terms.purchases[0].pricing_option_id"
    )?.context_key,
    "direct_pricing_option_id"
  );

  assert.equal(control.sample_request.media_buy_id, "$context.direct_media_buy_id");
  assert.equal(control.sample_request.revision, "$context.direct_buy_revision");
  assert.equal(control.sample_request.daily_budget_cap, 100);
  assert.match(control.sample_request.idempotency_key, /^\$generate:uuid_v4#/);
  assert.equal(
    validation(control, "field_equals_context", "media_buy_status")?.context_key,
    "direct_buy_status"
  );

  assert.equal(
    readback.sample_request.media_buy_ids[0],
    "$context.controlled_media_buy_id"
  );
  assert.equal(readback.sample_request.include_history, 2);
  assert.equal(
    validation(readback, "field_equals_context", "media_buys[0].revision")
      ?.context_key,
    "controlled_revision"
  );
  assert.equal(
    validation(readback, "field_equals_context", "media_buys[0].status")
      ?.context_key,
    "controlled_media_buy_status"
  );
  assert.equal(
    validation(readback, "field_equals_context", "media_buys[0].history[0].revision")
      ?.context_key,
    "controlled_revision"
  );
  assert.equal(
    validation(readback, "field_equals_context", "media_buys[0].history[1].revision")
      ?.context_key,
    "direct_buy_revision"
  );
  assert.equal(
    validation(readback, "field_less_than", "media_buys[0].history[1].revision")
      ?.context_key,
    "controlled_revision"
  );
  assert.equal(
    validation(readback, "field_value", "media_buys[0].daily_budget_cap")?.value,
    100
  );
});

test("compact direct-buy task pages remain testable", () => {
  for (const page of ["list_products", "buy_products", "control_media_buy"]) {
    const source = fs.readFileSync(
      path.join(ROOT, "docs", "media-buy", "task-reference", `${page}.mdx`),
      "utf8"
    );
    assert.match(source, /^---[\s\S]*?^testable: true$/m, `${page} is testable`);
  }
});

test("expiry and compatibility probes preserve the intended error precedence", () => {
  const expiry = readStoryboard("expired_proposal_execution");
  const expireStep = steps(expiry).find(
    (step) => step.sample_request?.params?.operation === "expire_proposal"
  );
  assert.ok(expireStep);
  assert.equal(expireStep.sample_request.scenario, "compact_product_lifecycle_probe");
  assert.equal(expireStep.sample_request.params.expires_at, undefined);
  assert.equal(expireStep.sample_request.params.target_time, undefined);

  for (const name of ["declined_proposal_execution", "expired_proposal_execution"]) {
    const createStep = steps(readStoryboard(name)).find(
      (step) => step.task === "create_media_buy"
    );
    assert.ok(createStep);
    assert.equal(createStep.requires_tool, "create_media_buy");
    assert.match(String(createStep.sample_request.total_budget.amount), /^\$context\./);
    assert.match(String(createStep.sample_request.total_budget.currency), /^\$context\./);
    assert.match(String(createStep.sample_request.start_time), /^\$context\./);
    assert.match(String(createStep.sample_request.end_time), /^\$context\./);
  }
});
