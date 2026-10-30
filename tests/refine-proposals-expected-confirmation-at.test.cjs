const test = require("node:test");
const assert = require("node:assert/strict");
const Ajv = require("ajv");
const addFormats = require("ajv-formats");

const { ensureBuiltSchemas, readBuiltSchema } = require("../scripts/built-schemas.cjs");

ensureBuiltSchemas();

async function compile(uri) {
  const ajv = new Ajv({ allErrors: true, strict: false, discriminator: true, loadSchema: async (ref) => readBuiltSchema(ref) });
  addFormats(ajv);
  return ajv.compileAsync(readBuiltSchema(uri));
}

const ESTIMATE = "2026-10-20T17:00:00Z";

test("refine_proposals submitted response accepts expected_confirmation_at", async () => {
  const validate = await compile("/schemas/media-buy/refine-proposals-wire-response.json");
  const submitted = { status: "submitted", task_id: "task_finalize_1" };
  assert.equal(validate(submitted), true, JSON.stringify(validate.errors));
  const withEstimate = { ...submitted, expected_confirmation_at: ESTIMATE };
  assert.equal(validate(withEstimate), true, JSON.stringify(validate.errors));
});

test("refine_proposals submitted response rejects a malformed expected_confirmation_at", async () => {
  const validate = await compile("/schemas/media-buy/refine-proposals-wire-response.json");
  assert.equal(
    validate({ status: "submitted", task_id: "task_finalize_1", expected_confirmation_at: "next week" }),
    false
  );
});

test("refine_proposals completed response must not carry expected_confirmation_at", async () => {
  const validate = await compile("/schemas/media-buy/refine-proposals-wire-response.json");
  const completed = {
    status: "completed",
    results: [{ source_proposal_id: "prop_1", outcome: "unable", reason_code: "hold_unavailable", reason: "No inventory." }],
    products: [],
  };
  assert.equal(validate(completed), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...completed, expected_confirmation_at: ESTIMATE }), false);
  assert.equal(
    validate({ ...completed, task_id: "task_1", expected_confirmation_at: ESTIMATE }),
    false
  );
});

test("refine_proposals submitted async wrapper accepts expected_confirmation_at", async () => {
  const validate = await compile("/schemas/media-buy/refine-proposals-async-response-submitted.json");
  assert.equal(
    validate({ status: "submitted", task_id: "task_finalize_1", expected_confirmation_at: ESTIMATE }),
    true,
    JSON.stringify(validate.errors)
  );
  assert.equal(
    validate({ status: "submitted", task_id: "task_finalize_1", expected_confirmation_at: "soon" }),
    false
  );
});
