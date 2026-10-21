#!/usr/bin/env node
/**
 * Lint: the AdCP 4.0 compatibility registry
 * (static/compliance/source/universal/v4-compatibility.yaml) stays in step
 * with the storyboards and notices that observe each check and with the
 * migration guide that explains each fix.
 *
 * Why
 * ---
 * The registry is how a report turns one compliance run into "passed /
 * failing / not observable" per 4.0 change (#8332). That join only works if
 * every check id resolves to exactly the validation or notice the registry
 * names, and if every 4.0 observation in the suite is in the registry.
 *
 * Rules (each error names its rule):
 *
 *   registry_shape          an entry is missing a field or has a bad value.
 *   duplicate_check_id      two entries share an id.
 *   unknown_storyboard      observed_by.validation names a storyboard id that
 *                           does not exist.
 *   unknown_step            a listed step is not in that storyboard.
 *   validation_missing      a listed step has no validation whose `id` is
 *                           the check id.
 *   advisory_not_permanent  the observing validation is advisory but not
 *                           `permanent_advisory` (expires_after_version would
 *                           promote it on a 3.x run).
 *   unregistered_validation a storyboard validation id ends in `_in_4_0`
 *                           but no registry entry lists that step.
 *   unknown_notice          observed_by.notice names a code that is not a
 *                           canonical notice code with effective_version 4.0.
 *   unregistered_notice     a canonical notice code with effective_version
 *                           4.0 is not a registry id (a registry entry may
 *                           observe it through a validation instead).
 *   validation_id_suffix    a validation-observed id does not end in
 *                           `_in_4_0`, so the reverse-parity scan could not
 *                           catch an unregistered reuse of it.
 *   migration_anchor_missing the migration guide has no anchor for an id.
 *   schema_site_unlisted    a schema node marked `x-removed-in: "4.0.0"` is
 *                           not listed in any check's `schema_sites` or in
 *                           `schema_removals_not_checked`.
 *   schema_site_invalid     a listed site does not resolve to a schema node
 *                           marked `x-removed-in: "4.0.0"`.
 *   schema_site_duplicate   a site is listed more than once.
 *   stray_migration_anchor  the migration guide has a check-shaped anchor
 *                           (`*_in_4_0`) that is not a registry id.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const REPO_ROOT = path.join(__dirname, '..');
const DEFAULT_SOURCE_DIR = path.join(REPO_ROOT, 'static/compliance/source');
const REGISTRY_REL = 'universal/v4-compatibility.yaml';
const CONTRACT_REL = 'universal/runner-output-contract.yaml';
const STORYBOARD_DIRS = ['universal', 'protocols', 'specialisms'];
const SCHEMA_REL = 'static/schemas/source';
const REMOVAL_VERSION = '4.0.0';

const ID_PATTERN = /^[a-z][a-z0-9_]*$/;
const CHECK_SHAPED_ID = /_in_4_0$/;
const CHANGES = new Set(['removal', 'new_requirement']);

function walkYaml(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walkYaml(full);
    return entry.name.endsWith('.yaml') ? [full] : [];
  });
}

function loadStoryboards(sourceDir) {
  const byId = new Map();
  for (const sub of STORYBOARD_DIRS) {
    for (const file of walkYaml(path.join(sourceDir, sub))) {
      let doc;
      try {
        doc = yaml.load(fs.readFileSync(file, 'utf8'));
      } catch {
        continue; // malformed YAML is reported by other lints
      }
      if (!doc || typeof doc !== 'object' || typeof doc.id !== 'string' || !Array.isArray(doc.phases)) continue;
      const steps = new Map();
      for (const phase of doc.phases) {
        for (const step of (phase && Array.isArray(phase.steps)) ? phase.steps : []) {
          if (step && typeof step.id === 'string') steps.set(step.id, step);
        }
      }
      byId.set(doc.id, { file: path.relative(sourceDir, file), steps });
    }
  }
  return byId;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function checkShape(entry, index, errors) {
  const where = `checks[${index}]${entry && entry.id ? ` (${entry.id})` : ''}`;
  const fail = msg => errors.push(`registry_shape: ${where}: ${msg}`);
  if (!entry || typeof entry !== 'object') return fail('entry must be a mapping');
  if (!nonEmptyString(entry.id) || !ID_PATTERN.test(entry.id)) fail('id must be snake_case');
  if (!Number.isInteger(entry.issue) || entry.issue <= 0) fail('issue must be a positive issue number');
  if (!CHANGES.has(entry.change)) fail(`change must be one of ${[...CHANGES].join(', ')}`);
  if (!Array.isArray(entry.applies_to) || entry.applies_to.length === 0 || !entry.applies_to.every(nonEmptyString)) {
    fail('applies_to must be a non-empty list of roles');
  }
  if (!nonEmptyString(entry.detection)) fail('detection is required');
  if (!nonEmptyString(entry.fix)) fail('fix is required');
  if (entry.schema_sites !== undefined && (!Array.isArray(entry.schema_sites) || !entry.schema_sites.every(nonEmptyString))) {
    fail('schema_sites must be a list of schema sites');
  }
  const observed = entry.observed_by;
  const kinds = observed && typeof observed === 'object' ? Object.keys(observed) : [];
  if (kinds.length !== 1 || !['validation', 'notice', 'none'].includes(kinds[0])) {
    fail('observed_by must have exactly one of validation, notice, none');
    return;
  }
  if (kinds[0] === 'validation') {
    const v = observed.validation;
    if (!v || !nonEmptyString(v.storyboard)) fail('observed_by.validation.storyboard is required');
    if (!v || !Array.isArray(v.steps) || v.steps.length === 0 || !v.steps.every(nonEmptyString)) {
      fail('observed_by.validation.steps must be a non-empty list of step ids');
    }
    if (nonEmptyString(entry.id) && !CHECK_SHAPED_ID.test(entry.id)) {
      errors.push(`validation_id_suffix: ${entry.id}: a validation-observed check id must end in _in_4_0`);
    }
  } else if (kinds[0] === 'notice') {
    const n = observed.notice;
    if (!n || !Array.isArray(n.storyboards) || n.storyboards.length === 0 || !n.storyboards.every(nonEmptyString)) {
      fail('observed_by.notice.storyboards must be a non-empty list of storyboard ids');
    }
  } else if (!observed.none || !nonEmptyString(observed.none.reason)) {
    fail('observed_by.none.reason is required');
  }
}

function walkJson(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walkJson(full);
    return entry.name.endsWith('.json') ? [full] : [];
  });
}

function escapePointerSegment(segment) {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1');
}

// Every schema node marked for removal in 4.0, as `<file>#<JSON Pointer>`.
function findRemovalSites(schemaDir) {
  const sites = new Set();
  for (const file of walkJson(schemaDir)) {
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue; // malformed JSON is reported by the schema build
    }
    const rel = path.relative(schemaDir, file).split(path.sep).join('/');
    const visit = (node, pointer) => {
      if (!node || typeof node !== 'object') return;
      if (pointer.includes('/examples/')) return;
      if (node['x-removed-in'] === REMOVAL_VERSION) sites.add(`${rel}#${pointer}`);
      for (const [key, child] of Object.entries(node)) visit(child, `${pointer}/${escapePointerSegment(key)}`);
    };
    visit(doc, '');
  }
  return sites;
}

function checkSchemaSites(registry, schemaDir, errors) {
  const listed = [];
  for (const entry of registry.checks) {
    for (const site of entry.schema_sites || []) listed.push({ site, owner: `check ${entry.id}` });
  }
  const groups = registry.schema_removals_not_checked || [];
  if (!Array.isArray(groups)) {
    errors.push('registry_shape: schema_removals_not_checked must be a list');
    return;
  }
  groups.forEach((group, i) => {
    const where = `schema_removals_not_checked[${i}]`;
    if (!group || !nonEmptyString(group.change)) errors.push(`registry_shape: ${where}: change is required`);
    if (!group || !nonEmptyString(group.reason)) errors.push(`registry_shape: ${where}: reason is required`);
    if (group && group.issue !== undefined && (!Number.isInteger(group.issue) || group.issue <= 0)) {
      errors.push(`registry_shape: ${where}: issue must be a positive issue number when present`);
    }
    if (!group || !Array.isArray(group.sites) || group.sites.length === 0 || !group.sites.every(nonEmptyString)) {
      errors.push(`registry_shape: ${where}: sites must be a non-empty list`);
      return;
    }
    for (const site of group.sites) listed.push({ site, owner: where });
  });

  const marked = findRemovalSites(schemaDir);
  const seen = new Set();
  for (const { site, owner } of listed) {
    if (seen.has(site)) errors.push(`schema_site_duplicate: ${site} is listed more than once`);
    seen.add(site);
    if (!marked.has(site)) {
      errors.push(`schema_site_invalid: ${owner} lists ${site}, which is not a schema node marked x-removed-in "${REMOVAL_VERSION}"`);
    }
  }
  for (const site of marked) {
    if (!seen.has(site)) {
      errors.push(
        `schema_site_unlisted: ${site} is marked x-removed-in "${REMOVAL_VERSION}" but is not in any check's schema_sites or in schema_removals_not_checked`,
      );
    }
  }
}

function migrationAnchors(content) {
  const anchors = new Set();
  for (const m of content.matchAll(/<a\s+id="([^"]+)"\s*(?:\/>|><\/a>)/g)) anchors.add(m[1]);
  return anchors;
}

/**
 * Run the lint. Returns an array of error strings (empty = clean).
 * Pass `{ sourceDir, repoRoot }` to override default paths (used by tests).
 */
function lint({ sourceDir = DEFAULT_SOURCE_DIR, repoRoot = REPO_ROOT, schemaDir = path.join(repoRoot, SCHEMA_REL) } = {}) {
  const errors = [];
  const registryPath = path.join(sourceDir, REGISTRY_REL);
  if (!fs.existsSync(registryPath)) return [`registry_shape: ${REGISTRY_REL} is missing`];
  const registry = yaml.load(fs.readFileSync(registryPath, 'utf8'));
  if (!registry || !Array.isArray(registry.checks)) return [`registry_shape: ${REGISTRY_REL} must declare checks[]`];

  registry.checks.forEach((entry, i) => checkShape(entry, i, errors));
  if (errors.length) return errors;

  const ids = new Set();
  for (const entry of registry.checks) {
    if (ids.has(entry.id)) errors.push(`duplicate_check_id: ${entry.id}`);
    ids.add(entry.id);
  }

  const storyboards = loadStoryboards(sourceDir);
  const registeredSteps = new Set();

  for (const entry of registry.checks) {
    const { validation, notice } = entry.observed_by;
    if (validation) {
      const sb = storyboards.get(validation.storyboard);
      if (!sb) {
        errors.push(`unknown_storyboard: ${entry.id}: storyboard ${validation.storyboard} does not exist`);
        continue;
      }
      for (const stepId of validation.steps) {
        registeredSteps.add(`${validation.storyboard}/${stepId}/${entry.id}`);
        const step = sb.steps.get(stepId);
        if (!step) {
          errors.push(`unknown_step: ${entry.id}: ${sb.file} has no step ${stepId}`);
          continue;
        }
        const match = (step.validations || []).find(v => v && v.id === entry.id);
        if (!match) {
          errors.push(`validation_missing: ${entry.id}: ${sb.file} step ${stepId} has no validation with id ${entry.id}`);
          continue;
        }
        if (match.severity === 'advisory' && (!match.permanent_advisory || match.expires_after_version !== undefined)) {
          errors.push(
            `advisory_not_permanent: ${entry.id}: ${sb.file} step ${stepId} must use permanent_advisory, not expires_after_version`,
          );
        }
      }
    }
    if (notice) {
      for (const sbId of notice.storyboards) {
        if (!storyboards.has(sbId)) errors.push(`unknown_storyboard: ${entry.id}: storyboard ${sbId} does not exist`);
      }
    }
  }

  // Reverse parity: every check-shaped validation id in the suite is registered.
  for (const [sbId, sb] of storyboards) {
    for (const [stepId, step] of sb.steps) {
      for (const v of step.validations || []) {
        if (!v || typeof v.id !== 'string' || !CHECK_SHAPED_ID.test(v.id)) continue;
        if (!registeredSteps.has(`${sbId}/${stepId}/${v.id}`)) {
          errors.push(
            `unregistered_validation: ${sb.file} step ${stepId} validation ${v.id} is not listed in ${REGISTRY_REL}`,
          );
        }
      }
    }
  }

  // Notice parity against the runner-output contract's canonical codes.
  const contract = yaml.load(fs.readFileSync(path.join(sourceDir, CONTRACT_REL), 'utf8'));
  const codes = (contract && contract.notice && contract.notice.canonical_codes) || {};
  const v4Codes = new Set(
    Object.entries(codes)
      .filter(([, def]) => def && typeof def === 'object' && String(def.effective_version) === '4.0')
      .map(([code]) => code),
  );
  const noticeIds = new Set(registry.checks.filter(e => e.observed_by.notice).map(e => e.id));
  for (const id of noticeIds) {
    if (!v4Codes.has(id)) {
      errors.push(`unknown_notice: ${id} is not a canonical notice code with effective_version "4.0" in ${CONTRACT_REL}`);
    }
  }
  for (const code of v4Codes) {
    if (!ids.has(code)) {
      errors.push(`unregistered_notice: canonical notice code ${code} (effective_version "4.0") is not in ${REGISTRY_REL}`);
    }
  }

  checkSchemaSites(registry, schemaDir, errors);

  // Migration guide anchors.
  const guideRel = registry.migration_guide;
  const guidePath = nonEmptyString(guideRel) ? path.join(repoRoot, guideRel) : null;
  if (!guidePath || !fs.existsSync(guidePath)) {
    errors.push(`migration_anchor_missing: migration_guide ${guideRel} does not exist`);
  } else {
    const anchors = migrationAnchors(fs.readFileSync(guidePath, 'utf8'));
    for (const id of ids) {
      if (!anchors.has(id)) errors.push(`migration_anchor_missing: ${guideRel} has no <a id="${id}"></a>`);
    }
    for (const anchor of anchors) {
      if (CHECK_SHAPED_ID.test(anchor) && !ids.has(anchor)) {
        errors.push(`stray_migration_anchor: ${guideRel} anchor ${anchor} is not a registry check id`);
      }
    }
  }

  return errors;
}

if (require.main === module) {
  const errors = lint();
  if (errors.length) {
    console.error(`✗ v4 compatibility registry lint:\n  - ${errors.join('\n  - ')}`);
    process.exit(1);
  }
  console.log('✓ v4 compatibility registry lint: registry, storyboards, notices, and migration guide agree');
}

module.exports = { lint, loadStoryboards, migrationAnchors, findRemovalSites };
