#!/usr/bin/env node
/** Validate 3.2 storyboard `fixture_resolution` declarations (DR-0010). */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const SOURCE_DIR = path.resolve(__dirname, '..', 'static', 'compliance', 'source');
const STRATEGIES = new Set(['seed', 'discover', 'construct']);
const OPERATORS = new Set([
  'equals',
  'present',
  'contains_all',
  'any_match',
  'canonical_format_satisfies',
]);
const ID_FIELDS = {
  accounts: 'account_id',
  products: 'product_id',
  creative_formats: 'format_id',
  creatives: 'creative_id',
  plans: 'plan_id',
  media_buys: 'media_buy_id',
};
// Keep this aligned with the entity-specific discovery contract in
// storyboard-schema.yaml. A normal read surface and deterministic tie-break
// are currently defined only for products and their pricing options.
const DISCOVERABLE = new Set(['products', 'pricing_options']);
// Reserved until a follow-up decision pins each entity's creation request,
// required outputs, and lifecycle transitions. The storyboard contract forbids
// runners from inventing a generic construct path in the meantime.
const CONSTRUCTABLE = new Set();

function walkYaml(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkYaml(full));
    else if (entry.isFile() && /\.ya?ml$/.test(entry.name)) files.push(full);
  }
  return files;
}

function fixtureKey(type, entry) {
  if (type === 'pricing_options') {
    return `${entry?.product_id ?? ''}\0${entry?.pricing_option_id ?? ''}`;
  }
  const idField = ID_FIELDS[type];
  return idField ? entry?.[idField] : undefined;
}

function resolutionKey(type, entry) {
  if (type === 'pricing_options') {
    return `${entry?.product_handle ?? ''}\0${entry?.handle ?? ''}`;
  }
  return entry?.handle;
}

function lintMatchClause(clause, at, violations) {
  if (!clause || typeof clause !== 'object' || Array.isArray(clause)) {
    violations.push({ rule: 'match_clause_shape', at });
    return;
  }
  if (typeof clause.path !== 'string' || !clause.path.startsWith('/')) {
    violations.push({ rule: 'match_path', at });
  }
  if (!OPERATORS.has(clause.operator)) {
    violations.push({ rule: 'match_operator', at, operator: clause.operator });
    return;
  }
  if (clause.operator === 'present') {
    if (Object.hasOwn(clause, 'value') || Object.hasOwn(clause, 'where')) {
      violations.push({ rule: 'present_shape', at });
    }
    return;
  }
  if (clause.operator === 'any_match') {
    if (Object.hasOwn(clause, 'value') || !Array.isArray(clause.where) || clause.where.length === 0) {
      violations.push({ rule: 'any_match_shape', at });
      return;
    }
    clause.where.forEach((nested, i) => lintMatchClause(nested, `${at}.where[${i}]`, violations));
    return;
  }
  if (!Object.hasOwn(clause, 'value') || Object.hasOwn(clause, 'where')) {
    violations.push({ rule: 'match_value_shape', at });
  }
  if (clause.operator === 'contains_all' && !Array.isArray(clause.value)) {
    violations.push({ rule: 'contains_all_value', at });
  }
}

function lintDoc(doc) {
  const violations = [];
  const resolution = doc?.fixture_resolution;
  if (resolution === undefined) return violations;
  if (!resolution || typeof resolution !== 'object' || Array.isArray(resolution)) {
    return [{ rule: 'root_shape', at: 'fixture_resolution' }];
  }

  const fixtures = doc?.fixtures && typeof doc.fixtures === 'object' ? doc.fixtures : {};
  for (const [type, entries] of Object.entries(resolution)) {
    const at = `fixture_resolution.${type}`;
    if (!Array.isArray(entries)) {
      violations.push({ rule: 'type_shape', at });
      continue;
    }
    if (!(type in ID_FIELDS) && type !== 'pricing_options') {
      violations.push({ rule: 'unknown_fixture_type', at, type });
      continue;
    }
    const fixtureEntries = Array.isArray(fixtures[type]) ? fixtures[type] : [];
    const fixtureKeys = new Set(fixtureEntries.map((entry) => fixtureKey(type, entry)));
    const seen = new Set();

    entries.forEach((entry, index) => {
      const entryAt = `${at}[${index}]`;
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        violations.push({ rule: 'entry_shape', at: entryAt });
        return;
      }
      if (typeof entry.handle !== 'string' || entry.handle.length === 0) {
        violations.push({ rule: 'handle', at: entryAt });
      }
      if (type === 'pricing_options' &&
          (typeof entry.product_handle !== 'string' || entry.product_handle.length === 0)) {
        violations.push({ rule: 'product_handle', at: entryAt });
      }
      const key = resolutionKey(type, entry);
      if (!fixtureKeys.has(key)) violations.push({ rule: 'dangling_handle', at: entryAt });
      if (seen.has(key)) violations.push({ rule: 'duplicate_handle', at: entryAt });
      seen.add(key);

      const strategies = Array.isArray(entry.strategies) ? entry.strategies : [];
      if (strategies.length === 0 ||
          strategies.some((strategy) => !STRATEGIES.has(strategy)) ||
          new Set(strategies).size !== strategies.length) {
        violations.push({ rule: 'strategies', at: entryAt });
      } else {
        if (strategies.includes('discover') && !DISCOVERABLE.has(type)) {
          violations.push({ rule: 'discover_unsupported_type', at: entryAt, type });
        }
        if (strategies.includes('construct') && !CONSTRUCTABLE.has(type)) {
          violations.push({ rule: 'construct_unsupported_type', at: entryAt, type });
        }
      }
      if (entry.allow_reuse !== undefined && typeof entry.allow_reuse !== 'boolean') {
        violations.push({ rule: 'allow_reuse', at: entryAt });
      }
      if (strategies.includes('discover')) {
        if (!Array.isArray(entry.match) || entry.match.length === 0) {
          violations.push({ rule: 'discover_match_required', at: entryAt });
        } else {
          entry.match.forEach((clause, i) => lintMatchClause(clause, `${entryAt}.match[${i}]`, violations));
        }
      } else if (entry.match !== undefined) {
        violations.push({ rule: 'match_without_discover', at: entryAt });
      }
    });
  }
  return violations;
}

function lint(sourceDir = SOURCE_DIR) {
  const violations = [];
  for (const file of walkYaml(sourceDir)) {
    let doc;
    try {
      doc = yaml.load(fs.readFileSync(file, 'utf8'));
    } catch {
      continue; // YAML syntax is owned by the existing source parser.
    }
    for (const violation of lintDoc(doc)) {
      violations.push({ file: path.relative(sourceDir, file), ...violation });
    }
  }
  return violations;
}

if (require.main === module) {
  const violations = lint();
  if (violations.length > 0) {
    console.error('Storyboard fixture-resolution violations:');
    for (const violation of violations) {
      console.error(`  ${violation.file}:${violation.at} — ${violation.rule}`);
    }
    process.exit(1);
  }
  console.log('Storyboard fixture-resolution declarations are valid.');
}

module.exports = { lint, lintDoc };
