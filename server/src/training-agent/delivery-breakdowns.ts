/**
 * Deterministic geo, device-type, and keyword delivery breakdowns for
 * get_media_buy_delivery (`by_geo`, `by_device_type`, `by_keyword` within
 * `by_package`).
 *
 * The training seller has no ad server, so each breakdown splits the
 * package's reported totals across rows with fixed weights. Rows are derived
 * from the package's own targeting when it names the dimension (geo_countries,
 * geo_regions, geo_metros, keyword_targets) and from the product's coverage
 * or channels otherwise, so a learner who buys "US + CA" sees exactly those
 * two country rows. Additive metrics across the rows reconcile to the package
 * totals.
 *
 * A breakdown is returned only when the buyer requested it through
 * reporting_dimensions and the product declares it in reporting_capabilities;
 * unsupported dimensions are silently omitted, as the request schema allows.
 */

export const KEYWORD_MATCH_TYPES = ['broad', 'phrase', 'exact'] as const;

/** Product-level `reporting_capabilities.supports_geo_breakdown` for catalog products. */
export const TRAINING_GEO_BREAKDOWN_SUPPORT = {
  country: true,
  region: true,
  metro: { nielsen_dma: true },
} as const;

const KEYWORD_CHANNELS = new Set(['search', 'retail_media']);

/** Search and retail-media inventory is bought and reported by keyword. */
export function sellsKeywordInventory(channels: readonly string[] | undefined): boolean {
  return (channels ?? []).some(channel => KEYWORD_CHANNELS.has(channel));
}

const SCREEN_DEVICE_WEIGHTS: ReadonlyArray<[string, number]> = [['mobile', 55], ['desktop', 35], ['tablet', 10]];
const AUDIO_DEVICE_WEIGHTS: ReadonlyArray<[string, number]> = [['mobile', 80], ['desktop', 20]];
const DEVICE_WEIGHTS_BY_CHANNEL: Readonly<Record<string, ReadonlyArray<[string, number]>>> = {
  display: SCREEN_DEVICE_WEIGHTS,
  olv: SCREEN_DEVICE_WEIGHTS,
  social: SCREEN_DEVICE_WEIGHTS,
  influencer: SCREEN_DEVICE_WEIGHTS,
  search: SCREEN_DEVICE_WEIGHTS,
  retail_media: SCREEN_DEVICE_WEIGHTS,
  gaming: SCREEN_DEVICE_WEIGHTS,
  email: SCREEN_DEVICE_WEIGHTS,
  streaming_audio: AUDIO_DEVICE_WEIGHTS,
  podcast: AUDIO_DEVICE_WEIGHTS,
  ctv: [['ctv', 100]],
  dooh: [['dooh', 100]],
  ooh: [['dooh', 100]],
};

function deviceTypeWeights(channels: readonly string[] | undefined): Array<[string, number]> {
  const weights = new Map<string, number>();
  for (const channel of channels ?? []) {
    for (const [deviceType, weight] of DEVICE_WEIGHTS_BY_CHANNEL[channel] ?? []) {
      weights.set(deviceType, (weights.get(deviceType) ?? 0) + weight);
    }
  }
  return [...weights.entries()];
}

/** Device form factors a product's channels serve. Print, radio, and linear TV have none. */
export function deliveryDeviceTypes(channels: readonly string[] | undefined): string[] {
  return deviceTypeWeights(channels).map(([deviceType]) => deviceType);
}

const COUNTRY_NAMES: Readonly<Record<string, string>> = {
  US: 'United States', CA: 'Canada', MX: 'Mexico', BR: 'Brazil', GB: 'United Kingdom',
  DE: 'Germany', FR: 'France', ES: 'Spain', IT: 'Italy', IN: 'India', JP: 'Japan',
  KR: 'South Korea', AU: 'Australia',
};

/** Default region rows per country when the package names no regions. */
const DEFAULT_REGIONS: Readonly<Record<string, ReadonlyArray<[string, string]>>> = {
  US: [['US-CA', 'California'], ['US-TX', 'Texas'], ['US-NY', 'New York'], ['US-FL', 'Florida'], ['US-IL', 'Illinois']],
  CA: [['CA-ON', 'Ontario'], ['CA-QC', 'Quebec'], ['CA-BC', 'British Columbia']],
  GB: [['GB-ENG', 'England'], ['GB-SCT', 'Scotland'], ['GB-WLS', 'Wales']],
};

const DEFAULT_DMAS: ReadonlyArray<[string, string]> = [
  ['501', 'New York'], ['803', 'Los Angeles'], ['602', 'Chicago'], ['623', 'Dallas-Ft. Worth'], ['504', 'Philadelphia'],
];

const DEFAULT_GEO_LIMIT = 25;

export interface PackageDeliveryTotals {
  impressions: number;
  spend: number;
  clicks: number;
}

export interface DimensionalBreakdownInput {
  /** The product's reporting_capabilities (or a compliance fixture's equivalent). */
  reporting: Record<string, unknown> | undefined;
  channels: readonly string[] | undefined;
  /** ISO 3166-1 alpha-2 countries the product's inventory covers. */
  coverageCountries: readonly string[] | undefined;
  /** The package's effective targeting_overlay. */
  targeting: Record<string, unknown> | undefined;
  totals: PackageDeliveryTotals;
  /** The request's reporting_dimensions. */
  dimensions: Record<string, unknown> | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/** Split `total` across `weights` so the parts sum exactly to the total at `decimalPlaces`. */
function allocateByWeight(total: number, weights: readonly number[], decimalPlaces = 0): number[] {
  const scale = 10 ** decimalPlaces;
  const totalUnits = Math.round(total * scale);
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  let cumulativeWeight = 0;
  let allocatedUnits = 0;
  return weights.map(weight => {
    cumulativeWeight += weight;
    const targetUnits = weightSum > 0 ? Math.round((totalUnits * cumulativeWeight) / weightSum) : 0;
    const units = targetUnits - allocatedUnits;
    allocatedUnits = targetUnits;
    return units / scale;
  });
}

/** Rank-decaying weights (1, 1/2, 1/3, ...) for rows that have no natural share. */
function rankWeights(count: number): number[] {
  return Array.from({ length: count }, (_, index) => 1 / (index + 1));
}

function metricRows(
  keys: ReadonlyArray<Record<string, unknown>>,
  weights: readonly number[],
  totals: PackageDeliveryTotals,
): Array<Record<string, unknown>> {
  const impressions = allocateByWeight(totals.impressions, weights);
  const spend = allocateByWeight(totals.spend, weights, 2);
  const clicks = allocateByWeight(totals.clicks, weights);
  return keys.map((key, index) => ({
    ...key,
    impressions: impressions[index]!,
    spend: spend[index]!,
    clicks: clicks[index]!,
  }));
}

/** Order rows by the requested metric, falling back to spend (and descending)
 * when the rows do not carry it, and echo the sort that was applied. */
function sortRows<T extends Record<string, unknown>>(
  rows: T[],
  dimension: Record<string, unknown>,
): { rows: T[]; sortedBy: string; sortDirection: 'asc' | 'desc' } {
  const requestedSort = typeof dimension.sort_by === 'string' ? dimension.sort_by : 'spend';
  const requestedDirection = dimension.sort_direction === 'asc' ? 'asc' : 'desc';
  const sortedBy = rows.length > 0 && rows.every(row => typeof row[requestedSort] === 'number')
    ? requestedSort
    : 'spend';
  const sortDirection = sortedBy === requestedSort ? requestedDirection : 'desc';
  const ordered = [...rows].sort((left, right) => {
    const a = left[sortedBy] as number;
    const b = right[sortedBy] as number;
    return sortDirection === 'asc' ? a - b : b - a;
  });
  return { rows: ordered, sortedBy, sortDirection };
}

function requestedLimit(dimension: Record<string, unknown>, fallback: number): number {
  return typeof dimension.limit === 'number' && Number.isInteger(dimension.limit) && dimension.limit >= 1
    ? dimension.limit
    : fallback;
}

function geoRowKeys(
  dimension: Record<string, unknown>,
  support: Record<string, unknown>,
  countries: string[],
  targeting: Record<string, unknown> | undefined,
): Array<Record<string, unknown>> | undefined {
  const level = dimension.geo_level;
  if (level === 'country') {
    if (support.country !== true) return undefined;
    return countries.map(code => ({ geo_level: 'country', geo_code: code, ...(COUNTRY_NAMES[code] && { geo_name: COUNTRY_NAMES[code] }) }));
  }
  if (level === 'region') {
    if (support.region !== true) return undefined;
    const targeted = stringArray(targeting?.geo_regions);
    if (targeted.length > 0) return targeted.map(code => ({ geo_level: 'region', geo_code: code }));
    return countries.flatMap(country => (DEFAULT_REGIONS[country] ?? []).map(([code, name]) => ({
      geo_level: 'region', geo_code: code, geo_name: name,
    })));
  }
  if (level === 'metro') {
    const system = typeof dimension.system === 'string' ? dimension.system : 'nielsen_dma';
    if (!isRecord(support.metro) || support.metro[system] !== true || system !== 'nielsen_dma') return undefined;
    const targeted = (Array.isArray(targeting?.geo_metros) ? targeting.geo_metros : [])
      .filter(isRecord)
      .filter(entry => entry.system === system)
      .flatMap(entry => stringArray(entry.values));
    if (targeted.length > 0) return targeted.map(code => ({ geo_level: 'metro', system, geo_code: code }));
    if (!countries.includes('US')) return [];
    return DEFAULT_DMAS.map(([code, name]) => ({ geo_level: 'metro', system, geo_code: code, geo_name: name }));
  }
  return undefined;
}

function geoBreakdown(input: DimensionalBreakdownInput, dimension: Record<string, unknown>): Record<string, unknown> {
  const support = input.reporting?.supports_geo_breakdown;
  if (!isRecord(support)) return {};
  const targetedCountries = stringArray(input.targeting?.geo_countries);
  const countries = targetedCountries.length > 0
    ? targetedCountries
    : (input.coverageCountries?.length ? [...input.coverageCountries] : ['US']);
  const keys = geoRowKeys(dimension, support, countries, input.targeting);
  if (!keys) return {};
  const { rows, sortedBy, sortDirection } = sortRows(metricRows(keys, rankWeights(keys.length), input.totals), dimension);
  const limit = requestedLimit(dimension, DEFAULT_GEO_LIMIT);
  return {
    by_geo: rows.slice(0, limit),
    by_geo_truncated: rows.length > limit,
    by_geo_sorted_by: sortedBy,
    by_geo_sort_direction: sortDirection,
  };
}

const DEVICE_TYPE_CURSOR_PREFIX = 'device_type_offset:';

function deviceTypeBreakdown(input: DimensionalBreakdownInput, dimension: Record<string, unknown>): Record<string, unknown> {
  if (input.reporting?.supports_device_type_breakdown !== true) return {};
  const weights = deviceTypeWeights(input.channels);
  if (weights.length === 0) return {};
  const keys = weights.map(([deviceType]) => ({ device_type: deviceType }));
  const { rows, sortedBy, sortDirection } = sortRows(metricRows(keys, weights.map(([, weight]) => weight), input.totals), dimension);
  const cursor = typeof dimension.cursor === 'string' && dimension.cursor.startsWith(DEVICE_TYPE_CURSOR_PREFIX)
    ? Number(dimension.cursor.slice(DEVICE_TYPE_CURSOR_PREFIX.length))
    : 0;
  const offset = Number.isInteger(cursor) && cursor > 0 ? cursor : 0;
  const limit = requestedLimit(dimension, rows.length);
  const page = rows.slice(offset, offset + limit);
  const truncated = offset + limit < rows.length;
  return {
    by_device_type: page,
    by_device_type_truncated: truncated,
    ...(truncated && {
      by_device_type_pagination: {
        has_more: true,
        cursor: `${DEVICE_TYPE_CURSOR_PREFIX}${offset + limit}`,
        total_count: rows.length,
      },
    }),
    by_device_type_sorted_by: sortedBy,
    by_device_type_sort_direction: sortDirection,
  };
}

function keywordBreakdown(input: DimensionalBreakdownInput, dimension: Record<string, unknown>): Record<string, unknown> {
  if (input.reporting?.supports_keyword_breakdown !== true) return {};
  const seen = new Set<string>();
  const keys = (Array.isArray(input.targeting?.keyword_targets) ? input.targeting.keyword_targets : [])
    .filter(isRecord)
    .filter(entry => typeof entry.keyword === 'string' && typeof entry.match_type === 'string')
    .filter(entry => {
      const identity = `${entry.keyword}\0${entry.match_type}`;
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    })
    .map(entry => ({ keyword: entry.keyword as string, match_type: entry.match_type as string }));
  const { rows, sortedBy, sortDirection } = sortRows(metricRows(keys, rankWeights(keys.length), input.totals), dimension);
  const limit = requestedLimit(dimension, rows.length);
  return {
    by_keyword: rows.slice(0, limit),
    by_keyword_truncated: rows.length > limit,
    by_keyword_sorted_by: sortedBy,
    by_keyword_sort_direction: sortDirection,
  };
}

/** The by_geo, by_device_type, and by_keyword fields for one package. */
export function dimensionalDeliveryBreakdowns(input: DimensionalBreakdownInput): Record<string, unknown> {
  const dimensions = input.dimensions;
  if (!isRecord(dimensions)) return {};
  return {
    ...(isRecord(dimensions.geo) ? geoBreakdown(input, dimensions.geo) : {}),
    ...(isRecord(dimensions.device_type) ? deviceTypeBreakdown(input, dimensions.device_type) : {}),
    ...(isRecord(dimensions.keyword) ? keywordBreakdown(input, dimensions.keyword) : {}),
  };
}
