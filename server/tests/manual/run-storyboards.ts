/**
 * Run all applicable storyboards against the training agent.
 *
 *   TRAINING_AGENT_PORT=4444 npx tsx server/tests/manual/run-storyboards.ts
 *   TRAINING_AGENT_PORT=4444 npx tsx server/tests/manual/run-storyboards.ts --filter signal-marketplace
 *   TRAINING_AGENT_PORT=4444 npx tsx server/tests/manual/run-storyboards.ts --filter governance --verbose
 *
 * Expects a training agent already running at `http://127.0.0.1:${PORT}/api/training-agent/mcp`.
 * Start one in a separate terminal with:
 *
 *   PUBLIC_TEST_AGENT_TOKEN=test-token PORT=4444 npm run start
 */

import express from 'express';
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import {
  listAllComplianceStoryboards,
  loadComplianceIndex,
  runStoryboard,
  getComplianceCacheDir,
} from '@adcp/sdk/testing';
import type { StoryboardResult, Storyboard, StoryboardRunOptions } from '@adcp/sdk/testing';
import {
  StaticJwksResolver,
  InMemoryReplayStore,
  InMemoryRevocationStore,
} from '@adcp/sdk/signing';
import type { AdcpJsonWebKey } from '@adcp/sdk/signing';

// Set auth env BEFORE loading the training-agent router. The router captures
// PUBLIC_TEST_AGENT_TOKEN / TRAINING_AGENT_TOKEN into its authenticator at
// module load, so this assignment must happen before the dynamic imports
// below.
const AUTH_TOKEN = process.env.PUBLIC_TEST_AGENT_TOKEN ?? 'storyboard-runner-test-token';
process.env.PUBLIC_TEST_AGENT_TOKEN = AUTH_TOKEN;
// SDK refuses the in-memory task registry outside dev/test. The runner is a
// local dev convenience; opt in explicitly so the SDK accepts the default.
if (!process.env.NODE_ENV) process.env.NODE_ENV = 'test';
// Silence pino logger noise so the progress table stays readable. Set
// LOG_STORYBOARDS=1 to get full log output for diagnosis.
if (!process.env.LOG_STORYBOARDS) process.env.LOG_LEVEL = 'silent';

const { createTrainingAgentRouter } = await import('../../src/training-agent/index.js');
const { stopSessionCleanup, clearSessions } = await import('../../src/training-agent/state.js');
const { clearAccountStore } = await import('../../src/training-agent/account-handlers.js');
const { clearSeededCreativeFormats, clearForcedTaskCompletions } = await import(
  '../../src/training-agent/comply-test-controller.js'
);
const { clearCatalogEventStores } = await import('../../src/training-agent/catalog-event-handlers.js');
const { getPublicJwks } = await import('../../src/training-agent/webhooks.js');

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const filter = args.includes('--filter') ? args[args.indexOf('--filter') + 1] : undefined;
const complianceOptions = process.env.ADCP_COMPLIANCE_DIR
  ? {
      complianceDir: process.env.ADCP_COMPLIANCE_DIR,
      ...(process.env.ADCP_SCHEMA_ROOT && { schemaRoot: process.env.ADCP_SCHEMA_ROOT }),
    }
  : undefined;
const releasedComplianceVersion = process.env.ADCP_COMPLIANCE_DIR
  ? loadComplianceIndex(complianceOptions).adcp_version
  : undefined;
const isThreeZeroCompatRun = releasedComplianceVersion !== undefined && /^3\.0\.\d+$/.test(releasedComplianceVersion);

interface Summary {
  id: string;
  title: string;
  passed: number;
  failed: number;
  skipped: number;
  not_applicable: number;
  error?: string;
  failures: Array<{ step: string; error: string }>;
}

async function startLocalAgent(): Promise<{ url: string; baseUrl: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json({
    limit: '5mb',
    verify: (req, _res, buf) => {
      (req as unknown as { rawBody?: string }).rawBody = buf.toString('utf8');
    },
  }));
  // The training agent is API-key-only — no OAuth issuer. Per
  // static/compliance/source/universal/security.yaml (lines 37–47), such
  // agents MUST NOT serve RFC 9728 protected-resource metadata; doing so
  // advertises an issuer the agent cannot back with an RFC 8414 auth-server
  // metadata document and triggers the exact failure security_baseline was
  // written to catch (presenceDetected flips and the `optional` OAuth phase
  // becomes a hard fail). api_key_path carries `auth_mechanism_verified`
  // on its own.
  app.use('/api/training-agent', createTrainingAgentRouter({
    ...(isThreeZeroCompatRun && { storyboardCompat: { version: '3.0' as const } }),
  }));
  return await new Promise((resolve, reject) => {
    const srv = http.createServer(app);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('listen returned no address'));
        return;
      }
      // TENANT_PATH selects the per-specialism tenant endpoint
      // (/api/training-agent/<tenant>/mcp). Required — there's no
      // single-URL fallback after the v5 monolith was retired.
      // Common values: signals, sales, governance, creative,
      // creative-builder, brand.
      const tenantPath = process.env.TENANT_PATH;
      if (!tenantPath) {
        throw new Error('TENANT_PATH env required (one of: signals, sales, governance, creative, creative-builder, brand)');
      }
      const localAgentBaseUrl = `http://127.0.0.1:${addr.port}/api/training-agent`;
      resolve({
        baseUrl: localAgentBaseUrl,
        url: `${localAgentBaseUrl}/${tenantPath}/mcp`,
        close: () => new Promise<void>(res => {
          stopSessionCleanup();
          srv.close(() => res());
        }),
      });
    });
  });
}

/**
 * Storyboards we know fail against the training agent for reasons that aren't
 * a regression — track each entry with the upstream/internal issue that gates
 * removal so the skip list doesn't silently grow.
 */
const KNOWN_FAILING_STORYBOARDS: ReadonlyMap<string, string> = new Map([
]);

/**
 * Per-step skip list. Entries are `{storyboard_id}/{step_id}` keys mapped to a
 * reason. The runner mutates the matched step result to `skipped: true` after
 * `runStoryboard` returns, so the rest of the storyboard's steps still pass.
 *
 * Use this when one step in an otherwise-green storyboard is blocked by an
 * upstream issue and skipping the whole storyboard would lose passing
 * coverage. Track every entry with a linked issue.
 */
const KNOWN_FAILING_STEPS: ReadonlyMap<string, string> = new Map([]);

const THREE_ZERO_COMPAT_KNOWN_FAILING_STEPS: ReadonlyMap<string, string> = new Map([
  [
    'pagination_integrity/first_page',
    '3.0.13 compatibility run under @adcp/sdk 8.1 beta.13: legacy pagination fixture expects a cursor on the first page for tenants whose compat handler now returns a terminal page. Current-source pagination coverage remains graded by the current matrix.',
  ],
  [
    'media_buy_seller/pending_creatives_to_start/create_buy_no_creatives',
    '3.0.13 compatibility run under @adcp/sdk 8.1 beta.13: legacy storyboard expects pending_creatives for no-creative creation; current-source lifecycle behavior is graded by the current matrix.',
  ],
  [
    'governance_delivery_monitor/check_governance_approved',
    '3.0.13 compatibility run under @adcp/sdk 8.1 beta.13: frozen governance response schema rejects the current training-agent governance envelope. Current-source governance coverage remains graded by the current matrix.',
  ],
  [
    'governance_spend_authority/check_governance_conditions',
    '3.0.13 compatibility run under @adcp/sdk 8.1 beta.13: frozen governance response schema rejects the current training-agent governance envelope. Current-source governance coverage remains graded by the current matrix.',
  ],
  [
    'governance_spend_authority/denied/check_governance_denied',
    '3.0.13 compatibility run under @adcp/sdk 8.1 beta.13: frozen governance response schema rejects the current training-agent governance envelope. Current-source governance coverage remains graded by the current matrix.',
  ],
  [
    'brand_rights/acquire_rights',
    '3.0.13 compatibility run under @adcp/sdk 8.1 beta.13: frozen brand-rights response schema rejects the current training-agent rights envelope. Current-source brand coverage remains graded by the current matrix.',
  ],
]);

const THREE_ZERO_SIGNED_POSITIVE_VECTOR_IDS = [
  '001-basic-post',
  '002-post-with-content-digest',
  '003-es256-post',
  '004-multiple-signature-labels',
  '005-default-port-stripped',
  '006-dot-segment-path',
  '007-query-byte-preserved',
  '008-percent-encoded-path',
  '009-percent-encoded-unreserved-decoded',
  '010-percent-encoded-slash-preserved',
  '011-ipv6-authority',
  '012-ipv6-authority-default-port-stripped',
];

const THREE_ZERO_SIGNED_NEGATIVE_VECTOR_IDS = [
  '001-no-signature-header',
  '002-wrong-tag',
  '003-expired-signature',
  '004-window-too-long',
  '005-alg-not-allowed',
  '006-missing-covered-component',
  '007-missing-content-digest',
  '008-unknown-keyid',
  '009-key-ops-missing-verify',
  '010-content-digest-mismatch',
  '011-malformed-header',
  '012-missing-expires-param',
  '013-expires-le-created',
  '014-missing-nonce-param',
  '015-signature-invalid',
  '016-replayed-nonce',
  '017-key-revoked',
  '018-digest-covered-when-forbidden',
  '019-signature-without-signature-input',
  '020-rate-abuse',
  '021-duplicate-signature-input-label',
  '022-multi-valued-content-type',
  '023-multi-valued-content-digest',
  '024-unquoted-string-param',
  '025-jwk-alg-crv-mismatch',
  '026-non-ascii-host',
  '027-webhook-registration-authentication-unsigned',
];

function skipThreeZeroSignedVectorsExcept(allowed: string[]): string[] {
  const allowedSet = new Set(allowed);
  return [...THREE_ZERO_SIGNED_POSITIVE_VECTOR_IDS, ...THREE_ZERO_SIGNED_NEGATIVE_VECTOR_IDS]
    .filter(id => !allowedSet.has(id));
}

function normalizeThreeZeroCompatFlightDates(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) normalizeThreeZeroCompatFlightDates(item);
    return;
  }

  const obj = value as Record<string, unknown>;
  if (
    obj.start_time === '2026-05-01T00:00:00Z'
    && obj.end_time === '2026-05-31T23:59:59Z'
  ) {
    obj.start_time = 'asap';
    obj.end_time = '2099-05-31T23:59:59Z';
  }
  for (const child of Object.values(obj)) normalizeThreeZeroCompatFlightDates(child);
}

function patchThreeZeroStoryboard(sb: Storyboard): Storyboard {
  let patched = sb;
  if (sb.id === 'creative/creative_lifecycle_webhooks') {
    patched = structuredClone(sb) as Storyboard;
    for (const phase of patched.phases ?? []) {
      for (const step of phase.steps ?? []) {
        if (step.id !== 'expect_status_changed_webhook' && step.id !== 'expect_purged_webhook') continue;
        delete (step as { triggered_by?: unknown }).triggered_by;
        const notificationType = step.id === 'expect_purged_webhook' ? 'creative.purged' : 'creative.status_changed';
        step.filter = {
          body: {
            notification_type: notificationType,
            creative_id: 'acme_lifecycle_banner_001',
            subscriber_id: 'buyer-primary',
          },
        };
      }
    }
  }

  if (!isThreeZeroCompatRun) return patched;
  patched = structuredClone(patched) as Storyboard;
  normalizeThreeZeroCompatFlightDates(patched);
  if (sb.id === 'media_buy_seller/pending_creatives_to_start') {
    for (const phase of patched.phases ?? []) {
      for (const step of phase.steps ?? []) {
        for (const validation of step.validations ?? []) {
          if (
            validation.check === 'field_value'
            && validation.path === 'status'
            && (
              validation.value === 'pending_creatives'
              || (Array.isArray(validation.allowed_values) && validation.allowed_values.includes('pending_start'))
            )
          ) {
            validation.path = 'media_buy_status';
          }
        }
      }
    }
    return patched;
  }

  if (sb.id === 'brand_rights') {
    for (const phase of patched.phases ?? []) {
      for (const step of phase.steps ?? []) {
        if (step.id === 'acquire_rights') {
          step.validations = (step.validations ?? []).filter(validation => validation.check !== 'response_schema');
        }
      }
    }
    return patched;
  }

  if (sb.id === 'idempotency') {
    for (const phase of patched.phases ?? []) {
      for (const step of phase.steps ?? []) {
        if (step.id !== 'create_media_buy_initial' && step.id !== 'create_media_buy_replay') continue;
        const sample = step.sample_request as Record<string, unknown> | undefined;
        if (sample) {
          sample.start_time = '2099-06-01T00:00:00Z';
          sample.end_time = '2099-06-30T23:59:59Z';
        }
        const pushConfig = sample?.push_notification_config as Record<string, unknown> | undefined;
        if (!pushConfig || pushConfig.operation_id !== undefined) continue;
        pushConfig.operation_id = 'op_idempotency_replay_initial';
      }
    }
    return patched;
  }

  if (sb.id !== 'media_buy_seller/proposal_finalize') return patched;
  for (const phase of patched.phases ?? []) {
    for (const step of phase.steps ?? []) {
      if (step.id === 'get_products_finalize') {
        step.context_outputs = [
          ...(step.context_outputs ?? []),
          { path: 'proposals[0].insertion_order.io_id', key: 'io_id' },
        ];
      }
      if (step.id !== 'create_media_buy') continue;
      step.sample_request = {
        ...(step.sample_request ?? {}),
        io_acceptance: {
          io_id: '$context.io_id',
          accepted_at: '2026-03-15T14:30:00Z',
          signatory: 'ops@acmeoutdoor.example',
        },
      };
    }
  }
  return patched;
}

function isApplicable(sb: Storyboard): boolean {
  if (filter && !sb.id.includes(filter) && !(sb.category ?? '').includes(filter)) return false;
  if (KNOWN_FAILING_STORYBOARDS.has(sb.id)) return false;
  return true;
}

/**
 * Resolve a storyboard's brand from its declared test_kit.
 *
 * Without this, `applyBrandInvariant` in the SDK's runner is a no-op: steps
 * that omit `brand`/`account` land in `open:default` while branded steps
 * (e.g. create_media_buy declaring `brand.domain`) land in
 * `open:<domain>`. The session key divergence surfaces as
 * `MEDIA_BUY_NOT_FOUND` on every subsequent read. Threading the test kit's
 * brand into options.brand forces every outgoing request onto the same
 * session key.
 */
interface LoadedTestKit {
  brand?: { house?: { domain?: string }; brand_id?: string };
  auth?: {
    api_key?: string;
    basic?: { username?: string; password?: string; credentials?: string };
    probe_task?: string;
  };
}

function loadTestKit(sb: Storyboard): LoadedTestKit | undefined {
  const kitRef = sb.prerequisites?.test_kit;
  if (!kitRef) return undefined;
  const path = join(getComplianceCacheDir(complianceOptions), kitRef);
  if (!existsSync(path)) return undefined;
  return YAML.parse(readFileSync(path, 'utf-8')) as LoadedTestKit;
}

function brandFromKit(kit: LoadedTestKit | undefined): StoryboardRunOptions['brand'] | undefined {
  const domain = kit?.brand?.house?.domain;
  return domain ? { domain } : undefined;
}

/**
 * Per-tenant probe-task override for security_baseline's auth probes.
 *
 * Most shared test-kits declare `auth.probe_task: list_creatives`, but cached
 * prerelease kits can lag the allowlist. Sales/creative explicitly pin the
 * allowlisted protected read they serve. /signals and /governance serve
 * different SDK-allowlisted protected reads. /creative-builder and /brand
 * have no 3.0-compatible allowlisted protected read task, so the 3.0 compat
 * path marks only the final mechanism assertion skipped below.
 */
const PROBE_TASK_BY_TENANT: Record<string, string> = {
  sales: 'list_creatives',
  creative: 'list_creatives',
  signals: 'get_signals',
  governance: 'list_content_standards',
};

/**
 * Thread the test-kit's `auth.api_key` / `auth.probe_task` through to the
 * runner so `api_key_path` in security_baseline (and any future kit-gated
 * phase) executes instead of being skipped by `skip_if: "!test_kit.auth.api_key"`.
 * `probe_task` is required by the runner whenever `auth` is declared — surface
 * missing values as a hard failure rather than silently defaulting.
 *
 * When `TENANT_PATH` matches a known tenant, override `probe_task` with a
 * tool that tenant actually serves (see `PROBE_TASK_BY_TENANT`).
 */
function testKitOptionsFromKit(kit: LoadedTestKit | undefined): StoryboardRunOptions['test_kit'] | undefined {
  const auth = kit?.auth;
  if (!auth?.api_key && !auth?.basic && !auth?.probe_task) return undefined;
  if (!auth.probe_task) {
    throw new Error('test kit declares auth credentials without auth.probe_task — required by runner');
  }
  const tenantPath = process.env.TENANT_PATH;
  const probeTask = (tenantPath && PROBE_TASK_BY_TENANT[tenantPath]) ?? auth.probe_task;
  return {
    auth: {
      ...(auth.api_key !== undefined && { api_key: auth.api_key }),
      ...(auth.basic !== undefined && { basic: auth.basic }),
      probe_task: probeTask,
    },
  };
}

function authTokenForStoryboard(storyboard: Storyboard, kit: LoadedTestKit | undefined): string {
  if (storyboard.id === 'billing_gate_dispatch' && kit?.auth?.api_key) return kit.auth.api_key;
  return AUTH_TOKEN;
}

/**
 * Mutate a `StoryboardResult` in place so any step listed in
 * `KNOWN_FAILING_STEPS` is recorded as `skipped` rather than failed. Lets one
 * blocked step in an otherwise-green storyboard reach the success column
 * without losing the surrounding passing steps.
 */
function applyStepSkipList(storyboardId: string, result: StoryboardResult): void {
  for (const phase of result.phases ?? []) {
    for (const step of (phase.steps ?? []) as Array<Record<string, unknown>>) {
      const stepId = (step.id ?? step.step_id) as string | undefined;
      if (!stepId) continue;
      let reason = KNOWN_FAILING_STEPS.get(`${storyboardId}/${stepId}`);
      if (!reason && isThreeZeroCompatRun) {
        reason = THREE_ZERO_COMPAT_KNOWN_FAILING_STEPS.get(`${storyboardId}/${stepId}`);
      }
      if (
        !reason
        && isThreeZeroCompatRun
        && storyboardId === 'security_baseline'
        && stepId === 'assert_mechanism'
        && ['creative-builder', 'brand'].includes(process.env.TENANT_PATH ?? '')
      ) {
        reason = '3.0.x security_baseline requires an allowlisted protected read probe; this tenant has no 3.0-compatible allowlisted read task. Current 3.1 source handles this without failing the tenant.';
      }
      if (!reason) continue;
      step.passed = true;
      step.skipped = true;
      step.skip_reason = 'known_failing';
      step.skip = { reason: 'known_failing', detail: reason };
      step.validations = [];
      delete step.error;
    }
  }
}

function stepStatus(s: { passed?: boolean; skipped?: boolean; not_applicable?: boolean; skip_reason?: string; skip?: { detail?: string }; validations?: Array<{ passed: boolean }>; error?: string; response?: { accepted?: unknown; errors?: Array<{ code?: unknown }> } }): 'passed' | 'failed' | 'skipped' | 'not_applicable' {
  if (verbose && s.skipped) {
    // eslint-disable-next-line no-console
    console.log(`    [skip] ${(s as { id?: string }).id ?? '?'} — ${s.skip_reason ?? '(no reason)'} :: ${s.skip?.detail ?? '(no detail)'}`);
  }
  if (s.not_applicable) return 'not_applicable';
  if (s.skipped) return 'skipped';
  const validations = s.validations ?? [];
  if (
    (s.passed === false || s.error)
    && s.response?.accepted === 0
    && s.response.errors?.some(error => error.code === 'BILLING_OUT_OF_BAND')
    && validations.length > 0
    && validations.every(v => v.passed)
  ) {
    return 'passed';
  }
  if (s.passed === false || s.error) return 'failed';
  if (validations.some(v => !v.passed)) return 'failed';
  return 'passed';
}

function summarize(sb: Storyboard, result: StoryboardResult | { error: string }): Summary {
  const base: Summary = { id: sb.id, title: sb.title, passed: 0, failed: 0, skipped: 0, not_applicable: 0, failures: [] };
  if ('error' in result) {
    base.error = result.error;
    return base;
  }
  for (const phase of result.phases ?? []) {
    for (const step of phase.steps ?? []) {
      const status = stepStatus(step as Parameters<typeof stepStatus>[0]);
      base[status] += 1;
      if (status === 'failed') {
        // Webhook-assertion pseudo-steps (expect_webhook*) return their id on
        // `step_id`; every other step result uses `id`. Carry both so the
        // failure summary never collapses to "(unknown step)".
        //
        // Surface both the validator's `description` (the narrative) AND its
        // `error` / `actual` fields per failure — the former alone collapsed
        // distinct codes into the same summary line (e.g. "Expected one of
        // [false], got undefined" vs "Expected one of [false], got true"
        // both rendered identically). Then prepend the step-level `error` so
        // probe-class failures that surface as "Probe validations failed"
        // still show which specific checks tripped (#2841).
        const s = step as {
          id?: string;
          step_id?: string;
          error?: string;
          validations?: Array<{ passed: boolean; description?: string; error?: string; actual?: unknown }>;
        };
        const validationFails = (s.validations ?? [])
          .filter(v => !v.passed)
          .map(v => {
            const desc = v.description ?? '(validation failed)';
            const detail = v.error ?? (v.actual ? JSON.stringify(v.actual) : undefined);
            return detail ? `${desc} — ${detail}` : desc;
          })
          .join('; ');
        const errorDetail = validationFails
          ? (s.error ? `${s.error} — ${validationFails}` : validationFails)
          : (s.error ?? '(failed without message)');
        base.failures.push({
          step: s.id ?? s.step_id ?? '(unknown step)',
          error: errorDetail,
        });
      }
    }
  }
  return base;
}

async function main() {
  const { url: agentUrl, baseUrl: localAgentBaseUrl, close } = await startLocalAgent();
  // eslint-disable-next-line no-console
  console.log(`\nTraining agent running at ${agentUrl}`);
  // eslint-disable-next-line no-console
  console.log(`Filter: ${filter ?? '(all storyboards)'}\n`);

  const everything = listAllComplianceStoryboards(complianceOptions);
  const all = everything.filter(isApplicable);
  const skippedKnownFailing = everything
    .filter(sb => KNOWN_FAILING_STORYBOARDS.has(sb.id))
    .filter(sb => !filter || sb.id.includes(filter) || (sb.category ?? '').includes(filter));
  if (skippedKnownFailing.length > 0) {
    // eslint-disable-next-line no-console
    console.log('Skipping storyboards on the known-failing list:');
    for (const sb of skippedKnownFailing) {
      // eslint-disable-next-line no-console
      console.log(`  - ${sb.id}: ${KNOWN_FAILING_STORYBOARDS.get(sb.id)}`);
    }
    // eslint-disable-next-line no-console
    console.log('');
  }
  if (KNOWN_FAILING_STEPS.size > 0) {
    // eslint-disable-next-line no-console
    console.log('Skipping individual steps on the known-failing list:');
    for (const [key, reason] of KNOWN_FAILING_STEPS) {
      // eslint-disable-next-line no-console
      console.log(`  - ${key}: ${reason}`);
    }
    // eslint-disable-next-line no-console
    console.log('');
  }
  const results: Summary[] = [];

  const jwksResolver = new StaticJwksResolver(getPublicJwks().keys as AdcpJsonWebKey[]);

  for (const sb of all) {
    const storyboard = patchThreeZeroStoryboard(sb);
    // Isolate storyboards from each other: a previous storyboard may have
    // seeded governance plans, media buys, creatives, etc. into a session
    // keyed by the same brand domain. Without this reset the next
    // storyboard inherits that state and e.g. a $10K governance plan
    // from `media_buy_seller/governance_denied` silently intercepts a
    // $50K buy in `sales_guaranteed`.
    await clearSessions();
    // clearSessions() only resets the framework's per-session map. The training
    // agent also keeps several module-level pools that are not session-scoped
    // (account catalogue, comply-controller seed/forced-completion pools,
    // catalog/event-source stores). Without these resets, e.g. a creative
    // format seeded by sales_catalog_driven leaks into creative_template's
    // discover_formats step and shadows the static catalogue, missing
    // `formats[0].assets`.
    clearAccountStore();
    clearSeededCreativeFormats();
    clearForcedTaskCompletions();
    clearCatalogEventStores();
    const kit = loadTestKit(storyboard);
    const brand = brandFromKit(kit);
    const testKit = testKitOptionsFromKit(kit);
    const authToken = authTokenForStoryboard(storyboard, kit);
    const previousTrainingAgentUrl = process.env.TRAINING_AGENT_URL;
    if (storyboard.id === 'webhook_emission') {
      process.env.TRAINING_AGENT_URL = localAgentBaseUrl;
    }

    if (storyboard.id === 'signed_requests') {
      // Run the signed_requests storyboard once per strict route variant.
      // Each route advertises a different covers_content_digest profile so
      // the grader runs vectors that were previously skipped as
      // capability-incompatible against the matching route.
      //
      // `/mcp-strict` (either): baseline run — skip 007/018 which target
      //   specific digest profiles, skip 025 (SDK-internal JWK test).
      // `/mcp-strict-required` (required): 007 fires here; skip 018/025.
      // `/mcp-strict-forbidden` (forbidden): 018 fires here; skip 007/025.
      const strictVariants: Array<{ routeSuffix: string; skipVectors: string[] }> = isThreeZeroCompatRun
        ? [
            {
              routeSuffix: '/mcp-strict',
              skipVectors: ['007-missing-content-digest', '018-digest-covered-when-forbidden', '025-jwk-alg-crv-mismatch'],
            },
            {
              routeSuffix: '/mcp-strict-required',
              // The frozen 3.0.x vector set predates per-route digest-profile
              // fixtures. Keep required-profile coverage by running only the
              // digest-bearing positive and digest-policy negatives here.
              skipVectors: skipThreeZeroSignedVectorsExcept([
                '002-post-with-content-digest',
                '007-missing-content-digest',
                '010-content-digest-mismatch',
              ]),
            },
            {
              routeSuffix: '/mcp-strict-forbidden',
              skipVectors: [
                '002-post-with-content-digest',
                '007-missing-content-digest',
                '010-content-digest-mismatch',
                '025-jwk-alg-crv-mismatch',
              ],
            },
          ]
        : [
            {
              routeSuffix: '/mcp-strict',
              skipVectors: ['007-missing-content-digest', '018-digest-covered-when-forbidden', '025-jwk-alg-crv-mismatch'],
            },
            {
              routeSuffix: '/mcp-strict-required',
              skipVectors: skipThreeZeroSignedVectorsExcept([
                '002-post-with-content-digest',
                '007-missing-content-digest',
                '010-content-digest-mismatch',
              ]),
            },
            {
              routeSuffix: '/mcp-strict-forbidden',
              skipVectors: [
                '002-post-with-content-digest',
                '007-missing-content-digest',
                '010-content-digest-mismatch',
                '025-jwk-alg-crv-mismatch',
              ],
            },
          ];
      for (const variant of strictVariants) {
        const variantLabel = `${storyboard.id}${variant.routeSuffix.replace('/mcp', '')}`;
        try {
          const targetUrl = agentUrl.replace(/\/mcp$/, variant.routeSuffix);
          const result = await runStoryboard(targetUrl, storyboard, {
            ...(releasedComplianceVersion && { adcpVersion: releasedComplianceVersion }),
            auth: { type: 'bearer', token: authToken },
            allow_http: true,
            contracts: ['webhook_receiver_runner'],
            webhook_receiver: { mode: 'loopback_mock' },
            webhook_signing: {
              jwks: jwksResolver,
              replayStore: new InMemoryReplayStore(),
              revocationStore: new InMemoryRevocationStore(),
            },
            request_signing: {
              transport: 'mcp',
              // Vector 020 (rate-abuse) sends cap+1 requests per run and is
              // opt-in anyway. Vector 025 grades SDK internals (inline
              // malformed JWK), not our agent — skipped on all three routes.
              // Vectors 007/018 are digest-profile-specific and run only on
              // the route whose advertised profile matches (see comments above).
              skipVectors: variant.skipVectors,
              skipRateAbuse: true,
            },
            ...(brand && { brand }),
            ...(testKit && { test_kit: testKit }),
          });
          applyStepSkipList(storyboard.id, result);
          const summary = { ...summarize(storyboard, result), id: variantLabel };
          results.push(summary);
          const pill = summary.failed === 0
            ? `✓ ${summary.passed}P / ${summary.skipped}S / ${summary.not_applicable}N/A`
            : `✗ ${summary.passed}P / ${summary.failed}F / ${summary.skipped}S / ${summary.not_applicable}N/A`;
          // eslint-disable-next-line no-console
          console.log(`  ${variantLabel.padEnd(40)} ${pill}`);
        } catch (err) {
          const summary = { ...summarize(storyboard, { error: err instanceof Error ? err.message : String(err) }), id: variantLabel };
          results.push(summary);
          // eslint-disable-next-line no-console
          console.log(`  ${variantLabel.padEnd(40)} ⚠ ${summary.error}`);
        }
      }
    } else {
      try {
        // The default `/mcp` route is the public bearer-authenticated sandbox
        // with no request-signing advertisement or enforcement. Every storyboard
        // other than `signed_requests` stays on `/mcp` so bearer-authed unsigned
        // calls keep working.
        const result = await runStoryboard(agentUrl, storyboard, {
          ...(releasedComplianceVersion && { adcpVersion: releasedComplianceVersion }),
          auth: { type: 'bearer', token: authToken },
          allow_http: true,
          contracts: ['webhook_receiver_runner'],
          webhook_receiver: { mode: 'loopback_mock' },
          webhook_signing: {
            jwks: jwksResolver,
            replayStore: new InMemoryReplayStore(),
            revocationStore: new InMemoryRevocationStore(),
          },
          ...(brand && { brand }),
          ...(testKit && { test_kit: testKit }),
        });
        applyStepSkipList(storyboard.id, result);
        const summary = summarize(storyboard, result);
        results.push(summary);
        const pill = summary.failed === 0
          ? `✓ ${summary.passed}P / ${summary.skipped}S / ${summary.not_applicable}N/A`
          : `✗ ${summary.passed}P / ${summary.failed}F / ${summary.skipped}S / ${summary.not_applicable}N/A`;
        // eslint-disable-next-line no-console
        console.log(`  ${storyboard.id.padEnd(40)} ${pill}`);
      } catch (err) {
        const summary = summarize(storyboard, { error: err instanceof Error ? err.message : String(err) });
        results.push(summary);
        // eslint-disable-next-line no-console
        console.log(`  ${storyboard.id.padEnd(40)} ⚠ ${summary.error}`);
      }
    }
    if (storyboard.id === 'webhook_emission') {
      if (previousTrainingAgentUrl === undefined) {
        delete process.env.TRAINING_AGENT_URL;
      } else {
        process.env.TRAINING_AGENT_URL = previousTrainingAgentUrl;
      }
    }
  }

  // eslint-disable-next-line no-console
  console.log('\n--- Failures ---');
  const failing = results.filter(r => r.failed > 0 || r.error);
  if (failing.length === 0) {
    // eslint-disable-next-line no-console
    console.log('  (none — clean run)');
  } else {
    for (const r of failing) {
      // eslint-disable-next-line no-console
      console.log(`\n  ${r.id}: ${r.title}`);
      if (r.error) console.log(`    ! ${r.error}`);
      for (const f of r.failures.slice(0, verbose ? undefined : 5)) {
        // eslint-disable-next-line no-console
        console.log(`    × ${f.step}: ${f.error.slice(0, 160)}`);
      }
      if (!verbose && r.failures.length > 5) {
        // eslint-disable-next-line no-console
        console.log(`    … +${r.failures.length - 5} more (run with --verbose)`);
      }
    }
  }

  const totals = results.reduce((acc, r) => ({
    passed: acc.passed + r.passed,
    failed: acc.failed + r.failed,
    skipped: acc.skipped + r.skipped,
    not_applicable: acc.not_applicable + r.not_applicable,
  }), { passed: 0, failed: 0, skipped: 0, not_applicable: 0 });

  // eslint-disable-next-line no-console
  console.log(`\n--- Totals ---`);
  // eslint-disable-next-line no-console
  console.log(`  storyboards: ${results.length - failing.length}/${results.length} clean`);
  // eslint-disable-next-line no-console
  console.log(`  steps: ${totals.passed} passed | ${totals.failed} failed | ${totals.skipped} skipped | ${totals.not_applicable} not applicable`);

  await close();
  process.exit(totals.failed > 0 || failing.some(r => r.error) ? 1 : 0);
}

main().catch(err => {
  // eslint-disable-next-line no-console
  console.error('Fatal:', err);
  process.exit(1);
});
