const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const Ajv = require("ajv");
const addFormats = require("ajv-formats");

const ROOT = path.join(__dirname, "..");
const SCHEMA_ROOT = path.join(ROOT, "static", "schemas", "source");

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

async function loadSchema(uri) {
  if (!uri.startsWith("/schemas/")) {
    throw new Error(`Unexpected schema URI: ${uri}`);
  }
  return JSON.parse(
    fs.readFileSync(path.join(SCHEMA_ROOT, uri.slice("/schemas/".length)), "utf8")
  );
}

async function compile(uri) {
  const ajv = new Ajv({ allErrors: true, strict: false, loadSchema });
  addFormats(ajv);
  return ajv.compileAsync(await loadSchema(uri));
}

function validationErrors(validate) {
  return JSON.stringify(validate.errors || []);
}

test("experimental TMP Offer cleanly publishes creative_data instead of macros", async () => {
  const offerSchema = JSON.parse(
    read("static/schemas/source/trusted-match/offer.json")
  );
  assert.ok(offerSchema.properties.creative_data);
  assert.equal(offerSchema.properties.macros, undefined);
  assert.match(
    offerSchema.properties.creative_data.description,
    /MUST ignore unknown keys/
  );
  assert.match(
    offerSchema.properties.creative_data.description,
    /missing key MUST NOT make an otherwise renderable offer fail/
  );

  const validate = await compile("/schemas/trusted-match/offer.json");
  assert.equal(
    validate({
      package_id: "pkg_123",
      creative_data: { sponsor_label: "Presented by Acme" },
    }),
    true,
    validationErrors(validate)
  );
  assert.equal(
    validate({ package_id: "pkg_123", creative_data: { discount: 20 } }),
    false
  );
  assert.equal(
    validate({ package_id: "pkg_123", macros: { sponsor_label: "Acme" } }),
    false,
    "the experimental clean rename must reject the removed macros property"
  );

  const tmpDocs = [
    "docs/trusted-match/specification.mdx",
    "docs/trusted-match/context-and-identity.mdx",
    "docs/trusted-match/surfaces/web.mdx",
    "docs/trusted-match/surfaces/mobile.mdx",
    "docs/trusted-match/surfaces/retail-media.mdx",
    "docs/trusted-match/surfaces/ai-assistants.mdx",
  ];
  for (const file of tmpDocs) {
    assert.doesNotMatch(
      read(file),
      /Offer(?:'s)?\s+`macros`|offer\.macros|"macros"\s*:/i,
      file
    );
  }
});
