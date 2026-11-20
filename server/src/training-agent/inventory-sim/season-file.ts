/**
 * Season files: load a `SeasonSeed` from YAML or JSON.
 *
 * A zod pass checks the shape and reports every problem with its path; the
 * engine's own checks (shares sum to 1, references resolve) then run through
 * `trafficFor`, which also primes the traffic cache for the returned seed.
 * Nothing is defaulted here, so a loaded seed equals the one that was written.
 */
import fs from 'node:fs';
import { parseAllDocuments, stringify } from 'yaml';
import { z } from 'zod';
import { EngineError, trafficFor, type SeasonSeed } from './engine/index.js';

const channel = z.enum(['display', 'olv', 'podcast', 'newsletter', 'creator_video']);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a YYYY-MM-DD date');
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

/** Validate `input` as a season seed. `source` names it in error messages. */
export function parseSeasonSeed(input: unknown, source: string): SeasonSeed {
  const parsed = seasonSeedSchema.safeParse(input);
  if (!parsed.success) {
    invalid(source, parsed.error.issues.map(issue => `${dottedPath(issue.path)}: ${issue.message}`));
  }
  const seed: SeasonSeed = parsed.data;
  try {
    trafficFor(seed);
  } catch (error) {
    if (error instanceof EngineError && error.code === 'INVALID_SEED') invalid(source, [error.message]);
    throw error;
  }
  return seed;
}

/** Read a YAML or JSON season file (JSON is valid YAML). */
export function readSeasonFile(path: string): SeasonSeed {
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
  return parseSeasonSeed(document.toJS(), path);
}

/** Serialize a season as YAML that `readSeasonFile` loads back unchanged. */
export function seasonToYaml(seed: SeasonSeed): string {
  return stringify(seed, { schema: 'core' });
}
