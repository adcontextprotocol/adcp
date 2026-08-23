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
const crypto = require('crypto');

const REGISTRY_DIR = path.join(__dirname, '..', 'static', 'registry', 'policies');
const POLICY_VERSION_DIR = path.join(__dirname, '..', 'static', 'registry', 'policy-versions');
const CATEGORY_DIR = path.join(__dirname, '..', 'static', 'registry', 'policy-categories');

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_ALPHA2 = /^[A-Z]{2}$/;
const VALID_CATEGORIES = new Set(['regulation', 'standard']);
const DIGEST = /^sha256:[a-f0-9]{64}$/;

function canonicalize(value) {
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('RFC 8785 forbids non-finite numbers');
  if (typeof value === 'string') {
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('RFC 8785 forbids lone surrogates');
        index += 1;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        throw new Error('RFC 8785 forbids lone surrogates');
      }
    }
  }
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${canonicalize(key)}:${canonicalize(value[key])}`).join(',')}}`;
}

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(canonicalize(value)).digest('hex')}`;
}

function policyContentDigest(entry) {
  const copy = structuredClone(entry);
  delete copy.acceptance_profile;
  return digest(copy);
}

function profileContentDigest(profile) {
  const copy = structuredClone(profile);
  delete copy.content_digest;
  return digest(copy);
}

function loadPolicyCategories() {
  const categories = new Map();
  if (!fs.existsSync(CATEGORY_DIR)) return categories;
  for (const file of fs.readdirSync(CATEGORY_DIR).filter((name) => name.endsWith('.json')).sort()) {
    const category = JSON.parse(fs.readFileSync(path.join(CATEGORY_DIR, file), 'utf8'));
    categories.set(category.category_id, category);
  }
  return categories;
}

const POLICY_CATEGORIES = loadPolicyCategories();

function checkPolicyCategory(category, filename) {
  const errors = [];
  const expectedId = filename.replace(/\.json$/, '');
  if (category.category_id !== expectedId) {
    errors.push(`category_id must match filename (expected "${expectedId}")`);
  }
  const seen = new Set();
  for (const [index, facet] of (category.facets || []).entries()) {
    if (seen.has(facet.facet_id)) errors.push(`duplicate facets[${index}].facet_id ${JSON.stringify(facet.facet_id)}`);
    seen.add(facet.facet_id);
  }
  for (const [frameworkIndex, framework] of (category.regulatory_frameworks || []).entries()) {
    for (const policyId of framework.policy_ids || []) {
      if (!fs.existsSync(path.join(REGISTRY_DIR, `${policyId}.json`))) {
        errors.push(`regulatory_frameworks[${frameworkIndex}].policy_ids references unknown registry policy ${JSON.stringify(policyId)}`);
      }
    }
  }
  for (const relatedId of category.related_categories || []) {
    if (!fs.existsSync(path.join(CATEGORY_DIR, `${relatedId}.json`))) {
      errors.push(`related_categories references unknown policy category ${JSON.stringify(relatedId)}`);
    }
  }
  return errors;
}

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

function checkAcceptanceProfile(entry, errors) {
  const profile = entry.acceptance_profile;
  if (profile === undefined) return;
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    errors.push('acceptance_profile must be an object');
    return;
  }
  if (profile.profile_id !== entry.policy_id) {
    errors.push('acceptance_profile.profile_id must equal the containing registry policy_id');
  }
  if (typeof profile.version !== 'string' || !SEMVER.test(profile.version)) {
    errors.push('acceptance_profile.version must be semver');
  }
  if (!DIGEST.test(profile.content_digest || '')) {
    errors.push('acceptance_profile.content_digest must be a canonical sha256 digest');
  }
  if (!['partial', 'complete'].includes(profile.coverage)) {
    errors.push('acceptance_profile.coverage must be partial or complete');
  }
  if (profile.coverage === 'complete' && (!profile.scope || typeof profile.scope !== 'object')) {
    errors.push('a complete acceptance_profile must declare scope');
  }

  const refs = Array.isArray(profile.policy_refs) ? profile.policy_refs : [];
  const expectedPolicyDigest = policyContentDigest(entry);
  const containingRef = refs.find((ref) => ref && ref.policy_id === entry.policy_id && ref.version === entry.version);
  if (!containingRef) {
    errors.push('acceptance_profile.policy_refs must pin the containing policy_id and exact version');
  } else if (containingRef.content_digest !== expectedPolicyDigest) {
    errors.push(`acceptance_profile.policy_refs digest for ${entry.policy_id}@${entry.version} must be ${expectedPolicyDigest}`);
  }
  for (const [index, ref] of refs.entries()) {
    if (!DIGEST.test(ref?.content_digest || '')) {
      errors.push(`acceptance_profile.policy_refs[${index}].content_digest must be a canonical sha256 digest`);
      continue;
    }
    const referencedFile = path.join(REGISTRY_DIR, `${ref.policy_id}.json`);
    if (!fs.existsSync(referencedFile)) {
      errors.push(`acceptance_profile.policy_refs[${index}] does not resolve to a registry policy ${JSON.stringify(ref.policy_id)}`);
      continue;
    }
    const referencedEntry = JSON.parse(fs.readFileSync(referencedFile, 'utf8'));
    if (referencedEntry.version !== ref.version) {
      errors.push(`acceptance_profile.policy_refs[${index}] pins unavailable ${ref.policy_id}@${ref.version}`);
    } else if (policyContentDigest(referencedEntry) !== ref.content_digest) {
      errors.push(`acceptance_profile.policy_refs[${index}] digest does not match ${ref.policy_id}@${ref.version}`);
    }
  }

  const expectedProfileDigest = profileContentDigest(profile);
  if (profile.content_digest !== expectedProfileDigest) {
    errors.push(`acceptance_profile.content_digest must be ${expectedProfileDigest}`);
  }

  const aliases = profile.region_aliases && typeof profile.region_aliases === 'object'
    ? new Set(Object.keys(profile.region_aliases))
    : new Set();
  for (const categoryId of profile.scope?.subject_categories || []) {
    if (!POLICY_CATEGORIES.has(categoryId)) {
      errors.push(`acceptance_profile.scope references unknown subject_category ${JSON.stringify(categoryId)}`);
    }
  }
  for (const group of profile.scope?.jurisdiction_groups || []) {
    if (!aliases.has(group)) {
      errors.push(`acceptance_profile.scope references undeclared jurisdiction group ${JSON.stringify(group)}`);
    }
  }
  const rules = Array.isArray(profile.rules) ? profile.rules : [];
  if (rules.length === 0) {
    errors.push('acceptance_profile.rules must contain at least one rule');
    return;
  }
  const ruleIds = new Set();
  const pinnedPolicyIds = new Set(refs.map((ref) => ref?.policy_id).filter(Boolean));
  for (const [index, rule] of rules.entries()) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
      errors.push(`acceptance_profile.rules[${index}] must be an object`);
      continue;
    }
    if (typeof rule.rule_id !== 'string' || rule.rule_id.length === 0) {
      errors.push(`acceptance_profile.rules[${index}].rule_id must be non-empty`);
    } else if (ruleIds.has(rule.rule_id)) {
      errors.push(`acceptance_profile contains duplicate rule_id ${JSON.stringify(rule.rule_id)}`);
    } else {
      ruleIds.add(rule.rule_id);
    }
    if (typeof rule.effective_at !== 'string' || !Number.isFinite(Date.parse(rule.effective_at))) {
      errors.push(`acceptance_profile rule ${JSON.stringify(rule.rule_id ?? index)} must declare a valid source effective_at`);
    }
    if (!Array.isArray(rule.policy_ids) || rule.policy_ids.length === 0) {
      errors.push(`acceptance_profile rule ${JSON.stringify(rule.rule_id ?? index)} must cite at least one pinned policy_id`);
    } else {
      for (const policyId of rule.policy_ids) {
        if (!pinnedPolicyIds.has(policyId)) {
          errors.push(`acceptance_profile rule ${JSON.stringify(rule.rule_id ?? index)} cites unpinned policy_id ${JSON.stringify(policyId)}`);
        }
      }
    }
    const category = POLICY_CATEGORIES.get(rule.subject_category);
    if (!category) {
      errors.push(`acceptance_profile rule ${JSON.stringify(rule.rule_id ?? index)} references unknown subject_category ${JSON.stringify(rule.subject_category)}`);
    } else {
      const knownFacets = new Set((category.facets || []).map((facet) => facet.facet_id));
      for (const facet of rule.subject_facets || []) {
        if (!knownFacets.has(facet)) {
          errors.push(`acceptance_profile rule ${JSON.stringify(rule.rule_id ?? index)} references unknown ${rule.subject_category} facet ${JSON.stringify(facet)}`);
        }
      }
    }
    for (const group of rule.jurisdiction_groups || []) {
      if (!aliases.has(group)) {
        errors.push(`acceptance_profile rule ${JSON.stringify(rule.rule_id ?? index)} references undeclared jurisdiction group ${JSON.stringify(group)}`);
      }
    }
  }
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

  checkAcceptanceProfile(entry, errors);

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
  let archivedVersionCount = 0;

  for (const file of fs.readdirSync(CATEGORY_DIR).filter((name) => name.endsWith('.json')).sort()) {
    const errors = checkPolicyCategory(POLICY_CATEGORIES.get(file.replace(/\.json$/, '')), file);
    if (errors.length > 0) failures.push({ file: `policy-categories/${file}`, errors });
  }

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

  if (fs.existsSync(POLICY_VERSION_DIR)) {
    for (const policyId of fs.readdirSync(POLICY_VERSION_DIR).sort()) {
      const policyDir = path.join(POLICY_VERSION_DIR, policyId);
      if (!fs.statSync(policyDir).isDirectory()) continue;
      for (const file of fs.readdirSync(policyDir).filter((name) => name.endsWith('.json')).sort()) {
        archivedVersionCount += 1;
        const relative = `policy-versions/${policyId}/${file}`;
        let entry;
        try {
          entry = JSON.parse(fs.readFileSync(path.join(policyDir, file), 'utf8'));
        } catch (err) {
          failures.push({ file: relative, errors: [`invalid JSON: ${err.message}`] });
          continue;
        }
        const expectedVersion = file.replace(/\.json$/, '');
        const errors = checkEntry(entry, `${policyId}.json`);
        if (entry.version !== expectedVersion) {
          errors.push(`version must match archived filename (expected ${JSON.stringify(expectedVersion)})`);
        }
        const currentFile = path.join(REGISTRY_DIR, `${policyId}.json`);
        if (!fs.existsSync(currentFile)) {
          errors.push(`archived policy must have a current registry entry ${JSON.stringify(policyId)}`);
        } else {
          try {
            const current = JSON.parse(fs.readFileSync(currentFile, 'utf8'));
            if (current.version === entry.version) {
              errors.push('archive must contain a retired version, not the current registry version');
            }
          } catch {
            // The current entry already reports its parse error in the main loop.
          }
        }
        if (errors.length > 0) failures.push({ file: relative, errors });
      }
    }
  }

  if (failures.length === 0) {
    console.log(`Registry completeness: ${files.length} current entr${files.length === 1 ? 'y' : 'ies'} and ${archivedVersionCount} archived version${archivedVersionCount === 1 ? '' : 's'} OK.`);
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

if (require.main === module) main();

module.exports = { canonicalize, digest, policyContentDigest, profileContentDigest, checkPolicyCategory, checkEntry };
