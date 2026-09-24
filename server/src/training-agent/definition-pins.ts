import { createHash } from 'node:crypto';
import { canonicalize } from '@adcp/sdk';

export type DefinitionPinKind =
  | 'publisher_format_option'
  | 'publisher_placement'
  | 'publisher_collection'
  | 'data_provider_signal';

export type DefinitionPin = {
  ref_kind: DefinitionPinKind;
  reference: Record<string, string>;
  content_digest: string;
  source_version?: string;
};

const EXCLUDED_FIELDS = new Set([
  'name',
  'description',
  'ext',
  'created_at',
  'updated_at',
  'last_updated',
  'timestamp',
  'talent',
  'tags',
]);
const SET_ARRAY_FIELDS = new Set([
  'allowed_values',
  'channels',
  'collection_ids',
  'format_option_ids',
  'placement_ids',
  'property_ids',
  'signal_ids',
  'tags',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function projection(value: unknown, fieldName?: string): unknown {
  if (Array.isArray(value)) {
    const projected = value.map(entry => projection(entry));
    if (!SET_ARRAY_FIELDS.has(fieldName ?? '')) return projected;
    const unique = new Map(projected.map(entry => [canonicalize(entry), entry]));
    return [...unique.values()].sort((left, right) => canonicalize(left).localeCompare(canonicalize(right)));
  }
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !EXCLUDED_FIELDS.has(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, projection(entry, key)]),
  );
}

export function definitionContentDigest(definition: unknown): string {
  return createHash('sha256')
    .update(canonicalize(projection(definition)), 'utf8')
    .digest('hex');
}

export function makeDefinitionPin(
  ref_kind: DefinitionPinKind,
  reference: Record<string, string>,
  definition: unknown,
  source_version?: string,
): DefinitionPin {
  return {
    ref_kind,
    reference: structuredClone(reference),
    content_digest: definitionContentDigest(definition),
    ...(source_version && { source_version }),
  };
}

export function sortDefinitionPins(pins: DefinitionPin[]): DefinitionPin[] {
  return [...pins].sort((left, right) => canonicalize(left).localeCompare(canonicalize(right)));
}

function referencesIn(value: unknown, output: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    value.forEach(entry => referencesIn(entry, output));
    return output;
  }
  if (!isRecord(value)) return output;
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'format_option_ref' || key === 'placement_ref' || key === 'collection_ref' || key === 'signal_ref') {
      if (isRecord(entry)) output.push({ kind: key, ...entry });
    }
    if (key === 'format_option_refs' || key === 'placement_refs' || key === 'collection_refs') {
      const kind = key.slice(0, -1);
      if (Array.isArray(entry)) {
        for (const reference of entry) {
          if (isRecord(reference)) output.push({ kind, ...reference });
        }
      }
    }
    referencesIn(entry, output);
  }
  return output;
}

function sameReference(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return canonicalize(left) === canonicalize(right);
}

function findDefinition(product: Record<string, unknown>, reference: Record<string, unknown>): unknown {
  const kind = reference.kind;
  const identity = { ...reference };
  delete identity.kind;
  const collections = Array.isArray(product.collections) ? product.collections : [];
  const placements = Array.isArray(product.placements) ? product.placements : [];
  const formats = Array.isArray(product.format_options) ? product.format_options : [];
  const signalOptions = Array.isArray(product.signal_targeting_options) ? product.signal_targeting_options : [];
  const candidates = kind === 'format_option_ref'
    ? formats
    : kind === 'placement_ref'
      ? placements
      : kind === 'collection_ref'
        ? collections
        : signalOptions;
  return candidates.find(candidate => isRecord(candidate) && (
    sameReference(reference, { kind, ...(candidate as Record<string, unknown>) })
      || (kind === 'format_option_ref'
        && reference.format_option_id === candidate.format_option_id
        && reference.publisher_domain === candidate.publisher_domain)
      || (kind === 'placement_ref'
        && reference.placement_id === candidate.placement_id
        && (!reference.publisher_domain || reference.publisher_domain === candidate.publisher_domain))
      || (kind === 'collection_ref'
        && reference.collection_id === candidate.collection_id
        && reference.publisher_domain === candidate.publisher_domain)
      || (kind === 'signal_ref'
        && isRecord(candidate.signal_ref)
        && canonicalize(identity) === canonicalize(candidate.signal_ref))
  ));
}

export function buildDefinitionPins(
  purchases: readonly unknown[],
  products: ReadonlyMap<string, unknown>,
): DefinitionPin[] {
  const pins: DefinitionPin[] = [];
  for (const purchase of purchases) {
    if (!isRecord(purchase) || typeof purchase.product_id !== 'string') continue;
    const product = products.get(purchase.product_id);
    if (!isRecord(product)) continue;
    for (const reference of referencesIn(purchase)) {
      const definition = findDefinition(product, reference);
      if (definition === undefined) continue;
      const kind = reference.kind === 'format_option_ref'
        ? (reference.scope === 'publisher' ? 'publisher_format_option' : undefined)
        : reference.kind === 'placement_ref'
          ? (typeof reference.publisher_domain === 'string' ? 'publisher_placement' : undefined)
          : reference.kind === 'collection_ref'
            ? 'publisher_collection'
            : reference.kind === 'signal_ref' && reference.scope === 'data_provider'
              ? 'data_provider_signal'
              : undefined;
      if (!kind) continue;
      const { kind: _kind, ...identity } = reference;
      const pin = makeDefinitionPin(kind, identity as Record<string, string>, definition);
      if (!pins.some(existing => canonicalize(existing) === canonicalize(pin))) pins.push(pin);
    }
  }
  return sortDefinitionPins(pins);
}

