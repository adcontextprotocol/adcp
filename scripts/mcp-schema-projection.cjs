#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MCP_PROTOCOL_VERSION = '2026-07-28';
const JSON_SCHEMA_DRAFT_07 = 'http://json-schema.org/draft-07/schema#';
const JSON_SCHEMA_2020_12 = 'https://json-schema.org/draft/2020-12/schema';
const SCHEMA_ORIGIN = 'https://adcontextprotocol.org';
const MAX_SCHEMA_DEPTH = 64;
const MAX_SCHEMA_OBJECTS = 10_000;
const MAX_SCHEMA_BYTES = 4 * 1024 * 1024;
const PRESENTATION_ANNOTATIONS = new Set([
  '$comment',
  'description',
  'enumDescriptions',
  'examples',
  'title',
]);

// Model prompt views communicate request shape while the parent role profile
// remains the validation authority. Omit low-signal primitive constraints and
// implementation extensions, but preserve properties, required fields,
// discriminators, enums, composition branches, and conditional structure.
const MODEL_CONTEXT_OMISSIONS = new Set([
  'default',
  'deprecated',
  'exclusiveMaximum',
  'exclusiveMinimum',
  'format',
  'maxItems',
  'maxLength',
  'maxProperties',
  'maximum',
  'minItems',
  'minLength',
  'minProperties',
  'minimum',
  'multipleOf',
  'pattern',
  'readOnly',
  'uniqueItems',
  'writeOnly',
]);

const POST_DRAFT_07_KEYWORDS = new Set([
  '$anchor',
  '$dynamicAnchor',
  '$dynamicRef',
  '$recursiveAnchor',
  '$recursiveRef',
  '$vocabulary',
  'contentSchema',
  'dependentRequired',
  'dependentSchemas',
  'maxContains',
  'minContains',
  'prefixItems',
  'unevaluatedItems',
  'unevaluatedProperties',
]);

const SINGLE_SCHEMA_KEYWORDS = new Set([
  'additionalProperties',
  'contains',
  'contentSchema',
  'else',
  'if',
  'not',
  'propertyNames',
  'then',
  'unevaluatedItems',
  'unevaluatedProperties',
]);

const SCHEMA_ARRAY_KEYWORDS = new Set([
  'allOf',
  'anyOf',
  'oneOf',
  'prefixItems',
]);

const SCHEMA_MAP_KEYWORDS = new Set([
  '$defs',
  'definitions',
  'dependentSchemas',
  'patternProperties',
  'properties',
]);

const REF_VALIDATION_SIBLINGS = new Set([
  ...SINGLE_SCHEMA_KEYWORDS,
  ...SCHEMA_ARRAY_KEYWORDS,
  ...SCHEMA_MAP_KEYWORDS,
  'additionalItems',
  'const',
  'dependencies',
  'enum',
  'exclusiveMaximum',
  'exclusiveMinimum',
  'format',
  'items',
  'maxContains',
  'maximum',
  'maxItems',
  'maxLength',
  'maxProperties',
  'minContains',
  'minimum',
  'minItems',
  'minLength',
  'minProperties',
  'multipleOf',
  'pattern',
  'required',
  'type',
  'uniqueItems',
]);

function clone(value) {
  return structuredClone(value);
}

function mergeSchemaMap(target, key, additions) {
  if (Object.keys(additions).length === 0) return;
  const existing = target[key];
  if (existing !== undefined && (typeof existing !== 'object' || existing === null || Array.isArray(existing))) {
    throw new Error(`${key} must be an object`);
  }
  const merged = { ...(existing || {}) };
  for (const [name, schema] of Object.entries(additions)) {
    if (Object.hasOwn(merged, name)) {
      throw new Error(`Cannot project duplicate ${key} entry ${JSON.stringify(name)}`);
    }
    merged[name] = schema;
  }
  target[key] = merged;
}

function forEachChildSchema(node, visit) {
  if (typeof node === 'boolean' || !node || typeof node !== 'object' || Array.isArray(node)) return;

  for (const [key, value] of Object.entries(node)) {
    if (key === 'items') {
      if (Array.isArray(value)) {
        for (const [index, item] of value.entries()) visit(item, ['items', String(index)]);
      } else if (typeof value === 'boolean' || (value && typeof value === 'object')) {
        visit(value, ['items']);
      }
      continue;
    }
    if (key === 'dependencies' && value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [name, dependency] of Object.entries(value)) {
        if (!Array.isArray(dependency)) visit(dependency, ['dependencies', name]);
      }
      continue;
    }
    if (SINGLE_SCHEMA_KEYWORDS.has(key) && (typeof value === 'boolean' || (value && typeof value === 'object'))) {
      visit(value, [key]);
      continue;
    }
    if (SCHEMA_ARRAY_KEYWORDS.has(key) && Array.isArray(value)) {
      for (const [index, schema] of value.entries()) visit(schema, [key, String(index)]);
      continue;
    }
    if (SCHEMA_MAP_KEYWORDS.has(key) && value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [name, schema] of Object.entries(value)) visit(schema, [key, name]);
    }
  }
}

function appendPointer(pointer, segments) {
  return pointer + segments.map(segment => `/${pointerSegment(segment)}`).join('');
}

function walkSchema(root, visit, depth = 1, pointer = '') {
  visit(root, depth, pointer);
  forEachChildSchema(root, (child, segments) => {
    walkSchema(child, visit, depth + 1, appendPointer(pointer, segments));
  });
}

function assertDraft07SourceSchema(schema, label) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new Error(`${label} must be a draft-07 schema object`);
  }
  if (schema.$schema !== JSON_SCHEMA_DRAFT_07) {
    throw new Error(
      `${label} must declare exact source dialect ${JSON.stringify(JSON_SCHEMA_DRAFT_07)}`
    );
  }

  walkSchema(schema, (node, _depth, pointer) => {
    if (typeof node === 'boolean' || !node || typeof node !== 'object') return;
    if (Object.hasOwn(node, '$schema') && node.$schema !== JSON_SCHEMA_DRAFT_07) {
      throw new Error(
        `${label}${pointer || '#'} changes schema dialect to ${JSON.stringify(node.$schema)}`
      );
    }
    const unsupported = Object.keys(node).find(key => POST_DRAFT_07_KEYWORDS.has(key));
    if (unsupported) {
      throw new Error(
        `${label}${pointer || '#'} uses post-draft-07 keyword ${JSON.stringify(unsupported)}`
      );
    }
  });
}

function collectLegacyDefinitionPointers(schema) {
  const pointers = new Set();
  walkSchema(schema, (node, _depth, pointer) => {
    if (typeof node === 'object' && node !== null && Object.hasOwn(node, 'definitions')) {
      pointers.add(appendPointer(pointer, ['definitions']));
    }
  });
  return pointers;
}

function rewriteLocalDefinitionRef(ref, legacyDefinitionPointers) {
  if (!ref.startsWith('#/')) return ref;

  const segments = ref.slice(2).split('/');
  let sourcePointer = '';
  for (let index = 0; index < segments.length; index++) {
    sourcePointer += `/${segments[index]}`;
    if (legacyDefinitionPointers.has(sourcePointer)) segments[index] = '$defs';
  }
  return `#/${segments.join('/')}`;
}

/**
 * Convert a draft-07 schema node to its semantics-equivalent 2020-12 shape.
 *
 * This deliberately walks only schema-bearing keywords. Annotation payloads
 * such as examples and default are copied byte-for-byte, even when their data
 * happens to contain keys named `$schema`, `items`, or `dependencies`.
 *
 * The projection does not introduce `unevaluatedProperties` or otherwise
 * tighten the accepted instance set. Contract tightening belongs to the AdCP
 * 4.0 source-dialect migration, not the 3.2 MCP transport projection.
 */
function projectDraft07Node(node, legacyDefinitionPointers = collectLegacyDefinitionPointers(node)) {
  if (typeof node === 'boolean') return node;
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    throw new Error('JSON Schema nodes must be objects or booleans');
  }

  if (typeof node.$ref === 'string') {
    const unsafeSibling = Object.keys(node).find(key => key !== '$ref' && REF_VALIDATION_SIBLINGS.has(key));
    if (unsafeSibling) {
      throw new Error(
        `Cannot preserve draft-07 $ref semantics with validation sibling ${JSON.stringify(unsafeSibling)}`
      );
    }
  }

  const projected = {};
  let legacyDefinitions;
  let legacyDependencies;
  let legacyAdditionalItems;

  for (const [key, value] of Object.entries(node)) {
    if (key === '$schema') {
      projected.$schema = JSON_SCHEMA_2020_12;
      continue;
    }
    if (key === '$ref' && typeof value === 'string') {
      projected.$ref = value.startsWith('#')
        ? rewriteLocalDefinitionRef(value, legacyDefinitionPointers)
        : value;
      continue;
    }
    if (key === 'definitions') {
      legacyDefinitions = value;
      continue;
    }
    if (key === 'dependencies') {
      legacyDependencies = value;
      continue;
    }
    if (key === 'additionalItems') {
      legacyAdditionalItems = value;
      continue;
    }
    if (key === 'items' && Array.isArray(value)) {
      projected.prefixItems = value.map(schema => projectDraft07Node(schema, legacyDefinitionPointers));
      continue;
    }
    if (key === 'items' && (typeof value === 'boolean' || (value && typeof value === 'object'))) {
      projected.items = projectDraft07Node(value, legacyDefinitionPointers);
      continue;
    }
    if (SINGLE_SCHEMA_KEYWORDS.has(key) && (typeof value === 'boolean' || (value && typeof value === 'object'))) {
      projected[key] = projectDraft07Node(value, legacyDefinitionPointers);
      continue;
    }
    if (SCHEMA_ARRAY_KEYWORDS.has(key) && Array.isArray(value)) {
      projected[key] = value.map(schema => projectDraft07Node(schema, legacyDefinitionPointers));
      continue;
    }
    if (SCHEMA_MAP_KEYWORDS.has(key) && value && typeof value === 'object' && !Array.isArray(value)) {
      projected[key] = Object.fromEntries(
        Object.entries(value).map(([name, schema]) => [
          name,
          projectDraft07Node(schema, legacyDefinitionPointers),
        ])
      );
      continue;
    }
    projected[key] = clone(value);
  }

  if (legacyDefinitions !== undefined) {
    if (!legacyDefinitions || typeof legacyDefinitions !== 'object' || Array.isArray(legacyDefinitions)) {
      throw new Error('definitions must be an object');
    }
    mergeSchemaMap(
      projected,
      '$defs',
      Object.fromEntries(
        Object.entries(legacyDefinitions).map(([name, schema]) => [
          name,
          projectDraft07Node(schema, legacyDefinitionPointers),
        ])
      )
    );
  }

  if (legacyDependencies !== undefined) {
    if (!legacyDependencies || typeof legacyDependencies !== 'object' || Array.isArray(legacyDependencies)) {
      throw new Error('dependencies must be an object');
    }
    const dependentRequired = {};
    const dependentSchemas = {};
    for (const [name, dependency] of Object.entries(legacyDependencies)) {
      if (Array.isArray(dependency)) {
        dependentRequired[name] = clone(dependency);
      } else {
        dependentSchemas[name] = projectDraft07Node(dependency, legacyDefinitionPointers);
      }
    }
    mergeSchemaMap(projected, 'dependentRequired', dependentRequired);
    mergeSchemaMap(projected, 'dependentSchemas', dependentSchemas);
  }

  if (legacyAdditionalItems !== undefined && projected.prefixItems !== undefined) {
    projected.items = typeof legacyAdditionalItems === 'boolean'
      ? legacyAdditionalItems
      : projectDraft07Node(legacyAdditionalItems, legacyDefinitionPointers);
  }

  return projected;
}

function pointerSegment(value) {
  return value.replace(/~/g, '~0').replace(/\//g, '~1');
}

function definitionKey(sourceDir, filename) {
  const relative = path.relative(sourceDir, filename).split(path.sep).join('/');
  return `external:${relative}`;
}

function parseExternalRef(ref, currentFile, sourceDir) {
  const hashIndex = ref.indexOf('#');
  const resource = hashIndex === -1 ? ref : ref.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? '' : ref.slice(hashIndex + 1);
  let resolved;

  if (resource.startsWith('/schemas/')) {
    resolved = path.resolve(sourceDir, resource.slice('/schemas/'.length));
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(resource)) {
    const url = new URL(resource);
    const marker = '/schemas/';
    const markerIndex = url.pathname.indexOf(marker);
    if (url.protocol !== 'https:' || markerIndex === -1) {
      throw new Error(`Unsupported external schema reference ${JSON.stringify(ref)}`);
    }
    resolved = path.resolve(sourceDir, decodeURIComponent(url.pathname.slice(markerIndex + marker.length)));
  } else {
    resolved = path.resolve(path.dirname(currentFile), resource);
  }

  const relative = path.relative(sourceDir, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Schema reference escapes source root: ${JSON.stringify(ref)}`);
  }
  if (!fs.existsSync(resolved)) {
    throw new Error(`Referenced schema does not exist: ${JSON.stringify(ref)} from ${currentFile}`);
  }
  return { resolved, fragment };
}

function compactDraft07Schema(rootSchema, rootFile, sourceDir) {
  assertDraft07SourceSchema(rootSchema, rootFile);
  const externalDefinitions = {};
  const bundledFiles = new Map();

  function localRef(fragment, currentKey) {
    if (!currentKey) return `#${fragment}`;
    const base = `#/definitions/${pointerSegment(currentKey)}`;
    if (!fragment) return base;
    if (!fragment.startsWith('/')) {
      throw new Error(`Unsupported anchor reference #${fragment} in ${currentKey}`);
    }
    return `${base}${fragment}`;
  }

  function rewriteRef(ref, currentFile, currentKey) {
    if (ref.startsWith('#')) return localRef(ref.slice(1), currentKey);

    const { resolved, fragment } = parseExternalRef(ref, currentFile, sourceDir);
    if (resolved === rootFile) return `#${fragment}`;
    if (resolved === currentFile) return localRef(fragment, currentKey);

    const key = definitionKey(sourceDir, resolved);
    if (!bundledFiles.has(resolved)) {
      bundledFiles.set(resolved, key);
      externalDefinitions[key] = true;
      const referenced = JSON.parse(fs.readFileSync(resolved, 'utf8'));
      assertDraft07SourceSchema(referenced, resolved);
      delete referenced.$id;
      delete referenced.$schema;
      externalDefinitions[key] = rewriteNode(referenced, resolved, key);
    }
    const base = `#/definitions/${pointerSegment(key)}`;
    return fragment ? `${base}${fragment.startsWith('/') ? fragment : `#${fragment}`}` : base;
  }

  function rewriteNode(node, currentFile, currentKey) {
    if (typeof node === 'boolean') return node;
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      throw new Error('JSON Schema nodes must be objects or booleans');
    }

    const rewritten = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') {
        rewritten.$ref = rewriteRef(value, currentFile, currentKey);
        continue;
      }
      if (key === 'items') {
        rewritten.items = Array.isArray(value)
          ? value.map(schema => rewriteNode(schema, currentFile, currentKey))
          : rewriteNode(value, currentFile, currentKey);
        continue;
      }
      if (key === 'dependencies' && value && typeof value === 'object' && !Array.isArray(value)) {
        rewritten.dependencies = Object.fromEntries(
          Object.entries(value).map(([name, dependency]) => [
            name,
            Array.isArray(dependency) ? clone(dependency) : rewriteNode(dependency, currentFile, currentKey),
          ])
        );
        continue;
      }
      if (SINGLE_SCHEMA_KEYWORDS.has(key) && (typeof value === 'boolean' || (value && typeof value === 'object'))) {
        rewritten[key] = rewriteNode(value, currentFile, currentKey);
        continue;
      }
      if (SCHEMA_ARRAY_KEYWORDS.has(key) && Array.isArray(value)) {
        rewritten[key] = value.map(schema => rewriteNode(schema, currentFile, currentKey));
        continue;
      }
      if (SCHEMA_MAP_KEYWORDS.has(key) && value && typeof value === 'object' && !Array.isArray(value)) {
        rewritten[key] = Object.fromEntries(
          Object.entries(value).map(([name, schema]) => [name, rewriteNode(schema, currentFile, currentKey)])
        );
        continue;
      }
      rewritten[key] = clone(value);
    }
    return rewritten;
  }

  const bundled = rewriteNode(rootSchema, rootFile, undefined);
  if (Object.keys(externalDefinitions).length > 0) {
    if (bundled.definitions && (typeof bundled.definitions !== 'object' || Array.isArray(bundled.definitions))) {
      throw new Error('definitions must be an object');
    }
    bundled.definitions = { ...(bundled.definitions || {}), ...externalDefinitions };
  }
  return bundled;
}

function collectExternalRefs(schema) {
  const refs = [];
  walkSchema(schema, node => {
    if (typeof node !== 'object' || node === null) return;
    for (const keyword of ['$ref', '$dynamicRef', '$recursiveRef']) {
      const value = node[keyword];
      if (typeof value === 'string' && !value.startsWith('#')) refs.push(value);
    }
  });
  return refs;
}

function resolvePointer(document, ref) {
  if (ref === '#') return document;
  if (!ref.startsWith('#/')) return undefined;
  let current = document;
  for (const rawSegment of ref.slice(2).split('/')) {
    const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

function assertLocalRefsResolve(schema) {
  let count = 0;
  walkSchema(schema, node => {
    if (typeof node !== 'object' || node === null || typeof node.$ref !== 'string') return;
    if (!node.$ref.startsWith('#')) throw new Error(`External $ref remains: ${node.$ref}`);
    if (resolvePointer(schema, node.$ref) === undefined) {
      throw new Error(`Unresolved local $ref: ${node.$ref}`);
    }
    count++;
  });
  return count;
}

function measureSchema(schema) {
  let objectCount = 0;
  let depth = 0;

  function visit(value, currentDepth) {
    depth = Math.max(depth, currentDepth);
    if (value === null || typeof value !== 'object') return;
    if (!Array.isArray(value)) objectCount++;
    for (const child of Object.values(value)) visit(child, currentDepth + 1);
  }

  visit(schema, 1);
  return {
    bytes: Buffer.byteLength(JSON.stringify(schema)),
    depth,
    objectCount,
  };
}

/**
 * Remove presentation-only annotations without changing validation semantics.
 * Walk only schema-bearing keywords so payloads in const/default/enum values
 * are never rewritten merely because they contain a key named "description".
 */
function stripPresentationAnnotations(schema) {
  const stripped = clone(schema);
  walkSchema(stripped, node => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    for (const annotation of PRESENTATION_ANNOTATIONS) delete node[annotation];
  });
  return stripped;
}

function stripModelContextAnnotations(schema) {
  const stripped = stripPresentationAnnotations(schema);
  walkSchema(stripped, node => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    for (const keyword of MODEL_CONTEXT_OMISSIONS) delete node[keyword];
    for (const keyword of Object.keys(node)) {
      if (keyword.startsWith('x-')) delete node[keyword];
    }
  });
  return stripped;
}

function enforceSchemaBounds(schema, label) {
  const metrics = measureSchema(schema);
  if (metrics.depth > MAX_SCHEMA_DEPTH) {
    throw new Error(`${label} exceeds AdCP schema depth bound: ${metrics.depth} > ${MAX_SCHEMA_DEPTH}`);
  }
  if (metrics.objectCount > MAX_SCHEMA_OBJECTS) {
    throw new Error(`${label} exceeds AdCP schema object bound: ${metrics.objectCount} > ${MAX_SCHEMA_OBJECTS}`);
  }
  if (metrics.bytes > MAX_SCHEMA_BYTES) {
    throw new Error(`${label} exceeds AdCP schema byte budget: ${metrics.bytes} > ${MAX_SCHEMA_BYTES}`);
  }
  return metrics;
}

function projectSourceSchema(
  schema,
  rootFile,
  sourceDir,
  urlVersion,
  relativePath,
  annotationMode = 'full',
  schemaUrlPrefix = `${urlVersion}/mcp/${MCP_PROTOCOL_VERSION}`,
) {
  const compact = compactDraft07Schema(schema, rootFile, sourceDir);
  let projected = projectDraft07Node(compact);
  if (annotationMode === 'structural') projected = stripPresentationAnnotations(projected);
  else if (annotationMode === 'model-context') projected = stripModelContextAnnotations(projected);
  else if (annotationMode !== 'full') throw new Error(`Unknown annotation mode ${JSON.stringify(annotationMode)}`);
  projected.$schema = JSON_SCHEMA_2020_12;
  projected.$id = `${SCHEMA_ORIGIN}/schemas/${schemaUrlPrefix}/${relativePath}`;
  if (annotationMode === 'model-context') {
    delete projected.$schema;
    delete projected.$id;
  }
  delete projected._bundled;

  const externalRefs = collectExternalRefs(projected);
  if (externalRefs.length > 0) {
    throw new Error(`MCP projection is not self-contained; external references remain: ${externalRefs.join(', ')}`);
  }
  assertLocalRefsResolve(projected);
  enforceSchemaBounds(projected, relativePath);
  return projected;
}

function writeJson(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function uniqueStringSet(values, label, { required = false } = {}) {
  if (values === undefined && !required) return new Set();
  if (!Array.isArray(values) || values.some(value => typeof value !== 'string' || value.length === 0)) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  const result = new Set(values);
  if (result.size !== values.length) throw new Error(`${label} must not contain duplicates`);
  return result;
}

/**
 * Select the exact runtime tool surface from a release manifest.
 *
 * implementedTools is the host's dispatch registry and is always the hard
 * upper bound. capabilityProtocols is a coarse protocol-family scope;
 * capabilityTools adds exact cross-protocol tools and per-session exceptions.
 * Protocol classification is ownership metadata, not dependency closure, so
 * this function never adds related tools implicitly.
 */
function selectRuntimeToolNames(manifest, {
  implementedTools,
  capabilityProtocols,
  capabilityTools,
  production = true,
} = {}) {
  if (!manifest || typeof manifest !== 'object' || !manifest.tools || typeof manifest.tools !== 'object') {
    throw new Error('manifest must contain a tools object');
  }

  const implemented = uniqueStringSet(implementedTools, 'implementedTools', { required: true });
  const protocolInputs = uniqueStringSet(capabilityProtocols, 'capabilityProtocols');
  const protocols = new Set([...protocolInputs].map(protocol => protocol.replaceAll('_', '-')));
  if (protocols.size !== protocolInputs.size) {
    throw new Error('capabilityProtocols must not contain equivalent snake_case and kebab-case values');
  }
  const exactTools = uniqueStringSet(capabilityTools, 'capabilityTools');
  const knownTools = new Set(Object.keys(manifest.tools));
  const knownProtocols = new Set(Object.values(manifest.tools).map(tool => tool.protocol));

  for (const toolName of implemented) {
    if (!knownTools.has(toolName)) throw new Error(`implementedTools names unknown tool ${toolName}`);
  }
  for (const protocol of protocols) {
    if (!knownProtocols.has(protocol)) throw new Error(`capabilityProtocols names unknown protocol ${protocol}`);
    if (production && protocol === 'compliance') {
      throw new Error('production runtime projections cannot select the compliance protocol');
    }
  }
  for (const toolName of exactTools) {
    if (!knownTools.has(toolName)) throw new Error(`capabilityTools names unknown tool ${toolName}`);
    if (!implemented.has(toolName)) {
      throw new Error(`capabilityTools advertises unimplemented tool ${toolName}`);
    }
    if (production && manifest.tools[toolName].protocol === 'compliance') {
      throw new Error(`production runtime projections cannot select compliance tool ${toolName}`);
    }
  }

  const hasCapabilityScope = capabilityProtocols !== undefined || capabilityTools !== undefined;
  return [...implemented]
    .filter(toolName => !production || manifest.tools[toolName].protocol !== 'compliance')
    .filter(toolName => (
      !hasCapabilityScope
      || exactTools.has(toolName)
      || protocols.has(manifest.tools[toolName].protocol)
    ))
    .sort();
}

/** Build MCP tools/list entries from already-generated per-tool bundles. */
function buildRuntimeToolsList(projectionManifest, selectedToolNames, loadInputSchema) {
  if (
    !projectionManifest
    || typeof projectionManifest !== 'object'
    || !projectionManifest.tools
    || typeof projectionManifest.tools !== 'object'
  ) {
    throw new Error('projectionManifest must contain a tools object');
  }
  const selected = uniqueStringSet(selectedToolNames, 'selectedToolNames', { required: true });
  if (typeof loadInputSchema !== 'function') throw new Error('loadInputSchema must be a function');

  return [...selected].sort().map(name => {
    const tool = projectionManifest.tools[name];
    if (!tool) throw new Error(`selectedToolNames names unknown projected tool ${name}`);
    if (typeof tool.inputSchema !== 'string') {
      throw new Error(`projected tool ${name} does not provide inputSchema`);
    }
    const inputSchema = loadInputSchema(tool.inputSchema, name);
    if (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) {
      throw new Error(`loadInputSchema returned an invalid schema for ${name}`);
    }
    return {
      name,
      ...(tool.summary ? { description: tool.summary } : {}),
      inputSchema: clone(inputSchema),
    };
  });
}

function generateMcpSchemaProjection({
  sourceDir,
  targetDir,
  manifestPath,
  urlVersion,
  annotationMode = 'full',
  toolFilter = () => true,
  schemaFields = ['inputSchema', 'outputSchema'],
  taskResultOverrideFilter = () => true,
  manifestMetadata = {},
  schemaUrlPrefix = `${urlVersion}/mcp/${MCP_PROTOCOL_VERSION}`,
}) {
  const supportedSchemaFields = new Set(['inputSchema', 'outputSchema']);
  if (
    !Array.isArray(schemaFields)
    || schemaFields.length === 0
    || new Set(schemaFields).size !== schemaFields.length
    || schemaFields.some(field => !supportedSchemaFields.has(field))
  ) {
    throw new Error('schemaFields must be a non-empty unique subset of inputSchema and outputSchema');
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const projectedTools = {};
  const generated = new Set();
  let schemaCount = 0;
  let totalBytes = 0;
  let largestSchemaBytes = 0;

  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(targetDir, { recursive: true });

  function projectSchema(relativePath, label = relativePath) {
    const sourcePath = path.join(sourceDir, relativePath);
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Missing source schema for ${label}: ${relativePath}`);
    }
    if (generated.has(relativePath)) return;

    const sourceSchema = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
    let projectedSchema;
    try {
      projectedSchema = projectSourceSchema(
        sourceSchema,
        sourcePath,
        sourceDir,
        urlVersion,
        relativePath,
        annotationMode,
        schemaUrlPrefix,
      );
    } catch (error) {
      throw new Error(`${relativePath}: ${error.message}`);
    }
    writeJson(path.join(targetDir, relativePath), projectedSchema);
    const bytes = Buffer.byteLength(JSON.stringify(projectedSchema));
    totalBytes += bytes;
    largestSchemaBytes = Math.max(largestSchemaBytes, bytes);
    schemaCount++;
    generated.add(relativePath);
  }

  for (const [toolName, tool] of Object.entries(manifest.tools || {})) {
    if (!toolFilter(toolName, tool)) continue;
    const projectedTool = {
      protocol: tool.protocol,
      ...(tool.summary ? { summary: tool.summary } : {}),
    };
    for (const [field, relativePath] of [
      ['inputSchema', tool.request_schema],
      ['outputSchema', tool.response_schema],
    ].filter(([field]) => schemaFields.includes(field))) {
      projectSchema(relativePath, `${toolName}.${field}`);
      projectedTool[field] = relativePath;
    }
    projectedTools[toolName] = projectedTool;
  }

  let taskResultResolution;
  if (schemaFields.includes('outputSchema') && manifest.task_result_resolution) {
    const terminalSchemaOverrides = {};
    for (const [taskType, relativePath] of Object.entries(
      manifest.task_result_resolution.terminal_schema_overrides || {}
    )) {
      if (!taskResultOverrideFilter(taskType, relativePath)) continue;
      projectSchema(relativePath, `task result override ${taskType}`);
      terminalSchemaOverrides[taskType] = relativePath;
    }
    taskResultResolution = {
      discriminator_field: manifest.task_result_resolution.discriminator_field,
      terminal_schema_pointer_template: '/tools/{task_type}/outputSchema',
      terminal_schema_overrides: terminalSchemaOverrides,
    };
  }

  const projectionManifest = {
    mcp_protocol_version: MCP_PROTOCOL_VERSION,
    schema_dialect: JSON_SCHEMA_2020_12,
    source_schema_dialect: JSON_SCHEMA_DRAFT_07,
    compatibility: 'semantics-preserving projection; no 4.0 strictness rules applied',
    delivery: 'downloadable schema artifacts; servers choose which schemas to embed in tools/list',
    annotation_mode: annotationMode,
    schema_fields: schemaFields,
    ...(taskResultResolution ? { task_result_resolution: taskResultResolution } : {}),
    ...manifestMetadata,
    tools: projectedTools,
  };
  writeJson(path.join(targetDir, 'manifest.json'), projectionManifest);

  return {
    toolCount: Object.keys(projectedTools).length,
    schemaCount,
    totalBytes,
    largestSchemaBytes,
  };
}

module.exports = {
  JSON_SCHEMA_DRAFT_07,
  JSON_SCHEMA_2020_12,
  MAX_SCHEMA_BYTES,
  MAX_SCHEMA_DEPTH,
  MAX_SCHEMA_OBJECTS,
  MCP_PROTOCOL_VERSION,
  assertDraft07SourceSchema,
  assertLocalRefsResolve,
  buildRuntimeToolsList,
  collectExternalRefs,
  compactDraft07Schema,
  enforceSchemaBounds,
  generateMcpSchemaProjection,
  measureSchema,
  projectDraft07Node,
  projectSourceSchema,
  selectRuntimeToolNames,
  stripModelContextAnnotations,
  stripPresentationAnnotations,
};
