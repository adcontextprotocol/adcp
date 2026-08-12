#!/usr/bin/env node
/**
 * High-recall guard for AdCP's canonical BCP 47 primitive.
 *
 * The lint inspects JSON Schema property declarations whose names follow the
 * repository's language/locale naming conventions. Every string-capable arm
 * (including array items) must resolve to core/locale-tag.json. Candidate
 * object maps must constrain their keys with that primitive via propertyNames.
 *
 * This is intentionally a naming-convention guard, not proof that every
 * language-bearing field in the protocol has been discovered. Known legacy
 * boundaries and deliberate name collisions live in the reviewed disposition
 * registry. Examples, defaults, and extension metadata are never traversed as
 * schema declarations.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_SCHEMAS_DIR = path.join(REPO_ROOT, 'static', 'schemas', 'source');
const DEFAULT_DISPOSITIONS_PATH = path.join(
  REPO_ROOT,
  'scripts',
  'lint-language-tag-refs-dispositions.json',
);
const LOCALE_TAG_RELATIVE_PATH = 'core/locale-tag.json';
const LANGUAGE_NAME = /(^|_)(?:language|languages|locale|locales|lang)(?:_|$)/;
const LOCALIZED_MAP_DEFINITION_NAME = /^localized_/;
const VALID_DISPOSITIONS = new Set([
  'legacy-language-boundary',
  'not-a-language-tag',
]);

const SCHEMA_CONTAINER_KEYS = [
  '$defs',
  'definitions',
  'dependentSchemas',
  'dependencies',
  'patternProperties',
];
const SCHEMA_SINGLE_KEYS = [
  'additionalProperties',
  'additionalItems',
  'contains',
  'else',
  'if',
  'items',
  'not',
  'propertyNames',
  'then',
  'unevaluatedItems',
  'unevaluatedProperties',
];
const SCHEMA_ARRAY_KEYS = ['allOf', 'anyOf', 'oneOf', 'prefixItems'];

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function escapePointerToken(value) {
  return value.replace(/~/g, '~0').replace(/\//g, '~1');
}

function walkJsonFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkJsonFiles(fullPath));
    else if (entry.isFile() && entry.name.endsWith('.json')) files.push(fullPath);
  }
  return files.sort();
}

function normalizeSchemaPath(value) {
  let normalized = value;
  if (/^https?:\/\//.test(normalized)) {
    let parsed;
    try {
      parsed = new URL(normalized);
    } catch {
      return null;
    }
    if (
      parsed.origin !== 'https://adcontextprotocol.org' ||
      parsed.username ||
      parsed.password ||
      parsed.search
    ) return null;
    normalized = parsed.pathname;
  }
  if (/^\/schemas\/v[^/]+\//.test(normalized)) return null;
  normalized = normalized.replace(/^\/schemas\/latest\//, '/schemas/');
  normalized = normalized.replace(/^\/schemas\//, '');
  return normalized.replace(/^\.\//, '');
}

function resolveJsonPointer(root, fragment) {
  if (!fragment || fragment === '#') return root;
  if (!fragment.startsWith('#/')) return null;
  let current = root;
  for (const token of fragment.slice(2).split('/')) {
    const key = token.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!current || typeof current !== 'object' || !(key in current)) return null;
    current = current[key];
  }
  return current;
}

function loadSchemaRegistry(schemasDir = DEFAULT_SCHEMAS_DIR) {
  const documents = [];
  const byKey = new Map();
  const parseErrors = [];

  for (const file of walkJsonFiles(schemasDir)) {
    const relativePath = toPosix(path.relative(schemasDir, file));
    let schema;
    try {
      schema = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      parseErrors.push(`${relativePath}: ${error.message}`);
      continue;
    }
    const document = { file, relativePath, schema };
    documents.push(document);
    const keys = new Set([
      relativePath,
      `/schemas/${relativePath}`,
      `/schemas/latest/${relativePath}`,
      path.resolve(file),
    ]);
    if (isSchema(schema) && typeof schema.$id === 'string') keys.add(schema.$id);
    for (const key of keys) {
      const normalizedKey = normalizeSchemaPath(key);
      if (normalizedKey) byKey.set(normalizedKey, document);
    }
  }

  return { schemasDir, documents, byKey, parseErrors };
}

function resolveRef(ref, fromDocument, registry) {
  if (typeof ref !== 'string') return null;
  const hashIndex = ref.indexOf('#');
  const base = hashIndex === -1 ? ref : ref.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? '' : ref.slice(hashIndex);
  let document = fromDocument;

  if (base) {
    let key;
    if (base.startsWith('.') && fromDocument) {
      key = toPosix(path.normalize(path.join(path.dirname(fromDocument.relativePath), base)));
    } else {
      key = normalizeSchemaPath(base);
    }
    if (!key) return null;
    document = registry.byKey.get(normalizeSchemaPath(key));
  }
  if (!document) return null;
  const node = resolveJsonPointer(document.schema, fragment);
  if (node === null || node === undefined) return null;
  return {
    document,
    node,
    fragment,
    isLocaleTag:
      document.relativePath === LOCALE_TAG_RELATIVE_PATH &&
      (!fragment || fragment === '#'),
  };
}

function isSchema(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function typeIncludes(schema, type) {
  return schema.type === type || (Array.isArray(schema.type) && schema.type.includes(type));
}

function isMapShaped(schema) {
  if (!isSchema(schema)) return false;
  if (isSchema(schema.propertyNames) || isSchema(schema.patternProperties)) return true;
  const hasDeclaredProperties = isSchema(schema.properties) &&
    Object.keys(schema.properties).length > 0;
  return !hasDeclaredProperties && (
    typeIncludes(schema, 'object') ||
    isSchema(schema.additionalProperties) ||
    schema.additionalProperties === true
  );
}

function acceptsEveryString(schema) {
  if (schema === true) return true;
  if (schema === false || !isSchema(schema)) return false;
  const annotationKeys = new Set([
    '$comment',
    '$id',
    '$schema',
    'default',
    'deprecated',
    'description',
    'examples',
    'readOnly',
    'title',
    'writeOnly',
  ]);
  const assertionKeys = Object.keys(schema).filter((key) => !annotationKeys.has(key));
  if (assertionKeys.length === 0) return true;
  return assertionKeys.length === 1 && assertionKeys[0] === 'type' &&
    typeIncludes(schema, 'string');
}

function canAcceptString(schema, document, registry, seen = new Set()) {
  if (schema === true) return true;
  if (schema === false || !isSchema(schema)) return false;

  if (schema.type !== undefined) return typeIncludes(schema, 'string');
  if (Object.prototype.hasOwnProperty.call(schema, 'const')) {
    return typeof schema.const === 'string';
  }
  if (Array.isArray(schema.enum)) {
    return schema.enum.some((value) => typeof value === 'string');
  }

  if (typeof schema.$ref === 'string') {
    const marker = `${document ? document.relativePath : '<unknown>'}:${schema.$ref}`;
    if (seen.has(marker)) return true;
    const resolved = resolveRef(schema.$ref, document, registry);
    if (!resolved) return true;
    const nextSeen = new Set(seen);
    nextSeen.add(marker);
    return canAcceptString(resolved.node, resolved.document, registry, nextSeen);
  }

  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    return schema.allOf.every((branch) =>
      canAcceptString(branch, document, registry, new Set(seen)));
  }
  for (const keyword of ['anyOf', 'oneOf']) {
    if (Array.isArray(schema[keyword]) && schema[keyword].length > 0) {
      return schema[keyword].some((branch) =>
        canAcceptString(branch, document, registry, new Set(seen)));
    }
  }

  if (acceptsEveryString(schema.not)) return false;

  // With no explicit non-string constraint, Draft-07 keywords such as
  // description, properties, and conditionals do not themselves exclude a
  // string instance. Conservatively keep the candidate in scope.
  return true;
}

/**
 * Returns true only when this schema applies the canonical locale-tag
 * constraint to the value on every alternative arm. allOf is an intersection,
 * so one canonical arm constrains the whole value. anyOf/oneOf require every
 * relevant arm to carry the constraint.
 */
function hasCanonicalLocaleConstraint(schema, document, registry, seen = new Set()) {
  if (!isSchema(schema)) return false;

  if (typeof schema.$ref === 'string') {
    const marker = `${document ? document.relativePath : '<unknown>'}:${schema.$ref}`;
    if (seen.has(marker)) return false;
    const resolved = resolveRef(schema.$ref, document, registry);
    if (!resolved) return false;
    if (resolved.isLocaleTag) return true;
    const nextSeen = new Set(seen);
    nextSeen.add(marker);
    if (hasCanonicalLocaleConstraint(
      resolved.node,
      resolved.document,
      registry,
      nextSeen,
    )) return true;
  }

  if (Array.isArray(schema.allOf) && schema.allOf.some((branch) =>
    hasCanonicalLocaleConstraint(branch, document, registry, new Set(seen)))) {
    return true;
  }

  for (const keyword of ['anyOf', 'oneOf']) {
    if (!Array.isArray(schema[keyword])) continue;
    const relevant = schema[keyword].filter((branch) => isRelevantValueSchema(
      branch,
      document,
      registry,
      new Set(seen),
    ));
    if (relevant.length > 0 && relevant.every((branch) =>
      hasCanonicalLocaleConstraint(branch, document, registry, new Set(seen)))) {
      return true;
    }
  }

  return false;
}

function isRelevantValueSchema(schema, document, registry, seen = new Set()) {
  if (schema === true) return true;
  if (schema === false || !isSchema(schema)) return false;
  if (canAcceptString(schema, document, registry, new Set(seen)) || isMapShaped(schema)) {
    return true;
  }
  if (typeIncludes(schema, 'array') || isSchema(schema.items) || Array.isArray(schema.items)) {
    if (Array.isArray(schema.items)) {
      if (schema.additionalItems === undefined || schema.additionalItems === true) return true;
      if (isRelevantValueSchema(
        schema.additionalItems,
        document,
        registry,
        new Set(seen),
      )) return true;
    } else if (schema.items === undefined || schema.items === true) {
      return true;
    }
    const items = Array.isArray(schema.items) ? schema.items : [schema.items];
    return items.some((item) => isRelevantValueSchema(
      item,
      document,
      registry,
      new Set(seen),
    ));
  }
  if (typeof schema.$ref === 'string') {
    const marker = `${document ? document.relativePath : '<unknown>'}:${schema.$ref}`;
    if (seen.has(marker)) return true;
    const resolved = resolveRef(schema.$ref, document, registry);
    if (!resolved) return true;
    seen.add(marker);
    return isRelevantValueSchema(resolved.node, resolved.document, registry, seen);
  }
  return [...SCHEMA_ARRAY_KEYS, 'then', 'else'].some((key) =>
    Array.isArray(schema[key]) && schema[key].some((branch) =>
      isRelevantValueSchema(branch, document, registry, new Set(seen))) ||
    isSchema(schema[key]) && isRelevantValueSchema(
      schema[key],
      document,
      registry,
      new Set(seen),
    ));
}

function inspectCandidateSchema(schema, document, registry, seen = new Set()) {
  if (schema === false) return [];
  if (schema === true) {
    return [{ reason: 'unconstrained boolean schema permits a bare string' }];
  }
  if (!isSchema(schema)) {
    return [{ reason: 'candidate declaration is not a JSON Schema object' }];
  }

  if (hasCanonicalLocaleConstraint(schema, document, registry, new Set(seen))) {
    return [];
  }

  if (!isRelevantValueSchema(schema, document, registry, new Set(seen))) {
    return [];
  }

  if (typeof schema.$ref === 'string') {
    const marker = `${document.relativePath}:${schema.$ref}`;
    if (seen.has(marker)) {
      return [{ reason: `cyclic $ref does not establish the locale-tag constraint (${schema.$ref})` }];
    }
    const resolved = resolveRef(schema.$ref, document, registry);
    if (!resolved) {
      return [{ reason: `unresolved $ref does not establish the locale-tag constraint (${schema.$ref})` }];
    }
    const nextSeen = new Set(seen);
    nextSeen.add(marker);
    return inspectCandidateSchema(resolved.node, resolved.document, registry, nextSeen);
  }

  if (isSchema(schema.if) && ('then' in schema || 'else' in schema)) {
    const conditionalViolations = [];
    let relevantOutcomeCount = 0;
    for (const keyword of ['then', 'else']) {
      if (!(keyword in schema)) {
        relevantOutcomeCount += 1;
        conditionalViolations.push({
          reason: `${keyword}: absent branch leaves a string outcome unconstrained`,
        });
        continue;
      }
      const branch = schema[keyword];
      if (!isRelevantValueSchema(branch, document, registry, new Set(seen))) continue;
      relevantOutcomeCount += 1;
      for (const violation of inspectCandidateSchema(
        branch,
        document,
        registry,
        new Set(seen),
      )) {
        conditionalViolations.push({ reason: `${keyword}: ${violation.reason}` });
      }
    }
    if (conditionalViolations.length > 0) return conditionalViolations;
    if (relevantOutcomeCount > 0) return [];
  }

  const violations = [];
  let relevantAlternativeCount = 0;
  for (const keyword of ['anyOf', 'oneOf']) {
    if (!Array.isArray(schema[keyword])) continue;
    schema[keyword].forEach((branch, index) => {
      if (!isRelevantValueSchema(branch, document, registry)) return;
      relevantAlternativeCount += 1;
      for (const violation of inspectCandidateSchema(
        branch,
        document,
        registry,
        new Set(seen),
      )) {
        violations.push({ reason: `${keyword}[${index}]: ${violation.reason}` });
      }
    });
  }
  if (violations.length > 0) return violations;
  if (relevantAlternativeCount > 0) return [];

  if (Array.isArray(schema.allOf)) {
    const relevantBranches = schema.allOf.filter((branch) =>
      isRelevantValueSchema(branch, document, registry));
    for (const branch of relevantBranches) {
      const branchViolations = inspectCandidateSchema(
        branch,
        document,
        registry,
        new Set(seen),
      );
      if (branchViolations.length === 0) return [];
    }
    if (relevantBranches.length > 0) {
      return [{ reason: 'allOf does not establish the locale-tag constraint' }];
    }
  }

  if (typeIncludes(schema, 'array') || isSchema(schema.items) || Array.isArray(schema.items)) {
    const tupleItems = Array.isArray(schema.items);
    const itemSchemas = tupleItems ? schema.items : [schema.items];
    const itemViolations = [];
    let relevantItemCount = 0;
    itemSchemas.forEach((item, index) => {
      if (!isRelevantValueSchema(item, document, registry)) return;
      relevantItemCount += 1;
      for (const violation of inspectCandidateSchema(item, document, registry, new Set(seen))) {
        itemViolations.push({ reason: `items${itemSchemas.length > 1 ? `[${index}]` : ''}: ${violation.reason}` });
      }
    });
    if (tupleItems) {
      if (schema.additionalItems === undefined || schema.additionalItems === true) {
        itemViolations.push({
          reason: 'tuple array permits unconstrained string values through additionalItems',
        });
      } else if (schema.additionalItems !== false && isRelevantValueSchema(
        schema.additionalItems,
        document,
        registry,
        new Set(seen),
      )) {
        relevantItemCount += 1;
        for (const violation of inspectCandidateSchema(
          schema.additionalItems,
          document,
          registry,
          new Set(seen),
        )) {
          itemViolations.push({ reason: `additionalItems: ${violation.reason}` });
        }
      }
    } else if (schema.items === undefined || schema.items === true) {
      itemViolations.push({ reason: 'array candidate has no constrained items schema' });
    }
    if (itemViolations.length > 0) return itemViolations;
    return relevantItemCount > 0
      ? []
      : [{ reason: 'array candidate does not carry language-tag string items' }];
  }

  if (isMapShaped(schema)) {
    if (isSchema(schema.propertyNames) && hasCanonicalLocaleConstraint(
      schema.propertyNames,
      document,
      registry,
      new Set(seen),
    )) return [];
    return [{ reason: 'object candidate does not constrain map keys with propertyNames -> locale-tag.json' }];
  }

  if (canAcceptString(schema, document, registry, new Set(seen))) {
    return [{ reason: 'bare string-capable schema does not reference locale-tag.json' }];
  }

  return [{ reason: 'candidate name does not resolve to a canonical language-tag schema' }];
}

function collectCandidates(registry) {
  const candidates = [];

  function visitSchema(node, document, pointer, visited) {
    if (!isSchema(node) || visited.has(node)) return;
    visited.add(node);

    if (isSchema(node.properties)) {
      for (const [name, propertySchema] of Object.entries(node.properties)) {
        const propertyPointer = `${pointer}/properties/${escapePointerToken(name)}`;
        if (LANGUAGE_NAME.test(name)) {
          candidates.push({
            document,
            name,
            pointer: propertyPointer,
            schema: propertySchema,
          });
        }
        visitSchema(propertySchema, document, propertyPointer, visited);
      }
    }

    for (const key of SCHEMA_CONTAINER_KEYS) {
      if (!isSchema(node[key])) continue;
      for (const [name, child] of Object.entries(node[key])) {
        if (!isSchema(child)) continue;
        const childPointer = `${pointer}/${key}/${escapePointerToken(name)}`;
        if (
          (key === '$defs' || key === 'definitions') &&
          LOCALIZED_MAP_DEFINITION_NAME.test(name) &&
          isMapShaped(child)
        ) {
          candidates.push({
            document,
            name,
            pointer: childPointer,
            schema: child,
          });
        }
        visitSchema(
          child,
          document,
          childPointer,
          visited,
        );
      }
    }
    for (const key of SCHEMA_SINGLE_KEYS) {
      if (isSchema(node[key])) {
        visitSchema(node[key], document, `${pointer}/${key}`, visited);
      } else if (Array.isArray(node[key])) {
        node[key].forEach((child, index) =>
          visitSchema(child, document, `${pointer}/${key}/${index}`, visited));
      }
    }
    for (const key of SCHEMA_ARRAY_KEYS) {
      if (!Array.isArray(node[key])) continue;
      node[key].forEach((child, index) =>
        visitSchema(child, document, `${pointer}/${key}/${index}`, visited));
    }
  }

  for (const document of registry.documents) {
    visitSchema(document.schema, document, '#', new WeakSet());
  }
  return candidates.sort((a, b) =>
    `${a.document.relativePath}${a.pointer}`.localeCompare(`${b.document.relativePath}${b.pointer}`));
}

function collectFindings(registry) {
  const findings = [];
  for (const candidate of collectCandidates(registry)) {
    const violations = inspectCandidateSchema(
      candidate.schema,
      candidate.document,
      registry,
    );
    if (violations.length === 0) continue;
    findings.push({
      path: `${candidate.document.relativePath}${candidate.pointer}`,
      file: candidate.document.relativePath,
      pointer: candidate.pointer,
      property: candidate.name,
      reasons: violations.map((violation) => violation.reason),
    });
  }
  return findings;
}

function validateDispositionRegistry(value) {
  const errors = [];
  const entries = value && Array.isArray(value.entries) ? value.entries : null;
  if (!entries) {
    return { entries: [], errors: ['disposition registry must contain an entries array'] };
  }
  const seen = new Set();
  entries.forEach((entry, index) => {
    const label = `entries[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${label} must be an object`);
      return;
    }
    if (!isDispositionPath(entry.path)) {
      errors.push(`${label}.path must be a schema-relative JSON Pointer`);
    } else if (seen.has(entry.path)) {
      errors.push(`${label}.path duplicates ${entry.path}`);
    } else {
      seen.add(entry.path);
    }
    if (!VALID_DISPOSITIONS.has(entry.disposition)) {
      errors.push(
        `${label}.disposition must be one of: ${[...VALID_DISPOSITIONS].join(', ')}`,
      );
    }
    if (typeof entry.rationale !== 'string' || entry.rationale.trim().length < 12) {
      errors.push(`${label}.rationale must explain the exception`);
    }
  });
  return { entries, errors };
}

function loadDispositions(dispositionsPath = DEFAULT_DISPOSITIONS_PATH) {
  if (!fs.existsSync(dispositionsPath)) {
    return {
      entries: [],
      errors: [`missing disposition registry: ${dispositionsPath}`],
      raw: { entries: [] },
    };
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(dispositionsPath, 'utf8'));
  } catch (error) {
    return { entries: [], errors: [`invalid disposition registry JSON: ${error.message}`], raw: null };
  }
  const validated = validateDispositionRegistry(raw);
  return { ...validated, raw };
}

function lintLanguageTagRefs({
  schemasDir = DEFAULT_SCHEMAS_DIR,
  dispositionsPath = DEFAULT_DISPOSITIONS_PATH,
  dispositionValue,
} = {}) {
  const registry = loadSchemaRegistry(schemasDir);
  const errors = registry.parseErrors.map((error) => `schema parse error: ${error}`);
  errors.push(...validateCanonicalPrimitive(registry));

  const findings = collectFindings(registry);
  const dispositionRegistry = dispositionValue === undefined
    ? loadDispositions(dispositionsPath)
    : { ...validateDispositionRegistry(dispositionValue), raw: dispositionValue };
  errors.push(...dispositionRegistry.errors);

  const findingPaths = new Set(findings.map((finding) => finding.path));
  const dispositionPaths = new Set(dispositionRegistry.entries
    .filter((entry) => entry && typeof entry.path === 'string')
    .map((entry) => entry.path));

  for (const finding of findings) {
    if (!dispositionPaths.has(finding.path)) {
      errors.push(`undispositioned finding: ${finding.path} — ${finding.reasons.join('; ')}`);
    }
  }
  for (const entry of dispositionRegistry.entries) {
    if (entry && typeof entry.path === 'string' && !findingPaths.has(entry.path)) {
      errors.push(`stale disposition: ${entry.path}`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    findings,
    candidates: collectCandidates(registry),
    dispositions: dispositionRegistry.entries,
    registry,
  };
}

function validateCanonicalPrimitive(registry) {
  const localeDocument = registry.documents.find(
    (document) => document.relativePath === LOCALE_TAG_RELATIVE_PATH,
  );
  if (!localeDocument) {
    return [`missing canonical primitive: ${LOCALE_TAG_RELATIVE_PATH}`];
  }
  if (!isSchema(localeDocument.schema) || !typeIncludes(localeDocument.schema, 'string')) {
    return [`canonical primitive must be a string schema: ${LOCALE_TAG_RELATIVE_PATH}`];
  }
  return [];
}

function buildUpdatedDispositionRegistry(findings, currentEntries = []) {
  const currentByPath = new Map(currentEntries
    .filter((entry) => entry && typeof entry.path === 'string')
    .map((entry) => [entry.path, entry]));
  return {
    $comment:
      'Reviewed exceptions for scripts/lint-language-tag-refs.cjs. TODO entries intentionally fail ordinary lint until classified.',
    entries: findings.map((finding) => currentByPath.get(finding.path) || {
      path: finding.path,
      disposition: 'TODO',
      rationale: `TODO: classify ${finding.property} (${finding.reasons.join('; ')})`,
    }),
  };
}

function isDispositionPath(value) {
  if (typeof value !== 'string' || value.includes('\\')) return false;
  const hashIndex = value.indexOf('#');
  if (hashIndex <= 0 || value.indexOf('#', hashIndex + 1) !== -1) return false;
  const file = value.slice(0, hashIndex);
  const pointer = value.slice(hashIndex + 1);
  if (path.posix.isAbsolute(file) || !file.endsWith('.json')) return false;
  if (file.split('/').some((segment) => segment === '.' || segment === '..' || !segment)) {
    return false;
  }
  if (!pointer.startsWith('/')) return false;
  return !/~(?![01])/g.test(pointer);
}

function readArg(args, name, fallback) {
  const index = args.indexOf(name);
  return index !== -1 && index + 1 < args.length ? args[index + 1] : fallback;
}

function main() {
  const args = process.argv.slice(2);
  const schemasDir = path.resolve(readArg(args, '--schemas', DEFAULT_SCHEMAS_DIR));
  const dispositionsPath = path.resolve(readArg(
    args,
    '--dispositions',
    DEFAULT_DISPOSITIONS_PATH,
  ));
  const updateBaseline = args.includes('--update-baseline');

  if (updateBaseline) {
    if (process.env.ADCP_UPDATE_LANGUAGE_TAG_DISPOSITIONS !== '1') {
      console.error(
        'Refusing to update dispositions without ADCP_UPDATE_LANGUAGE_TAG_DISPOSITIONS=1.',
      );
      process.exitCode = 2;
      return;
    }
    const registry = loadSchemaRegistry(schemasDir);
    const updateErrors = [
      ...registry.parseErrors.map((error) => `schema parse error: ${error}`),
      ...validateCanonicalPrimitive(registry),
    ];
    const current = loadDispositions(dispositionsPath);
    updateErrors.push(...current.errors);
    if (updateErrors.length > 0) {
      console.error(updateErrors.join('\n'));
      process.exitCode = 1;
      return;
    }
    const updated = buildUpdatedDispositionRegistry(
      collectFindings(registry),
      current.entries,
    );
    fs.writeFileSync(dispositionsPath, `${JSON.stringify(updated, null, 2)}\n`);
    console.log(
      `Updated ${toPosix(path.relative(REPO_ROOT, dispositionsPath))}; classify every TODO before committing.`,
    );
    return;
  }

  const result = lintLanguageTagRefs({ schemasDir, dispositionsPath });
  if (result.ok) {
    const legacy = result.dispositions.filter(
      (entry) => entry.disposition === 'legacy-language-boundary',
    ).length;
    const collisions = result.dispositions.filter(
      (entry) => entry.disposition === 'not-a-language-tag',
    ).length;
    console.log(
      `✓ language-tag ref lint: ${result.candidates.length} candidates, ` +
      `${result.findings.length} reviewed exceptions ` +
      `(${legacy} legacy boundaries, ${collisions} name collisions)`,
    );
    return;
  }

  console.error(`✗ language-tag ref lint failed with ${result.errors.length} error(s):\n`);
  result.errors.forEach((error) => console.error(`  - ${error}`));
  process.exitCode = 1;
}

module.exports = {
  LANGUAGE_NAME,
  LOCALE_TAG_RELATIVE_PATH,
  VALID_DISPOSITIONS,
  buildUpdatedDispositionRegistry,
  collectCandidates,
  collectFindings,
  hasCanonicalLocaleConstraint,
  inspectCandidateSchema,
  lintLanguageTagRefs,
  loadSchemaRegistry,
  resolveJsonPointer,
  resolveRef,
  validateCanonicalPrimitive,
  validateDispositionRegistry,
};

if (require.main === module) main();
