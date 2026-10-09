const fs = require("fs");
const path = require("path");
const Ajv = require("ajv");
const addFormats = require("ajv-formats");
const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

const SCHEMA_ROOT = path.join(__dirname, "..", "static", "schemas", "source");

function readSchema(uri) {
  return JSON.parse(
    fs.readFileSync(path.join(SCHEMA_ROOT, uri.slice("/schemas/".length)), "utf8")
  );
}

const installmentRow = (print_metrics) => ({
  installment_ref: {
    collection_ref: { publisher_domain: "northstar.example.com", collection_id: "northstar_weekly" },
    installment_id: "2026-10-12",
  },
  impressions: 0,
  spend: 4200,
  ...(print_metrics === undefined ? {} : { print_metrics }),
});

describe("print_metrics on by_installment rows", () => {
  let validate;

  before(async () => {
    const ajv = new Ajv({
      allErrors: true,
      strict: false,
      loadSchema: async (ref) => readSchema(ref),
    });
    addFormats(ajv);
    validate = await ajv.compileAsync(readSchema("/schemas/core/installment-delivery-metrics.json"));
  });

  it("is experimental and has no required fields", () => {
    const printMetrics = readSchema("/schemas/core/delivery-metrics.json").properties.print_metrics;
    assert.equal(printMetrics["x-status"], "experimental");
    assert.equal(printMetrics.required, undefined);
    assert.equal(printMetrics.additionalProperties, true);
    assert.equal(
      printMetrics.properties.evidence.$ref,
      "/schemas/core/placement-evidence.json"
    );
  });

  it("is declarable as a standard metric", () => {
    assert.ok(readSchema("/schemas/enums/available-metric.json").enum.includes("print_metrics"));
  });

  it("accepts a full row with tearsheet evidence", () => {
    const row = installmentRow({
      page_delivered: 7,
      position_delivered: "right_hand",
      circulation_delivered: 42000,
      circulation_basis: "audited",
      evidence: { url: "https://northstar.example.com/tearsheets/2026-10-12/p7.pdf" },
    });
    assert.equal(validate(row), true, JSON.stringify(validate.errors));
  });

  it("accepts an empty print_metrics object and a row without it", () => {
    assert.equal(validate(installmentRow({})), true, JSON.stringify(validate.errors));
    assert.equal(validate(installmentRow()), true, JSON.stringify(validate.errors));
  });

  it("rejects invalid field values", () => {
    for (const bad of [
      { page_delivered: 0 },
      { page_delivered: 1.5 },
      { circulation_delivered: -1 },
      { circulation_basis: "estimated" },
      { evidence: {} },
      { evidence: "https://northstar.example.com/tearsheets/p7.pdf" },
    ]) {
      assert.equal(validate(installmentRow(bad)), false, JSON.stringify(bad));
    }
  });
});
