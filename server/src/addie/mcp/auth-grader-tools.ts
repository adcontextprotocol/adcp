/**
 * Addie auth grader tools.
 *
 * `diagnose_agent_auth` wraps the public `runAuthDiagnosis` export from
 * `@adcp/sdk/auth`. `grade_agent_signing` shells out to the CLI's
 * `grade request-signing` subcommand because the underlying
 * `gradeRequestSigning` function isn't yet on the package's public export
 * surface — follow-up issue tracks promoting it. The same CLI is what users
 * would run locally, so shelling out also exercises the path they hit.
 *
 * Hosted Addie only probes public HTTPS endpoints and always skips the
 * rate-abuse/live-side-effect path. Operators who need private dev loops or
 * explicit live vectors must run the SDK CLI in their own trusted environment.
 */

import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { runAuthDiagnosis, type AuthDiagnosisReport } from '@adcp/sdk/auth';
import type { AddieTool } from '../types.js';
import type { AgentConfig } from '@adcp/sdk/types';
import { createLogger } from '../../logger.js';
import { AsyncSemaphore, SemaphoreOverloadedError } from '../../utils/async-semaphore.js';
import {
  isPrivateHostname,
  normalizeExternalHostname,
  safeFetch,
  validateFetchUrl,
} from '../../utils/url-security.js';
import { withToolRateLimit } from './tool-rate-limiter.js';

const execFileAsync = promisify(execFile);

// Resolve the bundled @adcp/sdk CLI from node_modules so the grader runs
// the same version the server depends on. Avoids `npx @adcp/sdk@latest`,
// which would pull a fresh tarball from the registry on every call — a
// live supply-chain hole if a malicious release ever shipped.
//
// The package's `exports` map blocks importing `@adcp/sdk/package.json`,
// so we resolve the main entry (which IS in exports) and walk up to the
// package root. Tied to the package layout (main = `dist/lib/index.js`);
// upstream changing that requires a major bump per semver, so the walk-up
// distance is stable enough for now.
const requireFromHere = createRequire(import.meta.url);
const ADCP_CLIENT_BIN = (() => {
  const mainEntry = requireFromHere.resolve('@adcp/sdk');
  // .../node_modules/@adcp/sdk/dist/lib/index.js → .../node_modules/@adcp/sdk
  const pkgRoot = path.resolve(mainEntry, '..', '..', '..');
  return path.join(pkgRoot, 'bin', 'adcp.js');
})();

const logger = createLogger('addie-auth-grader-tools');
const signingGraderSemaphore = new AsyncSemaphore(2, 0);
const HOSTED_ALWAYS_SKIPPED_VECTORS = [
  '016-replayed-nonce',
  '020-rate-abuse',
] as const;

type ContentDigestMode = 'either' | 'required' | 'forbidden';

/** Cap response body size at 64 KiB — capabilities responses are tiny; anything
 * larger is either a misbehaving agent or an attempted memory-exhaustion against
 * the prod server. Mirrors `@adcp/sdk`'s `ssrfSafeFetch` default. */
const PROBE_BODY_CAP_BYTES = 64 * 1024;

/**
 * Probe the agent's `request_signing.covers_content_digest` mode via a
 * JSON-RPC `tools/call` of `get_adcp_capabilities`. Lets us pre-skip the
 * mode-mismatch vectors the grader would otherwise report as failures —
 * `agentCapability` does this in-process, but the CLI doesn't expose it.
 *
 * Returns null (skip nothing) on any probe failure: better to over-report
 * than to silently swallow a real verifier bug.
 *
 * SSRF defense: `safeFetch` validates DNS and pins the validated address at
 * connect time. Redirects are disabled, the request is bounded to 10 seconds,
 * and the response is streamed only up to PROBE_BODY_CAP_BYTES.
 */
async function probeContentDigestMode(agentUrl: string): Promise<ContentDigestMode | null> {
  try {
    const res = await safeFetch(agentUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'get_adcp_capabilities', arguments: {} },
        id: 'addie-capability-probe',
      }),
      signal: AbortSignal.timeout(10_000),
      maxRedirects: 0,
    });
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > PROBE_BODY_CAP_BYTES) {
      await res.body?.cancel();
      return null;
    }
    const reader = res.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > PROBE_BODY_CAP_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    const body = JSON.parse(text) as {
      result?: { content?: Array<{ text?: string }> };
    };
    const inner = body.result?.content?.[0]?.text;
    if (!inner) return null;
    const cap = JSON.parse(inner) as {
      request_signing?: { covers_content_digest?: string };
    };
    const mode = cap.request_signing?.covers_content_digest;
    if (mode === 'either' || mode === 'required' || mode === 'forbidden') return mode;
    return null;
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'capability probe failed; grader will run without auto-skip'
    );
    return null;
  }
}

/**
 * Vectors whose `verifier_capability.covers_content_digest` clashes with
 * the declared agent mode. Hardcoded against `@adcp/sdk`@5.21.x test
 * vectors — extend when new content-digest vectors land. The grader's
 * in-process `agentCapability` option does this comparison automatically;
 * this is the CLI-side reimplementation.
 *
 * Exported for unit testing.
 */
export function contentDigestSkipsForMode(mode: ContentDigestMode | null): string[] {
  if (!mode) return [];
  const skip: string[] = [];
  // Vector 007 expects a `required` agent to reject a digest-less signature.
  // Skip when the agent declares `either` (ambivalent) or `forbidden`.
  if (mode === 'either' || mode === 'forbidden') skip.push('007-missing-content-digest');
  // Vector 018 expects a `forbidden` agent to reject a digest-covering signature.
  // Skip when the agent declares `either` or `required`.
  if (mode === 'either' || mode === 'required') skip.push('018-digest-covered-when-forbidden');
  return skip;
}

async function validateAgentUrl(url: string): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'Invalid agent URL format.';
  }
  if (parsed.protocol !== 'https:') {
    return 'Hosted Addie can only probe public HTTPS agent URLs.';
  }
  if (parsed.username || parsed.password) {
    return 'Agent URL must not contain credentials.';
  }
  const hostname = normalizeExternalHostname(parsed.hostname);
  if (!hostname || isPrivateHostname(hostname)) {
    return 'Agent URL must point to a public network address.';
  }
  try {
    await validateFetchUrl(parsed);
  } catch {
    return 'Agent URL must resolve only to public network addresses.';
  }
  return null;
}

function rejectLegacyUnsafeOptions(
  input: Record<string, unknown>,
  includeLiveSideEffects: boolean,
): string | null {
  if (input.allow_http === true) {
    return '**Error:** Hosted Addie cannot probe HTTP or private-network targets. Run the SDK CLI locally for trusted development loops.';
  }
  if (includeLiveSideEffects && input.allow_live_side_effects === true) {
    return '**Error:** Hosted Addie cannot enable live-side-effect vectors. Run the SDK CLI locally against a trusted sandbox.';
  }
  return null;
}

export const AUTH_GRADER_TOOLS: AddieTool[] = [
  {
    name: 'grade_agent_signing',
    description:
      "Run the safe-default RFC 9421 request-signing conformance grader against a public HTTPS agent. Tests whether the agent's verifier accepts valid signed requests and rejects unsigned, expired, replayed, wrong-key, etc. requests with the right error codes. Returns a per-vector pass/fail report with diagnostics. Preconditions: the agent declares `request_signing.supported: true` in get_adcp_capabilities and has its verifier preconfigured per `test-kits/signed-requests-runner.yaml` (accepts the runner's signing keyids `test-ed25519-2026` and `test-es256-2026`, has `test-revoked-2026` in its revocation list). Hosted Addie never probes private networks and always skips replay and rate-abuse live-side-effect vectors. Run the SDK CLI locally when testing trusted development endpoints or explicitly enabling live-side-effect vectors.",
    usage_hints:
      'use for "grade my request signing", "is my RFC 9421 setup correct?", "test my signing verifier". Sandbox-safe by default. Pair with diagnose_agent_auth when the user is troubleshooting end-to-end auth.',
    input_schema: {
      type: 'object',
      properties: {
        agent_url: {
          type: 'string',
          description: 'The public HTTPS agent URL to grade.',
        },
        transport: {
          type: 'string',
          enum: ['mcp', 'raw'],
          description: 'Transport mode. `mcp` (default) wraps each vector body in a JSON-RPC tools/call envelope and posts to the agent\'s MCP mount — right for AdCP MCP servers. `raw` posts to per-operation AdCP endpoints — for agents that expose a raw HTTP surface.',
        },
        content_digest_mode: {
          type: 'string',
          enum: ['either', 'required', 'forbidden'],
          description: 'The agent\'s declared `request_signing.covers_content_digest` mode. When set, vectors that test the inverse modes auto-skip (mirrors the in-process grader\'s `agentCapability` option, which the CLI doesn\'t expose). Leave unset to probe `get_adcp_capabilities` anonymously; the probe falls back to no-skip on auth-gated routes.',
        },
      },
      required: ['agent_url'],
    },
  },
  {
    name: 'diagnose_agent_auth',
    description:
      "Diagnose a public HTTPS agent's OAuth handshake by probing RFC 9728 protected-resource metadata and RFC 8414 authorization-server metadata, decoding any access token in scope, and reporting ranked hypotheses about what's wrong (likely / possible / ruled out). Use when an agent returns 401/403 unexpectedly, when OAuth metadata might be misconfigured, or when validating an agent's OAuth setup before integrating. This is anonymous-mode diagnosis — token refresh and authenticated tool-call probes are skipped, so the report describes what the public surface advertises rather than whether a specific token works. Hosted Addie never probes private networks; use the SDK CLI locally for trusted development endpoints.",
    usage_hints:
      'use for "diagnose OAuth on this agent", "why is the agent rejecting my token?", "is this agent\'s OAuth metadata correct?", "validate OAuth setup". For deeper diagnosis with a saved token or a trusted private development endpoint, point the user to the SDK CLI\'s local `adcp diagnose-auth <alias>` command.',
    input_schema: {
      type: 'object',
      properties: {
        agent_url: { type: 'string', description: 'The public HTTPS agent URL to probe.' },
      },
      required: ['agent_url'],
    },
  },
];

export type AuthGraderProcessRunner = (
  args: readonly string[],
  options: { timeout: number; maxBuffer: number },
) => Promise<{ stdout: string }>;

const defaultAuthGraderProcessRunner: AuthGraderProcessRunner = async (args, options) => {
  const { stdout } = await execFileAsync(process.execPath, [...args], options);
  return { stdout: String(stdout) };
};

let authGraderProcessRunner = defaultAuthGraderProcessRunner;

/** Test-only process boundary override. Passing null restores production. */
export function __setAuthGraderProcessRunnerForTests(
  runner: AuthGraderProcessRunner | null,
): void {
  authGraderProcessRunner = runner ?? defaultAuthGraderProcessRunner;
}

export function createAuthGraderToolHandlers(callerId: string): Map<
  string,
  (args: Record<string, unknown>) => Promise<string>
> {
  if (typeof callerId !== 'string' || !callerId.trim()) {
    throw new Error('createAuthGraderToolHandlers requires a stable caller ID');
  }

  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<string>>();

  const gradeAgentSigning = async (input: Record<string, unknown>) => {
    const agentUrl = String(input.agent_url ?? '');
    const rawTransport = input.transport === 'raw';

    const urlError = await validateAgentUrl(agentUrl);
    if (urlError) return `**Error:** ${urlError}`;

    // Run the bundled @adcp/sdk CLI's `grade request-signing --json`.
    // The underlying `gradeRequestSigning` isn't on the package's public
    // export surface yet, so we shell out — but we shell out to the CLI
    // installed in node_modules under the version pinned by package.json,
    // not via `npx @latest`. Same path, exit code, and report shape the
    // user would hit locally.
    //
    // Transport defaults to `mcp` rather than the CLI's `raw` default:
    // every Addie-grade-able agent today is MCP-style (JSON-RPC tools/call),
    // and `raw` against an MCP mount returns 404 on every probe. Operators
    // who genuinely have a raw AdCP endpoint can pass `transport: 'raw'`.
    // Pre-flight `get_adcp_capabilities` so we can pre-skip vectors whose
    // verifier_capability profile doesn't match what the agent advertises
    // (the in-process grader does this via `agentCapability`; the CLI
    // doesn't expose that option). The caller can short-circuit via
    // `content_digest_mode` — useful when the route requires auth and the
    // anonymous probe can't read the capability declaration.
    const explicitMode =
      input.content_digest_mode === 'either' ||
      input.content_digest_mode === 'required' ||
      input.content_digest_mode === 'forbidden'
        ? (input.content_digest_mode as ContentDigestMode)
        : null;
    const probedMode =
      explicitMode ?? (rawTransport ? null : await probeContentDigestMode(agentUrl));
    const autoSkip = contentDigestSkipsForMode(probedMode);
    const skipVectors = [...new Set([...HOSTED_ALWAYS_SKIPPED_VECTORS, ...autoSkip])];

    const args = [ADCP_CLIENT_BIN, 'grade', 'request-signing', agentUrl, '--json'];
    args.push('--transport', rawTransport ? 'raw' : 'mcp');
    args.push('--skip-rate-abuse');
    args.push('--skip', skipVectors.join(','));

    try {
      // Only the child-process lifetime holds a semaphore permit. URL checks
      // and the bounded capability probe happen before it; JSON formatting
      // happens after the child exits and releases the permit.
      const { stdout } = await signingGraderSemaphore.run(() =>
        authGraderProcessRunner(args, {
          timeout: 90_000,
          maxBuffer: 10 * 1024 * 1024,
        })
      );
      const report = JSON.parse(stdout) as GradeReport;
      return formatGradeReport(report);
    } catch (err) {
      if (err instanceof SemaphoreOverloadedError) {
        return '**RFC 9421 grader capacity is busy.** Try again after an in-progress grade finishes.';
      }
      // execFile rejects on non-zero exit. The grader exits 1 when at least
      // one vector failed but still emits the report on stdout — parse and
      // format it as a normal FAIL result. Other exit codes (2 = config
      // error, network failures, etc.) surface as errors to the user.
      const stdout = (err as { stdout?: string })?.stdout;
      const code = (err as { code?: number })?.code;
      if (code === 1 && stdout) {
        try {
          const report = JSON.parse(stdout) as GradeReport;
          return formatGradeReport(report);
        } catch {
          // fall through to error path
        }
      }
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message, agentUrl, code }, 'grade_agent_signing failed');
      return [
        `**Error running RFC 9421 grader:** ${message.slice(0, 500)}`,
        '',
        'Likely causes:',
        "- Agent doesn't advertise `request_signing.supported: true` in get_adcp_capabilities",
        "- Agent's verifier isn't preconfigured per test-kits/signed-requests-runner.yaml (runner keyids not accepted, revocation list missing the test key)",
        '- Agent URL unreachable from this server',
      ].join('\n');
    }
  };

  const diagnoseAgentAuth = async (input: Record<string, unknown>) => {
    const agentUrl = String(input.agent_url ?? '');

    const urlError = await validateAgentUrl(agentUrl);
    if (urlError) return `**Error:** ${urlError}`;

    const agentConfig: AgentConfig = {
      id: 'addie-probe',
      name: 'agent-probe',
      agent_uri: agentUrl,
      protocol: 'mcp',
    };

    try {
      const report = await runAuthDiagnosis(agentConfig, {
        allowPrivateIp: false,
        skipRefresh: true,
        skipToolCall: true,
      });
      return formatAuthDiagnosisReport(report);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message, agentUrl }, 'diagnose_agent_auth failed');
      return `**Error running OAuth diagnosis:** ${message}`;
    }
  };

  const rateLimitedGrade = withToolRateLimit('grade_agent_signing', callerId, gradeAgentSigning);
  handlers.set('grade_agent_signing', async (input) => {
    const unsafeOptionError = rejectLegacyUnsafeOptions(input, true);
    if (unsafeOptionError) return unsafeOptionError;
    return rateLimitedGrade(input);
  });

  const rateLimitedDiagnosis = withToolRateLimit('diagnose_agent_auth', callerId, diagnoseAgentAuth);
  handlers.set('diagnose_agent_auth', async (input) => {
    const unsafeOptionError = rejectLegacyUnsafeOptions(input, false);
    if (unsafeOptionError) return unsafeOptionError;
    return rateLimitedDiagnosis(input);
  });

  return handlers;
}

/**
 * Mirror of `@adcp/sdk`'s `GradeReport` / `VectorGradeResult` types. We
 * parse the CLI's `--json` stdout into this shape rather than importing the
 * upstream type because the type lives behind the same internal subpath the
 * runtime export does. Keep field names in sync with
 * `@adcp/sdk/dist/lib/testing/storyboard/request-signing/grader.d.ts`.
 * Verified against the package version pinned by this repository; move to a
 * public type import once the upstream package promotes it.
 */
interface VectorGradeResult {
  vector_id: string;
  kind: 'positive' | 'negative';
  passed: boolean;
  skipped?: boolean;
  skip_reason?: string;
  actual_error_code?: string;
  expected_error_code?: string;
  http_status: number;
  diagnostic?: string;
  probe_duration_ms: number;
}

interface GradeReport {
  agent_url: string;
  harness_mode: 'black_box';
  live_endpoint_warning: boolean;
  contract_loaded: boolean;
  positive: VectorGradeResult[];
  negative: VectorGradeResult[];
  passed: boolean;
  passed_count: number;
  failed_count: number;
  skipped_count: number;
  total_duration_ms: number;
}

function formatGradeReport(report: GradeReport): string {
  const lines: string[] = [];
  lines.push(`## RFC 9421 Request Signing Grade: ${report.agent_url}`);
  lines.push('');
  lines.push(
    `**Result:** ${report.passed ? 'PASS' : 'FAIL'} — ${report.passed_count} passed, ${report.failed_count} failed, ${report.skipped_count} skipped (${(report.total_duration_ms / 1000).toFixed(1)}s)`
  );
  if (!report.contract_loaded) {
    lines.push('');
    lines.push(
      '_No test-kit contract was loaded for this endpoint. Live-side-effect vectors auto-skipped; capability-profile checks degraded._'
    );
  }
  if (report.live_endpoint_warning) {
    lines.push('');
    lines.push(
      "Warning: this endpoint isn't declared as sandbox in its test-kit contract. Hosted Addie skips rate-abuse and caller-enabled live-side-effect vectors; use the SDK CLI locally for explicit live testing."
    );
  }

  const all = [...report.positive, ...report.negative];
  const failed = all.filter((v) => !v.skipped && !v.passed);
  if (failed.length > 0) {
    lines.push('', '### Failed vectors', '');
    for (const v of failed) {
      let line = `- **${v.vector_id}** (${v.kind}, HTTP ${v.http_status})`;
      if (v.kind === 'negative' && v.expected_error_code) {
        line += ` — expected \`${v.expected_error_code}\``;
        line += v.actual_error_code ? `, got \`${v.actual_error_code}\`` : ', got no error code';
      }
      if (v.diagnostic) line += `\n  ${v.diagnostic}`;
      lines.push(line);
    }
  }

  const skipped = all.filter((v) => v.skipped);
  if (skipped.length > 0) {
    lines.push('', '### Skipped vectors', '');
    const grouped = new Map<string, string[]>();
    for (const v of skipped) {
      const reason = v.skip_reason ?? 'unspecified';
      if (!grouped.has(reason)) grouped.set(reason, []);
      grouped.get(reason)!.push(v.vector_id);
    }
    for (const [reason, ids] of grouped) {
      lines.push(`- _${reason}_: ${ids.join(', ')}`);
    }
  }

  lines.push(
    '',
    'Interpret the failures conversationally. Group related fails (e.g. all canonicalization-bucket vectors), explain what each error code means, and suggest concrete fixes.'
  );
  return lines.join('\n');
}

function formatAuthDiagnosisReport(report: AuthDiagnosisReport): string {
  const lines: string[] = [];
  lines.push(`## OAuth Diagnosis: ${report.agentUrl}`);
  lines.push('');

  const likely = report.hypotheses.filter((h) => h.verdict === 'likely');
  const possible = report.hypotheses.filter((h) => h.verdict === 'possible');
  const ruled = report.hypotheses.filter((h) => h.verdict === 'ruled_out');

  if (likely.length === 0 && possible.length === 0) {
    lines.push('**No problems detected** in the public OAuth surface (anonymous-mode probe).');
  } else {
    if (likely.length > 0) {
      lines.push('### Likely causes', '');
      for (const h of likely) {
        lines.push(`- **${h.title}** (${h.id}) — ${h.summary}`);
        for (const e of h.evidence.slice(0, 3)) lines.push(`  - ${e}`);
      }
      lines.push('');
    }
    if (possible.length > 0) {
      lines.push('### Possible causes', '');
      for (const h of possible) {
        lines.push(`- **${h.title}** (${h.id}) — ${h.summary}`);
      }
      lines.push('');
    }
  }

  if (ruled.length > 0) {
    lines.push(`_Ruled out: ${ruled.map((h) => h.id).join(', ')}_`);
  }

  lines.push(
    '',
    'This is anonymous-mode diagnosis (no token, no authenticated tool call). For a deeper probe with a saved token, run `adcp diagnose-auth <alias>` locally.'
  );
  return lines.join('\n');
}
