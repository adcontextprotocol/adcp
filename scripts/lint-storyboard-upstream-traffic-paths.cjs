#!/usr/bin/env node
/**
 * Validate portable path grammar for upstream_traffic `identifier_paths`.
 *
 * The runner contract intentionally supports a small, request-payload-relative
 * grammar: dotted object keys with optional `[*]` wildcards on path segments.
 * Rejecting unsupported JSONPath-like forms at publish time prevents different
 * runners from silently resolving the same storyboard to different vectors.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_DIR = path.join(ROOT, 'static', 'compliance', 'source');
const SEGMENT_RE = /^[A-Za-z_][A-Za-z0-9_-]*(?:\[\*\])?$/;
const RESERVED_ROOTS = new Set(['request', 'response', 'context']);

const RULE_MESSAGES = {
  invalid_identifier_path: (identifierPath) =>
    `identifier_paths entry "${identifierPath}" is outside the portable upstream_traffic grammar. ` +
    'Use request-payload-relative dotted paths whose segments are keys optionally followed by [*], ' +
    'for example audiences[*].add[*].hashed_email. Bracket-quoted keys, numeric indexes, recursive ' +
    'descent, explicit roots, empty segments, and reserved roots request.*, response.*, and context.* ' +
    'are not portable.',
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
  if (value.startsWith('$.') || value.startsWith('$..')) return false;

  const segments = value.split('.');
  if (segments.some((segment) => segment.length === 0)) return false;

  const root = segments[0].replace(/\[\*\]$/, '');
  if (RESERVED_ROOTS.has(root)) return false;

  return segments.every((segment) => SEGMENT_RE.test(segment));
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
      if (paths === undefined || paths === null) continue;
      if (!Array.isArray(paths)) {
        violations.push({
          file: rel,
          phase: hit.phaseId,
          step: hit.stepId,
          index: hit.index,
          rule: 'invalid_identifier_path',
          identifier_path: String(paths),
        });
        continue;
      }
      for (const identifierPath of paths) {
        if (isPortableIdentifierPath(identifierPath)) continue;
        violations.push({
          file: rel,
          phase: hit.phaseId,
          step: hit.stepId,
          index: hit.index,
          rule: 'invalid_identifier_path',
          identifier_path: String(identifierPath),
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
    console.log('✓ storyboard upstream_traffic path lint: all identifier_paths use the portable grammar');
    return;
  }
  console.error(`✗ storyboard upstream_traffic path lint: ${violations.length} violation(s)\n`);
  for (const v of violations) {
    const msg = RULE_MESSAGES[v.rule] ? RULE_MESSAGES[v.rule](v.identifier_path) : v.rule;
    console.error(`  ${v.file} phase=${v.phase} step=${v.step} validations[${v.index}] (${v.rule})`);
    console.error(`    ${msg}`);
    console.error('');
  }
  process.exit(1);
}

if (require.main === module) main();

module.exports = {
  RULE_MESSAGES,
  isPortableIdentifierPath,
  walkUpstreamTrafficChecks,
  lint,
};
