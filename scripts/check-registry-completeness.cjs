#!/usr/bin/env node

/**
 * Registry publication linter.
 *
 * The PolicyEntry schema only requires three fields (policy_id, enforcement,
 * policy) so inline bespoke authoring stays ergonomic. Entries published to the
 * shared registry at static/registry/policies/ still need the full metadata so
 * downstream consumers can aggregate across publishers.
 *
 * Schema validation can't tell "this is being published to the registry" from
 * "this is an inline bespoke entry" — both use the same type. CI is the
 * enforcement point.
 *
 * See: https://github.com/adcontextprotocol/adcp/issues/2319
 */

const fs = require('fs');
const path = require('path');

const REGISTRY_DIR = path.join(__dirname, '..', 'static', 'registry', 'policies');

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_ALPHA2 = /^[A-Z]{2}$/;
const VALID_CATEGORIES = new Set(['regulation', 'standard']);

function checkExemplars(list, kind, errors) {
  if (!Array.isArray(list) || list.length < 1) {
    errors.push(`exemplars.${kind} must contain at least one entry (calibration requires ${kind === 'pass' ? 'positive' : 'negative'} examples)`);
    return;
  }
  list.forEach((ex, i) => {
    if (!ex || typeof ex !== 'object') {
      errors.push(`exemplars.${kind}[${i}] must be an object with scenario and explanation`);
      return;
    }
    if (typeof ex.scenario !== 'string' || ex.scenario.trim().length === 0) {
      errors.push(`exemplars.${kind}[${i}].scenario must be a non-empty string`);
    }
    if (typeof ex.explanation !== 'string' || ex.explanation.trim().length === 0) {
      errors.push(`exemplars.${kind}[${i}].explanation must be a non-empty string`);
    }
  });
}

function checkEntry(entry, filename) {
  const errors = [];

  if (entry.source !== 'registry') {
    errors.push(`source must be "registry" (got ${JSON.stringify(entry.source ?? null)})`);
  }

  if (typeof entry.version !== 'string' || !SEMVER.test(entry.version)) {
    errors.push(`version must be a semver string (got ${JSON.stringify(entry.version ?? null)})`);
  }

  if (typeof entry.name !== 'string' || entry.name.trim().length === 0) {
    errors.push('name must be a non-empty string');
  }

  if (!VALID_CATEGORIES.has(entry.category)) {
    errors.push(`category must be "regulation" or "standard" (got ${JSON.stringify(entry.category ?? null)})`);
  }

  if (!Array.isArray(entry.jurisdictions)) {
    errors.push('jurisdictions must be an array (empty array is valid for non-jurisdiction-specific policies)');
  } else {
    const badCodes = entry.jurisdictions.filter((j) => typeof j !== 'string' || !ISO_ALPHA2.test(j));
    if (badCodes.length > 0) {
      errors.push(`jurisdictions entries must be ISO 3166-1 alpha-2 country codes (got ${JSON.stringify(badCodes)})`);
    }
  }

  if (!Array.isArray(entry.governance_domains) || entry.governance_domains.length === 0) {
    errors.push('governance_domains must be a non-empty array — registry consumers need it to route policies to the right governance surface');
  }

  if (typeof entry.source_url !== 'string' || entry.source_url.trim().length === 0) {
    errors.push('source_url must be a non-empty URI string');
  } else {
    try {
      const parsed = new URL(entry.source_url);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        errors.push(`source_url must use http(s) (got ${JSON.stringify(parsed.protocol)})`);
      }
    } catch {
      errors.push(`source_url must be a valid URI (got ${JSON.stringify(entry.source_url)})`);
    }
  }

  if (typeof entry.source_name !== 'string' || entry.source_name.trim().length === 0) {
    errors.push('source_name must be a non-empty string');
  }

  if (typeof entry.effective_date !== 'string' || !ISO_DATE.test(entry.effective_date)) {
    errors.push(`effective_date must be an ISO 8601 date (YYYY-MM-DD), got ${JSON.stringify(entry.effective_date ?? null)}`);
  }

  const exemplars = entry.exemplars;
  if (!exemplars || typeof exemplars !== 'object') {
    errors.push('exemplars must be present with at least one pass and one fail entry');
  } else {
    checkExemplars(exemplars.pass, 'pass', errors);
    checkExemplars(exemplars.fail, 'fail', errors);
  }

  const expectedId = filename.replace(/\.json$/, '');
  if (entry.policy_id !== expectedId) {
    errors.push(`policy_id must match filename (expected "${expectedId}", got ${JSON.stringify(entry.policy_id ?? null)})`);
  }

  return errors;
}

function main() {
  if (!fs.existsSync(REGISTRY_DIR)) {
    console.error(`Registry directory not found: ${REGISTRY_DIR}`);
    process.exit(1);
  }

  const files = fs.readdirSync(REGISTRY_DIR).filter((f) => f.endsWith('.json')).sort();

  if (files.length === 0) {
    console.log('No registry entries found — nothing to check.');
    return;
  }

  const failures = [];

  for (const file of files) {
    const fullPath = path.join(REGISTRY_DIR, file);
    let entry;
    try {
      entry = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    } catch (err) {
      failures.push({ file, errors: [`invalid JSON: ${err.message}`] });
      continue;
    }
    const errors = checkEntry(entry, file);
    if (errors.length > 0) {
      failures.push({ file, errors });
    }
  }

  if (failures.length === 0) {
    console.log(`Registry completeness: ${files.length} entr${files.length === 1 ? 'y' : 'ies'} OK.`);
    return;
  }

  console.error(`Registry completeness check failed for ${failures.length} of ${files.length} entr${files.length === 1 ? 'y' : 'ies'}:\n`);
  for (const { file, errors } of failures) {
    console.error(`  ${file}`);
    for (const err of errors) {
      console.error(`    - ${err}`);
    }
    console.error('');
  }
  console.error('Registry-published policies must carry the full metadata set (see static/registry/README.md).');
  console.error('Inline bespoke policies in sync-plans/content-standards are unaffected — only files in static/registry/policies/ are checked.');
  process.exit(1);
}

main();
