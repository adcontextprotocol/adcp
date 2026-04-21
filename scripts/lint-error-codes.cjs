#!/usr/bin/env node
/**
 * Fail the build if any storyboard asserts on an error code that isn't in the
 * canonical enum at `static/schemas/source/enums/error-code.json` (or registered
 * as a deprecation alias).
 *
 * Scans every storyboard .yaml under static/compliance/source/ for validations
 * of the form `check: error_code` with `value:` or `allowed_values:`, and checks
 * each referenced code against the enum.
 *
 * Why this exists: error-code drift across the spec, storyboards, and SDKs is
 * a recurring source of implementer pain. A storyboard that asserts on a code
 * the spec doesn't define is a dead-weight failure for any agent that tried to
 * match the spec. Catching at build time keeps the three sources in sync.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_DIR = path.join(ROOT, 'static', 'compliance', 'source');
const ENUM_PATH = path.join(ROOT, 'static', 'schemas', 'source', 'enums', 'error-code.json');
const ALIAS_PATH = path.join(ROOT, 'scripts', 'error-code-aliases.json');

function loadEnum() {
  const raw = JSON.parse(fs.readFileSync(ENUM_PATH, 'utf8'));
  if (!Array.isArray(raw.enum)) {
    throw new Error(`Canonical error-code enum at ${ENUM_PATH} is missing or malformed.`);
  }
  const canonical = new Set(raw.enum);
  let aliases = new Set();
  if (fs.existsSync(ALIAS_PATH)) {
    const raw2 = JSON.parse(fs.readFileSync(ALIAS_PATH, 'utf8'));
    if (raw2.aliases && typeof raw2.aliases === 'object') {
      aliases = new Set(Object.keys(raw2.aliases));
    }
  }
  return { canonical, aliases };
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && entry.name.endsWith('.yaml')) out.push(full);
  }
  return out;
}

function* findErrorCodeAssertions(node, trail) {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      yield* findErrorCodeAssertions(node[i], [...trail, i]);
    }
    return;
  }
  if (node && typeof node === 'object') {
    if (node.check === 'error_code') {
      if (typeof node.value === 'string') {
        yield { code: node.value, trail: [...trail, 'value'] };
      }
      if (Array.isArray(node.allowed_values)) {
        for (let i = 0; i < node.allowed_values.length; i++) {
          const v = node.allowed_values[i];
          if (typeof v === 'string') {
            yield { code: v, trail: [...trail, 'allowed_values', i] };
          }
        }
      }
    }
    for (const key of Object.keys(node)) {
      yield* findErrorCodeAssertions(node[key], [...trail, key]);
    }
  }
}

function lintFile(filePath, { canonical, aliases }) {
  const violations = [];
  let doc;
  try {
    doc = yaml.load(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return [{ filePath, trail: [], code: null, reason: `skipped (YAML parse failed: ${err.message}) — fix via upstream YAML lint`, severity: 'warn' }];
  }
  if (!doc) return violations;
  for (const hit of findErrorCodeAssertions(doc, [])) {
    if (canonical.has(hit.code)) continue;
    if (aliases.has(hit.code)) {
      violations.push({
        filePath,
        trail: hit.trail,
        code: hit.code,
        reason: `deprecated alias — remove or migrate before the alias sunsets`,
        severity: 'warn',
      });
      continue;
    }
    violations.push({
      filePath,
      trail: hit.trail,
      code: hit.code,
      reason: `not in canonical error-code enum (static/schemas/source/enums/error-code.json)`,
      severity: 'error',
    });
  }
  return violations;
}

function formatTrail(trail) {
  return trail.map(seg => (typeof seg === 'number' ? `[${seg}]` : `.${seg}`)).join('').replace(/^\./, '');
}

function main() {
  const enumData = loadEnum();
  const files = walk(SOURCE_DIR);
  let errorCount = 0;
  let warnCount = 0;
  for (const file of files) {
    const violations = lintFile(file, enumData);
    for (const v of violations) {
      const rel = path.relative(ROOT, v.filePath);
      const loc = v.trail.length ? ` at ${formatTrail(v.trail)}` : '';
      const codeRef = v.code ? ` "${v.code}"` : '';
      const tag = v.severity === 'warn' ? 'warn' : 'error';
      console.error(`  ${tag}: ${rel}${loc}${codeRef} — ${v.reason}`);
      if (v.severity === 'warn') warnCount++; else errorCount++;
    }
  }
  if (errorCount || warnCount) {
    console.error(`\n  storyboard error-code lint: ${errorCount} error(s), ${warnCount} warning(s)`);
  }
  if (errorCount) {
    console.error(`\n  Add the code to static/schemas/source/enums/error-code.json or register it as an alias in error-code-aliases.json.`);
    process.exit(1);
  }
  if (!errorCount && !warnCount) {
    console.log(`  storyboard error-code lint: clean (${files.length} storyboard files scanned against ${enumData.canonical.size} canonical codes)`);
  }
}

main();
