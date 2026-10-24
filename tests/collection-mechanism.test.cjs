const fs = require("fs");
const path = require("path");
const Ajv = require("ajv");
const addFormats = require("ajv-formats");
const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

const SCHEMA_ROOT = path.join(__dirname, "..", "static", "schemas", "source");

function readSchema(uri) {
  assert.match(uri, /^\/schemas\//);
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_ROOT, uri.slice("/schemas/".length)), "utf8"));
}

async function compile(uri) {
  const ajv = new Ajv({ allErrors: true, strict: false, loadSchema: async (ref) => readSchema(ref) });
  addFormats(ajv);
  return ajv.compileAsync(readSchema(uri));
}

const SOURCE_TYPES = ["set_top_box", "acr", "panel", "server_logs", "client_tracker", "sdk"];

describe("collection mechanism vocabulary", () => {
  it("is a closed enum whose values name mechanisms, not parties", () => {
    const e = readSchema("/schemas/enums/collection-mechanism.json");
    assert.deepEqual(e.enum, SOURCE_TYPES);
    assert.deepEqual(Object.keys(e.enumDescriptions).sort(), [...SOURCE_TYPES].sort());
    for (const party of ["ad_server", "publisher_logs", "measurement_vendor", "seller_tracker", "census"]) {
      assert.ok(!e.enum.includes(party), `${party} is party-flavored or a coverage claim and must not be a value`);
    }
  });

  it("is experimental, marked 3.3, and distinct from the measurement_source provider slug", () => {
    const e = readSchema("/schemas/enums/collection-mechanism.json");
    assert.equal(e["x-status"], "experimental");
    assert.equal(e["x-added-in"], "3.3.0");
    assert.match(e.description, /Not `measurement_source`, which names the provider/);
    const terms = readSchema("/schemas/core/measurement-terms.json");
    const counting = terms.properties.billing_measurement.properties.counting_mechanisms;
    assert.equal(counting["x-status"], "experimental");
    assert.equal(counting["x-added-in"], "3.3.0");
    assert.match(counting.description, /Not `measurement_source`, which names the provider/);
    const vmv = readSchema("/schemas/core/vendor-metric-value.json");
    const prov = vmv.properties.measurement_provenance;
    assert.equal(prov["x-status"], "experimental");
    assert.equal(prov["x-added-in"], "3.3.0");
    assert.match(prov.description, /not `measurement_source`, which names the provider/);
  });

  describe("vendor_metric_values[].measurement_provenance", () => {
    let validate;
    const row = (mp) => ({
      vendor: { domain: "panelmeasurement.example" },
      metric_id: "demographic_reach",
      value: 1,
      ...(mp === undefined ? {} : { measurement_provenance: mp }),
    });
    before(async () => {
      validate = await compile("/schemas/core/vendor-metric-value.json");
    });

    it("is optional", () => assert.ok(validate(row())));
    it("accepts mechanisms with and without deduplicated", () => {
      assert.ok(validate(row({ mechanisms: ["set_top_box", "panel"], deduplicated: true })));
      assert.ok(validate(row({ mechanisms: ["acr"] })));
      assert.ok(validate(row({ mechanisms: ["set_top_box"], deduplicated: false })));
    });
    it("rejects empty, duplicate, and unknown mechanisms", () => {
      assert.ok(!validate(row({ mechanisms: [] })));
      assert.ok(!validate(row({ mechanisms: ["panel", "panel"] })));
      assert.ok(!validate(row({ mechanisms: ["ad_server"] })));
    });
    it("requires mechanisms and a boolean deduplicated", () => {
      assert.ok(!validate(row({ deduplicated: true })));
      assert.ok(!validate(row({ mechanisms: ["panel"], deduplicated: "yes" })));
    });
    it("stays open per DR-0009 while the enclosing row stays closed", () => {
      assert.ok(validate(row({ mechanisms: ["panel"], vendor_note: "x" })));
      assert.ok(!validate({ ...row(), mechanisms: ["panel"] }));
    });
  });

  describe("billing_measurement.counting_mechanisms[]", () => {
    for (const uri of ["/schemas/core/measurement-terms.json", "/schemas/core/canonical-measurement-terms.json"]) {
      describe(uri, () => {
        let validate;
        const terms = (cs) => ({
          billing_measurement: {
            vendor: { domain: "streamhaus.example" },
            ...(cs === undefined ? {} : { counting_mechanisms: cs }),
          },
        });
        before(async () => {
          validate = await compile(uri);
        });
        it("is optional", () => assert.ok(validate(terms())));
        it("accepts a hybrid set", () => assert.ok(validate(terms(["client_tracker", "server_logs"]))));
        it("rejects empty, duplicate, and unknown values", () => {
          assert.ok(!validate(terms([])));
          assert.ok(!validate(terms(["server_logs", "server_logs"])));
          assert.ok(!validate(terms(["seller_tracker"])));
        });
      });
    }
  });
});
