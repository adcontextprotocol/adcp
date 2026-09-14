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
export function agentIdentity(value: unknown): string | null {
  if (typeof value !== 'string' || /[\s\x00-\x1f\x7f]/.test(value)) return null;
  const canonical = canonicalizeAgentUrl(value);
  return canonical?.startsWith('https://') ? canonical : null;
}
