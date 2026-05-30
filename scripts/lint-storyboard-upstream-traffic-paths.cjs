#!/usr/bin/env node
/**
 * Validate upstream_traffic request-payload paths.
 *
 * `identifier_paths` is intentionally restricted to the portable
 * request-payload-relative grammar. `payload_must_contain.path` follows the
 * runner's JSONPath-lite compatibility surface so linting does not reject
 * paths that the current runner can execute.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_DIR = path.join(ROOT, 'static', 'compliance', 'source');
const IDENTIFIER_SEGMENT_RE = /^[A-Za-z_][A-Za-z0-9_-]*(?:\[\*\])?$/;
const PAYLOAD_SEGMENT_RE = /^(?:[^\[\]]+|\[\d+\]|[^\[\]]*\[\*\](?:\[(?:\*|\d+)\])*)$/;
const RESERVED_ROOTS = new Set(['request', 'response', 'context']);

const RULE_MESSAGES = {
  invalid_identifier_path: (identifierPath) =>
    `identifier_paths entry "${identifierPath}" is outside the portable upstream_traffic grammar. ` +
    'Use request-payload-relative dotted paths whose segments are keys optionally followed by literal `[*]`, ' +
    'for example audiences[*].add[*].hashed_email. Bracket-quoted keys, numeric indexes, recursive ' +
    'descent, explicit roots, empty segments, and reserved roots request.*, response.*, and context.* ' +
    'are not portable.',
  invalid_payload_path: (payloadPath) =>
    `payload_must_contain.path "${payloadPath}" is outside the upstream_traffic JSONPath-lite grammar. ` +
    'Use dotted paths with optional `[*]` wildcards, for example audiences[*].add[*].hashed_email. ' +
    'Standalone numeric index tokens such as items.[0].id are tolerated for SDK compatibility. ' +
    'Recursive descent, bracket-quoted keys, and key-attached numeric indexes such as items[0].id are not supported.',
};

function isStoryboardYaml(rel) {
  if (rel.startsWith('test-kits/')) return false;
  if (rel.endsWith('storyboard-schema.yaml')) return false;
  if (rel.endsWith('runner-output-contract.yaml')) return false;
  return true;
}

function isPortableIdentifierPath(value) {
  if (typeof value !== 'string') return false;
  if (value.length === 0) return false;
  if (value.startsWith('$.')) return false;

  const segments = value.split('.');
  if (segments.some((segment) => segment.length === 0)) return false;

  const root = segments[0].replace(/\[\*\]$/, '');
  if (RESERVED_ROOTS.has(root)) return false;

  return segments.every((segment) => IDENTIFIER_SEGMENT_RE.test(segment));
}

function isSupportedPayloadPath(value) {
  if (typeof value !== 'string') return false;
  if (value.length === 0) return false;
  if (value.startsWith('$..')) return false;

  let p = value;
  if (p.startsWith('$.')) {
    p = p.slice(2);
  } else if (p.startsWith('$')) {
    p = p.slice(1);
  }
  if (p.startsWith('.')) p = p.slice(1);
  if (p.length === 0) return true;
  if (p.includes('..')) return false;

  const segments = p.split('.');
  if (segments.some((segment) => segment.length === 0)) return false;
  return segments.every((segment) => PAYLOAD_SEGMENT_RE.test(segment));
}

function* walkUpstreamTrafficChecks(doc) {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.phases)) return;
  for (const phase of doc.phases) {
    if (!phase || !Array.isArray(phase.steps)) continue;
    for (const step of phase.steps) {
      if (!step || !Array.isArray(step.validations)) continue;
      for (let i = 0; i < step.validations.length; i++) {
        const v = step.validations[i];
        if (!v || typeof v !== 'object') continue;
        if (v.check !== 'upstream_traffic') continue;
        yield {
          phaseId: phase.id,
          stepId: step.id,
          index: i,
          validation: v,
        };
      }
    }
  }
}

function lint(sourceDir = SOURCE_DIR) {
  const violations = [];

  function lintFile(p) {
    const rel = path.relative(sourceDir, p);
    if (!isStoryboardYaml(rel)) return;
    let doc;
    try {
      doc = yaml.load(fs.readFileSync(p, 'utf8'));
    } catch {
      return;
    }
    for (const hit of walkUpstreamTrafficChecks(doc)) {
      const paths = hit.validation.identifier_paths;
      if (paths !== undefined && paths !== null && !Array.isArray(paths)) {
        violations.push({
          file: rel,
          phase: hit.phaseId,
          step: hit.stepId,
          index: hit.index,
          rule: 'invalid_identifier_path',
          identifier_path: String(paths),
          path_kind: 'identifier_paths',
        });
      }
      if (Array.isArray(paths)) {
        for (const identifierPath of paths) {
          if (isPortableIdentifierPath(identifierPath)) continue;
          violations.push({
            file: rel,
            phase: hit.phaseId,
            step: hit.stepId,
            index: hit.index,
            rule: 'invalid_identifier_path',
            identifier_path: String(identifierPath),
            path_kind: 'identifier_paths',
          });
        }
      }

      const payloadAssertions = hit.validation.payload_must_contain;
      if (!Array.isArray(payloadAssertions)) continue;
      for (let payloadIndex = 0; payloadIndex < payloadAssertions.length; payloadIndex++) {
        const assertion = payloadAssertions[payloadIndex];
        if (!assertion || typeof assertion !== 'object') continue;
        const payloadPath = assertion.path;
        if (payloadPath === undefined || payloadPath === null) continue;
        if (isSupportedPayloadPath(payloadPath)) continue;
        violations.push({
          file: rel,
          phase: hit.phaseId,
          step: hit.stepId,
          index: hit.index,
          rule: 'invalid_payload_path',
          identifier_path: String(payloadPath),
          path_kind: 'payload_must_contain.path',
          path_index: payloadIndex,
        });
      }
    }
  }

  function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(p);
        continue;
      }
      if (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml')) {
        lintFile(p);
      }
    }
  }
  walk(sourceDir);

  return violations;
}

function main() {
  const violations = lint();
  if (violations.length === 0) {
    console.log(
      '✓ storyboard upstream_traffic path lint: all identifier_paths and payload_must_contain.path values use supported grammars',
    );
    return;
  }
  console.error(`✗ storyboard upstream_traffic path lint: ${violations.length} violation(s)\n`);
  for (const v of violations) {
    const msg = RULE_MESSAGES[v.rule] ? RULE_MESSAGES[v.rule](v.identifier_path) : v.rule;
    const pathIndex = v.path_index === undefined ? '' : `[${v.path_index}]`;
    const pathKind = v.path_kind ? ` ${v.path_kind}${pathIndex}` : '';
    console.error(`  ${v.file} phase=${v.phase} step=${v.step} validations[${v.index}]${pathKind} (${v.rule})`);
    console.error(`    ${msg}`);
    console.error('');
  }
  process.exit(1);
}

if (require.main === module) main();

module.exports = {
  RULE_MESSAGES,
  isPortableIdentifierPath,
  isSupportedPayloadPath,
  walkUpstreamTrafficChecks,
  lint,
};
