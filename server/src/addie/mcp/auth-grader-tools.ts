/**
 * Addie auth grader tools.
 *
 * `diagnose_agent_auth` wraps the public `runAuthDiagnosis` export from
 * `@adcp/client/auth`. `grade_agent_signing` shells out to the CLI's
 * `grade request-signing` subcommand because the underlying
 * `gradeRequestSigning` function isn't yet on the package's public export
 * surface — follow-up issue tracks promoting it. The same CLI is what users
 * would run locally, so shelling out also exercises the path they hit.
 *
 * Live-side-effect vectors (real `create_media_buy`, replay-cap flood) are
 * skipped by default; the caller must explicitly opt in to run them and
 * should only do so against a sandbox endpoint.
 */

import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { runAuthDiagnosis, type AuthDiagnosisReport } from '@adcp/client/auth';
import type { AddieTool } from '../types.js';
import type { AgentConfig } from '@adcp/client/types';
import { createLogger } from '../../logger.js';

const execFileAsync = promisify(execFile);

// Resolve the bundled @adcp/client CLI from node_modules so the grader runs
// the same version the server depends on. Avoids `npx @adcp/client@latest`,
// which would pull a fresh tarball from the registry on every call — a
// live supply-chain hole if a malicious release ever shipped.
//
// The package's `exports` map blocks importing `@adcp/client/package.json`,
// so we resolve the main entry (which IS in exports) and walk up to the
// package root. Tied to the package layout (main = `dist/lib/index.js`);
// upstream changing that requires a major bump per semver, so the walk-up
// distance is stable enough for now.
const requireFromHere = createRequire(import.meta.url);
const ADCP_CLIENT_BIN = (() => {
  const mainEntry = requireFromHere.resolve('@adcp/client');
  // .../node_modules/@adcp/client/dist/lib/index.js → .../node_modules/@adcp/client
  const pkgRoot = path.resolve(mainEntry, '..', '..', '..');
  return path.join(pkgRoot, 'bin', 'adcp.js');
})();

const logger = createLogger('addie-auth-grader-tools');

function validateAgentUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'Invalid agent URL format.';
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return 'Agent URL must use HTTP or HTTPS.';
  }
  if (process.env.NODE_ENV === 'production' && parsed.protocol !== 'https:') {
    return 'Agent URL must use HTTPS.';
  }
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === '169.254.169.254' || hostname === 'metadata.google.internal') {
    return 'Agent URL points to a blocked address.';
  }
  return null;
}

export const AUTH_GRADER_TOOLS: AddieTool[] = [
  {
    name: 'grade_agent_signing',
    description:
      "Run the RFC 9421 request-signing conformance grader against an agent. Tests whether the agent's verifier accepts valid signed requests and rejects unsigned, expired, replayed, wrong-key, etc. requests with the right error codes. Returns a per-vector pass/fail report with diagnostics. Preconditions: the agent declares `request_signing.supported: true` in get_adcp_capabilities and has its verifier preconfigured per `test-kits/signed-requests-runner.yaml` (accepts the runner's signing keyids `test-ed25519-2026` and `test-es256-2026`, has `test-revoked-2026` in its revocation list). Live-side-effect vectors (real `create_media_buy`, replay-cap flood) are skipped by default — pass `allow_live_side_effects: true` to run them, and only do that against a sandbox endpoint.",
    usage_hints:
      'use for "grade my request signing", "is my RFC 9421 setup correct?", "test my signing verifier". Sandbox-safe by default. Pair with diagnose_agent_auth when the user is troubleshooting end-to-end auth.',
    input_schema: {
      type: 'object',
      properties: {
        agent_url: {
          type: 'string',
          description:
            'The agent URL to grade. Should point at a sandbox or test-kit-declared endpoint unless `allow_live_side_effects` is set.',
        },
        allow_live_side_effects: {
          type: 'boolean',
          description:
            'Run vectors that produce live agent-side effects (a real create_media_buy and a replay-cap flood). Default false. Only set true against a sandbox endpoint or one whose test-kit contract declares `endpoint_scope: sandbox`.',
        },
        allow_http: {
          type: 'boolean',
          description: 'Allow http:// and private-IP targets (dev loops only). Default false.',
        },
        transport: {
          type: 'string',
          enum: ['mcp', 'raw'],
          description: 'Transport mode. `mcp` (default) wraps each vector body in a JSON-RPC tools/call envelope and posts to the agent\'s MCP mount — right for AdCP MCP servers. `raw` posts to per-operation AdCP endpoints — for agents that expose a raw HTTP surface.',
        },
      },
      required: ['agent_url'],
    },
  },
  {
    name: 'diagnose_agent_auth',
    description:
      "Diagnose an agent's OAuth handshake by probing RFC 9728 protected-resource metadata and RFC 8414 authorization-server metadata, decoding any access token in scope, and reporting ranked hypotheses about what's wrong (likely / possible / ruled out). Use when an agent returns 401/403 unexpectedly, when OAuth metadata might be misconfigured, or when validating an agent's OAuth setup before integrating. This is anonymous-mode diagnosis — token refresh and authenticated tool-call probes are skipped, so the report describes what the public surface advertises rather than whether a specific token works.",
    usage_hints:
      'use for "diagnose OAuth on this agent", "why is the agent rejecting my token?", "is this agent\'s OAuth metadata correct?", "validate OAuth setup". For deeper diagnosis with a saved token the user can run `npx @adcp/client diagnose-auth <alias>` locally — point them there if a token-aware probe is needed.',
    input_schema: {
      type: 'object',
      properties: {
        agent_url: { type: 'string', description: 'The agent URL to probe.' },
        allow_http: {
          type: 'boolean',
          description: 'Allow http:// and private-IP targets (dev loops only). Default false.',
        },
      },
      required: ['agent_url'],
    },
  },
];

export function createAuthGraderToolHandlers(): Map<
  string,
  (args: Record<string, unknown>) => Promise<string>
> {
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<string>>();

  handlers.set('grade_agent_signing', async (input) => {
    const agentUrl = String(input.agent_url ?? '');
    const allowLive = input.allow_live_side_effects === true;
    const allowHttp = input.allow_http === true;
    const rawTransport = input.transport === 'raw';

    const urlError = validateAgentUrl(agentUrl);
    if (urlError) return `**Error:** ${urlError}`;

    // Run the bundled @adcp/client CLI's `grade request-signing --json`.
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
    const args = [ADCP_CLIENT_BIN, 'grade', 'request-signing', agentUrl, '--json'];
    args.push('--transport', rawTransport ? 'raw' : 'mcp');
    if (allowLive) args.push('--allow-live-side-effects');
    else args.push('--skip-rate-abuse');
    if (allowHttp) args.push('--allow-http');

    try {
      // 90s is enough for the safe-default path (rate-abuse skipped, ~25
      // vectors). When the caller opts into live side effects the cap-flood
      // vector takes minutes — give it 5min.
      const timeout = allowLive ? 5 * 60_000 : 90_000;
      const { stdout } = await execFileAsync(process.execPath, args, {
        timeout,
        maxBuffer: 10 * 1024 * 1024,
      });
      const report = JSON.parse(stdout) as GradeReport;
      return formatGradeReport(report);
    } catch (err) {
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
  });

  handlers.set('diagnose_agent_auth', async (input) => {
    const agentUrl = String(input.agent_url ?? '');
    const allowHttp = input.allow_http === true;

    const urlError = validateAgentUrl(agentUrl);
    if (urlError) return `**Error:** ${urlError}`;

    const agentConfig: AgentConfig = {
      id: 'addie-probe',
      name: 'agent-probe',
      agent_uri: agentUrl,
      protocol: 'mcp',
    };

    try {
      const report = await runAuthDiagnosis(agentConfig, {
        allowPrivateIp: allowHttp,
        skipRefresh: true,
        skipToolCall: true,
      });
      return formatAuthDiagnosisReport(report);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message, agentUrl }, 'diagnose_agent_auth failed');
      return `**Error running OAuth diagnosis:** ${message}`;
    }
  });

  return handlers;
}

/**
 * Mirror of `@adcp/client`'s `GradeReport` / `VectorGradeResult` types. We
 * parse the CLI's `--json` stdout into this shape rather than importing the
 * upstream type because the type lives behind the same internal subpath the
 * runtime export does. Keep field names in sync with
 * `@adcp/client/dist/lib/testing/storyboard/request-signing/grader.d.ts`.
 * Verified against @adcp/client@5.21.x; will move to a public type import
 * once the upstream PR promotes it.
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
      "Warning: this endpoint isn't declared as sandbox in its test-kit contract. If `allow_live_side_effects` was set, real side effects may have been produced."
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
    'This is anonymous-mode diagnosis (no token, no authenticated tool call). For a deeper probe with a saved token, run `npx @adcp/client diagnose-auth <alias>` locally.'
  );
  return lines.join('\n');
}
