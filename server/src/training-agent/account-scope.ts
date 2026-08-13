import type { AccountRef } from './types.js';

const ACCOUNT_ID_KEYS = new Set(['account_id']);
const NATURAL_ACCOUNT_KEYS = new Set(['brand', 'operator', 'operator_region', 'sandbox']);
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;
const BRAND_ID_RE = /^[a-z0-9_]+$/;
const MARKET_RE = /^[A-Z]{2}$/;
const OPERATOR_REGION_RE = /^[a-z0-9][a-z0-9_-]*$/;
const MAX_DOMAIN_LENGTH = 253;
const MAX_OPERATOR_REGION_LENGTH = 64;

export type CanonicalAccountRef =
  | { kind: 'account_id'; account_id: string }
  | {
      kind: 'natural';
      brand: { domain: string; brand_id?: string; market?: string };
      operator: string;
      operator_region?: string;
      sandbox: boolean;
    };

export class AccountRefValidationError extends Error {
  readonly field = 'account';

  constructor(message: string) {
    super(message);
    this.name = 'AccountRefValidationError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalid(message: string): never {
  throw new AccountRefValidationError(message);
}

function normalizedDomain(value: unknown, field: string): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_DOMAIN_LENGTH
    || !DOMAIN_RE.test(value)
  ) {
    return invalid(`${field} must be a valid domain name.`);
  }
  return value.toLowerCase();
}

/**
 * Validate AccountRef's exact-oneOf identity and return only canonical fields.
 *
 * AccountRef is a closed union: either the sole `account_id` field, or the
 * natural `brand` + `operator` identity with optional `sandbox`. Checking
 * property presence (rather than truthiness) ensures mixed, incomplete, and
 * unknown shapes cannot be silently interpreted as a different account.
 */
export function canonicalizeAccountRef(value: unknown): CanonicalAccountRef {
  if (!isRecord(value)) invalid('account must be an object.');

  const keys = Object.keys(value);
  const hasAccountId = Object.prototype.hasOwnProperty.call(value, 'account_id');
  const hasNaturalField = keys.some(key => NATURAL_ACCOUNT_KEYS.has(key));

  if (hasAccountId && hasNaturalField) {
    invalid('account must use exactly one identity: account_id or brand + operator.');
  }

  if (hasAccountId) {
    const unknown = keys.filter(key => !ACCOUNT_ID_KEYS.has(key));
    if (unknown.length > 0) {
      invalid(`account_id references do not allow field '${unknown[0]}'.`);
    }
    if (typeof value.account_id !== 'string' || value.account_id.length === 0) {
      invalid('account.account_id must be a non-empty string.');
    }
    return { kind: 'account_id', account_id: value.account_id };
  }

  const unknown = keys.filter(key => !NATURAL_ACCOUNT_KEYS.has(key));
  if (unknown.length > 0) {
    invalid(`natural account references do not allow field '${unknown[0]}'.`);
  }
  if (!Object.prototype.hasOwnProperty.call(value, 'brand')
    || !Object.prototype.hasOwnProperty.call(value, 'operator')) {
    invalid('account must use exactly one identity: account_id or brand + operator.');
  }
  if (!isRecord(value.brand)) invalid('account.brand must be an object.');

  const domain = normalizedDomain(value.brand.domain, 'account.brand.domain');
  const operator = normalizedDomain(value.operator, 'account.operator');
  let brandId: string | undefined;
  if (Object.prototype.hasOwnProperty.call(value.brand, 'brand_id')) {
    if (typeof value.brand.brand_id !== 'string' || !BRAND_ID_RE.test(value.brand.brand_id)) {
      invalid('account.brand.brand_id must contain lowercase letters, digits, or underscores.');
    }
    brandId = value.brand.brand_id;
  }
  let market: string | undefined;
  if (Object.prototype.hasOwnProperty.call(value.brand, 'market')) {
    if (typeof value.brand.market !== 'string' || !MARKET_RE.test(value.brand.market)) {
      invalid('account.brand.market must be an ISO 3166-1 alpha-2 country code.');
    }
    market = value.brand.market;
  }
  let operatorRegion: string | undefined;
  if (Object.prototype.hasOwnProperty.call(value, 'operator_region')) {
    if (
      typeof value.operator_region !== 'string'
      || value.operator_region.length > MAX_OPERATOR_REGION_LENGTH
      || !OPERATOR_REGION_RE.test(value.operator_region)
    ) {
      invalid('account.operator_region must be a lowercase operator-defined region identifier.');
    }
    operatorRegion = value.operator_region;
  }
  if (value.sandbox !== undefined && typeof value.sandbox !== 'boolean') {
    invalid('account.sandbox must be a boolean when provided.');
  }

  return {
    kind: 'natural',
    brand: {
      domain,
      ...(brandId !== undefined && { brand_id: brandId }),
      ...(market !== undefined && { market }),
    },
    operator,
    ...(operatorRegion !== undefined && { operator_region: operatorRegion }),
    sandbox: value.sandbox ?? false,
  };
}

/** Stable account partition shared by sessions and idempotency claims. */
export function accountScopeFromRef(value: AccountRef | unknown): string {
  const account = canonicalizeAccountRef(value);
  if (account.kind === 'account_id') return `a:${account.account_id}`;
  const base = [
    'n',
    account.brand.domain,
    account.brand.brand_id ?? '-',
    account.operator,
    account.sandbox ? '1' : '0',
  ].join(':');
  if (account.brand.market === undefined && account.operator_region === undefined) return base;
  return [
    base,
    'm',
    account.brand.market ?? '-',
    'r',
    account.operator_region ?? '-',
  ].join(':');
}
