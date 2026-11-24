/**
 * The named-format wire of the inventory tenants' creative tasks. The
 * creative library (`creatives.ts`) keys formats by their canonical
 * format_option_id from the seed's product format declarations; this module
 * translates the AdCP 3.x named-format identity buyers send and read
 * (format_id, format_ids) to and from those ids, and is the only inventory
 * module that sees it (`tests/lint-format-identity-boundaries.test.cjs`).
 * A caller's seeded products add their own format options (#9152), which
 * have no named format and are listed by format_kind and format_option_ref.
 */
import { createHash } from 'node:crypto';
import { canonicalize } from '@adcp/sdk';
import { getAgentUrl } from '../config.js';
import { formatOptionsForTrainingFormats } from '../product-factory.js';
import {
  handleListCreativeFormats,
  imageCarouselParamViolation,
  nativeInFeedParamViolation,
  type FormatOptionViolation,
} from '../task-handlers.js';
import type { TrainingContext } from '../types.js';
import type { CreativeError } from './creatives.js';

export interface FormatDeclaration {
  format_option_id: string;
  format_kind: string;
  params?: Record<string, unknown>;
  v1_format_ref?: Array<{ agent_url: string; id: string }>;
  /** A publisher-catalog option's publisher. */
  publisher_domain?: string;
  /** An option a caller's seeded product declares. Its format_option_id is
   * then an internal key (`seededFormats`), and `option_id` is the
   * format_option_id it declares, if any. */
  seeded?: true;
  option_id?: string;
}

/** The options a caller's seeded products declare, and the ones each
 * product serves, by key. */
export interface SeededFormats {
  declarations: FormatDeclaration[];
  byProduct: Map<string, Set<string>>;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The seed's formats (training catalogue ids) as product format declarations. */
export function seedFormatDeclarations(labels: readonly string[]): FormatDeclaration[] {
  return formatOptionsForTrainingFormats([...new Set(labels)], getAgentUrl()) as unknown as FormatDeclaration[];
}

/** The training catalogue id a declaration was made from; a seeded option's
 * own id or kind. */
export function catalogIdOf(declaration: FormatDeclaration): string {
  if (declaration.seeded) return seededLabel(declaration);
  return declaration.v1_format_ref?.[0]?.id ?? declaration.format_option_id;
}

/**
 * Every option a caller's seeded products declare in their fixtures'
 * format_options, including one that names no format_option_id. Each is keyed
 * by its namespace (publisher, or none for a product-local option), id, kind
 * and params, so the same option declared by two products is one format, and
 * two options that share an id but differ in namespace or params are two.
 */
export function seededFormats(products: ReadonlyArray<{ product_id: string; fixture: Record<string, unknown> }>): SeededFormats {
  const declarations = new Map<string, FormatDeclaration>();
  const byProduct = new Map<string, Set<string>>();
  for (const { product_id: productId, fixture } of products) {
    const keys = new Set<string>();
    for (const option of Array.isArray(fixture.format_options) ? fixture.format_options : []) {
      if (!isObject(option) || typeof option.format_kind !== 'string') continue;
      const optionId = typeof option.format_option_id === 'string' ? option.format_option_id : undefined;
      const domain = typeof option.publisher_domain === 'string' ? option.publisher_domain : undefined;
      const params = isObject(option.params) ? option.params : {};
      // Canonical JSON, so the same params in another key order are the same option.
      const identity = canonicalize([domain ?? null, optionId ?? null, option.format_kind, params]);
      const key = `seeded_${createHash('sha256').update(identity).digest('hex').slice(0, 16)}`;
      if (!declarations.has(key)) {
        declarations.set(key, {
          format_option_id: key,
          format_kind: option.format_kind,
          params,
          seeded: true,
          ...(optionId !== undefined && { option_id: optionId }),
          ...(domain !== undefined && { publisher_domain: domain }),
        });
      }
      keys.add(key);
    }
    byProduct.set(productId, keys);
  }
  return { declarations: [...declarations.values()], byProduct };
}

/** A seeded option's name for messages. */
function seededLabel(declaration: FormatDeclaration): string {
  return declaration.option_id ?? declaration.format_kind;
}

/** Every size a creative states: in its params, and on each image or video
 * asset that gives a width and height. */
function statedSizes(input: Json, field: string): Array<{ at: string; width: number; height: number }> {
  const sizes: Array<{ at: string; width: number; height: number }> = [];
  if (isObject(input.params) && typeof input.params.width === 'number' && typeof input.params.height === 'number') {
    sizes.push({ at: `${field}.params`, width: input.params.width, height: input.params.height });
  }
  for (const [key, asset] of Object.entries(isObject(input.assets) ? input.assets : {})) {
    if (!isObject(asset) || typeof asset.width !== 'number' || typeof asset.height !== 'number') continue;
    if (asset.asset_type !== undefined && asset.asset_type !== 'image' && asset.asset_type !== 'video') continue;
    sizes.push({ at: `${field}.assets.${key}`, width: asset.width, height: asset.height });
  }
  return sizes;
}

/**
 * A creative that states a size or duration other than the fixed one its
 * seeded option declares (width and height, duration_ms_exact, else
 * duration_ms_range), in its params or on any of its assets. A creative that
 * states none is not refused here, as on /sales.
 */
function fixedConstraintError(declaration: FormatDeclaration, input: Json, field: string): CreativeError | undefined {
  const params = declaration.params ?? {};
  const label = seededLabel(declaration);
  if (typeof params.width === 'number' && typeof params.height === 'number') {
    const wrong = statedSizes(input, field).find(size => size.width !== params.width || size.height !== params.height);
    if (wrong) {
      return {
        code: 'CREATIVE_SIZE_MISMATCH',
        message: `${label} is ${params.width}x${params.height}; this creative states ${wrong.width}x${wrong.height}`,
        field: wrong.at,
        details: { constraint: 'size', allowed_sizes: [{ width: params.width, height: params.height }], format_option_id: label },
      };
    }
  }
  const exact = typeof params.duration_ms_exact === 'number' ? params.duration_ms_exact : undefined;
  const range = exact === undefined && Array.isArray(params.duration_ms_range) ? params.duration_ms_range : undefined;
  if (exact === undefined && !range) return undefined;
  for (const [key, asset] of Object.entries(isObject(input.assets) ? input.assets : {})) {
    if (!isObject(asset) || typeof asset.duration_ms !== 'number') continue;
    const duration = asset.duration_ms;
    const [min, max] = range ?? [];
    const fits = exact !== undefined
      ? duration === exact
      : (typeof min !== 'number' || duration >= min) && (typeof max !== 'number' || duration <= max);
    if (fits) continue;
    return {
      code: 'VALIDATION_ERROR',
      message: `${label} runs ${exact !== undefined ? `${exact} ms` : `${min ?? 'any'} to ${max ?? 'any'} ms`}; this creative runs ${duration} ms`,
      field: `${field}.assets.${key}.duration_ms`,
      details: { constraint: exact !== undefined ? 'duration_ms_exact' : 'duration_ms_range', declared: exact ?? range, format_option_id: label },
    };
  }
  return undefined;
}

/** The first declared value of a seeded option a creative's assets break
 * (cta_values, image sizes, character limits), by the /sales checks. */
function declaredValueError(declaration: FormatDeclaration, input: Json, field: string): CreativeError | undefined {
  const params = declaration.params ?? {};
  const assets = isObject(input.assets) ? input.assets : {};
  let violation: FormatOptionViolation | null = null;
  if (declaration.format_kind === 'native_in_feed') violation = nativeInFeedParamViolation(assets, params);
  if (declaration.format_kind === 'image_carousel') violation = imageCarouselParamViolation(assets, params);
  if (!violation) return undefined;
  return {
    code: violation.code,
    message: violation.message,
    field: `${field}.${violation.field}`,
    details: {
      constraint: violation.constraint,
      declared: violation.expected,
      ...(violation.code === 'CREATIVE_VALUE_NOT_ALLOWED' && { allowed_values: violation.expected }),
      format_option_id: seededLabel(declaration),
    },
  };
}

/** A creative resolved to a seeded option, refused when it breaks a fixed
 * constraint or a value that option declares. */
function heldToSeededOption(
  seeded: readonly FormatDeclaration[],
  input: Json,
  field: string,
  resolved: { formatOptionId: string } | { error: CreativeError },
): { formatOptionId: string } | { error: CreativeError } {
  if (!('formatOptionId' in resolved)) return resolved;
  const declaration = seeded.find(candidate => candidate.format_option_id === resolved.formatOptionId)!;
  const error = fixedConstraintError(declaration, input, field) ?? declaredValueError(declaration, input, field);
  return error ? { error } : resolved;
}

/**
 * The seeded option a format_option_ref names, in the ref's namespace: a
 * publisher ref the option that publisher declares, a product ref a
 * product-local one and, given `allowed` (a package's product), only one
 * that product declares.
 */
function seededRefFormat(
  seeded: readonly FormatDeclaration[],
  ref: Json,
  refId: string,
  field: string,
  allowed?: ReadonlySet<string>,
): { formatOptionId: string } | { error: CreativeError } {
  const publisher = isPublisherRef(ref);
  const scoped = seeded.filter(candidate => candidate.option_id === refId
    && (publisher ? candidate.publisher_domain === ref.publisher_domain : candidate.publisher_domain === undefined));
  const inContext = scoped.filter(candidate => !allowed || allowed.has(candidate.format_option_id));
  if (inContext.length === 1) return { formatOptionId: inContext[0].format_option_id };
  const at = `${field}.format_option_ref`;
  if (inContext.length > 1) {
    return { error: { code: 'INVALID_REQUEST', message: `The products you seeded declare ${inContext.length} different ${refId} options; reference it from a package of the product you mean`, field: at } };
  }
  const message = scoped.length > 0
    ? `This package's product does not declare ${refId}`
    : `None of the products you seeded declares ${refId}${publisher ? ` for ${String(ref.publisher_domain)}` : ' as a product option'}`;
  return { error: { code: 'FORMAT_NOT_SUPPORTED', message, field: at } };
}

/** A format_option_ref into a publisher's catalog, not a product's own options. */
function isPublisherRef(ref: Json): boolean {
  return ref.scope === 'publisher' || (ref.scope === undefined && typeof ref.publisher_domain === 'string');
}

/**
 * The format of a creative among the seller's own formats and the options
 * of the products the caller seeded. A format_option_ref naming a seeded
 * option resolves within its namespace; a publisher ref never names one of
 * the seller's own options. Anything else resolves against the seller's own
 * formats as before. Only a creative that names no format (no format_id, no
 * format_option_ref) then falls back to the seeded options by kind and
 * params, and their refusal is the one returned when the seller has no
 * format of the creative's kind but a seeded product does. A creative in a
 * seeded option is held to the constraints and values the option declares.
 */
export function resolveSeededCreativeFormat(
  own: readonly FormatDeclaration[],
  seeded: readonly FormatDeclaration[],
  input: Json,
  field: string,
  allowed?: ReadonlySet<string>,
): { formatOptionId: string } | { error: CreativeError } {
  if (seeded.length === 0) return resolveCreativeFormat(own, input, field, allowed);
  const ref = isObject(input.format_option_ref) ? input.format_option_ref : undefined;
  const refId = ref?.format_option_id;
  const explicit = ref !== undefined && typeof refId === 'string';
  if (explicit) {
    const ownNamed = !isPublisherRef(ref) && own.some(candidate => candidate.format_option_id === refId);
    if (!ownNamed && seeded.some(candidate => candidate.option_id === refId)) {
      return heldToSeededOption(seeded, input, field, seededRefFormat(seeded, ref, refId, field, allowed));
    }
  }
  const resolved = resolveCreativeFormat(own, input, field, allowed);
  // A named format_id is the seller's own, and a ref that names no seeded
  // option never picks one by kind.
  if ('formatOptionId' in resolved || isObject(input.format_id) || explicit) return resolved;
  const fallback = resolveCreativeFormat(seeded, input, field, allowed);
  if ('formatOptionId' in fallback) return heldToSeededOption(seeded, input, field, fallback);
  const seededKind = seeded.some(candidate => candidate.format_kind === input.format_kind && (!allowed || allowed.has(candidate.format_option_id)));
  return resolved.error.code === 'FORMAT_NOT_SUPPORTED' && seededKind ? fallback : resolved;
}

/**
 * The format_option_id of a creative, from whichever identity it carries:
 * a named format_id, a canonical format_option_ref, or a canonical
 * format_kind with params (or sized assets) that pick one format. The SDK
 * canonicalizes create_media_buy and update_media_buy creatives; buyers may
 * send any of these to sync_creatives. `allowed` limits a format_kind match
 * to a product's formats.
 */
export function resolveCreativeFormat(
  declarations: readonly FormatDeclaration[],
  input: Json,
  field: string,
  allowed?: ReadonlySet<string>,
): { formatOptionId: string } | { error: CreativeError } {
  const served = declarations.map(catalogIdOf).join(', ');
  const named = input.format_id;
  if (isObject(named) && typeof named.id === 'string') {
    const declaration = declarations.find(candidate => catalogIdOf(candidate) === named.id);
    return declaration
      ? { formatOptionId: declaration.format_option_id }
      : { error: { code: 'FORMAT_NOT_SUPPORTED', message: `This seller serves ${served}; not ${named.id}`, field: `${field}.format_id` } };
  }
  const optionId = isObject(input.format_option_ref) ? input.format_option_ref.format_option_id : undefined;
  const byRef = declarations.find(candidate => candidate.format_option_id === optionId);
  if (byRef) return { formatOptionId: byRef.format_option_id };
  if (typeof input.format_kind === 'string') {
    const byKind = declarations.filter(candidate => candidate.format_kind === input.format_kind
      && (!allowed || allowed.has(candidate.format_option_id)));
    const matched = byParams(byKind, sizeHints(input));
    if (matched.length === 1) return { formatOptionId: matched[0].format_option_id };
    if (matched.length > 1) {
      return { error: { code: 'INVALID_REQUEST', message: `A ${input.format_kind} creative matches ${matched.map(catalogIdOf).join(', ')}; send params (or format_option_ref) that pick one`, field: `${field}.params` } };
    }
    const kinds = byKind.length > 0 ? `${input.format_kind} formats here are ${byKind.map(catalogIdOf).join(', ')}` : `this seller serves ${served}`;
    return { error: { code: 'FORMAT_NOT_SUPPORTED', message: `No format matches this ${input.format_kind} creative; ${kinds}`, field: `${field}.format_kind` } };
  }
  return { error: { code: 'INVALID_REQUEST', message: `Send a format_kind and params, or a format_id, from this seller's formats: ${served}`, field: `${field}.format_kind` } };
}

/** What a canonical creative says about its format beyond format_kind: its
 * params, or failing those the size of its first sized image or video. */
function sizeHints(input: Json): Json {
  if (isObject(input.params)) return input.params;
  for (const asset of isObject(input.assets) ? Object.values(input.assets) : []) {
    if (isObject(asset) && typeof asset.width === 'number' && typeof asset.height === 'number') {
      return { width: asset.width, height: asset.height };
    }
  }
  return {};
}

/** The declarations a creative's hints select. One that declares every hint
 * with the same value wins; otherwise any whose declared params do not
 * contradict the hints (an unsized format takes any size). */
function byParams(candidates: readonly FormatDeclaration[], hints: Json): FormatDeclaration[] {
  const keys = Object.keys(hints);
  if (keys.length === 0) return [...candidates];
  const params = (candidate: FormatDeclaration) => (isObject(candidate.params) ? candidate.params : {});
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const exact = candidates.filter(candidate => keys.every(key => key in params(candidate) && same(params(candidate)[key], hints[key])));
  if (exact.length > 0) return exact;
  return candidates.filter(candidate => keys.every(key => !(key in params(candidate)) || same(params(candidate)[key], hints[key])));
}

/** The format a creative is listed in: its named format or, in a seeded
 * option, which has none, its canonical kind and the option it declares. */
export function wireFormat(declarations: readonly FormatDeclaration[], formatOptionId: string): Json {
  const declaration = declarations.find(candidate => candidate.format_option_id === formatOptionId);
  if (!declaration) return {};
  if (declaration.seeded) {
    const optionId = declaration.option_id;
    return {
      format_kind: declaration.format_kind,
      ...(optionId !== undefined && {
        format_option_ref: declaration.publisher_domain
          ? { scope: 'publisher', publisher_domain: declaration.publisher_domain, format_option_id: optionId }
          : { scope: 'product', format_option_id: optionId },
      }),
    };
  }
  return { format_id: { agent_url: getAgentUrl(), id: catalogIdOf(declaration) } };
}

/** list_creatives filters.format_ids as format_option_ids. */
export function formatFilter(declarations: readonly FormatDeclaration[], filters: Json): ReadonlySet<string> | undefined {
  if (!Array.isArray(filters.format_ids)) return undefined;
  const ids = new Set((filters.format_ids as unknown[]).flatMap(format => (isObject(format) && typeof format.id === 'string' ? [format.id] : [])));
  return new Set(declarations.filter(declaration => ids.has(catalogIdOf(declaration))).map(declaration => declaration.format_option_id));
}

/** list_creative_formats: the training creative catalogue, limited to the
 * formats this seed serves. */
export async function listSeedCreativeFormats(declarations: readonly FormatDeclaration[], req: Json, training: TrainingContext): Promise<object> {
  const served = new Set(declarations.map(catalogIdOf));
  const requested = Array.isArray(req?.format_ids)
    ? (req.format_ids as unknown[]).filter((format): format is Json => isObject(format) && typeof format.id === 'string' && served.has(format.id))
    : [...served].map(id => ({ agent_url: getAgentUrl(), id }));
  if (requested.length === 0) return { formats: [] };
  return handleListCreativeFormats({ ...req, format_ids: requested } as Parameters<typeof handleListCreativeFormats>[0], training);
}
