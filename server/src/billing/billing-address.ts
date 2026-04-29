import type { BillingAddress } from '../db/organization-db.js';

const MAX_ADDR_FIELD = 200;

/**
 * Return a billing address with only known fields and each string capped at
 * MAX_ADDR_FIELD characters. Returns null if any required field is missing
 * or exceeds the cap. We persist this to JSONB and pass it to Stripe —
 * tightening here keeps malformed or attacker-controlled data out of both.
 */
export function sanitizeBillingAddress(input: unknown): BillingAddress | null {
  if (!input || typeof input !== 'object') return null;
  const a = input as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const line1 = str(a.line1).trim();
  const line2 = str(a.line2).trim();
  const city = str(a.city).trim();
  const state = str(a.state).trim();
  const postalCode = str(a.postal_code).trim();
  const country = str(a.country).trim();
  if (!line1 || !city || !state || !postalCode || !country) return null;
  for (const f of [line1, line2, city, state, postalCode, country]) {
    if (f.length > MAX_ADDR_FIELD) return null;
  }
  const out: BillingAddress = {
    line1,
    city,
    state,
    postal_code: postalCode,
    country,
  };
  if (line2) out.line2 = line2;
  return out;
}
