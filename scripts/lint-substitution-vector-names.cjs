#!/usr/bin/env node
/**
 * Fail the build if any storyboard's `expect_substitution_safe` step references
 * a `vector_name` that isn't in the canonical fixture at
 * `static/test-vectors/catalog-macro-substitution.json`, or if the runner
 * contract's `canonical_vector_names` list drifts from the fixture's names.
 *
 * Scans every storyboard .yaml under static/compliance/source/ for steps of
 * the form `task: expect_substitution_safe` with `catalog_bindings[].vector_name:`,
 * and checks each referenced name against the fixture's vector names.
 *
 * Also cross-checks the runner contract's declared `canonical_vector_names`
 * list against the fixture — the contract claims what names exist; the fixture
 * is the source of truth. Drift between the two is a separate error class
 * from a storyboard typo.
 *
 * Why this exists: the `expect_substitution_safe` task (#2647) takes free-string
 * `vector_name` arguments. A typo (`reserved-character-break0ut` vs
 * `reserved-character-breakout`) silently fails at runner execution as
 * "vector not found" — looks like a runner bug to an outside author, not a
 * storyboard bug. Catching at build time keeps the three sources in sync.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_DIR = path.join(ROOT, 'static', 'compliance', 'source');
const FIXTURE_PATH = path.join(ROOT, 'static', 'test-vectors', 'catalog-macro-substitution.json');
const CONTRACT_PATH = path.join(ROOT, 'static', 'compliance', 'source', 'test-kits', 'substitution-observer-runner.yaml');

function loadFixtureNames() {
  const raw = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  if (!Array.isArray(raw.vectors)) {
    throw new Error(`Fixture at ${FIXTURE_PATH} missing or malformed 'vectors' array.`);
  }
  return new Set(raw.vectors.map(v => v.name).filter(n => typeof n === 'string'));
}

function loadContractNames() {
  const raw = yaml.load(fs.readFileSync(CONTRACT_PATH, 'utf8'));
  const names = raw?.attacker_value_catalog?.canonical_vector_names;
  if (!Array.isArray(names)) {
    throw new Error(`Contract at ${CONTRACT_PATH} missing or malformed 'attacker_value_catalog.canonical_vector_names'.`);
  }
  return new Set(names);
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

function* findSubstitutionBindings(node, trail) {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      yield* findSubstitutionBindings(node[i], [...trail, i]);
    }
    return;
  }
  if (node && typeof node === 'object') {
    if (node.task === 'expect_substitution_safe' && Array.isArray(node.catalog_bindings)) {
      for (let i = 0; i < node.catalog_bindings.length; i++) {
        const binding = node.catalog_bindings[i];
        if (binding && typeof binding === 'object' && typeof binding.vector_name === 'string') {
          yield {
            vector_name: binding.vector_name,
            has_override: typeof binding.raw_value === 'string' || typeof binding.expected_encoded === 'string',
            trail: [...trail, 'catalog_bindings', i, 'vector_name'],
          };
        }
      }
    }
    for (const key of Object.keys(node)) {
      yield* findSubstitutionBindings(node[key], [...trail, key]);
    }
  }
}

function lintFile(filePath, fixtureNames) {
  const violations = [];
  let doc;
  try {
    doc = yaml.load(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return [{ filePath, trail: [], name: null, reason: `skipped (YAML parse failed: ${err.message}) — fix via upstream YAML lint`, severity: 'warn' }];
  }
  if (!doc) return violations;
  for (const hit of findSubstitutionBindings(doc, [])) {
    if (fixtureNames.has(hit.vector_name)) continue;
    if (hit.has_override) {
      // Custom vector with inline raw_value/expected_encoded — not required to
      // match the canonical fixture, just flag for human review.
      violations.push({
        filePath,
        trail: hit.trail,
        name: hit.vector_name,
        reason: `non-canonical vector (has raw_value/expected_encoded override) — verify fixture sync intentional`,
        severity: 'warn',
      });
      continue;
    }
    violations.push({
      filePath,
      trail: hit.trail,
      name: hit.vector_name,
      reason: `not in canonical fixture (static/test-vectors/catalog-macro-substitution.json)`,
      severity: 'error',
    });
  }
  return violations;
}

function formatTrail(trail) {
  return trail.map(seg => (typeof seg === 'number' ? `[${seg}]` : `.${seg}`)).join('').replace(/^\./, '');
}

function checkContractFixtureSync(contractNames, fixtureNames) {
  const violations = [];
  for (const name of contractNames) {
    if (!fixtureNames.has(name)) {
      violations.push({
        source: 'contract',
        name,
        reason: `declared in substitution-observer-runner.yaml#canonical_vector_names but missing from fixture (static/test-vectors/catalog-macro-substitution.json)`,
      });
    }
  }
  for (const name of fixtureNames) {
    if (!contractNames.has(name)) {
      violations.push({
        source: 'fixture',
        name,
        reason: `present in fixture but not declared in substitution-observer-runner.yaml#canonical_vector_names (storyboards referencing it will still pass this lint, but the contract under-advertises coverage)`,
      });
    }
  }
  return violations;
}

function main() {
  const fixtureNames = loadFixtureNames();
  const contractNames = loadContractNames();
  const syncViolations = checkContractFixtureSync(contractNames, fixtureNames);
  let errorCount = 0;
  let warnCount = 0;

  for (const v of syncViolations) {
    const severity = v.source === 'contract' ? 'error' : 'warn';
    console.error(`  ${severity}: contract/fixture drift — vector "${v.name}" — ${v.reason}`);
    if (severity === 'warn') warnCount++; else errorCount++;
  }

  const files = walk(SOURCE_DIR);
  for (const file of files) {
    const violations = lintFile(file, fixtureNames);
    for (const v of violations) {
      const rel = path.relative(ROOT, v.filePath);
      const loc = v.trail.length ? ` at ${formatTrail(v.trail)}` : '';
      const nameRef = v.name ? ` "${v.name}"` : '';
      const tag = v.severity === 'warn' ? 'warn' : 'error';
      console.error(`  ${tag}: ${rel}${loc}${nameRef} — ${v.reason}`);
      if (v.severity === 'warn') warnCount++; else errorCount++;
    }
  }

  if (errorCount || warnCount) {
    console.error(`\n  substitution-safety vector-name lint: ${errorCount} error(s), ${warnCount} warning(s)`);
  }
  if (errorCount) {
    console.error(`\n  Either fix the storyboard to reference a canonical vector name, add the vector to the fixture, or (for custom payloads) include raw_value + expected_encoded overrides on the binding.`);
    process.exit(1);
  }
  if (!errorCount && !warnCount) {
    console.log(`  substitution-safety vector-name lint: clean (${files.length} storyboard files scanned against ${fixtureNames.size} canonical fixture vectors)`);
  }
}

main();
