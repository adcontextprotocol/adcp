/**
 * Season files: load a `SeasonSeed` from YAML or JSON.
 *
 * A file over `MAX_SEASON_FILE_BYTES` is refused before it is read.
 * Loading makes four passes, each reporting every problem it finds:
 * 1. A zod pass checks the shape, dates, number ranges and the values tenants put on the wire
 *    (currency code, domains, formats present, floors), with the path of each problem.
 *    For `forecast_error`, `traffic.month_shape` and `traffic.truth_daily_sigma` it checks
 *    the shape only; their ranges come from the engine's `forecastErrorProblems`.
 * 2. A reference pass checks what the engine leaves unchecked: product
 *    properties, product collections, the ids traffic events target, that
 *    every collection's installments and postponements fall inside the season
 *    and, when the host lists the formats it supports, placement formats. It
 *    also reports every `forecastErrorProblems` problem, with its path.
 * 3. The engine's own checks run through `trafficFor` (shares sum to 1, ids
 *    resolve), which also primes the traffic cache for the returned seed.
 * 4. Every product must cover some inventory.
 * Nothing is defaulted here, so a loaded seed equals the one that was written.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { parseAllDocuments, stringify } from 'yaml';
import { z } from 'zod';
import { DAY_MS, EngineError, SeasonCalendar, forecastErrorProblems, parseDate, trafficFor, type SeasonSeed } from './engine/index.js';

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/** True when a `YYYY-MM-DD` string names a real day (2027-02-30 does not).
 * A string of any other shape passes, so the shape message speaks alone. */
function isCalendarDate(date: string): boolean {
  if (!DATE_SHAPE.test(date)) return true;
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) === date;
}

const channel = z.enum(['display', 'olv', 'podcast', 'newsletter', 'creator_video']);
const isoDate = z
  .string()
  .regex(DATE_SHAPE, 'must be a YYYY-MM-DD date')
  .refine(isCalendarDate, 'not a calendar date');
/** The AdCP currency code and publisher domain patterns: tenants send both
 * as they are in the season. */
const currencyCode = z.string().regex(/^[A-Z]{3}$/, 'must be a three-letter upper-case currency code such as USD');
const publisherDomain = z
  .string()
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/, 'must be a lower-case hostname such as news.example');
const installmentChannel = z.enum(['podcast', 'newsletter', 'creator_video']);

/** Range checks. Each stays a `number`, so the schema keeps matching `SeasonSeed`. */
const atLeastZero = z.number().min(0, 'must be 0 or more');
const wholeDays = (min: number) =>
  z
    .number()
    .int(`must be a whole number, ${min} or more`)
    .min(min, `must be a whole number, ${min} or more`);
const rate = z.number().min(0, 'must be between 0 and 1').max(1, 'must be between 0 and 1');

const cellRates = z.strictObject({
  viewability: rate,
  click_rate: rate,
  completion_rate: rate,
  conversion_rate: rate,
});

const rateMultipliers = z.strictObject({
  viewability: atLeastZero,
  click_rate: atLeastZero,
  completion_rate: atLeastZero,
  conversion_rate: atLeastZero,
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
  rate_multipliers: rateMultipliers.partial().optional(),
});

const segment = z.strictObject({
  segment_id: z.string(),
  name: z.string(),
  profile_ids: z.array(z.string()),
});

const property = z.strictObject({
  property_id: z.string(),
  name: z.string(),
  domain: publisherDomain,
  traffic_multiplier: atLeastZero.optional(),
  publisher_id: z.string().optional(),
});

const placement = z.strictObject({
  placement_id: z.string(),
  name: z.string(),
  channel,
  property_ids: z.array(z.string()),
  formats: z.array(z.string()).min(1, 'needs at least one format'),
  base_daily_impressions: z.number().optional(),
  floor_cpm: atLeastZero,
  rates: cellRates,
  reporting_lag_days: wholeDays(0),
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
  share_of_voice: z
    .number()
    .gt(0, 'must be above 0 and at most 1')
    .max(1, 'must be above 0 and at most 1')
    .optional(),
  collection_ids: z.array(z.string()).optional(),
});

const collection = z.strictObject({
  collection_id: z.string(),
  name: z.string(),
  channel: installmentChannel,
  property_id: z.string(),
  placement_id: z.string(),
  first_date: isoDate,
  cadence_days: wholeDays(1),
  count: wholeDays(1),
  expected_audience: atLeastZero,
  audience_sigma: atLeastZero,
});

/** The shape of the forecast error and of `traffic.month_shape` / `traffic.truth_daily_sigma`.
 * Their ranges are checked by `forecastErrorProblems`, which the engine shares. */
const publisherForecastError = z.strictObject({
  publisher_id: z.string(),
  bias: z.number(),
  bias_sigma: z.number().optional(),
  error_scale: z.number().optional(),
});

const spikes = z.strictObject({
  per_publisher_min: z.number(),
  per_publisher_max: z.number(),
  size_min: z.number(),
  size_max: z.number(),
  decay: z.number(),
  decay_forecast_sigma: z.number(),
});

const forecastError = z.strictObject({
  channel_sigma: z.partialRecord(channel, z.number()),
  ar1_phi: z.number(),
  lead_time_tau_days: z.number(),
  lead_time_horizon_days: z.number(),
  log_clip: z.number(),
  cell_kappa: z.number(),
  cell_min_impressions: z.number(),
  publishers: z.array(publisherForecastError).optional(),
  spikes: spikes.optional(),
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

export const seasonSeedSchema = z
  .strictObject({
    seed_id: z.string(),
    rng_seed: z.string(),
    start_date: isoDate,
    days: z.number(),
    currency: currencyCode,
    regions: z.array(region),
    audience_profiles: z.array(audienceProfile),
    segments: z.array(segment),
    properties: z.array(property),
    placements: z.array(placement).min(1, 'needs at least one placement'),
    products: z.array(product).min(1, 'needs at least one product'),
    collections: z.array(collection).optional(),
    traffic: z.strictObject({
      weekday_shape: z.array(atLeastZero),
      trend_per_day: z.number().optional(),
      month_shape: z.array(z.number()).optional(),
      truth_daily_sigma: z.number().optional(),
    }),
    forecast_error: forecastError,
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

/** The largest season file the loader reads. */
export const MAX_SEASON_FILE_BYTES = 5_000_000;

/** What the host that loads a season can serve. */
export interface SeasonFileOptions {
  /** The format labels the host maps onto its format catalogue. When given,
   * a placement format outside it is refused. */
  formats?: ReadonlySet<string>;
}

const MAX_DATE_MS = 8.64e15;

/** A day's ISO date, or undefined when the instant is beyond JavaScript's Date range. */
function dateIfRepresentable(calendar: SeasonCalendar, day: number): string | undefined {
  return Math.abs(calendar.startMs + day * DAY_MS) <= MAX_DATE_MS ? calendar.dateOf(day) : undefined;
}

/** References the engine does not resolve: a product's `property_ids` and
 * `collection_ids`, the ids a traffic event targets and the installments and
 * postponements that fall outside the season; each would load and then match
 * nothing. Then every forecast error and traffic shape problem, from the engine's
 * own `forecastErrorProblems`. With `formats`, also placement formats the host
 * does not know, followed by the supported-formats line. */
function referenceProblems(seed: SeasonSeed, formats?: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  let unsupported = false;
  if (formats) {
    seed.placements.forEach((placement, i) => {
      placement.formats.forEach((format, j) => {
        if (formats.has(format)) return;
        unsupported = true;
        problems.push(`placements[${i}].formats[${j}]: unsupported format ${format}`);
      });
    });
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
    const placementsKnown = product.placement_ids.every(id => placements.has(id));
    const served = new Set(product.placement_ids.flatMap(id => placements.get(id)?.property_ids ?? []));
    product.property_ids?.forEach((id, j) => {
      const path = `products[${i}].property_ids[${j}]`;
      if (!propertyIds.has(id)) problems.push(`${path}: unknown property ${id}`);
      else if (placementsKnown && !served.has(id)) problems.push(`${path}: property ${id} is not on any of the product's placements`);
    });
  });
  const collections = new Map((seed.collections ?? []).map(c => [c.collection_id, c]));
  seed.products.forEach((product, i) => {
    if (!product.placement_ids.every(id => placements.has(id))) return;
    product.collection_ids?.forEach((id, j) => {
      const collection = collections.get(id);
      if (collection && !product.placement_ids.includes(collection.placement_id)) {
        problems.push(`products[${i}].collection_ids[${j}]: collection ${id} is not on any of the product's placements`);
      }
    });
  });
  const calendar = new SeasonCalendar(seed.start_date, seed.days);
  const daysUsable = Number.isInteger(seed.days) && seed.days >= 1 && seed.days <= 1100;
  (daysUsable ? seed.collections ?? [] : []).forEach((collection, i) => {
    const first = (parseDate(collection.first_date) - calendar.startMs) / DAY_MS;
    if (first < 0) {
      problems.push(`collections[${i}]: installment 1 on ${collection.first_date} falls before the season starts (${seed.start_date})`);
      return;
    }
    const lastDay = first + (collection.count - 1) * collection.cadence_days;
    if (lastDay < seed.days) return;
    const firstPast = Math.max(Math.floor((seed.days - 1 - first) / collection.cadence_days) + 1, 0);
    const day = first + firstPast * collection.cadence_days;
    const date = dateIfRepresentable(calendar, day);
    const lastDate = calendar.dateOf(seed.days - 1);
    problems.push(
      date
        ? `collections[${i}]: installment ${firstPast + 1} on ${date} falls after the season ends (${lastDate})`
        : `collections[${i}]: installment ${firstPast + 1} falls ${day} days after the season starts, past its end (${lastDate})`,
    );
  });
  (seed.events ?? []).forEach((event, i) => {
    if (event.type === 'installment_postponed' && daysUsable && parseDate(event.to_date) - calendar.startMs >= seed.days * DAY_MS) {
      problems.push(`events[${i}].to_date: ${event.to_date} falls after the season ends (${calendar.dateOf(seed.days - 1)})`);
    }
    if (event.type !== 'traffic_multiplier') return;
    check(`events[${i}].placement_ids`, event.placement_ids, placementIds, 'placement');
    check(`events[${i}].property_ids`, event.property_ids, propertyIds, 'property');
    check(`events[${i}].region_ids`, event.region_ids, regionIds, 'region');
  });
  problems.push(...forecastErrorProblems(seed).map(p => `${p.path}: ${p.message}`));
  if (unsupported && formats) problems.push(`supported formats: ${[...formats].sort().join(', ')}`);
  return problems;
}

/** Validate `input` as a season seed. `source` names it in error messages. */
export function parseSeasonSeed(input: unknown, source: string, options: SeasonFileOptions = {}): SeasonSeed {
  const parsed = seasonSeedSchema.safeParse(input);
  if (!parsed.success) {
    invalid(
      source,
      parsed.error.issues.flatMap(issue =>
        issue.code === 'unrecognized_keys'
          ? issue.keys.map(key => `${dottedPath([...issue.path, key])}: unrecognized key`)
          : [`${dottedPath(issue.path)}: ${issue.message}`],
      ),
    );
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
  // Check and read through one descriptor, so the file can't change between the two.
  const fd = fs.openSync(path, 'r');
  let text: string;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) invalid(path, ['not a regular file']);
    const { size } = stat;
    if (size > MAX_SEASON_FILE_BYTES) invalid(path, [`the file is ${size} bytes; season files are limited to 5 MB`]);
    text = fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
  const read = Buffer.byteLength(text, 'utf8');
  if (read > MAX_SEASON_FILE_BYTES) invalid(path, [`the file is ${read} bytes; season files are limited to 5 MB`]);
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
  let value: unknown;
  try {
    value = document.toJS();
  } catch (error) {
    if (error instanceof Error) invalid(path, [error.message.split('\n')[0]]);
    throw error;
  }
  return parseSeasonSeed(value, path, options);
}

/** Serialize a season as YAML that `readSeasonFile` loads back unchanged. */
export function seasonToYaml(seed: SeasonSeed): string {
  return stringify(seed, { schema: 'core' });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const fingerprints = new WeakMap<SeasonSeed, string>();

/**
 * `sha256:` and the hex SHA-256 of the season's canonical JSON (object keys
 * sorted at every depth, arrays in order, no whitespace). Results record it
 * beside `seed_id`, so two runs name the same season only when every value
 * matches. Computed once per seed object.
 */
export function seasonFingerprint(seed: SeasonSeed): string {
  let fingerprint = fingerprints.get(seed);
  if (fingerprint === undefined) {
    fingerprint = `sha256:${createHash('sha256').update(canonicalJson(seed)).digest('hex')}`;
    fingerprints.set(seed, fingerprint);
  }
  return fingerprint;
}
