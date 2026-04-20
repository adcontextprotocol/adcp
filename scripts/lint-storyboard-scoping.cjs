#!/usr/bin/env node

/**
 * Storyboard scoping lint: every step that invokes a tenant-scoped task must
 * carry brand or account identity in its `sample_request`, so consecutive steps
 * land in the same per-tenant session on sellers that scope state by brand
 * (spec-required for multi-tenant isolation).
 *
 * Enforces the authoring invariant that adcontextprotocol/adcp#2236 exposed:
 * when step 1 writes to session `open:acmeoutdoor.example` and step 2 omits
 * brand, step 2 lands in `open:default` and can't find step 1's state.
 *
 * Tenant-scoped tasks are those whose handlers under
 * server/src/training-agent/ call getSession(sessionKeyFromArgs(...)),
 * excluding administrative/sync operations and test-control surfaces that are
 * legitimately called without brand context (see EXEMPT_FROM_LINT).
 *
 * Opt-out: set `scoping: global` at the step level for intentional cross-tenant
 * probes (capability discovery, auth probes, negative schema validation). The
 * lint will skip the step.
 *
 * Accepted identity shapes (any one satisfies the lint):
 *   - sample_request.brand.domain
 *   - sample_request.account.brand.domain
 *   - sample_request.account.account_id
 *   - sample_request.plans[*].brand.domain   (for sync_plans batch shape)
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

// Tasks that read/write per-tenant session state on the reference training
// agent. Every step whose `task` is in this set must carry brand/account in
// `sample_request` unless explicitly opted out via `scoping: global`.
//
// Source of truth: handlers under server/src/training-agent/ that call
// getSession(sessionKeyFromArgs(...)). Keep in sync.
const TENANT_SCOPED_TASKS = new Set([
  // Products & signals
  'get_products',
  'get_signals',
  'activate_signal',
  // Media buy lifecycle
  'create_media_buy',
  'get_media_buys',
  'get_media_buy_delivery',
  'update_media_buy',
  // Creatives
  'sync_creatives',
  'list_creatives',
  'get_creative_delivery',
  'build_creative',
  'preview_creative',
  // Governance (buyer/seller side)
  'sync_plans',
  'check_governance',
  'report_plan_outcome',
  'get_plan_audit_logs',
  // Property lists
  'create_property_list',
  'list_property_lists',
  'get_property_list',
  'update_property_list',
  'delete_property_list',
  'validate_property_delivery',
  // Collection lists
  'create_collection_list',
  'list_collection_lists',
  'get_collection_list',
  'update_collection_list',
  'delete_collection_list',
  // Content standards
  'create_content_standards',
  'list_content_standards',
  'get_content_standards',
  'update_content_standards',
  'calibrate_content',
  'validate_content_delivery',
  // Reporting & feedback
  'log_event',
  'provide_performance_feedback',
  'report_usage',
]);

// Tasks explicitly NOT checked by the lint. Administrative bulk-sync operations
// called by test harnesses (sync_accounts establishes identity itself; sync_*
// are typically batch imports from a governance/catalog control plane).
// `comply_test_controller` is the test-harness admin channel. Capability &
// auth probes are tenant-agnostic by design.
const EXEMPT_FROM_LINT = new Set([
  'get_adcp_capabilities',
  'list_creative_formats',
  'get_brand_identity',
  'get_rights',
  'acquire_rights',
  'update_rights',
  'creative_approval',
  'sync_accounts',
  'sync_governance',
  'sync_catalogs',
  'sync_event_sources',
  'comply_test_controller',
]);

function hasTenantIdentity(sampleRequest) {
  if (!sampleRequest || typeof sampleRequest !== 'object') return false;
  const { brand, account, plans } = sampleRequest;
  if (brand && typeof brand.domain === 'string' && brand.domain.length > 0) return true;
  if (account && typeof account === 'object') {
    if (typeof account.account_id === 'string' && account.account_id.length > 0) return true;
    if (account.brand && typeof account.brand.domain === 'string' && account.brand.domain.length > 0) return true;
  }
  if (Array.isArray(plans) && plans.some((p) => p?.brand?.domain)) return true;
  return false;
}

function checkStep(step, fileRel) {
  const task = step.task;
  if (!task || EXEMPT_FROM_LINT.has(task) || !TENANT_SCOPED_TASKS.has(task)) return null;
  if (step.scoping === 'global') return null;
  if (hasTenantIdentity(step.sample_request)) return null;
  return {
    file: fileRel,
    step: step.id || '(unnamed)',
    task,
  };
}

function lintFile(filePath, sourceRoot) {
  const rel = path.relative(sourceRoot, filePath);
  const doc = yaml.load(fs.readFileSync(filePath, 'utf-8'));
  if (!doc || typeof doc !== 'object') return [];
  const violations = [];
  for (const phase of doc.phases ?? []) {
    for (const step of phase.steps ?? []) {
      const v = checkStep(step, rel);
      if (v) violations.push(v);
    }
  }
  return violations;
}

function collectYamlFiles(root) {
  const out = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.yaml')) out.push(full);
    }
  }
  walk(root);
  return out.sort();
}

function lintScoping(sourceRoot) {
  const files = collectYamlFiles(sourceRoot);
  const violations = [];
  for (const f of files) {
    violations.push(...lintFile(f, sourceRoot));
  }
  return violations;
}

function formatReport(violations) {
  if (violations.length === 0) return '';
  const lines = [
    `❌ Storyboard scoping lint found ${violations.length} violation(s):`,
    '',
    ...violations.map(
      (v) => `   ${v.file}:${v.step} — task=${v.task} has no brand/account identity in sample_request`
    ),
    '',
    '   Every step that invokes a tenant-scoped task must carry one of:',
    '     - sample_request.brand.domain',
    '     - sample_request.account.brand.domain',
    '     - sample_request.account.account_id',
    '     - sample_request.plans[*].brand.domain  (sync_plans batch)',
    '',
    "   For intentional cross-tenant probes (capability discovery, auth, schema probes),",
    "   set `scoping: global` on the step.",
    '',
    '   Context: sellers scope session state by brand for multi-tenant isolation',
    '   (see server/src/training-agent/state.ts sessionKeyFromArgs). Omitting brand',
    '   makes a follow-up step land in a different session than the step that wrote state.',
    '',
  ];
  return lines.join('\n');
}

module.exports = {
  TENANT_SCOPED_TASKS,
  EXEMPT_FROM_LINT,
  hasTenantIdentity,
  checkStep,
  lintFile,
  lintScoping,
  formatReport,
};

if (require.main === module) {
  const sourceRoot = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(__dirname, '..', 'static', 'compliance', 'source');
  const violations = lintScoping(sourceRoot);
  if (violations.length > 0) {
    process.stderr.write(formatReport(violations));
    process.exit(1);
  }
  console.log(`✅ Storyboard scoping lint passed (${collectYamlFiles(sourceRoot).length} files)`);
}
