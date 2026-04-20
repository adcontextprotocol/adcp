#!/usr/bin/env node
/**
 * Fail the build if any storyboard step invokes a tenant-scoped task without
 * carrying brand/account identity in `sample_request`.
 *
 * Background: training-agent handlers derive their Postgres session key via
 * `sessionKeyFromArgs(args)` (server/src/training-agent/state.ts). If a step
 * omits `account.brand.domain` / `account.account_id` / `brand.domain`
 * (or `plans[0].brand.domain` for sync_plans), the handler lands in
 * `open:default` — so a `create_media_buy(brand=acme)` followed by
 * `get_media_buys()` silently writes to `open:acme` and reads from
 * `open:default`, producing MEDIA_BUY_NOT_FOUND. PR #2526 fixed a cluster of
 * that bug; this lint prevents recurrence.
 *
 * Drift guard: the handler-dispatch ↔ scoping parity test in
 * `tests/lint-storyboard-scoping.test.cjs` ensures every task registered in
 * `HANDLER_MAP` appears in exactly one of TENANT_SCOPED_TASKS /
 * EXEMPT_FROM_LINT below. Add a new tool? Also add it to one of the two sets.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const SOURCE_DIR = path.resolve(__dirname, '..', 'static', 'compliance', 'source');

/**
 * Tasks whose training-agent handler calls getSession(sessionKeyFromArgs(...))
 * and depends on top-level identity to land in the right tenant session.
 * Storyboard steps invoking these tasks MUST carry brand/account identity.
 */
const TENANT_SCOPED_TASKS = new Set([
  // Media buy lifecycle
  'create_media_buy',
  'get_media_buys',
  'update_media_buy',
  'get_media_buy_delivery',
  'creative_approval',
  // Creatives
  'sync_creatives',
  'list_creatives',
  'get_creative_delivery',
  'build_creative',
  'preview_creative',
  // Products & signals
  'get_products',
  'get_signals',
  'activate_signal',
  'provide_performance_feedback',
  // Governance plans
  'sync_plans',
  'check_governance',
  'report_plan_outcome',
  'get_plan_audit_logs',
  'log_event',
  // Brand rights (session-scoped grants only)
  'acquire_rights',
  // Property lists
  'create_property_list',
  'list_property_lists',
  'get_property_list',
  'update_property_list',
  'delete_property_list',
  'validate_property_delivery',
  // Collection lists
  'create_collection_list',
  'get_collection_list',
  'update_collection_list',
  'list_collection_lists',
  'delete_collection_list',
  // Content standards
  'create_content_standards',
  'list_content_standards',
  'get_content_standards',
  'update_content_standards',
  'calibrate_content',
  'validate_content_delivery',
  // Reporting
  'report_usage',
]);

/**
 * Tasks whose handlers either (a) don't scope by top-level identity (global
 * discovery / catalog reads) or (b) derive identity from the request payload
 * array, not the envelope. Storyboard steps invoking these tasks are
 * skipped by the lint.
 */
const EXEMPT_FROM_LINT = new Set([
  // Payload-array-keyed sync tasks
  'sync_accounts',
  'sync_governance',
  'sync_catalogs',
  'sync_event_sources',
  // Test-control primitive (sandbox-gated, operates on its own session)
  'comply_test_controller',
  // Global discovery
  'get_adcp_capabilities',
  'list_creative_formats',
  // Global brand/rights catalog reads
  'get_brand_identity',
  'get_rights',
  'update_rights',
]);

/** Walk a directory for *.yaml files. */
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

/** Pull out every step that declares a `task:` field from a parsed storyboard. */
function iterSteps(doc) {
  const out = [];
  const phases = Array.isArray(doc?.phases) ? doc.phases : [];
  for (const phase of phases) {
    const steps = Array.isArray(phase?.steps) ? phase.steps : [];
    for (const step of steps) {
      if (step && typeof step.task === 'string') {
        out.push({ phaseId: phase.id, step });
      }
    }
  }
  return out;
}

/**
 * Check whether sample_request carries any valid tenant identity shape.
 * Accepts: account.account_id, account.brand.domain, top-level brand.domain,
 * or (for sync_plans) plans[0].brand.domain.
 */
function hasTenantIdentity(task, req) {
  if (!req || typeof req !== 'object') return false;
  const account = req.account;
  if (account && typeof account === 'object') {
    if (typeof account.account_id === 'string' && account.account_id.length > 0) return true;
    if (account.brand?.domain && typeof account.brand.domain === 'string') return true;
  }
  if (req.brand?.domain && typeof req.brand.domain === 'string') return true;
  if (task === 'sync_plans' && Array.isArray(req.plans) && req.plans.length > 0) {
    const first = req.plans[0];
    if (first?.brand?.domain && typeof first.brand.domain === 'string') return true;
  }
  return false;
}

function lint() {
  const files = walkYaml(SOURCE_DIR);
  const violations = [];

  for (const file of files) {
    let doc;
    try {
      doc = yaml.load(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (!doc || typeof doc !== 'object') continue;

    for (const { phaseId, step } of iterSteps(doc)) {
      const task = step.task;
      // Template-expanded task refs ($test_kit.*) and non-AdCP assertion
      // pseudo-tasks are not tenant-scoped — skip.
      if (task.startsWith('$')) continue;
      if (!TENANT_SCOPED_TASKS.has(task)) continue;
      if (EXEMPT_FROM_LINT.has(task)) continue;
      if (step.scoping === 'global') continue;

      if (!hasTenantIdentity(task, step.sample_request)) {
        violations.push({
          file: path.relative(SOURCE_DIR, file),
          phaseId,
          stepId: step.id || '<unnamed>',
          task,
        });
      }
    }
  }

  return violations;
}

function main() {
  // Parity guard: identical strings in both sets would silently under-report.
  for (const task of TENANT_SCOPED_TASKS) {
    if (EXEMPT_FROM_LINT.has(task)) {
      console.error(`lint-storyboard-scoping: task "${task}" is in both TENANT_SCOPED_TASKS and EXEMPT_FROM_LINT`);
      process.exit(2);
    }
  }

  const violations = lint();
  if (violations.length === 0) {
    console.log(`✓ storyboard scoping lint: all session-scoped steps carry brand/account identity`);
    return;
  }

  console.error(`✗ storyboard scoping lint: ${violations.length} violation(s)\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.phaseId}/${v.stepId} (${v.task}) — sample_request missing brand/account`);
  }
  console.error('\nFix: add one of');
  console.error('  sample_request.account.account_id');
  console.error('  sample_request.account.brand.domain');
  console.error('  sample_request.brand.domain');
  console.error('  sample_request.plans[0].brand.domain (sync_plans only)');
  console.error('\nOr add `scoping: global` on the step if the probe is intentionally cross-tenant.');
  console.error('See docs/contributing/storyboard-authoring.md.');
  process.exit(1);
}

if (require.main === module) main();

module.exports = { TENANT_SCOPED_TASKS, EXEMPT_FROM_LINT, lint, hasTenantIdentity };
