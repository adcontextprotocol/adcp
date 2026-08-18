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
