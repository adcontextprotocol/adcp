#!/usr/bin/env node
/**
 * Pagination cursor↔has_more invariant lint.
 *
 * `static/schemas/source/core/pagination-response.json` documents in prose
 * that `cursor` is "Only present when has_more is true." That contract is
 * not enforced by the JSON Schema (cursor lives in properties without an
 * if/then/else gate), so the obligation falls to authoring guards. Two
 * violation classes show up in canonical examples and storyboard fixtures
 * before they reach implementers as misleading reference material:
 *
 *   has_more_true_missing_cursor — `pagination.has_more: true` with no
 *                                  `pagination.cursor`. Callers cannot
 *                                  fetch the next page; the example
 *                                  teaches a non-conformant shape.
 *
 *   has_more_false_with_cursor   — `pagination.has_more: false` with a
 *                                  `pagination.cursor` field present. The
 *                                  cursor is meaningless on a terminal
 *                                  page and invites callers to follow it
 *                                  into undefined behavior.
 *
 * Scans:
 *   - `examples[].data` (or `examples[]`) on every JSON Schema under
 *     `static/schemas/source/`.
 *   - `sample_request` and `sample_response` on every step of every
 *     storyboard under `static/compliance/source/`.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const REPO_ROOT = path.resolve(__dirname, '..');
const SCHEMA_DIR = path.join(REPO_ROOT, 'static', 'schemas', 'source');
const STORYBOARD_DIR = path.join(REPO_ROOT, 'static', 'compliance', 'source');

const RULE_MESSAGES = {
  has_more_true_missing_cursor: () =>
    '`pagination.has_more: true` requires a `pagination.cursor`. ' +
    'Without one, callers have no way to fetch the next page and the example ' +
    'teaches a non-conformant shape. ' +
    'See static/schemas/source/core/pagination-response.json (cursor description).',
  has_more_false_with_cursor: () =>
    '`pagination.has_more: false` MUST omit `pagination.cursor`. ' +
    'A stale cursor on a terminal page invites callers to follow it into undefined behavior. ' +
    'See static/schemas/source/core/pagination-response.json (cursor description).',
};

function walkFiles(dir, extensions) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full, extensions));
    else if (entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Walk an arbitrary JSON-shaped value and yield every nested `pagination`
 * object that carries a boolean `has_more`. Yielded entry is
 * `{ pathSoFar, pagination }` where pathSoFar is the dotted path from the
 * walk root, ending in `pagination`. We deliberately do not assume the
 * shape of the parent object — pagination appears under list-* responses,
 * get-* responses, query-summary fixtures, etc. — so any object with the
 * field qualifies.
 *
 * `visited` is a WeakSet guard against YAML anchor/alias graphs that
 * resolve to ancestor references (`&a … *a`). js-yaml does not reject
 * such constructs, so the walker would otherwise stack-overflow on a
 * pathological storyboard. Repeated visits also yield no new violations,
 * so skipping is safe.
 */
function* walkPaginationObjects(node, pathSoFar = [], visited = new WeakSet()) {
  if (node === null || typeof node !== 'object') return;
  if (visited.has(node)) return;
  visited.add(node);
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      yield* walkPaginationObjects(node[i], [...pathSoFar, `[${i}]`], visited);
    }
    return;
  }
  const pag = node.pagination;
  if (
    pag !== null &&
    typeof pag === 'object' &&
    !Array.isArray(pag) &&
    typeof pag.has_more === 'boolean'
  ) {
    yield { pathSoFar: [...pathSoFar, 'pagination'], pagination: pag };
  }
  for (const [key, value] of Object.entries(node)) {
    yield* walkPaginationObjects(value, [...pathSoFar, key], visited);
  }
}

/**
 * Apply the invariant to a single pagination object. Returns the rule ID
 * when violated, or null. `cursor: null` is treated as present — the
 * spec's wire shape has the field absent on terminal pages, not present
 * with a null value.
 *
 * Asymmetry with `pagination-integrity.yaml`: the storyboard's terminal-
 * page check uses `field_value_or_absent` with `allowed_values: [null]`,
 * which tolerates a runtime `cursor: null` (the runner reports absent
 * fields as `actual: null` per `runner-output-contract.yaml`). Authored
 * fixtures must be strictly absent (caught here); live agents may emit
 * either. The two contracts are intentional — fixtures teach, runtime
 * tolerates — so don't "fix" one to match the other.
 */
function checkPagination(pagination) {
  const hasCursor = Object.prototype.hasOwnProperty.call(pagination, 'cursor');
  if (pagination.has_more === true && !hasCursor) {
    return { rule: 'has_more_true_missing_cursor' };
  }
  if (pagination.has_more === false && hasCursor) {
    return { rule: 'has_more_false_with_cursor' };
  }
  return null;
}

function lintSchemas(dir = SCHEMA_DIR) {
  const violations = [];
  for (const file of walkFiles(dir, ['.json'])) {
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (!doc || !Array.isArray(doc.examples)) continue;
    for (let i = 0; i < doc.examples.length; i++) {
      const example = doc.examples[i];
      // Schema example shape varies: some wrap payloads in `{ description, data }`,
      // others place the payload directly in the array element.
      const data =
        example && typeof example === 'object' && 'data' in example ? example.data : example;
      for (const found of walkPaginationObjects(data)) {
        const violation = checkPagination(found.pagination);
        if (violation) {
          violations.push({
            file: path.relative(REPO_ROOT, file),
            location: `examples[${i}].${found.pathSoFar.join('.')}`,
            rule: violation.rule,
          });
        }
      }
    }
  }
  return violations;
}

function lintStoryboards(dir = STORYBOARD_DIR) {
  const violations = [];
  for (const file of walkFiles(dir, ['.yaml', '.yml'])) {
    let doc;
    try {
      doc = yaml.load(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (!doc || typeof doc !== 'object') continue;
    const phases = Array.isArray(doc.phases) ? doc.phases : [];
    for (const phase of phases) {
      const phaseId = phase?.id || '<unnamed>';
      const steps = Array.isArray(phase?.steps) ? phase.steps : [];
      for (const step of steps) {
        const stepId = step?.id || '<unnamed>';
        for (const key of ['sample_request', 'sample_response']) {
          const payload = step?.[key];
          if (!payload || typeof payload !== 'object') continue;
          for (const found of walkPaginationObjects(payload)) {
            const violation = checkPagination(found.pagination);
            if (violation) {
              violations.push({
                file: path.relative(REPO_ROOT, file),
                location: `phases.${phaseId}.steps.${stepId}.${key}.${found.pathSoFar.join('.')}`,
                rule: violation.rule,
              });
            }
          }
        }
      }
    }
  }
  return violations;
}

function lint() {
  return [...lintSchemas(), ...lintStoryboards()];
}

function main() {
  const violations = lint();
  if (violations.length === 0) {
    console.log('✓ pagination-invariant lint: no violations');
    return;
  }
  console.error(`✗ pagination-invariant lint: ${violations.length} violation(s)\n`);
  for (const v of violations) {
    const msg = RULE_MESSAGES[v.rule] ? RULE_MESSAGES[v.rule]() : v.rule;
    console.error(`  ${v.file}:${v.location} (${v.rule})`);
    console.error(`    ${msg}`);
    console.error('');
  }
  process.exit(1);
}

if (require.main === module) main();

module.exports = {
  RULE_MESSAGES,
  walkPaginationObjects,
  checkPagination,
  lintSchemas,
  lintStoryboards,
  lint,
};
