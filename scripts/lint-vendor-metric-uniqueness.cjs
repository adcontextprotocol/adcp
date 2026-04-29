#!/usr/bin/env node
/**
 * Fail the build if any storyboard step inlines vendor_metric_values or
 * vendor_metrics arrays that violate the semantic uniqueness key
 * (vendor.domain, vendor.brand_id, metric_id).
 *
 * JSON Schema `uniqueItems` was deliberately omitted from these arrays because
 * BrandRef carries optional fields whose absence/presence defeats deep-equal.
 * The MUST constraint ("sellers MUST de-duplicate before emission") is
 * normatively documented in reporting-capabilities.json and delivery-metrics.json
 * but was not enforced at build time. This lint closes that gap for storyboard
 * fixtures. The companion check in scripts/build-schemas.cjs enforces the same
 * constraint on schema file `examples` arrays. Issue: adcontextprotocol/adcp#3502.
 *
 * Key normalization: `domain|brand_id|metric_id` where absent brand_id → "".
 * The `|` separator is safe: domain (`[a-z0-9.-]`), brand_id (`[a-z0-9_]`), and
 * metric_id (`[a-z][a-z0-9_]*`) cannot contain `|`. Absent brand_id is the empty
 * string — distinct from any valid brand_id so `{domain:"x"}` and
 * `{domain:"x",brand_id:""}` cannot collide.
 *
 * Scans both sample_request and params fields on every storyboard step.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SOURCE_DIR = path.resolve(__dirname, '..', 'static', 'compliance', 'source');

/** Walk a directory for *.yaml / *.yml files. */
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

// js-yaml is loaded lazily so that requiring this module for unit tests
// (which only exercise the pure helper functions) does not fail in environments
// where node_modules are not installed.
function loadYaml() {
  return require('js-yaml'); // eslint-disable-line global-require
}

/** Pull out every step from a parsed storyboard document. */
function iterSteps(doc) {
  const out = [];
  const phases = Array.isArray(doc?.phases) ? doc.phases : [];
  for (const phase of phases) {
    const steps = Array.isArray(phase?.steps) ? phase.steps : [];
    for (const step of steps) {
      if (step && typeof step === 'object') {
        out.push({ phaseId: phase.id ?? '<unnamed>', step });
      }
    }
  }
  return out;
}

/**
 * Build the semantic key string for a vendor metric entry.
 * Normalizes absent brand_id to "" so {domain:"x"} ≠ {domain:"x",brand_id:"sub"}.
 */
function vendorMetricKey(entry) {
  if (!entry || typeof entry !== 'object' || !entry.vendor) return null;
  const domain = typeof entry.vendor.domain === 'string' ? entry.vendor.domain : '';
  const brandId = typeof entry.vendor.brand_id === 'string' ? entry.vendor.brand_id : '';
  const metricId = typeof entry.metric_id === 'string' ? entry.metric_id : '';
  return `${domain}|${brandId}|${metricId}`;
}

/**
 * Check one payload object for vendor metric duplicate tuples.
 * Returns an array of duplicate key strings found.
 */
function findDuplicatesInPayload(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const duplicates = [];
  for (const field of ['vendor_metric_values', 'vendor_metrics']) {
    const arr = payload[field];
    if (!Array.isArray(arr) || arr.length < 2) continue;
    const seen = new Set();
    for (const entry of arr) {
      const key = vendorMetricKey(entry);
      if (key === null) continue;
      if (seen.has(key)) duplicates.push(`${field}[]: "${key}"`);
      seen.add(key);
    }
  }
  return duplicates;
}

function lint() {
  const files = walkYaml(SOURCE_DIR);
  const violations = [];

  for (const file of files) {
    let doc;
    try {
      doc = loadYaml().load(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (!doc || typeof doc !== 'object') continue;

    for (const { phaseId, step } of iterSteps(doc)) {
      const stepId = step.id ?? '<unnamed>';
      const relFile = path.relative(SOURCE_DIR, file);

      // Check sample_request (buyer/agent payloads)
      const fromRequest = findDuplicatesInPayload(step.sample_request);
      for (const dup of fromRequest) {
        violations.push({ file: relFile, phaseId, stepId, source: 'sample_request', dup });
      }

      // Check params (comply_test_controller scenario params)
      const fromParams = findDuplicatesInPayload(step.params);
      for (const dup of fromParams) {
        violations.push({ file: relFile, phaseId, stepId, source: 'params', dup });
      }
    }
  }

  return violations;
}

function main() {
  const violations = lint();
  if (violations.length === 0) {
    console.log('✓ vendor metric uniqueness lint: no duplicate (vendor.domain, vendor.brand_id, metric_id) tuples in storyboard fixtures');
    return;
  }

  console.error(`✗ vendor metric uniqueness lint: ${violations.length} violation(s)\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.phaseId}/${v.stepId} (${v.source}) — ${v.dup}`);
  }
  console.error('\nFix: each (vendor.domain, vendor.brand_id, metric_id) tuple MUST appear at most once per array.');
  console.error('See static/schemas/source/core/reporting-capabilities.json and delivery-metrics.json for the');
  console.error('normative constraint. Sellers MUST de-duplicate before emission. adcontextprotocol/adcp#3502.');
  process.exit(1);
}

if (require.main === module) main();

module.exports = { lint, findDuplicatesInPayload, vendorMetricKey };
