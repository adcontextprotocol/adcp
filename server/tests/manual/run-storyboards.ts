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

async function startLocalAgent(): Promise<{ url: string; close: () => Promise<void> }> {
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
  app.use('/api/training-agent', createTrainingAgentRouter());
  return await new Promise((resolve, reject) => {
    const srv = http.createServer(app);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('listen returned no address'));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${addr.port}/api/training-agent/mcp`,
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
  // The storyboard asserts `field_present: status` against the v3 envelope,
  // but `response_schema_ref` points at the inner per-tool response schema
  // (which doesn't define `status`). The framework's auto-registered
  // `get_adcp_capabilities` returns the inner payload as `structuredContent`
  // without an envelope wrapper, so `data.status` is undefined at runtime.
  // Tracked upstream as adcp#3429; remove once the storyboard is migrated to
  // `envelope_field_present` AND the framework wraps capabilities responses.
  ['v3_envelope_integrity', 'adcp-client#1045 / adcp#3429 — storyboard asserts envelope status, framework capabilities tool returns unenveloped payload'],
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
const KNOWN_FAILING_STEPS: ReadonlyMap<string, string> = new Map([
  // `ProtocolClient.callTool` (5.24+) spreads the SDK's version envelope after
  // caller args, overriding `adcp_major_version` from the storyboard's
  // sample_request. The storyboard sends 99 to probe the seller's version
  // validation, but the buyer-side SDK rewrites it to the SDK's pinned major
  // before the request hits the wire — the seller never sees 99 and can't
  // reject it. Pre-existing on main (overlay was landing in `*.previous` so
  // the storyboard never ran); the SDK 5.25 cache layout exposes it.
  ['error_compliance/unsupported_major_version', 'adcp-client buyer-side SDK overrides adcp_major_version on the wire — storyboard cannot probe seller-side version validation through the SDK transport'],
]);

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
  auth?: { api_key?: string; probe_task?: string };
}

function loadTestKit(sb: Storyboard): LoadedTestKit | undefined {
  const kitRef = sb.prerequisites?.test_kit;
  if (!kitRef) return undefined;
  const path = join(getComplianceCacheDir(), kitRef);
  if (!existsSync(path)) return undefined;
  return YAML.parse(readFileSync(path, 'utf-8')) as LoadedTestKit;
}

function brandFromKit(kit: LoadedTestKit | undefined): StoryboardRunOptions['brand'] | undefined {
  const domain = kit?.brand?.house?.domain;
  return domain ? { domain } : undefined;
}

/**
 * Thread the test-kit's `auth.api_key` / `auth.probe_task` through to the
 * runner so `api_key_path` in security_baseline (and any future kit-gated
 * phase) executes instead of being skipped by `skip_if: "!test_kit.auth.api_key"`.
 * `probe_task` is required by the runner whenever `auth` is declared — surface
 * missing values as a hard failure rather than silently defaulting.
 */
function testKitOptionsFromKit(kit: LoadedTestKit | undefined): StoryboardRunOptions['test_kit'] | undefined {
  const auth = kit?.auth;
  if (!auth?.api_key && !auth?.probe_task) return undefined;
  if (!auth.probe_task) {
    throw new Error('test kit declares auth.api_key without auth.probe_task — required by runner');
  }
  return {
    auth: {
      ...(auth.api_key !== undefined && { api_key: auth.api_key }),
      probe_task: auth.probe_task,
    },
  };
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
      const reason = KNOWN_FAILING_STEPS.get(`${storyboardId}/${stepId}`);
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

function stepStatus(s: { passed?: boolean; skipped?: boolean; not_applicable?: boolean; validations?: Array<{ passed: boolean }>; error?: string }): 'passed' | 'failed' | 'skipped' | 'not_applicable' {
  if (s.not_applicable) return 'not_applicable';
  if (s.skipped) return 'skipped';
  if (s.passed === false || s.error) return 'failed';
  const validations = s.validations ?? [];
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
  const { url: agentUrl, close } = await startLocalAgent();
  // eslint-disable-next-line no-console
  console.log(`\nTraining agent running at ${agentUrl}`);
  // eslint-disable-next-line no-console
  console.log(`Filter: ${filter ?? '(all storyboards)'}\n`);

  const everything = listAllComplianceStoryboards();
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
    process.stdout.write(`  ${sb.id.padEnd(40)} `);
    try {
      const kit = loadTestKit(sb);
      const brand = brandFromKit(kit);
      const testKit = testKitOptionsFromKit(kit);
      // The default `/mcp` route is the public sandbox (bearer OR signed,
      // no `required_for` enforcement). The `/mcp-strict` route is the
      // grader target with presence-gated signing + required_for. Point
      // the signed_requests conformance storyboard at the strict route
      // so vector 001 (`request_signature_required`) fires against a
      // cap that actually advertises `required_for: [create_media_buy]`;
      // every other storyboard stays on `/mcp` so bearer-authed unsigned
      // calls keep working.
      const targetUrl = sb.id === 'signed_requests'
        ? agentUrl.replace(/\/mcp$/, '/mcp-strict')
        : agentUrl;
      const result = await runStoryboard(targetUrl, sb, {
        auth: { type: 'bearer', token: AUTH_TOKEN },
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
          // Our declared capability is `covers_content_digest: 'either'`;
          // vectors 007 and 018 assert specific mismatching policies
          // (`required` / `forbidden`) — the grader skip-list per
          // capability-profile mismatch. Vector 020 (rate-abuse) sends
          // cap+1 requests per run and is opt-in anyway. Vector 025
          // grades the SDK's library verifier against an inline malformed
          // JWK (`jwks_override`) — it exercises SDK internals, not our
          // agent, so we skip it here and rely on upstream SDK tests.
          skipVectors: [
            '007-missing-content-digest',
            '018-digest-covered-when-forbidden',
            '025-jwk-alg-crv-mismatch',
          ],
          skipRateAbuse: true,
        },
        ...(brand && { brand }),
        ...(testKit && { test_kit: testKit }),
      });
      applyStepSkipList(sb.id, result);
      const summary = summarize(sb, result);
      results.push(summary);
      const pill = summary.failed === 0
        ? `✓ ${summary.passed}P / ${summary.skipped}S / ${summary.not_applicable}N/A`
        : `✗ ${summary.passed}P / ${summary.failed}F / ${summary.skipped}S / ${summary.not_applicable}N/A`;
      // eslint-disable-next-line no-console
      console.log(pill);
    } catch (err) {
      const summary = summarize(sb, { error: err instanceof Error ? err.message : String(err) });
      results.push(summary);
      // eslint-disable-next-line no-console
      console.log(`⚠ ${summary.error}`);
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
