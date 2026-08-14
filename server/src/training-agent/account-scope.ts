import type { AccountRef, OperatorUnit } from './types.js';

const ACCOUNT_ID_KEYS = new Set(['account_id']);
const NATURAL_ACCOUNT_KEYS = new Set(['brand', 'operator', 'operator_unit', 'currency', 'sandbox']);
const BRAND_REF_KEYS = new Set([
  'domain',
  'brand_id',
  'countries',
  'industries',
  'data_subject_contestation',
  'brand_kit_override',
]);
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;
const BRAND_ID_RE = /^[a-z0-9_]+$/;
const COUNTRY_RE = /^[A-Z]{2}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const OPERATOR_UNIT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const MAX_DOMAIN_LENGTH = 253;
const MAX_OPERATOR_UNIT_ID_LENGTH = 255;
const MAX_OPERATOR_UNIT_NAME_LENGTH = 200;

export type CanonicalAccountRef =
  | { kind: 'account_id'; account_id: string }
  | {
      kind: 'natural';
      brand: { domain: string; brand_id?: string; countries?: string[] };
      operator: string;
      operator_unit?: OperatorUnit;
      currency?: string;
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
 * natural advertiser identity with optional operator unit, fixed currency,
 * and sandbox disposition. Checking
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
  const unknownBrandKey = Object.keys(value.brand).find(key => !BRAND_REF_KEYS.has(key));
  if (unknownBrandKey) invalid(`account.brand does not allow field '${unknownBrandKey}'.`);

  const domain = normalizedDomain(value.brand.domain, 'account.brand.domain');
  const operator = normalizedDomain(value.operator, 'account.operator');
  let brandId: string | undefined;
  if (Object.prototype.hasOwnProperty.call(value.brand, 'brand_id')) {
    if (typeof value.brand.brand_id !== 'string' || !BRAND_ID_RE.test(value.brand.brand_id)) {
      invalid('account.brand.brand_id must contain lowercase letters, digits, or underscores.');
    }
    brandId = value.brand.brand_id;
  }
  let countries: string[] | undefined;
  if (Object.prototype.hasOwnProperty.call(value.brand, 'countries')) {
    if (
      !Array.isArray(value.brand.countries)
      || value.brand.countries.length === 0
      || value.brand.countries.some(country => typeof country !== 'string' || !COUNTRY_RE.test(country))
      || new Set(value.brand.countries).size !== value.brand.countries.length
    ) {
      invalid('account.brand.countries must be a non-empty unique array of ISO 3166-1 alpha-2 country codes.');
    }
    countries = [...value.brand.countries].sort();
  }
  let operatorUnit: OperatorUnit | undefined;
  if (Object.prototype.hasOwnProperty.call(value, 'operator_unit')) {
    if (!isRecord(value.operator_unit)) invalid('account.operator_unit must be an object.');
    const unitKeys = Object.keys(value.operator_unit);
    const unknownUnitKey = unitKeys.find(key => key !== 'id' && key !== 'name');
    if (unknownUnitKey) invalid(`account.operator_unit does not allow field '${unknownUnitKey}'.`);
    if (
      typeof value.operator_unit.id !== 'string'
      || value.operator_unit.id.length > MAX_OPERATOR_UNIT_ID_LENGTH
      || !OPERATOR_UNIT_ID_RE.test(value.operator_unit.id)
    ) {
      invalid('account.operator_unit.id must be a stable operator-defined identifier.');
    }
    if (
      value.operator_unit.name !== undefined
      && (
        typeof value.operator_unit.name !== 'string'
        || value.operator_unit.name.length === 0
        || value.operator_unit.name.length > MAX_OPERATOR_UNIT_NAME_LENGTH
      )
    ) {
      invalid('account.operator_unit.name must be a non-empty string of at most 200 characters.');
    }
    operatorUnit = {
      id: value.operator_unit.id,
      ...(typeof value.operator_unit.name === 'string' && { name: value.operator_unit.name }),
    };
  }
  let currency: string | undefined;
  if (Object.prototype.hasOwnProperty.call(value, 'currency')) {
    if (typeof value.currency !== 'string' || !CURRENCY_RE.test(value.currency)) {
      invalid('account.currency must be an ISO 4217 currency code.');
    }
    currency = value.currency;
  }
  if (value.sandbox !== undefined && typeof value.sandbox !== 'boolean') {
    invalid('account.sandbox must be a boolean when provided.');
  }

  return {
    kind: 'natural',
    brand: {
      domain,
      ...(brandId !== undefined && { brand_id: brandId }),
      ...(countries !== undefined && { countries }),
    },
    operator,
    ...(operatorUnit !== undefined && { operator_unit: operatorUnit }),
    ...(currency !== undefined && { currency }),
    sandbox: value.sandbox ?? false,
  };
}

/** Stable account partition shared by sessions and idempotency claims. */
export function accountScopeFromRef(value: AccountRef | unknown): string {
  const account = canonicalizeAccountRef(value);
  if (account.kind === 'account_id') return `a:${account.account_id}`;
  return `n:${JSON.stringify({
    brand: account.brand,
    operator: account.operator,
    operator_unit_id: account.operator_unit?.id ?? null,
    currency: account.currency ?? null,
    sandbox: account.sandbox,
  })}`;
}
