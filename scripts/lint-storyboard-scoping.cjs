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
 * Tasks whose request schema has no required globally-unique scope-ID and
 * whose training-agent handler keys session state by envelope identity.
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
  'build_creative',       // schema has optional account + brand
  'preview_creative',     // schema has no required scope-ID
  // Products & signals
  'get_products',
  'get_signals',
  'activate_signal',
  'provide_performance_feedback',
  // Governance plans
  'sync_plans',
  'get_plan_audit_logs',  // schema required=[]; filters optional
  // Property lists
  'create_property_list',
  'list_property_lists',
  'get_property_list',
  'update_property_list',
  'delete_property_list',
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
  // Reporting
  'report_usage',
]);

/**
 * Tasks where envelope identity is not required by the spec. Three sub-buckets:
 *
 * (a) Payload-array-keyed sync tasks — identity lives in the array items, not
 *     the envelope. `sync_accounts`, `sync_governance`, `sync_catalogs`,
 *     `sync_event_sources`.
 *
 * (b) Global discovery / catalog reads. `get_adcp_capabilities`,
 *     `list_creative_formats`, `get_brand_identity`, `get_rights`,
 *     `update_rights`, `comply_test_controller`.
 *
 * (c) Identity implicit via a required globally-unique ID in the request
 *     schema. The seller looks up the ID → resolves the tenant → applies
 *     policy. Envelope `account` is redundant. Covers the Option C split
 *     from #2577:
 *       - `check_governance`       — required `plan_id`
 *       - `report_plan_outcome`    — required `plan_id`
 *       - `acquire_rights`         — required `rights_id` + `buyer` + `campaign`
 *       - `log_event`              — required `event_source_id`
 *       - `calibrate_content`      — required `standards_id`
 *       - `validate_content_delivery` — required `standards_id`
 *       - `validate_property_delivery` — required `list_id` (schema also
 *                                         has optional `account`)
 *
 *     Storyboard authors may still carry envelope identity on these tasks for
 *     training-agent session routing; the lint simply doesn't require it.
 *     The training-agent runtime aligning its routing to resolve by ID is
 *     tracked as follow-up work in #2577.
 */
const EXEMPT_FROM_LINT = new Set([
  // (a) Payload-array-keyed sync tasks
  'sync_accounts',
  'sync_governance',
  'sync_catalogs',
  'sync_event_sources',
  // (b) Test-control primitive (sandbox-gated, operates on its own session)
  'comply_test_controller',
  // (b) Global discovery
  'get_adcp_capabilities',
  'list_creative_formats',
  // (b) Global brand/rights catalog reads
  'get_brand_identity',
  'get_rights',
  'update_rights',
  // (c) Identity implicit via required globally-unique ID
  'check_governance',
  'report_plan_outcome',
  'acquire_rights',
  'log_event',
  'calibrate_content',
  'validate_content_delivery',
  'validate_property_delivery',
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
 *
 * Canonical: account { brand, operator } — required by AccountRef whenever
 * the account natural-key form is used. Also accepts account_id form.
 *
 * Tolerated fallbacks (for tasks whose request schema has no `account` field
 * at all — `check_governance`, `acquire_rights`, `preview_creative`, etc. —
 * or where storyboards legitimately keep identity inside the payload array):
 *   - top-level brand.domain (training-agent routes by it; no-op for schemas
 *     that don't define the field)
 *   - plans[0].brand.domain for sync_plans (the sync_plans schema defines
 *     plan-level `brand` and forbids `account` inside plan items).
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
  console.error('\nFix: add `account { brand, operator }` to sample_request, e.g.');
  console.error('  sample_request:');
  console.error('    account:');
  console.error('      brand:');
  console.error('        domain: "acmeoutdoor.example"');
  console.error('      operator: "pinnacle-agency.example"');
  console.error('\nAlternate identity shapes (accepted for back-compat):');
  console.error('  sample_request.account.account_id                     # explicit-account form');
  console.error('  sample_request.brand.domain                           # training-agent routing only — not a spec-canonical identity');
  console.error('  sample_request.plans[0].brand.domain                  # sync_plans — canonical per sync-plans-request schema');
  console.error('\nOr add `scoping: global` on the step if the probe is intentionally cross-tenant.');
  console.error('See docs/contributing/storyboard-authoring.md.');
  process.exit(1);
}

if (require.main === module) main();

module.exports = { TENANT_SCOPED_TASKS, EXEMPT_FROM_LINT, lint, hasTenantIdentity };
