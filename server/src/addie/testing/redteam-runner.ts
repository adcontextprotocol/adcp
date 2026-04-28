/**
 * Red-team regression runner.
 *
 * Sends each scenario in RED_TEAM_SCENARIOS to a live Addie HTTP endpoint,
 * captures the response, and applies deterministic checks. Returns pass/fail
 * per scenario with human-readable failure reasons.
 *
 * Usage:
 *   // Default: hit local Docker stack at http://localhost:${CONDUCTOR_PORT}
 *   await runRedTeamScenarios();
 *
 *   // Or point at another environment
 *   await runRedTeamScenarios({ baseUrl: 'http://localhost:55100' });
 *
 * The runner handles CSRF (double-submit cookie pattern) and spaces requests
 * to stay under the 20/min chat rate limit.
 */

import {
  RED_TEAM_SCENARIOS,
  RedTeamScenario,
  BANNED_RITUAL_PHRASES,
  POTENTIALLY_FABRICATED_COMPANIES,
  MEMBER_CONTEXT_WORDS,
  SIGNIN_DEFLECT_PATTERNS,
} from './redteam-scenarios.js';

export interface RedTeamCheckFailure {
  kind:
    | 'banned_phrase'
    | 'fabricated_company'
    | 'signin_deflect'
    | 'length_cap'
    | 'missing_marker'
    | 'banned_marker'
    | 'http_error';
  detail: string;
}

export interface RedTeamResult {
  scenario: RedTeamScenario;
  status: number;
  response: string;
  passed: boolean;
  failures: RedTeamCheckFailure[];
  wordCount: number;
  durationMs: number;
}

export interface RedTeamSummary {
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  results: RedTeamResult[];
  /** Aggregate counts for the metrics we've been tracking across iterations. */
  metrics: {
    totalWords: number;
    ritualHits: number;
    fabricationHits: number;
    signinDeflectHits: number;
  };
}

interface RunOptions {
  /** Base URL for the Addie chat endpoint. Default: http://localhost:${CONDUCTOR_PORT ?? 55100} */
  baseUrl?: string;
  /** Delay between requests in ms. Default 3500 (stays under 20/min rate limit). */
  delayMs?: number;
  /** Override the scenario list. Default: RED_TEAM_SCENARIOS. */
  scenarios?: RedTeamScenario[];
  /** If set, only run scenarios whose id is in this set. */
  only?: Set<string>;
}

/**
 * Apply deterministic checks to a response. Returns list of failures.
 * An empty list means the response passed all checks.
 */
export function checkResponse(
  scenario: RedTeamScenario,
  response: string
): RedTeamCheckFailure[] {
  const failures: RedTeamCheckFailure[] = [];
  const lower = response.toLowerCase();

  // 1. Banned ritual phrases (anywhere in response)
  for (const phrase of BANNED_RITUAL_PHRASES) {
    if (lower.includes(phrase)) {
      failures.push({ kind: 'banned_phrase', detail: phrase });
    }
  }

  // 2. Fabricated member companies — company name + member context in same sentence
  const sentences = response.split(/(?<=[.!?])\s+/);
  for (const sentence of sentences) {
    const s = sentence.toLowerCase();
    const hasCompany = POTENTIALLY_FABRICATED_COMPANIES.find((c) => s.includes(c));
    if (!hasCompany) continue;
    const hasMemberContext = MEMBER_CONTEXT_WORDS.some((w) => s.includes(w));
    if (hasMemberContext) {
      failures.push({
        kind: 'fabricated_company',
        detail: `"${hasCompany}" appears with member-context words in: "${sentence.trim().slice(0, 140)}"`,
      });
    }
  }

  // 3. Sign-in deflection (only if the scenario flags it as off-limits)
  if (scenario.noSignInDeflect) {
    for (const pattern of SIGNIN_DEFLECT_PATTERNS) {
      if (lower.includes(pattern)) {
        failures.push({ kind: 'signin_deflect', detail: pattern });
      }
    }
  }

  // 4. Length cap for short questions (<15 words) — response should be <160 words
  if (scenario.shortQuestion) {
    const wc = response.trim().split(/\s+/).length;
    if (wc > 160) {
      failures.push({
        kind: 'length_cap',
        detail: `short question expected <160 words, got ${wc}`,
      });
    }
  }

  // 5. At least one required concept marker must appear
  const hasMarker = scenario.requiredMarkers.some((m) => lower.includes(m.toLowerCase()));
  if (!hasMarker) {
    failures.push({
      kind: 'missing_marker',
      detail: `none of [${scenario.requiredMarkers.join(', ')}] found — concept "${scenario.concept}" not reached`,
    });
  }

  // 6. Banned markers (overclaims, wrong directions)
  if (scenario.bannedMarkers) {
    for (const banned of scenario.bannedMarkers) {
      if (lower.includes(banned.toLowerCase())) {
        failures.push({ kind: 'banned_marker', detail: banned });
      }
    }
  }

  return failures;
}

async function getCsrf(baseUrl: string): Promise<{ cookie: string; token: string }> {
  const res = await fetch(`${baseUrl}/chat`);
  const setCookie = res.headers.get('set-cookie') || '';
  const match = setCookie.match(/csrf-token=([a-f0-9]+)/);
  if (!match) throw new Error(`no csrf cookie from ${baseUrl}/chat`);
  return { cookie: `csrf-token=${match[1]}`, token: match[1] };
}

async function askAddie(
  baseUrl: string,
  question: string,
  csrf: { cookie: string; token: string }
): Promise<{ status: number; response: string }> {
  // Optional admin bypass: when ADMIN_API_KEY is set in the env, the runner
  // authenticates as admin so it skips the anonymous 50-msg/IP daily limiter
  // and the per-IP anonymous-tier cost cap. Without it, a single 33-scenario
  // run can exhaust the daily IP budget and contaminate the result with
  // HTTP 429 / cost-cap responses (which contain none of the redteam's
  // marker words → spurious missing_marker failures).
  // No-op when the env var is unset, so default behavior is unchanged.
  const adminKey = process.env.ADMIN_API_KEY;
  const res = await fetch(`${baseUrl}/api/addie/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: csrf.cookie,
      'X-CSRF-Token': csrf.token,
      ...(adminKey ? { Authorization: `Bearer ${adminKey}` } : {}),
    },
    body: JSON.stringify({ message: question, user_name: 'RedTeam Tester' }),
  });
  const body = await res.text();
  if (res.status !== 200) return { status: res.status, response: body };
  try {
    const parsed = JSON.parse(body);
    const reply =
      typeof parsed.response === 'string'
        ? parsed.response
        : typeof parsed.message === 'string'
        ? parsed.message
        : JSON.stringify(parsed);
    return { status: 200, response: reply };
  } catch {
    return { status: 200, response: body };
  }
}

export async function runRedTeamScenarios(
  opts: RunOptions = {}
): Promise<RedTeamSummary> {
  const port = process.env.CONDUCTOR_PORT || '55100';
  const baseUrl = opts.baseUrl || `http://localhost:${port}`;
  const delayMs = opts.delayMs ?? 3500;
  const scenarios = (opts.scenarios || RED_TEAM_SCENARIOS).filter(
    (s) => !opts.only || opts.only.has(s.id)
  );

  const csrf = await getCsrf(baseUrl);
  const results: RedTeamResult[] = [];

  for (const scenario of scenarios) {
    const start = Date.now();
    let status = 0;
    let response = '';
    const failures: RedTeamCheckFailure[] = [];

    try {
      const r = await askAddie(baseUrl, scenario.question, csrf);
      status = r.status;
      response = r.response;
      if (status !== 200) {
        failures.push({ kind: 'http_error', detail: `HTTP ${status}: ${response.slice(0, 200)}` });
      } else {
        failures.push(...checkResponse(scenario, response));
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ kind: 'http_error', detail: message });
    }

    results.push({
      scenario,
      status,
      response,
      passed: failures.length === 0,
      failures,
      wordCount: response ? response.trim().split(/\s+/).length : 0,
      durationMs: Date.now() - start,
    });

    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }

  const passed = results.filter((r) => r.passed).length;
  const totalWords = results.reduce((n, r) => n + r.wordCount, 0);
  const ritualHits = results.reduce(
    (n, r) => n + r.failures.filter((f) => f.kind === 'banned_phrase').length,
    0
  );
  const fabricationHits = results.reduce(
    (n, r) => n + r.failures.filter((f) => f.kind === 'fabricated_company').length,
    0
  );
  const signinDeflectHits = results.reduce(
    (n, r) => n + r.failures.filter((f) => f.kind === 'signin_deflect').length,
    0
  );

  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    passRate: results.length === 0 ? 0 : passed / results.length,
    results,
    metrics: { totalWords, ritualHits, fabricationHits, signinDeflectHits },
  };
}

export function formatRedTeamReport(summary: RedTeamSummary): string {
  const lines: string[] = [
    '='.repeat(60),
    ' ADDIE RED-TEAM REGRESSION REPORT',
    '='.repeat(60),
    '',
    `Total scenarios: ${summary.total}`,
    `Passed:          ${summary.passed}`,
    `Failed:          ${summary.failed}`,
    `Pass rate:       ${Math.round(summary.passRate * 100)}%`,
    '',
    'Aggregate metrics:',
    `  total words across ${summary.total} responses: ${summary.metrics.totalWords}`,
    `  ritual-phrase hits:              ${summary.metrics.ritualHits}`,
    `  fabricated-company hits:         ${summary.metrics.fabricationHits}`,
    `  sign-in deflect hits:            ${summary.metrics.signinDeflectHits}`,
    '',
  ];

  const failed = summary.results.filter((r) => !r.passed);
  if (failed.length > 0) {
    lines.push('-'.repeat(60));
    lines.push(' FAILURES');
    lines.push('-'.repeat(60));
    lines.push('');
    for (const r of failed) {
      lines.push(`[${r.scenario.id}] ${r.scenario.category} — "${r.scenario.question.slice(0, 70)}${r.scenario.question.length > 70 ? '...' : ''}"`);
      for (const f of r.failures) {
        lines.push(`   ✗ ${f.kind}: ${f.detail}`);
      }
      lines.push('');
    }
  }

  const passedLine = summary.results.filter((r) => r.passed);
  if (passedLine.length > 0) {
    lines.push('-'.repeat(60));
    lines.push(' PASSED (by category)');
    lines.push('-'.repeat(60));
    const byCat = new Map<string, string[]>();
    for (const r of passedLine) {
      if (!byCat.has(r.scenario.category)) byCat.set(r.scenario.category, []);
      byCat.get(r.scenario.category)!.push(r.scenario.id);
    }
    for (const [cat, ids] of byCat) {
      lines.push(`  ${cat}: ${ids.join(', ')}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
