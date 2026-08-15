#!/usr/bin/env node

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { MCP_ROLE_PROFILE_TOOLS } = require("./build-schemas.cjs");
const {
  MCP_PROTOCOL_VERSION,
  selectRuntimeToolNames,
} = require("./mcp-schema-projection.cjs");
const {
  analyzeInputSchemaWeights,
  applyMediaBuyPromptCleanupExperiment,
  buildSharedDefinitionsView,
  compactBytes,
  toolsListPayload,
} = require("./mcp-schema-analysis.cjs");

const REPO_ROOT = path.resolve(__dirname, "..");
const LATEST_DIR = path.join(REPO_ROOT, "dist", "schemas", "latest");
const MODEL_CONTEXT_DIR = path.join(
  LATEST_DIR,
  "mcp",
  MCP_PROTOCOL_VERSION,
  "profiles",
  "media-buy",
  "model-context"
);
// This compact identifier is repeated in every external $ref placed in model
// context. It is explicitly non-resolvable unless the client pre-registers
// the dictionary.
const DICTIONARY_ID = "adcp://schemas/shared";

function readJson(filename) {
  return JSON.parse(fs.readFileSync(filename, "utf8"));
}

function loadRepresentativeMediaBuyRuntime() {
  const canonicalManifest = readJson(path.join(LATEST_DIR, "manifest.json"));
  const modelManifest = readJson(path.join(MODEL_CONTEXT_DIR, "manifest.json"));
  const selectedToolNames = selectRuntimeToolNames(canonicalManifest, {
    implementedTools: MCP_ROLE_PROFILE_TOOLS["media-buy"],
    capabilityProtocols: ["media_buy"],
    capabilityTools: ["get_adcp_capabilities", "get_task_status"],
  });
  const schemas = {};
  const tools = {};
  for (const toolName of selectedToolNames) {
    const tool = modelManifest.tools[toolName];
    schemas[toolName] = readJson(
      path.join(MODEL_CONTEXT_DIR, tool.inputSchema)
    );
    tools[toolName] = {
      name: toolName,
      description: tool.summary,
      inputSchema: schemas[toolName],
    };
  }
  return { schemas, selectedToolNames, tools };
}

function sharedViewMeasurement(view) {
  return {
    context_bytes:
      compactBytes(toolsListPayload(view.tools)) +
      compactBytes(view.dictionary),
    tools_list_bytes: compactBytes(toolsListPayload(view.tools)),
    dictionary_bytes: compactBytes(view.dictionary),
    dictionary_definitions: Object.keys(view.dictionary.$defs).length,
  };
}

function buildExperimentReport() {
  const { schemas, selectedToolNames, tools } =
    loadRepresentativeMediaBuyRuntime();
  const baselineWeights = analyzeInputSchemaWeights(schemas);
  const compactSchemas = applyMediaBuyPromptCleanupExperiment(schemas);
  const compactTools = Object.fromEntries(
    selectedToolNames.map((toolName) => [
      toolName,
      { ...tools[toolName], inputSchema: compactSchemas[toolName] },
    ])
  );
  const baselineShared = buildSharedDefinitionsView({
    schemas,
    tools,
    dictionaryId: DICTIONARY_ID,
  });
  const compactShared = buildSharedDefinitionsView({
    schemas: compactSchemas,
    tools: compactTools,
    dictionaryId: DICTIONARY_ID,
  });

  const baselineBytes = compactBytes(toolsListPayload(tools));
  const compactBytesTotal = compactBytes(toolsListPayload(compactTools));
  const baselineSharedMeasurement = sharedViewMeasurement(baselineShared);
  const compactSharedMeasurement = sharedViewMeasurement(compactShared);

  return {
    experiment: "mcp-schema-context-efficiency",
    status: "non-normative",
    source_profile: "media-buy/model-context",
    selection: {
      implemented_role: "media-buy",
      capability_protocols: ["media_buy"],
      capability_tools: ["get_adcp_capabilities", "get_task_status"],
      tools: selectedToolNames,
    },
    variants: {
      standalone: {
        context_bytes: baselineBytes,
        relative_to_standalone: 1,
      },
      prompt_cleanup: {
        context_bytes: compactBytesTotal,
        relative_to_standalone: compactBytesTotal / baselineBytes,
      },
      shared_dictionary: {
        ...baselineSharedMeasurement,
        relative_to_standalone:
          baselineSharedMeasurement.context_bytes / baselineBytes,
      },
      shared_dictionary_with_prompt_cleanup: {
        ...compactSharedMeasurement,
        relative_to_standalone:
          compactSharedMeasurement.context_bytes / baselineBytes,
      },
    },
    prompt_cleanup_operations: [
      "project account-ref and brand-ref selectors to canonical-account-ref and brand-key",
      "represent targeting requirements as required_dimensions plus structured constraints",
      "omit deprecated axe and signal_targeting branches from the 3.2 prompt view",
      "omit purchase terms inherited unchanged from the selected pricing option",
    ],
    prompt_cleanup_adapter: {
      required: true,
      reason:
        "required_dimensions plus constraints must expand to canonical required_overlay_support before validation",
      affected_tools: [
        "list_products",
        "request_proposals",
        "refine_proposals",
      ],
    },
    weights: {
      ...Object.fromEntries(
        Object.entries(baselineWeights).filter(
          ([key]) => !["fields", "definitions"].includes(key)
        )
      ),
      largest_fields: baselineWeights.fields.slice(0, 20),
      largest_repeated_definitions: baselineWeights.definitions.slice(0, 20),
    },
  };
}

if (require.main === module) {
  console.log(JSON.stringify(buildExperimentReport(), null, 2));
}

module.exports = {
  DICTIONARY_ID,
  MODEL_CONTEXT_DIR,
  buildExperimentReport,
  loadRepresentativeMediaBuyRuntime,
};
