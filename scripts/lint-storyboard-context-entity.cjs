#!/usr/bin/env node
/**
 * Cross-storyboard context-entity lint (issue #2660, rule 3 of the storyboard
 * contradiction trio). Catches the #2627 class of bug: a value captured into
 * `$context.<name>` from a field of one entity type (e.g., advertiser_brand)
 * gets consumed in a later step's `sample_request` as a field of a different
 * entity type (e.g., rights_holder_brand). Both storyboards stay locally
 * valid; only a real agent surfaces the contradiction.
 *
 * The lint reads the `x-entity` annotation on schema fields (see
 * docs/contributing/x-entity-annotation.md and
 * static/schemas/source/core/x-entity-types.json). It is silent on fields
 * without annotations — partial rollout is safe. Only explicit mismatches flag.
 *
 * Rules:
 *   entity_mismatch    — capture and consume sites carry different x-entity values
 *   unknown_entity     — a schema's x-entity value is not in the registry
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const STORYBOARD_DIR = path.resolve(__dirname, '..', 'static', 'compliance', 'source');
const SCHEMA_DIR = path.resolve(__dirname, '..', 'static', 'schemas', 'source');
const REGISTRY_PATH = path.join(SCHEMA_DIR, 'core', 'x-entity-types.json');

const CONTEXT_REF = /^\$context\.([A-Za-z_][A-Za-z0-9_]*)$/;

const RULE_MESSAGES = {
  entity_mismatch: ({
    captureName,
    captureEntity,
    consumeEntity,
    captureStepId,
    captureFile,
    capturePath,
    consumePath,
  }) =>
    `\`$context.${captureName}\` was captured as \`${captureEntity}\` at ` +
    `${captureFile}:${captureStepId} (path: ${capturePath}), but is consumed ` +
    `at ${consumePath} which the request schema annotates as \`${consumeEntity}\`. ` +
    'These are different entities — feeding one into the other will look valid to the schema ' +
    'but fail against a real agent (see https://github.com/adcontextprotocol/adcp/issues/2627).\n' +
    '    Fix one of:\n' +
    `      1. If the consume site was wrong: capture a fresh \`${consumeEntity}\` id in an earlier step and use that.\n` +
    `      2. If the capture path was wrong: pick a different field in ${captureFile}:${captureStepId} whose x-entity is \`${consumeEntity}\`.\n` +
    "      3. If the two really are the same entity: the schema annotations are wrong — fix them, don't paper over here.\n" +
    '    See docs/contributing/x-entity-annotation.md.',
  unknown_entity: ({ entity, schemaFile, schemaPath, didYouMean }) => {
    const suggestion = didYouMean ? ` Did you mean \`${didYouMean}\`?` : '';
    return (
      `schema ${schemaFile} at ${schemaPath} uses \`x-entity: ${JSON.stringify(entity)}\` ` +
      `which is not registered in static/schemas/source/core/x-entity-types.json.${suggestion} ` +
      'Either fix the typo or add the value to the registry (see docs/contributing/x-entity-annotation.md).'
    );
  },
  capture_name_collision: ({ captureName, firstEntity, firstStepId, secondEntity }) =>
    `capture \`${captureName}\` was first recorded as \`${firstEntity}\` at ${firstStepId} ` +
    `and then re-captured as \`${secondEntity}\` in this step. ` +
    'Capture names MUST be unique within a storyboard (storyboard-schema.yaml). ' +
    'Rename one of the captures so downstream consumers can tell which entity they got.',
};

function formatMessage(violation) {
  const builder = RULE_MESSAGES[violation.rule];
  return builder ? builder(violation) : `unknown rule ${violation.rule}`;
}

function loadRegistry() {
  const doc = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  return new Set(doc.enum || []);
}

/**
 * Cheap edit-distance (Damerau-Levenshtein-ish, substitution-cost-1). Used to
 * suggest a registered x-entity value when the author typoed. Bounded by
 * length so a wildly different string returns a large number rather than
 * triggering a misleading suggestion.
 */
function editDistance(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j += 1) prev[j] = j;
  for (let i = 1; i <= m; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

function closestRegistered(entity, registry) {
  let best = null;
  let bestDist = Infinity;
  for (const candidate of registry) {
    const d = editDistance(entity, candidate);
    if (d < bestDist) {
      bestDist = d;
      best = candidate;
    }
  }
  // Only suggest if the typo is close — edit distance ≤ 2, or ≤ 3 for longer
  // strings. Avoids confident-but-wrong suggestions like `task → catalog`.
  const threshold = entity.length >= 10 ? 3 : 2;
  return bestDist <= threshold ? best : null;
}

function walkYaml(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkYaml(full));
    else if (entry.isFile() && (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml'))) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Split a storyboard path (`rights[0].rights_id`, `products[0].format_ids[0].id`,
 * `rights.0.rights_id`, `plan_id`) into ordered path segments the walker can
 * consume. Normalises `[N]` to `.N` before splitting so both bracket and dotted
 * forms are accepted. The canonical authoring form per
 * static/compliance/source/universal/storyboard-schema.yaml is bracket notation;
 * both forms are tolerated because a handful of older storyboards use dots.
 */
function parsePath(raw) {
  if (!raw) return [];
  return raw.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
}

/**
 * Resolve a schema $id like `/schemas/brand/get-rights-response.json` or a
 * schema_ref like `brand/get-rights-response.json` into an absolute file path.
 */
function schemaRefToPath(ref) {
  if (!ref) return null;
  const trimmed = ref.startsWith('/schemas/') ? ref.slice('/schemas/'.length) : ref;
  return path.join(SCHEMA_DIR, trimmed);
}

const schemaCache = new Map();

function loadSchema(ref) {
  const full = schemaRefToPath(ref);
  if (!full) return null;
  if (schemaCache.has(full)) return schemaCache.get(full);
  let doc = null;
  try {
    doc = JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch {
    doc = null;
  }
  schemaCache.set(full, doc);
  return doc;
}

/**
 * Walk a JSON Schema node to find the `x-entity` annotation at a dotted path.
 * Follows `$ref`, descends through `properties.<name>` for object steps,
 * through `items` for numeric-index steps, and tries each variant of a
 * `oneOf` / `anyOf`. Returns the annotation string if present, undefined if
 * absent, or an `{ ambiguous: [values] }` object if variants disagree.
 */
function resolveEntityAtPath(node, segments) {
  if (!node || typeof node !== 'object') return undefined;

  if (node.$ref) {
    const resolved = loadSchema(node.$ref);
    return resolveEntityAtPath(resolved, segments);
  }

  if (Array.isArray(node.oneOf) || Array.isArray(node.anyOf) || Array.isArray(node.allOf)) {
    // oneOf / anyOf: variants are alternatives — take any variant that resolves.
    // allOf: variants are all required — any variant that carries the annotation
    // wins (spec composition by merge). All three compose by "look in each
    // branch, reconcile unique hits" for the lint's purpose.
    const variants = node.oneOf || node.anyOf || node.allOf;
    const hits = [];
    for (const variant of variants) {
      const r = resolveEntityAtPath(variant, segments);
      if (r === undefined) continue;
      if (typeof r === 'object' && r.ambiguous) {
        hits.push(...r.ambiguous);
      } else {
        hits.push(r);
      }
    }
    const unique = Array.from(new Set(hits));
    if (unique.length === 0) return undefined;
    if (unique.length === 1) return unique[0];
    return { ambiguous: unique };
  }

  if (segments.length === 0) {
    return node['x-entity'];
  }

  const [seg, ...rest] = segments;

  if (/^\d+$/.test(seg)) {
    if (node.items) return resolveEntityAtPath(node.items, rest);
    return undefined;
  }

  if (node.properties && Object.prototype.hasOwnProperty.call(node.properties, seg)) {
    return resolveEntityAtPath(node.properties[seg], rest);
  }

  return undefined;
}

/**
 * Walk a schema tree and collect every `x-entity` value it declares, paired
 * with a human-readable path ("properties.brand_id", "properties.rights.items.properties.brand_id").
 * Used by the registry check to flag unknown values without needing to
 * enumerate schemas externally.
 */
function collectEntityAnnotations(node, trail, seen, out) {
  if (!node || typeof node !== 'object' || seen.has(node)) return;
  seen.add(node);

  if (typeof node['x-entity'] === 'string') {
    out.push({ path: trail.join('.') || '<root>', entity: node['x-entity'] });
  }

  if (node.$ref) return; // don't cross $ref boundaries for the registry check

  for (const [key, value] of Object.entries(node)) {
    if (!value || typeof value !== 'object') continue;
    if (Array.isArray(value)) {
      value.forEach((v, i) => collectEntityAnnotations(v, [...trail, key, String(i)], seen, out));
    } else {
      collectEntityAnnotations(value, [...trail, key], seen, out);
    }
  }
}

function relSchemaPath(absPath) {
  return path.relative(SCHEMA_DIR, absPath);
}

/**
 * Walk every schema under SCHEMA_DIR and flag `x-entity` values that aren't
 * in the registry. Runs independently of storyboards so a typo in a schema
 * is caught even before any storyboard references it.
 */
function lintRegistry(registry) {
  const violations = [];
  const walkDir = (dir) => {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walkDir(full));
      else if (entry.isFile() && entry.name.endsWith('.json')) out.push(full);
    }
    return out;
  };

  for (const file of walkDir(SCHEMA_DIR)) {
    if (file === REGISTRY_PATH) continue; // the registry itself uses x-entity-definitions, not x-entity
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    const annotations = [];
    collectEntityAnnotations(doc, [], new WeakSet(), annotations);
    for (const a of annotations) {
      if (!registry.has(a.entity)) {
        violations.push({
          rule: 'unknown_entity',
          schemaFile: relSchemaPath(file),
          schemaPath: a.path,
          entity: a.entity,
          didYouMean: closestRegistered(a.entity, registry),
        });
      }
    }
  }
  return violations;
}

/**
 * Walk a storyboard's `sample_request` object and invoke `onContextRef(key, path)`
 * for every string leaf whose value matches `^\$context\.<key>$`. `path` is the
 * dot-joined request-schema path to the consume site.
 */
function walkContextRefs(node, trail, onContextRef) {
  if (node === null || node === undefined) return;
  if (typeof node === 'string') {
    const m = node.match(CONTEXT_REF);
    if (m) onContextRef(m[1], trail.join('.'));
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => walkContextRefs(v, [...trail, String(i)], onContextRef));
    return;
  }
  if (typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      walkContextRefs(value, [...trail, key], onContextRef);
    }
  }
}

/**
 * Lint a single storyboard doc against its referenced schemas. Captures flow
 * forward through the storyboard — a capture in step N is available to
 * consume sites in step N+1 onward. Same-name captures from later steps
 * overwrite earlier ones (matching runner semantics).
 *
 * Returns violations shaped as `{ rule, file?, phaseId, stepId, ... }`.
 */
function lintDoc(doc) {
  const violations = [];
  if (!doc || typeof doc !== 'object') return violations;
  const phases = Array.isArray(doc.phases) ? doc.phases : [];

  // capture table: name → { entity, stepId, phaseId, path }
  const captures = new Map();

  for (const phase of phases) {
    const phaseId = phase?.id || '<unnamed>';
    const steps = Array.isArray(phase?.steps) ? phase.steps : [];

    for (const step of steps) {
      const stepId = step?.id || '<unnamed>';

      // 1. Consume sites — check BEFORE this step's own captures, since
      // $context resolves to prior captures. A step's sample_request is
      // evaluated against the capture state as it stood when the step began.
      const requestRef = step?.schema_ref;
      const sampleRequest = step?.sample_request;
      if (requestRef && sampleRequest && typeof sampleRequest === 'object') {
        const requestSchema = loadSchema(requestRef);
        if (requestSchema) {
          walkContextRefs(sampleRequest, [], (captureName, consumePath) => {
            const capture = captures.get(captureName);
            if (!capture) return; // unknown capture — runner problem, not ours
            if (!capture.entity) return; // capture site had no x-entity — silent
            const consumeEntity = resolveEntityAtPath(requestSchema, parsePath(consumePath));
            if (consumeEntity === undefined) return; // consume site has no x-entity — silent
            if (typeof consumeEntity === 'object' && consumeEntity.ambiguous) {
              // variants disagree inside the request schema itself; the lint
              // cannot attribute this to the storyboard — it's a schema bug
              // and will surface via registry/schema review.
              return;
            }
            if (consumeEntity !== capture.entity) {
              violations.push({
                rule: 'entity_mismatch',
                phaseId,
                stepId,
                captureName,
                captureEntity: capture.entity,
                consumeEntity,
                captureStepId: `${capture.phaseId}/${capture.stepId}`,
                captureFile: capture.file || '<same>',
                capturePath: capture.path,
                consumePath,
              });
            }
          });
        }
      }

      // 2. Captures — record for downstream consumers.
      const responseRef = step?.response_schema_ref;
      const contextOutputs = Array.isArray(step?.context_outputs) ? step.context_outputs : [];
      if (responseRef && contextOutputs.length > 0) {
        const responseSchema = loadSchema(responseRef);
        for (const out of contextOutputs) {
          const name = out?.key || out?.name;
          const srcPath = out?.path;
          if (!name || !srcPath) continue;
          let entity;
          if (responseSchema) {
            const resolved = resolveEntityAtPath(responseSchema, parsePath(srcPath));
            if (typeof resolved === 'object' && resolved?.ambiguous) {
              entity = undefined; // schema-level ambiguity; skip
            } else {
              entity = resolved;
            }
          }
          const prior = captures.get(name);
          if (prior && prior.entity && entity && prior.entity !== entity) {
            violations.push({
              rule: 'capture_name_collision',
              phaseId,
              stepId,
              captureName: name,
              firstEntity: prior.entity,
              firstStepId: `${prior.phaseId}/${prior.stepId}`,
              secondEntity: entity,
            });
          }
          captures.set(name, { entity, phaseId, stepId, path: srcPath });
        }
      }
    }
  }

  return violations;
}

function lint() {
  const registry = loadRegistry();
  const violations = [...lintRegistry(registry)];

  const files = walkYaml(STORYBOARD_DIR);
  for (const file of files) {
    let doc;
    try {
      doc = yaml.load(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    const relFile = path.relative(STORYBOARD_DIR, file);
    for (const v of lintDoc(doc)) {
      violations.push({ ...v, file: relFile });
    }
  }
  return violations;
}

function main() {
  const violations = lint();
  if (violations.length === 0) {
    console.log('✓ storyboard context-entity lint: all captures and consumes align');
    return;
  }
  console.error(`✗ storyboard context-entity lint: ${violations.length} violation(s)\n`);
  for (const v of violations) {
    const loc = v.file
      ? (v.stepId ? `${v.file}:${v.phaseId}/${v.stepId}` : v.file)
      : `${v.schemaFile}:${v.schemaPath}`;
    console.error(`  ${loc} — ${formatMessage(v)}`);
  }
  console.error(
    '\nSee docs/contributing/x-entity-annotation.md for annotation guidance.',
  );
  process.exit(1);
}

if (require.main === module) main();

module.exports = {
  RULE_MESSAGES,
  lint,
  lintDoc,
  lintRegistry,
  loadRegistry,
  loadSchema,
  resolveEntityAtPath,
  walkContextRefs,
  formatMessage,
};
