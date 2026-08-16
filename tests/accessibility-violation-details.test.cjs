const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const Ajv = require("ajv");
const addFormats = require("ajv-formats");

const ROOT = path.join(__dirname, "..");
const SCHEMA_ROOT = path.join(ROOT, "static", "schemas", "source");

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

test("accessibility violations use structured CREATIVE_REJECTED details", async () => {
  const validateDetails = await compile(
    "/schemas/error-details/accessibility-violation.json"
  );
  const validateError = await compile("/schemas/core/error.json");
  const validateBuildResponse = await compile(
    "/schemas/media-buy/build-creative-response.json"
  );
  const validateSyncResponse = await compile(
    "/schemas/creative/sync-creatives-response.json"
  );
  const inlineDetails = {
    violations: [
      {
        pointer: "/creative_manifest/assets/hero_image",
        criterion: "1.4.3",
        criterion_source: "WCAG22",
        required_level: "AA",
        failure_kind: "contrast_ratio_insufficient",
        remediation:
          "For normal-sized text, increase contrast to at least 4.5:1.",
      },
    ],
  };
  assert.equal(
    validateDetails(inlineDetails),
    true,
    validationErrors(validateDetails)
  );
  assert.equal(
    validateDetails({
      violations: [
        { ...inlineDetails.violations[0], failure_kind: "Bad Kind" },
      ],
    }),
    false
  );
  assert.equal(validateDetails({ violations: [] }), false);
  assert.equal(
    validateDetails({
      violations: [
        { ...inlineDetails.violations[0], failure_kind: "x_vendor_check_7" },
      ],
    }),
    true,
    validationErrors(validateDetails),
    "vendor-local failure kinds use the x_ extension namespace"
  );
  assert.equal(
    validateDetails({
      violations: [
        { ...inlineDetails.violations[0], pointer: "assets/hero_image" },
      ],
    }),
    false,
    "violation pointers must be request-rooted RFC 6901 pointers"
  );

  const makeError = (field, details) => ({
    code: "CREATIVE_REJECTED",
    message: "Creative fails the required accessibility level",
    field,
    recovery: "correctable",
    details,
  });
  const inlineError = makeError(
    "creative_manifest.assets.hero_image",
    inlineDetails
  );
  assert.equal(validateError(inlineError), true, validationErrors(validateError));
  assert.equal(
    validateBuildResponse({ status: "failed", errors: [inlineError] }),
    true,
    validationErrors(validateBuildResponse)
  );

  const batchDetails = {
    violations: [
      {
        ...inlineDetails.violations[0],
        pointer: "/creatives/0/assets/logo~1dark~0mode",
        criterion: "1.1.1",
        failure_kind: "alt_text_missing",
      },
    ],
  };
  assert.equal(
    validateDetails(batchDetails),
    true,
    validationErrors(validateDetails),
    "escaped RFC 6901 tokens are accepted"
  );
  assert.equal(
    validateSyncResponse({
      status: "completed",
      creatives: [
        {
          creative_id: "creative_123",
          action: "failed",
          errors: [makeError("creatives[0].assets.logo/dark~mode", batchDetails)],
        },
      ],
    }),
    true,
    validationErrors(validateSyncResponse)
  );

  const storedDetails = {
    violations: [
      { ...inlineDetails.violations[0], pointer: "/creative_id" },
    ],
  };
  assert.equal(
    validateDetails(storedDetails),
    true,
    validationErrors(validateDetails)
  );
  assert.equal(
    validateBuildResponse({
      status: "failed",
      errors: [makeError("creative_id", storedDetails)],
    }),
    true,
    validationErrors(validateBuildResponse)
  );

  const maximalViolation = {
    pointer: `/${"p".repeat(255)}`,
    criterion: "c".repeat(32),
    criterion_source: "S".repeat(64),
    required_level: "L".repeat(64),
    failure_kind: `x_${"f".repeat(62)}`,
    remediation: "r".repeat(256),
  };
  const boundedError = makeError("creative_manifest", {
    violations: Array.from({ length: 4 }, () => maximalViolation),
    truncated: true,
  });
  assert.equal(
    validateDetails(boundedError.details),
    true,
    validationErrors(validateDetails)
  );
  assert.ok(JSON.stringify(boundedError).length <= 4096);
  assert.equal(
    validateDetails({
      violations: Array.from({ length: 5 }, () => maximalViolation),
      truncated: true,
    }),
    false,
    "producers must summarize more than four violations"
  );
  for (const [field, value] of [
    ["pointer", "/unsafe\u0000path"],
    ["criterion", "1.4.3\u0000"],
    ["required_level", "AA\u0000"],
    ["remediation", "unsafe\u0000text"],
  ]) {
    assert.equal(
      validateDetails({
        violations: [{ ...inlineDetails.violations[0], [field]: value }],
      }),
      false,
      `${field} rejects control characters that expand during serialization`
    );
  }

  const docs = fs.readFileSync(
    path.join(ROOT, "docs/creative/accessibility.mdx"),
    "utf8"
  );
  assert.match(docs, /"code": "CREATIVE_REJECTED"/);
  assert.doesNotMatch(docs, /"code": "ACCESSIBILITY_VIOLATION"/);
  assert.match(docs, /code.*recovery.*only/is);
  assert.match(docs, /immutable\s+copy of the original\s+request/i);
});
