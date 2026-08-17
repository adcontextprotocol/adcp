#!/usr/bin/env node

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const path = require("node:path");
const test = require("node:test");
const Ajv2020 = require("ajv/dist/2020");
const {
  ACCOUNT_REF,
  BRAND_REF,
  PRODUCT_PURCHASE,
  TARGETING,
  TARGETING_REQUIREMENTS,
  adaptMediaBuyPromptArguments,
  analyzeInputSchemaWeights,
  applyMediaBuyPromptCleanupExperiment,
  buildSharedDefinitionsView,
  compactBytes,
  mergeDefinitions,
  toolsListPayload,
} = require("../scripts/mcp-schema-analysis.cjs");
const {
  DICTIONARY_ID,
  MODEL_CONTEXT_DIR,
  buildExperimentReport,
  loadRepresentativeMediaBuyRuntime,
} = require("../scripts/run-mcp-schema-context-experiment.cjs");

test("input-field weight report attributes the largest transitive schema graphs", () => {
  const { schemas } = loadRepresentativeMediaBuyRuntime();
  const report = analyzeInputSchemaWeights(schemas);

  assert.equal(report.tool_count, 16);
  assert.equal(report.definition_instances, 576);
  assert.equal(report.unique_definitions, 150);
  assert.equal(report.repeated_definitions, 107);
  assert.ok(report.repeated_definition_bytes > 180_000);

  assert.deepEqual(
    report.fields.slice(0, 5).map(({ tool, field }) => [tool, field]),
    [
      ["refine_proposals", "refinements"],
      ["list_products", "criteria"],
      ["request_proposals", "criteria"],
      ["buy_products", "purchases"],
      ["control_media_buy", "packages"],
    ]
  );
  assert.ok(report.fields[0].transitive_definition_count >= 70);
  assert.ok(report.fields[0].transitive_definition_bytes > 40_000);
  assert.equal(report.definitions[0].name, "external:core/targeting.json");
});

test("prompt cleanup experiment is pure and leaves canonical schemas unchanged", () => {
  const { schemas } = loadRepresentativeMediaBuyRuntime();
  const before = structuredClone(schemas);
  const compact = applyMediaBuyPromptCleanupExperiment(schemas);
  assert.deepEqual(schemas, before);

  const { definitions } = mergeDefinitions(compact);
  assert.ok(!Object.hasOwn(definitions, ACCOUNT_REF));
  assert.ok(!Object.hasOwn(definitions, BRAND_REF));

  const targeting = definitions[TARGETING];
  for (const deprecated of [
    "axe_include_segment",
    "axe_exclude_segment",
    "signal_targeting",
  ]) {
    assert.ok(!Object.hasOwn(targeting.properties, deprecated));
  }

  const purchase = definitions[PRODUCT_PURCHASE];
  for (const inherited of [
    "pricing",
    "start_time",
    "end_time",
    "measurement_terms",
    "performance_standards",
  ]) {
    assert.ok(!Object.hasOwn(purchase.properties, inherited));
  }

  const requirements = definitions[TARGETING_REQUIREMENTS];
  assert.deepEqual(Object.keys(requirements.properties), [
    "required_dimensions",
    "constraints",
    "ext",
  ]);
  assert.ok(
    requirements.properties.required_dimensions.items.enum.includes("browser")
  );
  assert.ok(requirements.properties.constraints.properties.browser);
});

test("prompt argument adapter expands compact targeting requirements before validation", () => {
  const compactArguments = {
    adcp_version: "3.2",
    criteria: {
      required_overlay_support: {
        required_dimensions: ["geo_countries", "browser"],
        constraints: { browser: { families: ["chrome", "safari"] } },
        ext: { experiment: true },
      },
    },
  };
  const adapted = adaptMediaBuyPromptArguments(
    "list_products",
    compactArguments
  );
  assert.deepEqual(
    compactArguments.criteria.required_overlay_support.required_dimensions,
    ["geo_countries", "browser"]
  );
  assert.deepEqual(adapted.criteria.required_overlay_support, {
    geo_countries: true,
    browser: { families: ["chrome", "safari"] },
    ext: { experiment: true },
  });
  assert.deepEqual(
    adaptMediaBuyPromptArguments("list_products", {
      criteria: { required_overlay_support: { geo_countries: true } },
    }),
    { criteria: { required_overlay_support: { geo_countries: true } } }
  );

  const canonicalSchema = JSON.parse(
    fs.readFileSync(
      path.join(
        MODEL_CONTEXT_DIR,
        "..",
        "media-buy",
        "list-products-request.json"
      ),
      "utf8"
    )
  );
  const validator = new Ajv2020({
    strict: false,
    validateFormats: false,
  }).compile(canonicalSchema);
  assert.equal(validator(compactArguments), false);
  assert.equal(validator(adapted), true, JSON.stringify(validator.errors));
});

test("shared dictionary resolves every experimental tool schema when explicitly registered", () => {
  const { schemas, tools } = loadRepresentativeMediaBuyRuntime();
  const view = buildSharedDefinitionsView({
    schemas,
    tools,
    dictionaryId: DICTIONARY_ID,
  });

  assert.equal(view.dictionary.$id, DICTIONARY_ID);
  assert.equal(Object.keys(view.dictionary.$defs).length, 150);
  for (const tool of Object.values(view.tools)) {
    assert.equal(tool.inputSchema.$defs, undefined);
    assert.match(
      JSON.stringify(tool.inputSchema),
      /adcp:\/\/schemas\/shared#\/\$defs\//
    );
  }

  const firstSchema = Object.values(view.tools)[0].inputSchema;
  assert.throws(
    () =>
      new Ajv2020({ strict: false, validateFormats: false }).compile(
        firstSchema
      ),
    /can't resolve reference/
  );

  const validator = new Ajv2020({ strict: false, validateFormats: false });
  validator.addSchema(view.dictionary);
  for (const [toolName, tool] of Object.entries(view.tools)) {
    assert.doesNotThrow(() => validator.compile(tool.inputSchema), toolName);
  }
});

test("official MCP TypeScript v2 validator accepts a pre-registered local dictionary", () => {
  const adcpSdkRequire = createRequire(require.resolve("@adcp/sdk/package.json"));
  const { AjvJsonSchemaValidator } = adcpSdkRequire(
    "@modelcontextprotocol/client/validators/ajv"
  );
  const { schemas, tools } = loadRepresentativeMediaBuyRuntime();
  const view = buildSharedDefinitionsView({
    schemas,
    tools,
    dictionaryId: DICTIONARY_ID,
  });
  const firstSchema = Object.values(view.tools)[0].inputSchema;

  assert.throws(
    () => new AjvJsonSchemaValidator().getValidator(firstSchema),
    /can't resolve reference/
  );

  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  ajv.addSchema(view.dictionary);
  const provider = new AjvJsonSchemaValidator(ajv);
  for (const [toolName, tool] of Object.entries(view.tools)) {
    assert.doesNotThrow(
      () => provider.getValidator(tool.inputSchema),
      toolName
    );
  }
});

test("experiment report keeps all alternatives smaller than standalone model context", () => {
  const report = buildExperimentReport();
  const variants = report.variants;
  assert.equal(report.status, "non-normative");
  assert.equal(report.prompt_cleanup_adapter.required, true);
  assert.equal(report.selection.tools.length, 16);
  // Tolerance band, not an exact pin: every schema-touching PR shifts this
  // number, and an exact equality forced each one to re-pin the constant —
  // guaranteeing merge conflicts between any two in-flight schema PRs (#6571).
  // The meaningful invariants are that the standalone context stays large
  // enough for the experiment comparisons to matter and below the projection
  // budget; the ratio and payload-consistency assertions below carry the
  // actual signal.
  assert.ok(
    variants.standalone.context_bytes > 200_000 &&
      variants.standalone.context_bytes < 400 * 1024,
    `standalone context outside [200 KiB, 400 KiB]: ${variants.standalone.context_bytes}`
  );
  assert.ok(
    variants.prompt_cleanup.context_bytes <
      variants.standalone.context_bytes * 0.82
  );
  assert.ok(
    variants.shared_dictionary.context_bytes <
      variants.standalone.context_bytes * 0.37
  );
  assert.ok(
    variants.shared_dictionary_with_prompt_cleanup.context_bytes <
      variants.shared_dictionary.context_bytes
  );
  assert.ok(
    variants.shared_dictionary.dictionary_definitions > 100,
    `shared dictionary unexpectedly small: ${variants.shared_dictionary.dictionary_definitions} definitions`
  );
  assert.ok(
    variants.shared_dictionary_with_prompt_cleanup.dictionary_definitions <
      variants.shared_dictionary.dictionary_definitions,
    "prompt cleanup should strictly reduce dictionary definitions"
  );

  const { tools } = loadRepresentativeMediaBuyRuntime();
  assert.equal(
    compactBytes(toolsListPayload(tools)),
    variants.standalone.context_bytes
  );
});
