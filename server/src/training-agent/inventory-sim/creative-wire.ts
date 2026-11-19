/**
 * The named-format wire of the inventory tenants' creative tasks. The
 * creative library (`creatives.ts`) keys formats by their canonical
 * format_option_id from the seed's product format declarations; this module
 * translates the AdCP 3.x named-format identity buyers send and read
 * (format_id, format_ids) to and from those ids, and is the only inventory
 * module that sees it (`tests/lint-format-identity-boundaries.test.cjs`).
 */
import { getAgentUrl } from '../config.js';
import { formatOptionsForTrainingFormats } from '../product-factory.js';
import { handleListCreativeFormats } from '../task-handlers.js';
import type { TrainingContext } from '../types.js';
import type { CreativeError } from './creatives.js';

export interface FormatDeclaration {
  format_option_id: string;
  format_kind: string;
  v1_format_ref?: Array<{ agent_url: string; id: string }>;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The seed's formats (training catalogue ids) as product format declarations. */
export function seedFormatDeclarations(labels: readonly string[]): FormatDeclaration[] {
  return formatOptionsForTrainingFormats([...new Set(labels)], getAgentUrl()) as unknown as FormatDeclaration[];
}

/** The training catalogue id a declaration was made from. */
export function catalogIdOf(declaration: FormatDeclaration): string {
  return declaration.v1_format_ref?.[0]?.id ?? declaration.format_option_id;
}

/**
 * The format_option_id of a creative, from whichever identity it carries:
 * a named format_id (sync_creatives), or a canonical format_option_ref or
 * format_kind (create_media_buy and update_media_buy, which the SDK
 * canonicalizes). `allowed` limits a format_kind match to a product's
 * formats.
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
    if (byKind.length === 1) return { formatOptionId: byKind[0].format_option_id };
    return { error: { code: 'FORMAT_NOT_SUPPORTED', message: `This seller serves ${served}; send the format_id from the product's format_options`, field: `${field}.format_kind` } };
  }
  return { error: { code: 'INVALID_REQUEST', message: `Send a format_id from this seller's formats: ${served}`, field: `${field}.format_id` } };
}

/** The named format a creative is listed in. */
export function wireFormat(declarations: readonly FormatDeclaration[], formatOptionId: string): Json {
  const declaration = declarations.find(candidate => candidate.format_option_id === formatOptionId);
  return declaration ? { format_id: { agent_url: getAgentUrl(), id: catalogIdOf(declaration) } } : {};
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
