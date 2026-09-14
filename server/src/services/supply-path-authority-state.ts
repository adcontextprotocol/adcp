import { PostgresStateStore, patchWithRetry, type AdcpStateStore } from '@adcp/sdk/server';
import { getPool } from '../db/client.js';
import { domain, record } from './supply-path-input.js';
import type { SupplyPathManifest } from './supply-path-contract.js';

const COLLECTION = 'supply_path_authority_v1';
const HOLD_MS = 7 * 86400000;
const persistentStore = new PostgresStateStore({
  query: async (text: string, values?: unknown[]) => {
    const config = { text, values, query_timeout: 5000 };
    return getPool().query(config);
  },
});
type HeldRevocation = { publisher_domain: string; revoked_at: string; first_observed_at: number };
type AuthorityState = Record<string, unknown> & { location?: string; revoked: HeldRevocation[] };

/** Persist observations atomically in the existing SDK document store, shared by registry workers. */
export async function observeSupplyPathAuthority(
  authority: string, manifest: SupplyPathManifest | null, location?: string, store: AdcpStateStore = persistentStore,
): Promise<{ revoked: string[] }> {
  if (!domain(authority)) throw new TypeError('Invalid publisher authority');
  if (location) validateLocation(location);
  const observed = manifest?.revoked_publisher_domains;
  if (observed !== undefined && (!Array.isArray(observed) || observed.length > 1024)) throw new Error('Invalid publisher revocation evidence');
  const incoming: Array<{ publisher_domain: string; revoked_at: string }> = [];
  for (const raw of (observed as unknown[] | undefined) ?? []) {
    const publisher = domain(record(raw) ? raw.publisher_domain : raw);
    const timestamp = record(raw) ? raw.revoked_at : undefined;
    if (!publisher || (timestamp !== undefined && (typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp))))) throw new Error('Invalid publisher revocation evidence');
    incoming.push({ publisher_domain: publisher, revoked_at: typeof timestamp === 'string' ? timestamp : 'unspecified' });
  }
  const now = Date.now();
  let unchanged: AuthorityState | null = null;
  const state = await patchWithRetry<AuthorityState>(store, COLLECTION, authority, current => {
    if (!current && !location && !incoming.length) return null;
    if (current?.location && location && current.location !== location) throw new Error('Authoritative location changed; publisher migration requires independent confirmation');
    const held = new Map((current?.revoked ?? []).filter(entry => entry.first_observed_at + HOLD_MS > now).map(entry => [entry.publisher_domain, entry]));
    for (const entry of incoming) {
      const prior = held.get(entry.publisher_domain);
      if (!prior) held.set(entry.publisher_domain, { ...entry, first_observed_at: now });
      else if (Date.parse(entry.revoked_at) < Date.parse(prior.revoked_at)) held.set(entry.publisher_domain, { ...prior, revoked_at: entry.revoked_at });
    }
    if (held.size > 1024) throw new Error('Supply-path authority revocation capacity exceeded');
    const next = { ...(location || current?.location ? { location: location ?? current?.location } : {}), revoked: [...held.values()] };
    if (current && current.location === next.location && current.revoked.length === held.size && current.revoked.every(entry => {
      const retained = held.get(entry.publisher_domain);
      return retained?.revoked_at === entry.revoked_at && retained.first_observed_at === entry.first_observed_at;
    })) {
      unchanged = current;
      return null; // SDK CAS helper's explicit no-write result; retain this read snapshot locally.
    }
    return next;
  }, { maxAttempts: 5 });
  const effective = state ?? (unchanged as AuthorityState | null);
  return { revoked: effective?.revoked.map(entry => entry.publisher_domain) ?? [] };
}

/** Operator-only migration confirmation. Never invoke as an automatic retry of a rejected observation. */
export async function approveSupplyPathAuthorityChange(authority: string, location: string, store: AdcpStateStore = persistentStore): Promise<void> {
  if (!domain(authority)) throw new TypeError('Invalid publisher authority');
  const parsed = validateLocation(location);
  await patchWithRetry<AuthorityState>(store, COLLECTION, authority, current => ({ ...(current ?? { revoked: [] }), location: parsed.href }));
}

function validateLocation(location: string): URL {
  const parsed = new URL(location);
  if (location.length > 8192 || parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.href.includes('#') || (parsed.port && parsed.port !== '443')) throw new TypeError('Invalid publisher authority');
  return parsed;
}
