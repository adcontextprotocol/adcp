/**
 * Signal gatherers for escalation triage.
 *
 * Each helper is isolated and testable — the classifier in escalation-triage.ts
 * composes them. Kept dependency-light (no DB, no Anthropic) so unit tests can
 * exercise the logic with fixture inputs.
 */

/**
 * Extract all agenticadvertising.org URLs from a free-text summary.
 * Used to probe whether a bug-shaped escalation still repros.
 */
export function extractAaoUrls(text: string | null | undefined): string[] {
  if (!text) return [];
  const rx = /https?:\/\/(?:www\.)?agenticadvertising\.org\/[^\s)"'\]]*/gi;
  const matches = text.match(rx) ?? [];
  return [...new Set(matches.map(s => s.replace(/[.,;:!?]+$/, '')))];
}

/**
 * Extract IDs referenced in summary text like "follow-up to escalation #283".
 * Only matches inside an explicit "cancel" or "follow-up" prefix — a bare
 * "see escalation 42" is intentionally ignored so unrelated mentions don't
 * chain resolutions across tickets.
 */
export function extractReferencedEscalationIds(text: string | null | undefined): number[] {
  if (!text) return [];
  const rx = /(?:cancel\s+escalation|follow.?up\s+(?:to|on)\s+escalation)\s+#?(\d{1,6})/gi;
  const ids: number[] = [];
  for (const m of text.matchAll(rx)) {
    const n = parseInt(m[1], 10);
    if (!Number.isNaN(n)) ids.push(n);
  }
  return [...new Set(ids)];
}

/**
 * Hostnames `probeUrlStatus` is allowed to hit. Keeping this list tight
 * closes the SSRF surface: even if a future caller passes an arbitrary
 * URL, the probe refuses to reach non-AAO hosts.
 */
const PROBE_ALLOWED_HOSTS = new Set(['agenticadvertising.org', 'www.agenticadvertising.org']);

/**
 * GET-probe a URL with a short timeout. Returns the HTTP status code or
 * null on failure / disallowed host. Follows only the first hop; a
 * 200/301/302 on an AAO URL is treated as "the page exists now".
 */
export async function probeUrlStatus(
  url: string,
  timeoutMs = 8000,
): Promise<number | null> {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  if (!PROBE_ALLOWED_HOSTS.has(host)) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'User-Agent': 'aao-escalation-triage/1.0' },
    });
    return resp.status;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Age in days given a created_at timestamp. Pure fn.
 */
export function ageInDays(createdAt: Date | string, now: Date = new Date()): number {
  const t = typeof createdAt === 'string' ? Date.parse(createdAt) : createdAt.getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((now.getTime() - t) / 86_400_000));
}

/**
 * Buckets the classifier considers "ops work" (non-bug). Centralised so
 * the stale-ops rule and the bucket helper can't drift apart.
 */
export const OPS_BUCKETS = new Set(['billing', 'invite', 'content', 'ops-other']);

/**
 * Heuristic bucket from a summary. Lowered, keyword-driven. Same rules used
 * during the manual triage pass — reproducible and easy to extend.
 *
 * Bug detection intentionally avoids `returns \d+` patterns because
 * "returns 200" is a *success* signal, not a bug — catching that would
 * invert the verdict.
 */
export function bucketForSummary(summary: string | null | undefined): string {
  const s = (summary ?? '').toLowerCase();
  if (/bug|error|blank page|not reflecting|not rendering|cannot get|404|500|broken|does not|doesn'?t work|failing|fails|unable to|can'?t|not working|hangs/.test(s)) {
    return 'bug';
  }
  if (/no tool|tooling for|knowledge gap|addie /.test(s)) return 'addie';
  if (/invoice|payment|stripe|receipt|checkout|charge|refund|subscription/.test(s)) {
    return 'billing';
  }
  if (/slack invite|workspace invite|invite|invitation|working group|wg invite/.test(s)) {
    return 'invite';
  }
  if (/press release|announce|publish|blog|post a /.test(s)) return 'content';
  return 'ops-other';
}
