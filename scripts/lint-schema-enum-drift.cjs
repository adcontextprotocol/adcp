#!/usr/bin/env node
/**
 * Detect inline enum definitions in schema files that have drifted from
 * canonical enum files in enums/.
 *
 * Why this lint exists
 * --------------------
 * When a schema defines an inline `"enum": [...]` whose values overlap with a
 * canonical enum file, the inline copy can silently drift as the canonical
 * evolves (values added or removed). The brand.json property-type drift
 * (#6330 / PR #6334) is the motivating example: `linear_tv` and
 * `ai_assistant` were added to `enums/property-type.json` but the inline copy
 * in `brand.json` was missed, causing validation to reject valid documents.
 *
 * Rules
 * -----
 *   subset_drift  — inline values are a strict subset of a canonical enum,
 *                    missing values that were likely added later.
 *                    EXIT CODE 1 — this is a real drift bug.
 *
 * Informational (does not fail the lint):
 *   exact_match   — inline values are identical to a canonical enum.
 *                    Printed with --verbose. Candidate for $ref migration.
 *
 * Allowlist
 * ---------
 * Some inline enums are intentionally narrower than their canonical source
 * (state-machine constraints, conditional restrictions, different concepts
 * with overlapping values). These are listed in ALLOWED below.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SCHEMA_DIR = path.join(ROOT, 'static', 'schemas', 'source');
const ENUM_DIR = path.join(SCHEMA_DIR, 'enums');

// Inline enums that are intentionally narrower or use overlapping values
// from a different concept. Key: "relFile|jsonPathPrefix". Use * for any path.
const ALLOWED = new Set([
  // Capabilities response: snake_case wire format vs kebab-case canonical
  'protocol/get-adcp-capabilities-response.json|/properties/supported_protocols',
  // Capabilities: co-branding excludes "none" intentionally
  'protocol/get-adcp-capabilities-response.json|/properties/creative',
  'protocol/get-adcp-capabilities-response.json|/properties/media_buy/properties/execution/properties/co_branding',
  // Capabilities: quantitative vs numeric — established SI term
  'protocol/get-adcp-capabilities-response.json|/properties/sponsored_intelligence',
  // State-machine transition constraints
  'creative/creative-status-changed-webhook.json|*',
  // Governance conditional restrictions
  'governance/check-governance-request.json|*',
  'governance/check-governance-response.json|*',
  // Notification config: account-anchored event types only
  'core/notification-config.json|*',
  // Creative approval scope: allOf+$ref intentional narrowing
  'core/creative-approval-scope.json|*',
  // Diagnostic severity (error/warning/info) is distinct from escalation severity
  'core/diagnostic-issue.json|*',
  // Signal definition methodology intentionally excludes "projected"
  'core/signal-definition.json|*',
  'core/signal-definition-enrichment.json|*',
  // Manifest protocol includes internal sub-protocols; idempotency_requirement distinct concept
  'manifest.schema.json|*',
  // Overlay uses fraction for relative positioning — distinct from dimension-unit dp
  'core/overlay.json|*',
  // Property feature type: quantitative is the established term (not numeric)
  'property/property-feature-definition.json|*',
  // Package-level indicators intentionally exclude assignment-only types
  'media-buy/get-media-buys-response.json|*',
  // Sync response managed_by: buyer/seller overlaps canceled-by but distinct concept
  'media-buy/sync-event-sources-response.json|/oneOf/0/properties/event_sources/items/properties/managed_by',
  // Sync response action: accounts only use created/failed/unchanged/updated (no deleted)
  'account/sync-accounts-response.json|/oneOf/0/properties/accounts/items/properties/action',
  // canonical-media-buy-action oneOf branch intentionally lists a subset of actions
  'core/canonical-media-buy-action.json|*',
  // Event surface category has owned_property not in action-source (broader concept)
  'core/event-surface.json|*',
  // Creative format base has broader asset types and different watermark types
  'formats/canonical/_base.json|*',
  // Sponsored placement supported_id_types includes asin (broader than content-id-type)
  'formats/canonical/sponsored_placement.json|/properties/supported_id_types',
  // Delivery status is a superset of media-buy-status (includes failed, pending, etc.)
  'media-buy/get-media-buy-delivery-response.json|*',
  'media-buy/media-buy-delivery-webhook-result.json|*',
  // GOP type open/closed overlaps but is distinct concept
  'core/opportunity-context.json|*',
]);

function loadCanonicalEnums() {
  const enums = new Map();
  if (!fs.existsSync(ENUM_DIR)) return enums;
  for (const file of fs.readdirSync(ENUM_DIR)) {
    if (!file.endsWith('.json')) continue;
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(ENUM_DIR, file), 'utf8'));
      if (Array.isArray(doc.enum)) {
        enums.set(file, { values: new Set(doc.enum), sorted: [...doc.enum].sort() });
      }
    } catch { /* skip malformed */ }
  }
  return enums;
}

function walkSchemaEnums(obj, currentPath, results) {
  if (!obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    obj.forEach((item, i) => walkSchemaEnums(item, `${currentPath}/${i}`, results));
    return;
  }
  if (Array.isArray(obj.enum) && obj.enum.length >= 2 && obj.enum.every(v => typeof v === 'string')) {
    results.push({ path: currentPath, values: new Set(obj.enum), sorted: [...obj.enum].sort() });
  }
  for (const [key, val] of Object.entries(obj)) {
    if (key === '$ref') continue;
    walkSchemaEnums(val, `${currentPath}/${key}`, results);
  }
}

function isAllowed(relFile, jsonPath) {
  for (const entry of ALLOWED) {
    const [file, prefix] = entry.split('|');
    if (file !== relFile) continue;
    if (prefix === '*' || jsonPath.startsWith(prefix)) return true;
  }
  return false;
}

function findBestMatch(inline, canonicals) {
  let best = null;
  let bestScore = 0;
  for (const [enumFile, canonical] of canonicals) {
    const overlap = [...inline.values].filter(v => canonical.values.has(v));
    const score = overlap.length / Math.max(inline.values.size, canonical.values.size);
    if (score >= 0.7 && score > bestScore) {
      bestScore = score;
      best = { enumFile, canonical, score };
    }
  }
  return best;
}

function lint(schemaDir = SCHEMA_DIR) {
  const canonicals = loadCanonicalEnums();
  const driftViolations = [];
  const exactMatches = [];

  function processFile(absPath) {
    const relFile = path.relative(schemaDir, absPath);
    if (relFile.startsWith('enums/') || relFile.startsWith('enums\\')) return;

    let doc;
    try { doc = JSON.parse(fs.readFileSync(absPath, 'utf8')); } catch { return; }

    const inlineEnums = [];
    walkSchemaEnums(doc, '', inlineEnums);

    for (const inline of inlineEnums) {
      const match = findBestMatch(inline, canonicals);
      if (!match) continue;
      if (isAllowed(relFile, inline.path)) continue;

      const missing = [...match.canonical.values].filter(v => !inline.values.has(v));
      const extra = [...inline.values].filter(v => !match.canonical.values.has(v));

      if (missing.length === 0 && extra.length === 0) {
        exactMatches.push({
          file: relFile,
          path: inline.path,
          canonicalEnum: match.enumFile,
        });
      } else if (extra.length === 0 && missing.length > 0) {
        driftViolations.push({
          file: relFile,
          path: inline.path,
          canonicalEnum: match.enumFile,
          missing: missing.sort(),
        });
      }
    }
  }

  function walkDir(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walkDir(full);
      else if (entry.name.endsWith('.json') && entry.name !== 'index.json') processFile(full);
    }
  }

  walkDir(schemaDir);
  return { driftViolations, exactMatches };
}

if (require.main === module) {
  const verbose = process.argv.includes('--verbose');
  const { driftViolations, exactMatches } = lint();

  if (verbose && exactMatches.length > 0) {
    console.log(`ℹ ${exactMatches.length} inline enum(s) are exact matches — candidates for $ref migration:\n`);
    for (const m of exactMatches) {
      console.log(`  ${m.file}${m.path} → enums/${m.canonicalEnum}`);
    }
    console.log();
  }

  if (driftViolations.length === 0) {
    console.log(`✓ schema inline-enum drift lint: no drift violations${exactMatches.length ? ` (${exactMatches.length} exact-match $ref candidates)` : ''}`);
    process.exit(0);
  }

  console.error(`✗ schema inline-enum drift lint: ${driftViolations.length} drift violation(s)\n`);
  for (const v of driftViolations) {
    console.error(`  ${v.file}${v.path}`);
    console.error(`    canonical: enums/${v.canonicalEnum}`);
    console.error(`    missing from inline: ${v.missing.join(', ')}`);
    console.error();
  }
  process.exit(1);
}

module.exports = { lint, loadCanonicalEnums, ALLOWED };
