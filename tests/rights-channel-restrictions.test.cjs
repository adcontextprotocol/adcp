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

const rights = (channels) => ({
  rights_id: "rg_nova_talent_001",
  rights_agent: { url: "https://rights.novabrands.example/mcp", id: "nova_rights" },
  uses: ["likeness"],
  ...(channels === undefined ? {} : { channels }),
});

describe("rights-constraint channels restriction (#5542)", () => {
  let validate;
  const channelEnum = readSchema("/schemas/enums/channels.json").enum;

  before(async () => {
    const ajv = new Ajv({ allErrors: true, strict: false, loadSchema: async (ref) => readSchema(ref) });
    addFormats(ajv);
    validate = await ajv.compileAsync(readSchema("/schemas/core/rights-constraint.json"));
  });

  it("is optional, experimental, and reuses the channels vocabulary", () => {
    const schema = readSchema("/schemas/core/rights-constraint.json");
    assert.ok(!schema.required.includes("channels"));
    assert.equal(schema.properties.channels["x-status"], "experimental");
    for (const key of ["allowed", "denied"]) {
      assert.equal(schema.properties.channels.properties[key].items.$ref, "/schemas/enums/channels.json");
    }
    assert.ok(validate(rights()), JSON.stringify(validate.errors));
  });

  it("accepts denied-only, allowed-only, both, and empty allowed", () => {
    for (const channels of [
      { denied: ["ctv", "linear_tv"] },
      { allowed: ["social", "display"] },
      { allowed: ["social", "display", "ctv"], denied: ["ctv"] },
      { allowed: [] },
    ]) {
      assert.ok(validate(rights(channels)), JSON.stringify(validate.errors));
    }
  });

  it("rejects values outside the channels vocabulary and duplicate entries", () => {
    assert.equal(validate(rights({ denied: ["tiktok"] })), false);
    assert.equal(validate(rights({ allowed: ["social", "social"] })), false);
  });

  it("stays open so a later platforms axis is additive", () => {
    assert.ok(validate(rights({ denied: ["social"], platforms: { denied: ["example_network"] } })));
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
    field: "creative_manifest.rights[0].channels",
    details: { rights_id: "rg_nova_talent_001", channel: "ctv" },
  };

  it("keeps a single-capability success with an advisory on the success branch only", () => {
    const response = {
      status: "completed",
      creative_manifest: { format_kind: "image", assets: {}, rights: [rights({ denied: ["ctv"] })] },
      errors: [advisory],
    };
    assert.ok(validate(response), JSON.stringify(validate.errors));
  });

  it("keeps a multi-capability success with an advisory", () => {
    const response = {
      status: "completed",
      creative_manifests: [{ format_kind: "image", assets: {}, rights: [rights({ denied: ["ctv"] })] }],
      errors: [advisory],
    };
    assert.ok(validate(response), JSON.stringify(validate.errors));
  });

  it("still resolves errors[] without a manifest to the terminal error branch", () => {
    const response = { status: "failed", errors: [{ ...advisory, code: "VALIDATION_ERROR" }] };
    assert.ok(validate(response), JSON.stringify(validate.errors));
  });
});
