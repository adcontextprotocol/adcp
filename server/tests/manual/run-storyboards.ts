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
} from '@adcp/client/testing';
import type { StoryboardResult, Storyboard, StoryboardRunOptions } from '@adcp/client/testing';
import {
  StaticJwksResolver,
  InMemoryReplayStore,
  InMemoryRevocationStore,
} from '@adcp/client/signing';
import type { AdcpJsonWebKey } from '@adcp/client/signing';

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

function isApplicable(sb: Storyboard): boolean {
  if (filter && !sb.id.includes(filter) && !(sb.category ?? '').includes(filter)) return false;
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
        const s = step as { step_id?: string; error?: string; validations?: Array<{ passed: boolean; description?: string }> };
        const validationFails = (s.validations ?? [])
          .filter(v => !v.passed)
          .map(v => v.description ?? '(validation failed)')
          .join('; ');
        // Prefer the step-level error; fall back to the concatenated failed-
        // validation descriptions so runs don't collapse to the one-liner
        // "Probe validations failed" without surfacing the actual checks that
        // didn't pass (issue #2841).
        const errorDetail = validationFails
          ? (s.error ? `${s.error} — ${validationFails}` : validationFails)
          : (s.error ?? '(failed without message)');
        base.failures.push({
          step: s.step_id ?? '(unknown step)',
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

  const all = listAllComplianceStoryboards().filter(isApplicable);
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
