import { isIP } from 'node:net';
import { canonicalizeAgentUrl } from '@adcp/sdk';

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(record) : [];
}
export function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(v => typeof v === 'string' && v.trim().length > 0);
}
/** Domain identity never strips www or conflates sibling publisher namespaces. */
export function domain(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.toLowerCase().replace(/\.$/, '');
  if (normalized.length > 253 || isIP(normalized) || !normalized.includes('.')) return null;
  return normalized.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ? normalized : null;
}
/**
 * Supply-path agent identity: the exact canonical agent URL.
 *
 * The supply-path verifier deliberately STAYS on exact canonical-URL matching
 * until 4.0: an `authorized_agents[].url` matches only an agent URL with the
 * same canonical form, path included. 3.3 `adagents.json` lookups
 * (`AgentValidator` and the registry directory, via `agentUrlAuthorizedBy` in
 * db/registry-agent-url-key.ts) let an origin-only entry authorize every path
 * at its origin (DR-0023, #8939), but supply-path verification semantics
 * version 1 pins exact matching, and its `case-sensitive-agent-path` test
 * vector depends on it. Adopting origin-only matching here needs a new
 * supply-path semantics version, deferred to 4.0; until then do not route
 * this through `agentUrlAuthorizedBy`.
 * See https://github.com/adcontextprotocol/adcp/issues/8943.
 */
export function agentIdentity(value: unknown): string | null {
  if (typeof value !== 'string' || /[\s\x00-\x1f\x7f]/.test(value)) return null;
  const canonical = canonicalizeAgentUrl(value);
  return canonical?.startsWith('https://') ? canonical : null;
}
