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

const rights = (restriction) => ({
  rights_id: "rg_nova_talent_001",
  rights_agent: { url: "https://rights.novabrands.example/mcp", id: "nova_rights" },
  uses: ["likeness"],
  ...restriction,
});

describe("rights-constraint channels restriction (#5542)", () => {
  let validate;

  before(async () => {
    const ajv = new Ajv({ allErrors: true, strict: false, loadSchema: async (ref) => readSchema(ref) });
    addFormats(ajv);
    validate = await ajv.compileAsync(readSchema("/schemas/core/rights-constraint.json"));
  });

  it("is optional, experimental, added in 3.3, and reuses the channels vocabulary", () => {
    const schema = readSchema("/schemas/core/rights-constraint.json");
    for (const key of ["channels", "excluded_channels"]) {
      assert.ok(!schema.required.includes(key));
      assert.equal(schema.properties[key].type, "array");
      assert.equal(schema.properties[key]["x-status"], "experimental");
      assert.equal(schema.properties[key]["x-added-in"], "3.3.0");
      assert.equal(schema.properties[key].items.$ref, "/schemas/enums/channels.json");
    }
    assert.ok(validate(rights()), JSON.stringify(validate.errors));
  });

  it("accepts excluded-only, channels-only, both, and empty channels", () => {
    for (const restriction of [
      { excluded_channels: ["ctv", "linear_tv"] },
      { channels: ["social", "display"] },
      { channels: ["social", "display", "ctv"], excluded_channels: ["ctv"] },
      { channels: [] },
    ]) {
      assert.ok(validate(rights(restriction)), JSON.stringify(validate.errors));
    }
  });

  it("rejects values outside the channels vocabulary and duplicate entries", () => {
    assert.equal(validate(rights({ excluded_channels: ["tiktok"] })), false);
    assert.equal(validate(rights({ channels: ["social", "social"] })), false);
  });

  it("stays open so a later platforms axis is additive", () => {
    assert.ok(validate(rights({ excluded_channels: ["social"], platforms: { excluded: ["example_network"] } })));
  });
});

describe("RIGHTS_CHANNEL_VIOLATION error code (#5542, DR-0003)", () => {
  const schema = readSchema("/schemas/enums/error-code.json");
  const code = "RIGHTS_CHANNEL_VIOLATION";

  it("is present on both error surfaces and the enum", () => {
    assert.ok(schema.enum.includes(code));
    assert.ok(schema.enumDescriptions[code]);
    assert.equal(schema.enumMetadata[code].recovery, "correctable");
    assert.ok(schema.enumMetadata[code].suggestion);
  });
});

// The response is a oneOf, so a passing validation means exactly one branch accepted it; a manifest plus
// errors[] therefore cannot also satisfy the terminal error branch.
describe("build_creative success responses carry advisory errors[]", () => {
  let validate;

  before(async () => {
    const ajv = new Ajv({ allErrors: true, strict: false, loadSchema: async (ref) => readSchema(ref) });
    addFormats(ajv);
    validate = await ajv.compileAsync(readSchema("/schemas/media-buy/build-creative-response.json"));
  });

  const advisory = {
    code: "RIGHTS_CHANNEL_VIOLATION",
    message: "Requested output targets ctv, which these rights exclude",
    field: "creative_manifest.rights[0].excluded_channels",
    details: { rights_id: "rg_nova_talent_001", channel: "ctv" },
  };

  it("keeps a single-capability success with an advisory on the success branch only", () => {
    const response = {
      status: "completed",
      creative_manifest: { format_kind: "image", assets: {}, rights: [rights({ excluded_channels: ["ctv"] })] },
      errors: [advisory],
    };
    assert.ok(validate(response), JSON.stringify(validate.errors));
  });

  it("keeps a multi-capability success with an advisory", () => {
    const response = {
      status: "completed",
      creative_manifests: [{ format_kind: "image", assets: {}, rights: [rights({ excluded_channels: ["ctv"] })] }],
      errors: [advisory],
    };
    assert.ok(validate(response), JSON.stringify(validate.errors));
  });

  it("still resolves errors[] without a manifest to the terminal error branch", () => {
    const response = { status: "failed", errors: [{ ...advisory, code: "VALIDATION_ERROR" }] };
    assert.ok(validate(response), JSON.stringify(validate.errors));
  });
});
