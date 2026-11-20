/**
 * Season files: load a `SeasonSeed` from YAML or JSON.
 *
 * Loading makes three passes, each reporting every problem it finds:
 * 1. A zod pass checks the shape and dates, with the path of each problem.
 * 2. A reference pass checks what the engine leaves unchecked: product
 *    properties, product collections, the ids traffic events target and,
 *    when the host lists the formats it supports, placement formats.
 * 3. The engine's own checks run through `trafficFor` (shares sum to 1, ids
 *    resolve), which also primes the traffic cache for the returned seed. Then
 *    every product must cover some inventory.
 * Nothing is defaulted here, so a loaded seed equals the one that was written.
 */
import fs from 'node:fs';
import { parseAllDocuments, stringify } from 'yaml';
import { z } from 'zod';
import { EngineError, trafficFor, type SeasonSeed } from './engine/index.js';

/** True when a `YYYY-MM-DD` string names a real day (2027-02-30 does not). */
function isCalendarDate(date: string): boolean {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) === date;
}

const channel = z.enum(['display', 'olv', 'podcast', 'newsletter', 'creator_video']);
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a YYYY-MM-DD date')
  .refine(isCalendarDate, 'not a calendar date');
const installmentChannel = z.enum(['podcast', 'newsletter', 'creator_video']);

const cellRates = z.strictObject({
  viewability: z.number(),
  click_rate: z.number(),
  completion_rate: z.number(),
  conversion_rate: z.number(),
});

const region = z.strictObject({
  region_id: z.string(),
  country: z.string(),
  subdivision: z.string().optional(),
  name: z.string(),
  share: z.number(),
});

const audienceProfile = z.strictObject({
  profile_id: z.string(),
  name: z.string(),
  share: z.number(),
  rate_multipliers: cellRates.partial().optional(),
});

const segment = z.strictObject({
  segment_id: z.string(),
  name: z.string(),
  profile_ids: z.array(z.string()),
});

const property = z.strictObject({
  property_id: z.string(),
  name: z.string(),
  domain: z.string(),
  traffic_multiplier: z.number().optional(),
});

const placement = z.strictObject({
  placement_id: z.string(),
  name: z.string(),
  channel,
  property_ids: z.array(z.string()),
  formats: z.array(z.string()),
  base_daily_impressions: z.number().optional(),
  floor_cpm: z.number(),
  rates: cellRates,
  reporting_lag_days: z.number(),
});

const product = z.strictObject({
  product_id: z.string(),
  name: z.string(),
  description: z.string(),
  delivery_type: z.enum(['guaranteed', 'non_guaranteed']),
  placement_ids: z.array(z.string()),
  property_ids: z.array(z.string()).optional(),
  segment_id: z.string().optional(),
  rate_cpm: z.number().optional(),
  share_of_voice: z.number().optional(),
  collection_ids: z.array(z.string()).optional(),
});

const collection = z.strictObject({
  collection_id: z.string(),
  name: z.string(),
  channel: installmentChannel,
  property_id: z.string(),
  placement_id: z.string(),
  first_date: isoDate,
  cadence_days: z.number(),
  count: z.number(),
  expected_audience: z.number(),
  audience_sigma: z.number(),
});

const event = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('traffic_multiplier'),
    event_id: z.string(),
    description: z.string(),
    start_date: isoDate,
    end_date: isoDate,
    multiplier: z.number(),
    placement_ids: z.array(z.string()).optional(),
    property_ids: z.array(z.string()).optional(),
    region_ids: z.array(z.string()).optional(),
  }),
  z.strictObject({
    type: z.literal('installment_postponed'),
    event_id: z.string(),
    description: z.string(),
    installment_id: z.string(),
    to_date: isoDate,
  }),
  z.strictObject({
    type: z.literal('installment_cancelled'),
    event_id: z.string(),
    description: z.string(),
    installment_id: z.string(),
  }),
]);

export const seasonSeedSchema = z.strictObject({
  seed_id: z.string(),
  rng_seed: z.string(),
  start_date: isoDate,
  days: z.number(),
  currency: z.string(),
  regions: z.array(region),
  audience_profiles: z.array(audienceProfile),
  segments: z.array(segment),
  properties: z.array(property),
  placements: z.array(placement),
  products: z.array(product),
  collections: z.array(collection).optional(),
  traffic: z.strictObject({
    weekday_shape: z.array(z.number()),
    trend_per_day: z.number().optional(),
  }),
  forecast_error: z.strictObject({
    bias: z.number().optional(),
    day_sigma: z.number(),
    cell_sigma: z.number(),
  }),
  events: z.array(event).optional(),
});

/** Compile-time check that the schema and `SeasonSeed` are the same type,
 * optional fields included: a field added to one and not the other fails
 * `npm run typecheck`. */
type Equals<A, B> = (<X>() => X extends A ? 1 : 2) extends (<X>() => X extends B ? 1 : 2) ? true : false;
const schemaMatchesType: Equals<z.infer<typeof seasonSeedSchema>, SeasonSeed> = true;
void schemaMatchesType;

function invalid(source: string, lines: string[]): never {
  throw new EngineError('INVALID_SEED', `Season ${source} is invalid:\n${lines.map(line => `  ${line}`).join('\n')}`);
}

function dottedPath(path: ReadonlyArray<PropertyKey>): string {
  let out = '';
  for (const part of path) {
    if (typeof part === 'number') out += `[${part}]`;
    else out += out ? `.${String(part)}` : String(part);
  }
  return out || '(root)';
}

/** What the host that loads a season can serve. */
export interface SeasonFileOptions {
  /** The format labels the host maps onto its format catalogue. When given,
   * a placement format outside it is refused. */
  formats?: ReadonlySet<string>;
}

/** References the engine does not resolve: a product's `property_ids` and
 * `collection_ids`, and the ids a traffic event targets. Each would load and
 * then match nothing. With `formats`, also placement formats the host does
 * not know. */
function referenceProblems(seed: SeasonSeed, formats?: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  if (formats) {
    let unsupported = false;
    seed.placements.forEach((placement, i) => {
      placement.formats.forEach((format, j) => {
        if (formats.has(format)) return;
        unsupported = true;
        problems.push(`placements[${i}].formats[${j}]: unsupported format ${format}`);
      });
    });
    if (unsupported) problems.push(`supported formats: ${[...formats].sort().join(', ')}`);
  }
  const propertyIds = new Set(seed.properties.map(p => p.property_id));
  const placementIds = new Set(seed.placements.map(p => p.placement_id));
  const regionIds = new Set(seed.regions.map(r => r.region_id));
  const placements = new Map(seed.placements.map(p => [p.placement_id, p]));
  const check = (path: string, ids: string[] | undefined, known: Set<string>, kind: string) => {
    ids?.forEach((id, j) => {
      if (!known.has(id)) problems.push(`${path}[${j}]: unknown ${kind} ${id}`);
    });
  };
  seed.products.forEach((product, i) => {
    const served = new Set(product.placement_ids.flatMap(id => placements.get(id)?.property_ids ?? []));
    product.property_ids?.forEach((id, j) => {
      const path = `products[${i}].property_ids[${j}]`;
      if (!propertyIds.has(id)) problems.push(`${path}: unknown property ${id}`);
      else if (!served.has(id)) problems.push(`${path}: property ${id} is not on any of the product's placements`);
    });
  });
  const collections = new Map((seed.collections ?? []).map(c => [c.collection_id, c]));
  seed.products.forEach((product, i) => {
    product.collection_ids?.forEach((id, j) => {
      const collection = collections.get(id);
      if (collection && !product.placement_ids.includes(collection.placement_id)) {
        problems.push(`products[${i}].collection_ids[${j}]: collection ${id} is not on any of the product's placements`);
      }
    });
  });
  (seed.events ?? []).forEach((event, i) => {
    if (event.type !== 'traffic_multiplier') return;
    check(`events[${i}].placement_ids`, event.placement_ids, placementIds, 'placement');
    check(`events[${i}].property_ids`, event.property_ids, propertyIds, 'property');
    check(`events[${i}].region_ids`, event.region_ids, regionIds, 'region');
  });
  return problems;
}

/** Validate `input` as a season seed. `source` names it in error messages. */
export function parseSeasonSeed(input: unknown, source: string, options: SeasonFileOptions = {}): SeasonSeed {
  const parsed = seasonSeedSchema.safeParse(input);
  if (!parsed.success) {
    invalid(source, parsed.error.issues.map(issue => `${dottedPath(issue.path)}: ${issue.message}`));
  }
  const seed: SeasonSeed = parsed.data;
  const problems = referenceProblems(seed, options.formats);
  if (problems.length > 0) invalid(source, problems);
  let traffic;
  try {
    traffic = trafficFor(seed);
  } catch (error) {
    if (error instanceof Error) invalid(source, [error.message]);
    throw error;
  }
  const uncovered = seed.products
    .map((product, i) => ({ product, i }))
    .filter(({ product }) => traffic.eligibleCells(product.product_id).length === 0)
    .map(({ product, i }) => `products[${i}]: product ${product.product_id} covers no inventory`);
  if (uncovered.length > 0) invalid(source, uncovered);
  return seed;
}

/** Read a YAML or JSON season file (JSON is valid YAML). */
export function readSeasonFile(path: string, options: SeasonFileOptions = {}): SeasonSeed {
  const text = fs.readFileSync(path, 'utf8');
  const documents = parseAllDocuments(text, { schema: 'core' });
  if (documents.length > 1) invalid(path, ['a season file must hold one document, found several']);
  const document = documents[0];
  if (!document || document.contents === null) invalid(path, ['the file is empty']);
  if (document.errors.length > 0) {
    invalid(path, document.errors.map(error => {
      const pos = error.linePos?.[0];
      return `${path}${pos ? `:${pos.line}:${pos.col}` : ''}: ${error.message.split('\n')[0]}`;
    }));
  }
  return parseSeasonSeed(document.toJS(), path, options);
}

/** Serialize a season as YAML that `readSeasonFile` loads back unchanged. */
export function seasonToYaml(seed: SeasonSeed): string {
  return stringify(seed, { schema: 'core' });
}
