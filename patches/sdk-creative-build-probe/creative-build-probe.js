"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var creative_build_probe_exports = {};
__export(creative_build_probe_exports, {
  prepareCreativeBuildProbe: () => prepareCreativeBuildProbe,
  resolveCreativeBuildProbe: () => resolveCreativeBuildProbe,
  validateCreativeBuildProbeSpec: () => validateCreativeBuildProbeSpec
});
module.exports = __toCommonJS(creative_build_probe_exports);
var import_fixture_resolution = require('./fixture-resolution.js');
var import_schema_loader = require('../../validation/schema-loader.js');
var import_version = require('../../version.js');
var import_redact_secrets = require('../../utils/redact-secrets.js');
var import_json_depth = require('../../utils/json-depth.js');
var import_resolve_agent_properties = require('../../discovery/resolve-agent-properties.js');
const INPUT_FIELDS = /* @__PURE__ */ new Set([
  "message",
  "creative_manifest",
  "creative_id",
  "transformer_id",
  "config",
  "target_format_id"
]);
const TRUST_FIELDS = /^(auth|private[_-]?key|bearer[_-]?token|id[_-]?token|jwk|jwks|jwks[_-]?uri|x[_-]api[_-]key|signing[_-]?key|secret[_-]?key|hmac[_-]?key|client[_-]?key)$/i;
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
function at(value, ...keys) {
  for (const key of keys) value = isRecord(value) ? value[key] : void 0;
  return value;
}
function displayDiagnostic(value, limit) {
  let displayed = "";
  for (const char of value) {
    const escaped = JSON.stringify(char).slice(1, -1).replace(/[\u007f-\u009f\u2028\u2029]/g, (control) => `\\u${control.charCodeAt(0).toString(16).padStart(4, "0")}`);
    if (displayed.length + escaped.length > limit - 1) return `${displayed}\u2026`;
    displayed += escaped;
  }
  return displayed;
}
function displayUnknownKind(kind) {
  return `"${displayDiagnostic(kind.slice(0, 128), 768)}"`;
}
function displayValidationErrors(errors) {
  const message = errors.slice(0, 8).map((error) => `${(error.instancePath || "/").slice(0, 2048)} ${(error.message ?? "").slice(0, 2048)}`).join("; ");
  return displayDiagnostic(message, 2048);
}
function validateCreativeBuildProbeSpec(value) {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "context_prefix" && key !== "message") || typeof value.context_prefix !== "string" || !/^[a-z][a-z0-9_]*$/.test(value.context_prefix) || typeof value.message !== "string" || value.message.trim().length === 0) {
    throw new Error("creative_build_probe requires context_prefix (lowercase identifier) and a nonempty message");
  }
}
function containsSecretField(value, depth = 0, seen = /* @__PURE__ */ new Set()) {
  if (depth > import_json_depth.MAX_JSON_DEPTH) throw new Error("creative_build_probe: fixture nesting exceeds the JSON depth bound");
  if (typeof value === "string" && /^https?:\/\//i.test(value)) {
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new Error("creative_build_probe: invalid URL in fixture");
    }
    return !!(url.username || url.password) || [...url.searchParams.keys()].some((key) => import_redact_secrets.SECRET_KEY_PATTERN.test(key) || TRUST_FIELDS.test(key));
  }
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) throw new Error("creative_build_probe: fixture must be acyclic JSON");
  seen.add(value);
  const found = Array.isArray(value) ? value.some((item) => containsSecretField(item, depth + 1, seen)) : Object.entries(value).some(
    ([key, item]) => import_redact_secrets.SECRET_KEY_PATTERN.test(key) || TRUST_FIELDS.test(key) || containsSecretField(item, depth + 1, seen)
  );
  seen.delete(value);
  return found;
}
function validateRecipeBudget(value, location) {
  let nodes = 0;
  let bytes = 0;
  const ancestors = /* @__PURE__ */ new Set();
  const visit = (item, depth) => {
    if (++nodes > 1e5 || depth > import_json_depth.MAX_JSON_DEPTH)
      throw new Error(`${location}: recipe exceeds the fixture node/depth budget`);
    if (typeof item === "string") bytes += Buffer.byteLength(item, "utf8");
    if (bytes > 4 * 1024 * 1024) throw new Error(`${location}: recipe exceeds the 4 MiB fixture string budget`);
    if (!item || typeof item !== "object") return;
    if (ancestors.has(item)) throw new Error(`${location}: recipe must be acyclic JSON`);
    ancestors.add(item);
    for (const [key, child] of Object.entries(item)) {
      bytes += Buffer.byteLength(key, "utf8");
      visit(child, depth + 1);
    }
    ancestors.delete(item);
  };
  visit(value, 0);
}
function validateInput(value, location, validateManifest) {
  if (!isRecord(value) || Object.keys(value).some((key) => !INPUT_FIELDS.has(key))) {
    throw new Error(
      `${location}: input may only contain message, creative_manifest, creative_id, transformer_id, config and target_format_id`
    );
  }
  if (containsSecretField(value))
    throw new Error(`${location}: input must not carry credential or trust-material fields`);
  for (const key of ["message", "creative_id", "transformer_id"]) {
    if (value[key] !== void 0 && (typeof value[key] !== "string" || value[key].trim().length === 0)) {
      throw new Error(`${location}: ${key} must be a nonempty string`);
    }
  }
  if (value.config !== void 0 && (!isRecord(value.config) || !value.transformer_id))
    throw new Error(
      `${location}: this probe contract requires config to be an object bound to a provisioned transformer_id`
    );
  if (value.creative_id && value.creative_manifest)
    throw new Error(
      `${location}: this probe contract requires one unambiguous source, not both creative_id and creative_manifest`
    );
  if (value.creative_manifest !== void 0) {
    const manifest = value.creative_manifest;
    if (!validateManifest || !validateManifest(manifest)) {
      throw new Error(`${location}: creative_manifest must be a complete manifest, including format and assets`);
    }
  }
  if (!value.message && !value.creative_manifest && !value.creative_id && !value.transformer_id) {
    throw new Error(
      `${location}: input must identify a brief, source manifest or provisioned library creative/transformer`
    );
  }
}
function resolveCreativeBuildProbe(creative, spec, testKit, adcpVersion, governanceEnforcement) {
  return resolveCreativeBuildProbeWithSchemas(
    creative,
    spec,
    testKit,
    governanceEnforcement,
    adcpVersion,
    captureRequestSchemas(adcpVersion)
  );
}
function captureRequestSchemas(adcpVersion) {
  return {
    request: (0, import_schema_loader.getSchemaDocumentByRef)("media-buy/build-creative-request.json", adcpVersion)?.schema,
    validateManifest: (0, import_schema_loader.getSchemaValidatorByRef)("core/creative-manifest.json", adcpVersion),
    validateFormatId: (0, import_schema_loader.getSchemaValidatorByRef)("core/format-id.json", adcpVersion),
    formatIdProperties: at((0, import_schema_loader.getSchemaDocumentByRef)("core/format-id.json", adcpVersion)?.schema, "properties")
  };
}
function prepareCreativeBuildProbe(capabilities, spec, testKit, adcpVersion) {
  const requestSchemas = captureRequestSchemas(adcpVersion);
  return (0, import_schema_loader.withServedValidationVersion)(
    capabilities,
    adcpVersion ?? import_version.ADCP_VERSION,
    (catalogVersion) => resolveCreativeBuildProbeWithSchemas(
      at(capabilities, "creative"),
      spec,
      testKit,
      at(capabilities, "adcp", "governance_enforcement"),
      catalogVersion,
      requestSchemas
    )
  );
}
function resolveCreativeBuildProbeWithSchemas(creative, spec, testKit, governanceEnforcement, catalogAdcpVersion, requestSchemas) {
  validateCreativeBuildProbeSpec(spec);
  if (isRecord(creative) && creative.supported_formats !== void 0 && !Array.isArray(creative.supported_formats)) {
    return { status: "failed", detail: "creative.supported_formats: malformed catalog (expected array)" };
  }
  if (!isRecord(creative) || !Array.isArray(creative.supported_formats)) {
    return {
      status: "unsatisfied",
      detail: `fixture_unsatisfied: creative_format:${spec.context_prefix}: no advertised creative build catalog`
    };
  }
  const recipes = isRecord(testKit) && testKit.creative_build_probes !== void 0 ? testKit.creative_build_probes : [];
  if (!Array.isArray(recipes)) throw new Error("test_kit.creative_build_probes must be an array");
  if (recipes.some(
    (recipe) => isRecord(recipe) && isRecord(recipe.input) && recipe.input.creative_manifest !== void 0
  ) && !requestSchemas.validateManifest) {
    return {
      status: "unsatisfied",
      detail: `fixture_unsatisfied: creative_format:${spec.context_prefix}: selected-version source manifest schema validator is unavailable`
    };
  }
  const normalized = recipes.map((recipe, index) => {
    const location = `test_kit.creative_build_probes[${index}]`;
    validateRecipeBudget(recipe, location);
    if (!isRecord(recipe) || Object.keys(recipe).some((key) => key !== "match" && key !== "input")) {
      throw new Error(`${location}: expected only match and input`);
    }
    const match = (0, import_fixture_resolution.normalizeFixtureMatchExpression)(recipe.match, `${location}.match`);
    if (match.length === 0) throw new Error(`${location}: at least one explicit match predicate is required`);
    validateInput(recipe.input, location, requestSchemas.validateManifest);
    return { match, input: recipe.input };
  });
  const catalogDocument = (0, import_schema_loader.getSchemaDocumentByRef)("protocol/get-adcp-capabilities-response.json", catalogAdcpVersion);
  const catalog = catalogDocument?.schema;
  const selectedVersion = catalogDocument?.resolvedVersion ?? catalogAdcpVersion ?? "selected bundle";
  const item = at(catalog, "properties", "creative", "properties", "supported_formats", "items");
  const request = requestSchemas.request;
  const canonicalSelector = !!at(request, "properties", "target_capability_id");
  const legacySelector = !!at(request, "properties", "target_format_id");
  const catalogRequest = (0, import_schema_loader.getSchemaDocumentByRef)("media-buy/build-creative-request.json", catalogAdcpVersion)?.schema;
  const canonicalCatalog = !!at(catalogRequest, "properties", "target_capability_id");
  const requestIdPattern = at(request, "properties", "target_capability_id", "pattern");
  const canonicalAddressable = (route) => canonicalCatalog && canonicalSelector && typeof route.capability_id === "string" && (typeof requestIdPattern !== "string" || new RegExp(requestIdPattern).test(route.capability_id));
  const ref = at(item, "properties", "format", "$ref");
  const formatRef = typeof ref === "string" ? ref.replace(/^(?:https:\/\/adcontextprotocol\.org)?\/schemas\/(?:(?:v?\d[^/]*|latest)\/)?/, "") : void 0;
  const validateFormat = formatRef ? (0, import_schema_loader.getSchemaValidatorByRef)(formatRef, catalogAdcpVersion) : void 0;
  const validateKind = (0, import_schema_loader.getSchemaValidatorByRef)("core/canonical-format-kind.json", catalogAdcpVersion);
  if (!validateFormat || !validateKind || !catalogRequest || !canonicalSelector && !legacySelector) {
    return {
      status: "unsatisfied",
      detail: `fixture_unsatisfied: creative_format:${spec.context_prefix}: selected-version creative catalog schema validators are unavailable`
    };
  }
  for (const recipe of normalized) {
    if (recipe.input.target_format_id !== void 0) {
      if (!legacySelector)
        throw new Error(
          "test_kit.creative_build_probes: target_format_id is not supported by the selected build request"
        );
      const validateId = requestSchemas.validateFormatId;
      if (!validateId)
        return {
          status: "unsatisfied",
          detail: `fixture_unsatisfied: creative_format:${spec.context_prefix}: selected-version legacy FormatID schema validator is unavailable`
        };
      if (!validateId(recipe.input.target_format_id))
        throw new Error(
          "test_kit.creative_build_probes: target_format_id must be a selected-version valid provisioned FormatID"
        );
    }
  }
  const idPattern = at(item, "properties", "capability_id", "pattern");
  const hasOperations = at(item, "properties", "operations") !== void 0;
  const isBuildRoute = (entry) => !hasOperations || entry.operations === void 0 || Array.isArray(entry.operations) && entry.operations.includes("build");
  const selectorProperties = at(
    (0, import_schema_loader.getSchemaDocumentByRef)("core/format-id.json", catalogAdcpVersion)?.schema,
    "properties"
  );
  const requestSelectorProperties = requestSchemas.formatIdProperties;
  const requestHasPixelRatio = at(requestSelectorProperties, "pixel_ratio") !== void 0;
  const legacyDimensions = ["width", "height", "duration_ms", "pixel_ratio"].filter(
    (key) => at(selectorProperties, key) !== void 0
  );
  const unavailableKinds = /* @__PURE__ */ new Set();
  const ids = /* @__PURE__ */ new Set();
  const buildRoutes = [];
  for (const [index, entry] of creative.supported_formats.entries()) {
    const location = `creative.supported_formats[${index}]`;
    const invalid = (detail) => ({
      status: "failed",
      detail: `${location}: ${detail}`
    });
    if (!isRecord(entry)) return invalid("malformed catalog entry (expected object)");
    if (entry.capability_id !== void 0) {
      if (typeof entry.capability_id !== "string" || typeof idPattern === "string" && !new RegExp(idPattern).test(entry.capability_id) || canonicalCatalog && ids.has(entry.capability_id)) {
        return invalid("capability_id must be usable and unique within the catalog");
      }
      ids.add(entry.capability_id);
    }
    const operations = entry.operations;
    if (hasOperations && operations !== void 0 && (!Array.isArray(operations) || operations.length === 0 || operations.some(
      (operation, index2) => typeof operation !== "string" || !["build", "validate", "preview"].includes(operation) || operations.indexOf(operation) !== index2
    ))) {
      return invalid("operations must be a nonempty unique array of build, validate or preview");
    }
    if (!isRecord(entry.format) || typeof entry.format.format_kind !== "string" || !isRecord(entry.format.params)) {
      return invalid("format must declare format_kind and params");
    }
    if (!canonicalCatalog && !validateKind(entry.format.format_kind)) {
      unavailableKinds.add(entry.format.format_kind);
      if (isBuildRoute(entry)) buildRoutes.push(entry);
      continue;
    }
    if (!validateFormat(entry.format) || !validateKind(entry.format.format_kind)) {
      return invalid(
        `malformed format declaration: ${displayValidationErrors([...validateFormat.errors ?? [], ...validateKind.errors ?? []])}`
      );
    }
    const validateParams = (0, import_schema_loader.getSchemaValidatorByRef)(
      `formats/canonical/${entry.format.format_kind}.json`,
      catalogAdcpVersion
    );
    if (entry.format.format_kind !== "custom" && !validateParams) {
      unavailableKinds.add(entry.format.format_kind);
      if (isBuildRoute(entry)) buildRoutes.push(entry);
      continue;
    }
    if (validateParams && !validateParams(entry.format.params) || validateFormat && !validateFormat(entry.format) || validateKind && !validateKind(entry.format.format_kind)) {
      return invalid(
        `malformed format declaration: ${displayValidationErrors([...validateParams?.errors ?? [], ...validateFormat?.errors ?? [], ...validateKind?.errors ?? []])}`
      );
    }
    if (isBuildRoute(entry)) buildRoutes.push(entry);
  }
  if (isRecord(governanceEnforcement) && Array.isArray(governanceEnforcement.tasks) && governanceEnforcement.tasks.some(
    (task) => isRecord(task) && task.task === "build_creative" && Array.isArray(task.modes) && task.modes.includes("signed_context")
  )) {
    return {
      status: "unsatisfied",
      detail: `fixture_unsatisfied: creative_format:${spec.context_prefix}: payload-bound build governance authorization is not prepared by this runner contract`
    };
  }
  for (const route of buildRoutes) {
    const knownKind = validateKind(route.format.format_kind);
    if (!knownKind || route.format.format_kind !== "custom" && !(0, import_schema_loader.getSchemaValidatorByRef)(
      `formats/canonical/${route.format.format_kind}.json`,
      catalogAdcpVersion
    ))
      continue;
    let source = "test_kit";
    const usable = (input2) => {
      if (input2.transformer_id) return creative.supports_transformers === true;
      if (input2.creative_id) return creative.has_creative_library === true;
      if (input2.creative_manifest)
        return creative.supports_transformation === true || creative.supports_generation === true;
      return creative.supports_generation === true;
    };
    const format = route.format;
    const legacyBindingAgrees = (input2) => {
      if (input2.target_format_id === void 0) return canonicalAddressable(route);
      if (format.canonical_formats_only === true || !isRecord(input2.target_format_id)) return false;
      if (!Array.isArray(format.v1_format_ref)) return true;
      const target = input2.target_format_id;
      const targetUrl = typeof target.agent_url === "string" ? (0, import_resolve_agent_properties.canonicalizeAgentUrl)(target.agent_url) : null;
      if (targetUrl === null) return false;
      return format.v1_format_ref.some(
        (ref2) => isRecord(ref2) && ref2.id === target.id && typeof ref2.agent_url === "string" && typeof target.agent_url === "string" && (0, import_resolve_agent_properties.canonicalizeAgentUrl)(ref2.agent_url) === targetUrl && legacyDimensions.every(
          (key) => key === "pixel_ratio" ? (ref2[key] ?? 1) === (requestHasPixelRatio ? target[key] ?? 1 : 1) : ref2[key] === void 0 || ref2[key] === target[key]
        )
      );
    };
    const selectedRecipe = normalized.find(
      (recipe) => (0, import_fixture_resolution.matchesFixtureRequirements)(route, recipe.match) && usable(recipe.input) && legacyBindingAgrees(recipe.input)
    );
    let input = selectedRecipe?.input;
    const kindValidator = (0, import_schema_loader.getSchemaValidatorByRef)("core/canonical-format-kind.json", catalogAdcpVersion);
    const emptyCompleteFormat = format.technical_requirements_complete === true && format.format_kind !== "custom" && kindValidator?.(format.format_kind) === true && Object.keys(format.params).length === 0 && Object.keys(format).every(
      (key) => [
        "format_kind",
        "params",
        "technical_requirements_complete",
        "display_name",
        "seller_preference",
        "experimental",
        "sample_render_url",
        "format_option_id",
        "publisher_domain",
        "applies_to_channels",
        "canonical_formats_only"
      ].includes(key)
    ) && Object.keys(route).every((key) => ["capability_id", "operations", "format"].includes(key));
    if (!input && canonicalAddressable(route) && creative.supports_generation === true && buildRoutes.length === 1 && emptyCompleteFormat) {
      source = "generation";
      const manifest = { format_kind: format.format_kind, assets: {} };
      const validateManifest = requestSchemas.validateManifest;
      if (!validateManifest?.(manifest)) continue;
      input = { message: spec.message, creative_manifest: manifest };
    }
    if (!input) continue;
    const useCanonicalSelector = input.target_format_id === void 0;
    const context = useCanonicalSelector ? { [`${spec.context_prefix}_capability_id`]: route.capability_id } : { [`${spec.context_prefix}_target_format_id`]: structuredClone(input.target_format_id) };
    for (const key of ["message", "creative_manifest", "creative_id", "transformer_id", "config"]) {
      if (input[key] !== void 0) context[`${spec.context_prefix}_${key}`] = structuredClone(input[key]);
    }
    return {
      status: "resolved",
      ...useCanonicalSelector ? { capabilityId: route.capability_id } : { formatId: structuredClone(input.target_format_id) },
      context,
      source,
      requirements: selectedRecipe?.match ?? []
    };
  }
  return {
    status: "unsatisfied",
    detail: `fixture_unsatisfied: creative_format:${spec.context_prefix}: no routable build entry has a known-valid generation input or a matching provisioned test-kit recipe${unavailableKinds.size ? `; ${unavailableKinds.size} unvalidated kind(s) in schema bundle ${selectedVersion}: ${[...unavailableKinds].slice(0, 8).map(displayUnknownKind).join(", ")}${unavailableKinds.size > 8 ? ", \u2026" : ""}` : ""}`
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  prepareCreativeBuildProbe,
  resolveCreativeBuildProbe,
  validateCreativeBuildProbeSpec
});
