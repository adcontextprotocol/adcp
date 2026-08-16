#!/usr/bin/env node

"use strict";

const assert = require("node:assert/strict");
const { isDeepStrictEqual } = require("node:util");

const JSON_SCHEMA_2020_12 = "https://json-schema.org/draft/2020-12/schema";
const ACCOUNT_REF = "external:core/account-ref.json";
const CANONICAL_ACCOUNT_REF = "external:core/canonical-account-ref.json";
const BRAND_REF = "external:core/brand-ref.json";
const BRAND_KEY = "external:core/brand-key.json";
const TARGETING = "external:core/targeting.json";
const TARGETING_REQUIREMENTS =
  "external:core/targeting-overlay-requirements.json";
const PRODUCT_PURCHASE = "external:media-buy/product-purchase.json";

const TARGETING_DIMENSIONS = [
  "geo_countries",
  "geo_countries_exclude",
  "geo_regions",
  "geo_regions_exclude",
  "geo_metros",
  "geo_metros_exclude",
  "geo_postal_areas",
  "geo_postal_areas_exclude",
  "geo_proximity",
  "daypart_targets",
  "audience_include",
  "audience_exclude",
  "signal_targeting_groups",
  "demographics",
  "frequency_cap",
  "property_list",
  "property_list_exclude",
  "collection_list",
  "collection_list_exclude",
  "placement_selection",
  "age_restriction",
  "device_platform",
  "device_platform_exclude",
  "device_type",
  "device_type_exclude",
  "browser",
  "browser_exclude",
  "store_catchments",
  "language",
  "keyword_targets",
  "negative_keywords",
];

function clone(value) {
  return structuredClone(value);
}

function compactBytes(value) {
  return Buffer.byteLength(JSON.stringify(value));
}

function pointerSegment(value) {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function definitionRef(name) {
  return { $ref: `#/$defs/${pointerSegment(name)}` };
}

function forEachRef(value, visit, { includeDefinitions = true } = {}) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) forEachRef(item, visit, { includeDefinitions });
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (!includeDefinitions && key === "$defs") continue;
    if (key === "$ref" && typeof child === "string") visit(child, value);
    else forEachRef(child, visit, { includeDefinitions });
  }
}

function definitionNameForRef(ref, names) {
  if (typeof ref !== "string" || !ref.startsWith("#/$defs/")) return undefined;
  const decoded = ref
    .slice("#/$defs/".length)
    .replaceAll("~1", "/")
    .replaceAll("~0", "~");
  return [...names]
    .filter((name) => decoded === name || decoded.startsWith(`${name}/`))
    .sort((left, right) => right.length - left.length)[0];
}

function collectDefinitionClosure(value, definitions) {
  const names = new Set(Object.keys(definitions));
  const closure = new Set();
  const queue = [];

  function addRef(ref) {
    const name = definitionNameForRef(ref, names);
    if (!name || closure.has(name)) return;
    closure.add(name);
    queue.push(name);
  }

  forEachRef(value, addRef, { includeDefinitions: false });
  while (queue.length > 0) {
    const name = queue.pop();
    forEachRef(definitions[name], addRef);
  }
  return closure;
}

function mergeDefinitions(schemas) {
  const definitions = {};
  const occurrences = new Map();
  for (const [toolName, schema] of Object.entries(schemas)) {
    for (const [name, definition] of Object.entries(schema.$defs || {})) {
      if (
        Object.hasOwn(definitions, name) &&
        !isDeepStrictEqual(definitions[name], definition)
      ) {
        throw new Error(`Conflicting shared definition ${name} in ${toolName}`);
      }
      definitions[name] = clone(definition);
      const occurrence = occurrences.get(name) || { count: 0, tools: [] };
      occurrence.count++;
      occurrence.tools.push(toolName);
      occurrences.set(name, occurrence);
    }
  }
  return { definitions, occurrences };
}

function pruneSchemaDefinitions(schema, availableDefinitions) {
  const root = clone(schema);
  delete root.$defs;
  const closure = collectDefinitionClosure(root, availableDefinitions);
  if (closure.size > 0) {
    root.$defs = Object.fromEntries(
      [...closure]
        .sort()
        .map((name) => [name, clone(availableDefinitions[name])])
    );
  }
  return root;
}

function replaceDefinitionRefs(value, replacements) {
  forEachRef(value, (ref, owner) => {
    for (const [oldName, newName] of Object.entries(replacements)) {
      const oldPrefix = `#/$defs/${pointerSegment(oldName)}`;
      if (ref !== oldPrefix && !ref.startsWith(`${oldPrefix}/`)) continue;
      owner.$ref = `#/$defs/${pointerSegment(newName)}${ref.slice(
        oldPrefix.length
      )}`;
      return;
    }
  });
}

function structuredArrayRequirement(propertyName, enumDefinition) {
  return {
    type: "object",
    properties: {
      [propertyName]: {
        type: "array",
        items: definitionRef(enumDefinition),
      },
    },
    required: [propertyName],
    additionalProperties: false,
  };
}

function buildCompactTargetingRequirements() {
  const required = { type: "boolean", const: true };
  const metro = structuredArrayRequirement(
    "systems",
    "external:enums/metro-system.json"
  );
  const browser = structuredArrayRequirement(
    "families",
    "external:enums/browser-family.json"
  );
  const keyword = structuredArrayRequirement(
    "supported_match_types",
    "external:enums/match-type.json"
  );
  return {
    type: "object",
    properties: {
      required_dimensions: {
        type: "array",
        items: { type: "string", enum: TARGETING_DIMENSIONS },
      },
      constraints: {
        type: "object",
        properties: {
          geo_metros: metro,
          geo_metros_exclude: clone(metro),
          geo_postal_areas: definitionRef(
            "external:core/positive-postal-area-support.json"
          ),
          geo_postal_areas_exclude: definitionRef(
            "external:core/positive-postal-area-support.json"
          ),
          geo_proximity: {
            type: "object",
            properties: {
              radius: clone(required),
              travel_time: clone(required),
              geometry: clone(required),
              transport_modes: {
                type: "array",
                items: definitionRef("external:enums/transport-mode.json"),
              },
            },
            anyOf: ["radius", "travel_time", "geometry", "transport_modes"].map(
              (name) => ({ required: [name] })
            ),
            additionalProperties: false,
          },
          demographics: {
            type: "object",
            properties: { age: clone(required) },
            required: ["age"],
            additionalProperties: false,
          },
          browser,
          browser_exclude: clone(browser),
          keyword_targets: keyword,
          negative_keywords: clone(keyword),
        },
        additionalProperties: false,
      },
      ext: definitionRef("external:core/ext.json"),
    },
    anyOf: [
      { required: ["required_dimensions"] },
      { required: ["constraints"] },
    ],
    additionalProperties: false,
  };
}

/**
 * Produce a prompt-only 3.2 cleanup experiment. This deliberately does not
 * change or replace the canonical validation schemas.
 */
function applyMediaBuyPromptCleanupExperiment(schemas) {
  const output = clone(schemas);
  const { definitions } = mergeDefinitions(output);
  const replacements = {
    [ACCOUNT_REF]: CANONICAL_ACCOUNT_REF,
    [BRAND_REF]: BRAND_KEY,
  };

  for (const definition of Object.values(definitions)) {
    replaceDefinitionRefs(definition, replacements);
  }
  definitions[TARGETING_REQUIREMENTS] = buildCompactTargetingRequirements();

  const targeting = definitions[TARGETING];
  assert.ok(targeting?.properties, `Experiment requires ${TARGETING}`);
  for (const property of [
    "axe_include_segment",
    "axe_exclude_segment",
    "signal_targeting",
  ]) {
    delete targeting.properties[property];
  }

  const purchase = definitions[PRODUCT_PURCHASE];
  assert.ok(purchase?.properties, `Experiment requires ${PRODUCT_PURCHASE}`);
  for (const property of [
    "pricing",
    "start_time",
    "end_time",
    "measurement_terms",
    "performance_standards",
  ]) {
    delete purchase.properties[property];
  }

  for (const [toolName, schema] of Object.entries(output)) {
    const root = clone(schema);
    delete root.$defs;
    replaceDefinitionRefs(root, replacements);
    output[toolName] = pruneSchemaDefinitions(root, definitions);
  }
  return output;
}

function expandCompactTargetingRequirements(requirements) {
  if (
    !requirements ||
    typeof requirements !== "object" ||
    Array.isArray(requirements)
  ) {
    return requirements;
  }
  if (
    !Object.hasOwn(requirements, "required_dimensions") &&
    !Object.hasOwn(requirements, "constraints")
  ) {
    return clone(requirements);
  }
  const output = {};
  for (const dimension of requirements.required_dimensions || [])
    output[dimension] = true;
  Object.assign(output, clone(requirements.constraints || {}));
  if (Object.hasOwn(requirements, "ext")) output.ext = clone(requirements.ext);
  return output;
}

/** Translate the one non-wire-compatible cleanup shape before validation. */
function adaptMediaBuyPromptArguments(toolName, argumentsValue) {
  const output = clone(argumentsValue);
  if (!output || typeof output !== "object" || Array.isArray(output))
    return output;
  function adaptCriteria(criteria) {
    if (!criteria || typeof criteria !== "object" || Array.isArray(criteria))
      return;
    if (Object.hasOwn(criteria, "required_overlay_support")) {
      criteria.required_overlay_support = expandCompactTargetingRequirements(
        criteria.required_overlay_support
      );
    }
  }
  if (["list_products", "request_proposals"].includes(toolName))
    adaptCriteria(output.criteria);
  if (toolName === "refine_proposals" && Array.isArray(output.refinements)) {
    for (const refinement of output.refinements)
      adaptCriteria(refinement?.criteria);
  }
  return output;
}

function rewriteRootRefsToDictionary(schema, dictionaryId) {
  forEachRef(
    schema,
    (ref, owner) => {
      if (ref.startsWith("#/$defs/")) owner.$ref = `${dictionaryId}${ref}`;
    },
    { includeDefinitions: false }
  );
}

function buildSharedDefinitionsView({ schemas, tools, dictionaryId }) {
  if (!dictionaryId || typeof dictionaryId !== "string") {
    throw new Error("dictionaryId must be a non-empty string");
  }
  const { definitions } = mergeDefinitions(schemas);
  const projectedTools = {};
  for (const toolName of Object.keys(schemas).sort()) {
    const inputSchema = clone(schemas[toolName]);
    delete inputSchema.$defs;
    rewriteRootRefsToDictionary(inputSchema, dictionaryId);
    projectedTools[toolName] = {
      name: toolName,
      ...(tools?.[toolName]?.description
        ? { description: tools[toolName].description }
        : {}),
      inputSchema,
    };
  }
  return {
    dictionary: {
      $schema: JSON_SCHEMA_2020_12,
      $id: dictionaryId,
      $defs: Object.fromEntries(
        Object.entries(definitions).sort(([left], [right]) =>
          left.localeCompare(right)
        )
      ),
    },
    tools: projectedTools,
  };
}

function effectiveRootProperties(schema, definitions) {
  const properties = { ...(schema.properties || {}) };
  const visited = new Set();

  function mergeAllOf(node) {
    if (!node || typeof node !== "object" || Array.isArray(node)) return;
    Object.assign(properties, node.properties || {});
    for (const branch of node.allOf || []) {
      if (branch?.$ref) {
        const name = definitionNameForRef(
          branch.$ref,
          new Set(Object.keys(definitions))
        );
        if (!name || visited.has(name)) continue;
        visited.add(name);
        mergeAllOf(definitions[name]);
      } else {
        mergeAllOf(branch);
      }
    }
  }

  mergeAllOf(schema);
  return properties;
}

function definitionSetBytes(names, definitions) {
  if (names.size === 0) return 0;
  return compactBytes(
    Object.fromEntries(
      [...names].sort().map((name) => [name, definitions[name]])
    )
  );
}

function analyzeInputSchemaWeights(schemas) {
  const { definitions, occurrences } = mergeDefinitions(schemas);
  const definitionInstances = [...occurrences.values()].reduce(
    (total, occurrence) => total + occurrence.count,
    0
  );
  const embeddedDefinitionBytes = Object.values(schemas).reduce(
    (total, schema) => total + compactBytes(schema.$defs || {}),
    0
  );
  const uniqueDefinitionBytes = compactBytes(definitions);

  const fields = [];
  for (const [toolName, schema] of Object.entries(schemas)) {
    for (const [field, fieldSchema] of Object.entries(
      effectiveRootProperties(schema, schema.$defs || {})
    )) {
      const closure = collectDefinitionClosure(fieldSchema, schema.$defs || {});
      fields.push({
        tool: toolName,
        field,
        direct_schema_bytes: compactBytes(fieldSchema),
        transitive_definition_count: closure.size,
        transitive_definition_bytes: definitionSetBytes(
          closure,
          schema.$defs || {}
        ),
      });
    }
  }
  fields.sort(
    (left, right) =>
      right.transitive_definition_bytes - left.transitive_definition_bytes ||
      left.tool.localeCompare(right.tool) ||
      left.field.localeCompare(right.field)
  );

  const repeatedDefinitions = [...occurrences.entries()]
    .filter(([, occurrence]) => occurrence.count > 1)
    .map(([name, occurrence]) => {
      const bytes = compactBytes(definitions[name]);
      return {
        name,
        instances: occurrence.count,
        definition_bytes: bytes,
        repeated_bytes: bytes * (occurrence.count - 1),
        tools: occurrence.tools,
      };
    })
    .sort(
      (left, right) =>
        right.repeated_bytes - left.repeated_bytes ||
        left.name.localeCompare(right.name)
    );

  return {
    tool_count: Object.keys(schemas).length,
    input_schema_bytes: Object.values(schemas).reduce(
      (total, schema) => total + compactBytes(schema),
      0
    ),
    definition_instances: definitionInstances,
    unique_definitions: Object.keys(definitions).length,
    repeated_definitions: repeatedDefinitions.length,
    embedded_definition_bytes: embeddedDefinitionBytes,
    unique_definition_bytes: uniqueDefinitionBytes,
    repeated_definition_bytes: embeddedDefinitionBytes - uniqueDefinitionBytes,
    fields,
    definitions: repeatedDefinitions,
  };
}

function toolsListPayload(tools) {
  return {
    tools: Object.values(tools).sort((left, right) =>
      left.name.localeCompare(right.name)
    ),
  };
}

module.exports = {
  ACCOUNT_REF,
  BRAND_REF,
  PRODUCT_PURCHASE,
  TARGETING,
  TARGETING_REQUIREMENTS,
  analyzeInputSchemaWeights,
  adaptMediaBuyPromptArguments,
  applyMediaBuyPromptCleanupExperiment,
  buildCompactTargetingRequirements,
  buildSharedDefinitionsView,
  collectDefinitionClosure,
  compactBytes,
  definitionNameForRef,
  expandCompactTargetingRequirements,
  mergeDefinitions,
  pruneSchemaDefinitions,
  toolsListPayload,
};
