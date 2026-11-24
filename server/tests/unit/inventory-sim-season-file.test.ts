/**
 * Season files: the YAML/JSON loader that lets a season be supplied as data
 * instead of a compiled-in constant.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  ADSERVER_SEASON,
  CONTENT_SEASON,
  EngineError,
  InventorySimulation,
  MAX_REVISION_DRAWS,
  MAX_SPIKES_PER_PUBLISHER,
  SeasonCalendar,
  SeasonTraffic,
  type SeasonSeed,
} from '../../src/training-agent/inventory-sim/engine/index.js';
import {
  MAX_SEASON_FILE_BYTES,
  parseSeasonSeed,
  readSeasonFile,
  seasonFingerprint,
  seasonToYaml,
} from '../../src/training-agent/inventory-sim/season-file.js';
import { TRAINING_FORMAT_LABELS } from '../../src/training-agent/product-factory.js';
import {
  INVENTORY_ADSERVER_TENANT_ID,
  INVENTORY_CONTENT_TENANT_ID,
  INVENTORY_SEASON_FILE_ENV,
  resolveInventoryTenantProfiles,
} from '../../src/training-agent/tenants/inventory.js';

const at = (iso: string) => Date.parse(iso);

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'season-file-'));
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(name: string, content: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

function invalidSeedMessage(fn: () => unknown): string {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(EngineError);
  expect((caught as EngineError).code).toBe('INVALID_SEED');
  return (caught as EngineError).message;
}

const SEEDS: Array<[string, SeasonSeed]> = [
  ['ADSERVER_SEASON', ADSERVER_SEASON],
  ['CONTENT_SEASON', CONTENT_SEASON],
];

/** Smallest valid season, as YAML text. */
const MINIMAL_YAML = `
seed_id: tiny
rng_seed: tiny-v1
start_date: 2027-01-01
days: 30
currency: USD
regions:
  - { region_id: r1, country: US, name: Region one, share: 1 }
audience_profiles:
  - { profile_id: p1, name: Profile one, share: 1 }
segments: []
properties:
  - { property_id: site, name: Site, domain: site.example }
placements:
  - placement_id: banner
    name: Banner
    channel: display
    property_ids: [site]
    formats: [display_300x250]
    base_daily_impressions: 10000
    floor_cpm: 2
    rates: { viewability: 0.6, click_rate: 0.01, completion_rate: 0, conversion_rate: 0.02 }
    reporting_lag_days: 0
products:
  - product_id: banner_open
    name: Banner
    description: Open auction banner
    delivery_type: non_guaranteed
    placement_ids: [banner]
traffic:
  weekday_shape: [1, 1, 1, 1, 1, 1, 1]
forecast_error:
  channel_sigma: { display: 0.05 }
  ar1_phi: 0.5
  lead_time_tau_days: 14
  lead_time_horizon_days: 60
  log_clip: 0.6931471805599453
  cell_kappa: 0.5
  cell_min_impressions: 100
`;

describe('season fingerprint', () => {
  it('is sha256 and hex of the canonical JSON', () => {
    expect(seasonFingerprint(ADSERVER_SEASON)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(seasonFingerprint(ADSERVER_SEASON)).not.toBe(seasonFingerprint(CONTENT_SEASON));
  });

  it('does not depend on key order', () => {
    const reversed = Object.fromEntries(Object.entries(ADSERVER_SEASON).reverse()) as unknown as SeasonSeed;
    expect(seasonFingerprint(reversed)).toBe(seasonFingerprint(ADSERVER_SEASON));
  });

  it('changes when any value changes', () => {
    const base = seasonFingerprint(ADSERVER_SEASON);
    expect(seasonFingerprint({ ...ADSERVER_SEASON, seed_id: `${ADSERVER_SEASON.seed_id}x` })).not.toBe(base);
    const nested = structuredClone(ADSERVER_SEASON);
    nested.forecast_error.log_clip += 0.01;
    expect(seasonFingerprint(nested)).not.toBe(base);
  });

  it('is the same for a shipped season loaded through YAML and for the constant', () => {
    for (const [name, seed] of SEEDS) {
      const loaded = readSeasonFile(write(`fingerprint-${name}.yaml`, seasonToYaml(seed)));
      expect(seasonFingerprint(loaded)).toBe(seasonFingerprint(seed));
    }
  });
});

describe('season files', () => {
  it('loads every shipped season through YAML and JSON unchanged', () => {
    for (const [name, seed] of SEEDS) {
      const yamlFile = write(`${name}.yaml`, seasonToYaml(seed));
      const jsonFile = write(`${name}.json`, JSON.stringify(seed));
      expect(readSeasonFile(yamlFile)).toEqual(seed);
      expect(readSeasonFile(jsonFile)).toEqual(seed);
    }
  });

  it('runs the same market from a loaded season as from the constant', () => {
    const now = at('2026-12-31T12:00:00Z');
    const flight = { flight_start_ms: at('2027-01-01'), flight_end_ms: at('2027-03-01') };
    const requests = [
      {
        seed: ADSERVER_SEASON,
        book: { booking_id: 'b', product_id: 'sports_hero_guaranteed', ...flight, budget: 10_000, impression_goal: 180_000 },
        query: { product_id: 'sports_hero_guaranteed', ...flight },
      },
      {
        seed: CONTENT_SEASON,
        book: { booking_id: 'b', product_id: 'morning_brief_midroll', targeting: { installment_ids: ['morning_brief_011'] }, ...flight, budget: 5000 },
        query: { product_id: 'morning_brief_midroll', targeting: { installment_ids: ['morning_brief_013'] }, ...flight },
      },
    ];
    for (const { seed, book, query } of requests) {
      const loaded = readSeasonFile(write(`${seed.seed_id}.yaml`, seasonToYaml(seed)));
      const run = (s: SeasonSeed) => {
        const sim = InventorySimulation.create(s, now);
        sim.book(book, now);
        sim.advanceTo(at('2027-02-01T00:00:00Z'));
        return { sim, forecast: sim.forecast(query, at('2027-02-01T00:00:00Z')) };
      };
      const fromConstant = run(seed);
      const fromFile = run(loaded);
      expect(fromFile.sim.state).toEqual(fromConstant.sim.state);
      expect(fromFile.forecast).toEqual(fromConstant.forecast);
    }
  });

  it('reads unquoted dates as strings', () => {
    const seed = readSeasonFile(write('dates.yaml', MINIMAL_YAML));
    expect(seed.start_date).toBe('2027-01-01');
  });

  it('names the path of each problem', () => {
    const badShape = write('bad-shape.yaml', MINIMAL_YAML.replace('days: 30', 'days: "30"') + 'forecast_eror: {}\n');
    const message = invalidSeedMessage(() => readSeasonFile(badShape));
    expect(message).toContain(`Season ${badShape} is invalid:`);
    expect(message).toContain('  days: ');
    expect(message).toContain('forecast_eror');

    const badShares = write('bad-shares.yaml', MINIMAL_YAML.replace('share: 1 }\naudience', 'share: 1.2 }\naudience'));
    expect(invalidSeedMessage(() => readSeasonFile(badShares))).toMatch(/region shares sum to 1\.2/);
  });

  it('indexes array paths and reports every zod issue', () => {
    const seed = JSON.parse(JSON.stringify(ADSERVER_SEASON));
    seed.placements[0].floor_cpm = 'high';
    seed.regions[1].share = 'half';
    const message = invalidSeedMessage(() => parseSeasonSeed(seed, 'inline'));
    expect(message).toContain('  placements[0].floor_cpm: ');
    expect(message).toContain('  regions[1].share: ');
  });

  it('names the field of a date that is not YYYY-MM-DD', () => {
    const file = write('bad-date.yaml', MINIMAL_YAML.replace('start_date: 2027-01-01', 'start_date: 2027-1-5'));
    expect(invalidSeedMessage(() => readSeasonFile(file))).toContain('  start_date: ');
  });

  it.each(['2027/01/05', 'abc', '2027-1-5'])('reports only the format problem for the date %s', date => {
    const seed = parseYaml(MINIMAL_YAML);
    seed.start_date = date;
    const message = invalidSeedMessage(() => parseSeasonSeed(seed, 'dates'));
    expect(message).toContain('start_date: must be a YYYY-MM-DD date');
    expect(message).not.toContain('not a calendar date');
  });

  it('refuses digit separators', () => {
    const file = write('separators.yaml', MINIMAL_YAML.replace('base_daily_impressions: 10000', 'base_daily_impressions: 2_200_000'));
    expect(invalidSeedMessage(() => readSeasonFile(file))).toContain('placements[0].base_daily_impressions');
  });

  it('refuses a product property that is unknown', () => {
    const file = write(
      'product-unknown-property.yaml',
      MINIMAL_YAML.replace('    placement_ids: [banner]', '    placement_ids: [banner]\n    property_ids: [missing]'),
    );
    const message = invalidSeedMessage(() => readSeasonFile(file));
    expect(message).toContain('products[0].property_ids[0]');
    expect(message).toContain('missing');
  });

  it('refuses a product property its placements do not serve', () => {
    const file = write(
      'product-unserved-property.yaml',
      MINIMAL_YAML
        .replace('properties:\n', 'properties:\n  - { property_id: harbor_weekly, name: Harbor, domain: harbor.example }\n')
        .replace('    placement_ids: [banner]', '    placement_ids: [banner]\n    property_ids: [harbor_weekly]'),
    );
    const message = invalidSeedMessage(() => readSeasonFile(file));
    expect(message).toContain('products[0].property_ids[0]');
    expect(message).toContain('harbor_weekly');
  });

  it('refuses a traffic event naming an unknown region, property or placement', () => {
    const file = write(
      'event-unknown-references.yaml',
      `${MINIMAL_YAML}events:
  - type: traffic_multiplier
    event_id: surge
    description: Surge
    start_date: 2027-01-05
    end_date: 2027-01-07
    multiplier: 2
    placement_ids: [no_placement]
    property_ids: [no_property]
    region_ids: [no_region]
`,
    );
    const message = invalidSeedMessage(() => readSeasonFile(file));
    expect(message).toContain('events[0].placement_ids[0]');
    expect(message).toContain('no_placement');
    expect(message).toContain('events[0].property_ids[0]');
    expect(message).toContain('no_property');
    expect(message).toContain('events[0].region_ids[0]');
    expect(message).toContain('no_region');
  });

  it('refuses a date that is not on the calendar', () => {
    const start = write('feb30.yaml', MINIMAL_YAML.replace('start_date: 2027-01-01', 'start_date: 2027-02-30'));
    const startMessage = invalidSeedMessage(() => readSeasonFile(start));
    expect(startMessage).toContain(`Season ${start} is invalid`);
    expect(startMessage).toContain('start_date');

    const event = write(
      'apr31.yaml',
      `${MINIMAL_YAML}events:
  - type: traffic_multiplier
    event_id: surge
    description: Surge
    start_date: 2027-04-01
    end_date: 2027-04-31
    multiplier: 2
`,
    );
    const eventMessage = invalidSeedMessage(() => readSeasonFile(event));
    expect(eventMessage).toContain(`Season ${event} is invalid`);
    expect(eventMessage).toContain('events[0].end_date');
  });

  it('refuses a product that sells a collection on another placement', () => {
    const seed = structuredClone(CONTENT_SEASON);
    seed.products[0].collection_ids = ['weekly_dispatch'];
    const message = invalidSeedMessage(() => parseSeasonSeed(seed, 'content-copy'));
    expect(message).toContain('products[0]');
    expect(message).toContain('weekly_dispatch');
  });

  it('refuses a sponsorship product with no collections', () => {
    const seed = structuredClone(CONTENT_SEASON);
    delete seed.products[1].collection_ids;
    const message = invalidSeedMessage(() => parseSeasonSeed(seed, 'content-copy'));
    expect(message).toContain('products[1]');
    expect(message).toContain('covers no inventory');
  });

  it('refuses empty and multi-document files', () => {
    expect(invalidSeedMessage(() => readSeasonFile(write('empty.yaml', '')))).toContain('empty');
    expect(invalidSeedMessage(() => readSeasonFile(write('comments.yaml', '# nothing here\n')))).toContain('empty');
    expect(invalidSeedMessage(() => readSeasonFile(write('multi.yaml', `${MINIMAL_YAML}\n---\n${MINIMAL_YAML}`)))).toContain('one document');
  });

  it('reports YAML syntax errors with the line', () => {
    const file = write('syntax.yaml', 'seed_id: tiny\nregions: [unclosed\ndays: 3\n');
    expect(invalidSeedMessage(() => readSeasonFile(file))).toMatch(/syntax\.yaml:\d+:\d+/);
  });

  it('refuses duplicate keys', () => {
    const file = write('dupes.yaml', MINIMAL_YAML.replace('days: 30', 'days: 30\ndays: 60'));
    expect(invalidSeedMessage(() => readSeasonFile(file))).toMatch(/dupes\.yaml:\d+:\d+/);
  });
});

describe('season values the tenants put on the wire', () => {
  const refuses: Array<[string, (yaml: string) => string, string]> = [
    ['a lowercase currency', y => y.replace('currency: USD', 'currency: usd'), 'currency:'],
    ['a currency that is not three letters', y => y.replace('currency: USD', 'currency: DOLLARS'), 'currency:'],
    ['a property domain that is not a hostname', y => y.replace('domain: site.example', 'domain: https://site.example/'), 'properties[0].domain:'],
    ['an upper-case property domain', y => y.replace('domain: site.example', 'domain: Site.Example'), 'properties[0].domain:'],
    ['a placement with no formats', y => y.replace('formats: [display_300x250]', 'formats: []'), 'placements[0].formats: needs at least one format'],
    ['a negative floor', y => y.replace('floor_cpm: 2', 'floor_cpm: -1'), 'placements[0].floor_cpm: must be 0 or more'],
  ];

  it.each(refuses)('refuses %s', (_name, edit, where) => {
    expect(invalidSeedMessage(() => parseSeasonSeed(parseYaml(edit(MINIMAL_YAML)), 'wire'))).toContain(where);
  });

  it('accepts a zero floor and a hyphenated multi-label domain', () => {
    const yaml = MINIMAL_YAML.replace('floor_cpm: 2', 'floor_cpm: 0').replace('domain: site.example', 'domain: news-desk.example.co');
    expect(parseSeasonSeed(parseYaml(yaml), 'wire').placements[0].floor_cpm).toBe(0);
  });
});

describe('season number ranges', () => {
  const starterPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../fixtures/inventory-sim/small-season.yaml');
  const collection = {
    collection_id: 'show',
    name: 'Show',
    channel: 'podcast',
    property_id: 'harbor_daily',
    placement_id: 'banner',
    first_date: '2026-11-01',
    cadence_days: 7,
    count: 10,
    expected_audience: 1000,
    audience_sigma: 0.1,
  };
  const SPIKES = { per_publisher_min: 1, per_publisher_max: 3, size_min: 0.2, size_max: 0.8, decay: 0.7, decay_forecast_sigma: 0.1 };
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const cases: Array<[string, (seed: any) => void, string]> = [
    ['a negative reporting lag', s => { s.placements[0].reporting_lag_days = -1; }, 'placements[0].reporting_lag_days:'],
    ['a fractional reporting lag', s => { s.placements[0].reporting_lag_days = 1.5; }, 'placements[0].reporting_lag_days:'],
    ['a zero cadence', s => { s.collections = [{ ...collection, cadence_days: 0 }]; }, 'collections[0].cadence_days:'],
    ['a fractional cadence', s => { s.collections = [{ ...collection, cadence_days: 1.5 }]; }, 'collections[0].cadence_days:'],
    ['a zero count', s => { s.collections = [{ ...collection, count: 0 }]; }, 'collections[0].count:'],
    ['a fractional count', s => { s.collections = [{ ...collection, count: 2.5 }]; }, 'collections[0].count:'],
    ['a negative expected audience', s => { s.collections = [{ ...collection, expected_audience: -1 }]; }, 'collections[0].expected_audience:'],
    ['a negative audience sigma', s => { s.collections = [{ ...collection, audience_sigma: -0.1 }]; }, 'collections[0].audience_sigma:'],
    ['a zero share of voice', s => { s.products[0].share_of_voice = 0; }, 'products[0].share_of_voice:'],
    ['a share of voice above 1', s => { s.products[0].share_of_voice = 1.5; }, 'products[0].share_of_voice:'],
    ['a placement rate below 0', s => { s.placements[0].rates.click_rate = -0.1; }, 'placements[0].rates.click_rate:'],
    ['a placement rate above 1', s => { s.placements[0].rates.viewability = 1.1; }, 'placements[0].rates.viewability:'],
    ['a negative rate multiplier', s => { s.audience_profiles[0].rate_multipliers.click_rate = -1; }, 'audience_profiles[0].rate_multipliers.click_rate:'],
    ['a negative weekday shape', s => { s.traffic.weekday_shape[3] = -1; }, 'traffic.weekday_shape[3]:'],
    ['a negative traffic multiplier', s => { s.properties[0].traffic_multiplier = -1; }, 'properties[0].traffic_multiplier:'],
    ['a negative channel sigma', s => { s.forecast_error.channel_sigma.display = -0.1; }, 'forecast_error.channel_sigma.display:'],
    ['an ar1_phi of 1', s => { s.forecast_error.ar1_phi = 1; }, 'forecast_error.ar1_phi:'],
    ['a negative ar1_phi', s => { s.forecast_error.ar1_phi = -0.1; }, 'forecast_error.ar1_phi:'],
    ['a zero lead_time_tau_days', s => { s.forecast_error.lead_time_tau_days = 0; }, 'forecast_error.lead_time_tau_days:'],
    ['a negative lead_time_horizon_days', s => { s.forecast_error.lead_time_horizon_days = -1; }, 'forecast_error.lead_time_horizon_days:'],
    ['a fractional lead_time_horizon_days', s => { s.forecast_error.lead_time_horizon_days = 1.5; }, 'forecast_error.lead_time_horizon_days:'],
    ['a zero log_clip', s => { s.forecast_error.log_clip = 0; }, 'forecast_error.log_clip:'],
    ['a negative cell_kappa', s => { s.forecast_error.cell_kappa = -1; }, 'forecast_error.cell_kappa:'],
    ['a cell_min_impressions below 1', s => { s.forecast_error.cell_min_impressions = 0.5; }, 'forecast_error.cell_min_impressions:'],
    ['a negative truth_daily_sigma', s => { s.traffic.truth_daily_sigma = -0.1; }, 'traffic.truth_daily_sigma:'],
    ['a month_shape of eleven values', s => { s.traffic.month_shape = Array(11).fill(1); }, 'traffic.month_shape'],
    ['a month_shape with a zero', s => { s.traffic.month_shape = [1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1]; }, 'traffic.month_shape[2]'],
    ['a negative bias_sigma', s => { s.forecast_error.publishers = [{ publisher_id: 'harbor_daily', bias: 0, bias_sigma: -1 }]; }, 'forecast_error.publishers[0].bias_sigma:'],
    ['a negative error_scale', s => { s.forecast_error.publishers = [{ publisher_id: 'harbor_daily', bias: 0, error_scale: -1 }]; }, 'forecast_error.publishers[0].error_scale:'],
    ['a negative per_publisher_min', s => { s.forecast_error.spikes = { ...SPIKES, per_publisher_min: -1 }; }, 'forecast_error.spikes.per_publisher_min:'],
    ['a size_min of -1', s => { s.forecast_error.spikes = { ...SPIKES, size_min: -1 }; }, 'forecast_error.spikes.size_min:'],
    ['a per_publisher_min above per_publisher_max', s => { s.forecast_error.spikes = { ...SPIKES, per_publisher_min: 4, per_publisher_max: 3 }; }, 'forecast_error.spikes.per_publisher_max:'],
    ['a size_min above size_max', s => { s.forecast_error.spikes = { ...SPIKES, size_min: 1, size_max: 0.5 }; }, 'forecast_error.spikes.size_max:'],
    ['a per_publisher_max above the days', s => { s.forecast_error.spikes = { ...SPIKES, per_publisher_max: 366 }; }, 'forecast_error.spikes.per_publisher_max:'],
    ['a spike decay of 1', s => { s.forecast_error.spikes = { ...SPIKES, decay: 1 }; }, 'forecast_error.spikes.decay:'],
    ['a negative decay_forecast_sigma', s => { s.forecast_error.spikes = { ...SPIKES, decay_forecast_sigma: -1 }; }, 'forecast_error.spikes.decay_forecast_sigma:'],
    ['a publisher no property has', s => { s.forecast_error.publishers = [{ publisher_id: 'nobody', bias: 0 }]; }, 'forecast_error.publishers[0].publisher_id: unknown publisher nobody'],
    ['a publisher listed twice', s => { s.forecast_error.publishers = [{ publisher_id: 'harbor_daily', bias: 0 }, { publisher_id: 'harbor_daily', bias: 0.1 }]; }, 'forecast_error.publishers[1].publisher_id'],
  ];
  /* eslint-enable @typescript-eslint/no-explicit-any */

  it('refuses out-of-range numbers', () => {
    for (const [name, mutate, where] of cases) {
      const seed = parseYaml(fs.readFileSync(starterPath, 'utf8'));
      mutate(seed);
      const message = invalidSeedMessage(() => parseSeasonSeed(seed, 'ranges'));
      expect(message, name).toContain(where);
    }
  });

  it('names what is wrong after the path', () => {
    const seed = parseYaml(fs.readFileSync(starterPath, 'utf8'));
    seed.placements[0].reporting_lag_days = -1;
    expect(invalidSeedMessage(() => parseSeasonSeed(seed, 'ranges'))).toContain(
      'placements[0].reporting_lag_days: must be a whole number, 0 or more',
    );
  });

  it('accepts the bounds themselves', () => {
    const seed = parseYaml(fs.readFileSync(starterPath, 'utf8'));
    seed.placements[0].reporting_lag_days = 0;
    seed.placements[0].rates.click_rate = 1;
    seed.products[0].share_of_voice = 1;
    seed.forecast_error.publishers = [{ publisher_id: 'harbor_daily', bias: -5, bias_sigma: 0, error_scale: 0 }];
    seed.forecast_error.ar1_phi = 0;
    seed.forecast_error.lead_time_horizon_days = 0;
    seed.forecast_error.cell_min_impressions = 1;
    seed.forecast_error.channel_sigma.display = 0;
    seed.traffic.truth_daily_sigma = 0;
    seed.traffic.trend_per_day = -0.01;
    expect(() => parseSeasonSeed(seed, 'ranges')).not.toThrow();
  });

  it('accepts spikes at their bounds', () => {
    const seed = parseYaml(fs.readFileSync(starterPath, 'utf8'));
    seed.forecast_error.spikes = { per_publisher_min: 0, per_publisher_max: 100, size_min: -0.99, size_max: -0.99, decay: 0, decay_forecast_sigma: 0 };
    expect(() => parseSeasonSeed(seed, 'ranges')).not.toThrow();
  });
});

describe('forecast error values', () => {
  it('names the old keys and the missing channel_sigma', () => {
    const seed = parseYaml(MINIMAL_YAML);
    seed.forecast_error = { day_sigma: 0.05, ar1_phi: 0.5, lead_time_tau_days: 14, lead_time_horizon_days: 60, log_clip: 0.7, cell_kappa: 0, cell_min_impressions: 100 };
    const message = invalidSeedMessage(() => parseSeasonSeed(seed, 'old'));
    expect(message).toContain('forecast_error.day_sigma');
    expect(message).toContain('forecast_error.channel_sigma');
  });

  it('refuses a placement channel with no channel_sigma, in the loader and in the engine', () => {
    const seed = parseYaml(MINIMAL_YAML);
    seed.placements.push({ ...seed.placements[0], placement_id: 'show_spot', channel: 'podcast' });
    const message = invalidSeedMessage(() => parseSeasonSeed(seed, 'podcast'));
    expect(message).toContain('forecast_error.channel_sigma.podcast');
    expect(message).toContain('show_spot');
    expect(invalidSeedMessage(() => new SeasonTraffic(seed))).toContain('forecast_error.channel_sigma.podcast');
  });

  it('refuses a channel_sigma key that is not a channel, naming the path', () => {
    const seed = parseYaml(MINIMAL_YAML);
    seed.forecast_error.channel_sigma.radio = 0.1;
    const message = invalidSeedMessage(() => parseSeasonSeed(seed, 'unknown channel'));
    expect(message).toContain('forecast_error.channel_sigma');
    expect(message).toContain('forecast_error.channel_sigma.radio');
  });

  it('keeps the supported-formats line last with the forecast error problems', () => {
    const seed = parseYaml(MINIMAL_YAML);
    seed.forecast_error.publishers = [{ publisher_id: 'nobody', bias: 0 }];
    seed.placements[0].formats = ['custom_banner'];
    const lines = invalidSeedMessage(() => parseSeasonSeed(seed, 'both', { formats: new Set(['display_300x250']) })).trim().split('\n');
    expect(lines.some(line => line.includes('unknown publisher nobody'))).toBe(true);
    expect(lines[lines.length - 1]).toContain('supported formats:');
  });

  it('reports every forecast problem and a reference problem together, each with its path', () => {
    const seed = parseYaml(MINIMAL_YAML);
    seed.forecast_error.ar1_phi = 1;
    seed.placements.push({ ...seed.placements[0], placement_id: 'show_spot', channel: 'podcast' });
    seed.forecast_error.publishers = [{ publisher_id: 'site', bias: 0 }, { publisher_id: 'site', bias: 0.1 }];
    seed.products[0].property_ids = ['ghost'];
    const message = invalidSeedMessage(() => parseSeasonSeed(seed, 'many'));
    expect(message).toContain('forecast_error.ar1_phi:');
    expect(message).toContain('forecast_error.channel_sigma.podcast:');
    expect(message).toContain('forecast_error.publishers[1].publisher_id:');
    expect(message).toContain('products[0].property_ids[0]: unknown property ghost');
  });

  it('refuses a lead_time_horizon_days above 366', () => {
    const seed = parseYaml(MINIMAL_YAML);
    seed.forecast_error.lead_time_horizon_days = 367;
    expect(invalidSeedMessage(() => parseSeasonSeed(seed, 'horizon'))).toContain(
      'forecast_error.lead_time_horizon_days: must be a whole number from 0 to 366',
    );
    seed.forecast_error.lead_time_horizon_days = 366;
    expect(() => parseSeasonSeed(seed, 'horizon')).not.toThrow();
  });

  it('refuses a season whose forecast error needs more draws than the build budget', () => {
    const seed = parseYaml(MINIMAL_YAML);
    seed.days = 1100;
    seed.forecast_error.lead_time_horizon_days = 366;
    for (let i = 0; i < 40; i++) {
      seed.properties.push({ property_id: `extra_${i}`, name: `Extra ${i}`, domain: `extra-${i}.example` });
    }
    // 41 publishers × (1100 + 366) × 367 = 22,058,902 draws, above the 20,000,000 budget.
    expect(41 * (1100 + 366) * 367).toBeGreaterThan(MAX_REVISION_DRAWS);
    const message = invalidSeedMessage(() => parseSeasonSeed(seed, 'budget'));
    expect(message).toContain('forecast_error.lead_time_horizon_days:');
    expect(message).toContain('41 publishers');
    expect(message).toContain(String(MAX_REVISION_DRAWS));
    expect(invalidSeedMessage(() => new SeasonTraffic(seed))).toContain('forecast_error.lead_time_horizon_days:');
  });

  it('makes the engine throw path: message for the first forecast problem', () => {
    const seed = parseYaml(MINIMAL_YAML);
    seed.traffic.truth_daily_sigma = -1;
    seed.forecast_error.ar1_phi = 1;
    expect(invalidSeedMessage(() => new SeasonTraffic(seed))).toBe('traffic.truth_daily_sigma: must be 0 or more');
  });

  it('groups properties into a publisher by publisher_id', () => {
    const seed = parseYaml(MINIMAL_YAML);
    seed.properties.push({ property_id: 'site_b', name: 'Site B', domain: 'site-b.example', publisher_id: 'house' });
    seed.forecast_error.publishers = [{ publisher_id: 'house', bias: 0.1 }, { publisher_id: 'site', bias: 0.2 }];
    expect(() => parseSeasonSeed(seed, 'groups')).not.toThrow();
  });

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const engineCases: Array<[string, (seed: any) => void, string]> = [
    ['a missing ar1_phi', s => { delete s.forecast_error.ar1_phi; }, 'forecast_error.ar1_phi'],
    ['a missing channel_sigma', s => { delete s.forecast_error.channel_sigma; }, 'forecast_error.channel_sigma'],
    ['a NaN sigma', s => { s.forecast_error.channel_sigma.display = NaN; }, 'forecast_error.channel_sigma.display'],
    ['a missing lead_time_tau_days', s => { delete s.forecast_error.lead_time_tau_days; }, 'forecast_error.lead_time_tau_days'],
    ['a missing lead_time_horizon_days', s => { delete s.forecast_error.lead_time_horizon_days; }, 'forecast_error.lead_time_horizon_days'],
    ['a missing log_clip', s => { delete s.forecast_error.log_clip; }, 'forecast_error.log_clip'],
    ['a missing cell_kappa', s => { delete s.forecast_error.cell_kappa; }, 'forecast_error.cell_kappa'],
    ['a missing cell_min_impressions', s => { delete s.forecast_error.cell_min_impressions; }, 'forecast_error.cell_min_impressions'],
    ['a month_shape of eleven values', s => { s.traffic.month_shape = Array(11).fill(1); }, 'traffic.month_shape'],
    ['a negative truth_daily_sigma', s => { s.traffic.truth_daily_sigma = -1; }, 'traffic.truth_daily_sigma'],
    ['an unknown publisher', s => { s.forecast_error.publishers = [{ publisher_id: 'nobody', bias: 0 }]; }, 'forecast_error.publishers[0]'],
    ['a publisher listed twice', s => { s.forecast_error.publishers = [{ publisher_id: 'site', bias: 0 }, { publisher_id: 'site', bias: 0 }]; }, 'forecast_error.publishers[1]'],
    ['an invalid spikes block', s => { s.forecast_error.spikes = { per_publisher_min: 2, per_publisher_max: 1, size_min: 0, size_max: 1, decay: 0.5, decay_forecast_sigma: 0 }; }, 'forecast_error.spikes.per_publisher_max'],
  ];
  /* eslint-enable @typescript-eslint/no-explicit-any */

  it.each(engineCases)('makes the engine refuse %s instead of producing NaN', (_name, mutate, where) => {
    const seed = parseYaml(MINIMAL_YAML);
    mutate(seed);
    expect(invalidSeedMessage(() => new SeasonTraffic(seed))).toContain(where);
  });
});

describe('forecast error value bounds', () => {
  const starterPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../fixtures/inventory-sim/small-season.yaml');
  const SPIKES = { per_publisher_min: 1, per_publisher_max: 3, size_min: 0.2, size_max: 0.8, decay: 0.7, decay_forecast_sigma: 0.1 };
  const starter = () => parseYaml(fs.readFileSync(starterPath, 'utf8'));

  /* eslint-disable @typescript-eslint/no-explicit-any */
  interface Bound {
    name: string;
    path: string;
    set: (seed: any, value: number) => void;
    /** The value at the edge of the allowed range, which is accepted. */
    edge: number;
    /** `above` refuses what exceeds the edge; `below` refuses what falls short of it. */
    side: 'above' | 'below';
    message: string;
    /** Values past the edge to refuse, when the defaults would trip another rule first. */
    refused?: number[];
  }
  const publisher = (field: string) => (seed: any, value: number) => {
    seed.forecast_error.publishers = [{ publisher_id: 'harbor_daily', bias: 0, [field]: value }];
  };
  const spikes = (field: string) => (seed: any, value: number) => {
    seed.forecast_error.spikes = { ...SPIKES, [field]: value };
  };
  const bounds: Bound[] = [
    { name: 'a publisher bias above 5', path: 'forecast_error.publishers[0].bias', set: publisher('bias'), edge: 5, side: 'above', message: 'must be from -5 to 5' },
    { name: 'a publisher bias below -5', path: 'forecast_error.publishers[0].bias', set: publisher('bias'), edge: -5, side: 'below', message: 'must be from -5 to 5' },
    { name: 'a bias_sigma above 5', path: 'forecast_error.publishers[0].bias_sigma', set: publisher('bias_sigma'), edge: 5, side: 'above', message: 'must be at most 5' },
    { name: 'an error_scale above 100', path: 'forecast_error.publishers[0].error_scale', set: publisher('error_scale'), edge: 100, side: 'above', message: 'must be at most 100' },
    { name: 'a channel_sigma above 5', path: 'forecast_error.channel_sigma.display', set: (s, v) => { s.forecast_error.channel_sigma.display = v; }, edge: 5, side: 'above', message: 'must be at most 5' },
    { name: 'a truth_daily_sigma above 5', path: 'traffic.truth_daily_sigma', set: (s, v) => { s.traffic.truth_daily_sigma = v; }, edge: 5, side: 'above', message: 'must be at most 5' },
    { name: 'a decay_forecast_sigma above 5', path: 'forecast_error.spikes.decay_forecast_sigma', set: spikes('decay_forecast_sigma'), edge: 5, side: 'above', message: 'must be at most 5' },
    { name: 'a cell_kappa above 1000', path: 'forecast_error.cell_kappa', set: (s, v) => { s.forecast_error.cell_kappa = v; }, edge: 1000, side: 'above', message: 'must be at most 1000' },
    {
      name: 'a month_shape entry above 100',
      path: 'traffic.month_shape[4]',
      set: (s, v) => { s.traffic.month_shape = Array(12).fill(1); s.traffic.month_shape[4] = v; },
      edge: 100,
      side: 'above',
      message: 'must be at most 100',
    },
    { name: 'a lead_time_tau_days below 0.01', path: 'forecast_error.lead_time_tau_days', set: (s, v) => { s.forecast_error.lead_time_tau_days = v; }, edge: 0.01, side: 'below', message: 'must be at least 0.01' },
    { name: 'a per_publisher_max above 100', path: 'forecast_error.spikes.per_publisher_max', set: spikes('per_publisher_max'), edge: 100, side: 'above', message: 'must be at most 100', refused: [101, 365] },
  ];
  /* eslint-enable @typescript-eslint/no-explicit-any */
  // Past the edge by a hair, and past it by as much as a finite number can be.
  const beyond = (b: Bound): number[] => {
    if (b.refused) return b.refused;
    if (b.side === 'above') return [b.edge * 1.01, Number.MAX_VALUE];
    return b.edge < 0 ? [b.edge * 1.01, -Number.MAX_VALUE] : [b.edge * 0.99, 1e-9, -Number.MAX_VALUE];
  };

  it('keeps the spike cap at 100', () => {
    expect(MAX_SPIKES_PER_PUBLISHER).toBe(100);
  });

  it.each(bounds)('accepts the edge of the range for $name', b => {
    const seed = starter();
    b.set(seed, b.edge);
    expect(() => parseSeasonSeed(seed, 'bounds')).not.toThrow();
    expect(() => new SeasonTraffic(seed)).not.toThrow();
  });

  it.each(bounds)('refuses $name at its season-file path, in the loader and in the engine', b => {
    for (const value of beyond(b)) {
      const seed = starter();
      b.set(seed, value);
      expect(invalidSeedMessage(() => parseSeasonSeed(seed, 'bounds')), String(value)).toContain(`${b.path}: ${b.message}`);
      expect(invalidSeedMessage(() => new SeasonTraffic(seed)), String(value)).toBe(`${b.path}: ${b.message}`);
    }
  });

  it('refuses a tiny lead_time_tau_days such as 1e-9, which would blow up the revision shocks', () => {
    const seed = starter();
    seed.forecast_error.lead_time_tau_days = 1e-9;
    expect(invalidSeedMessage(() => parseSeasonSeed(seed, 'tau'))).toContain('forecast_error.lead_time_tau_days: must be at least 0.01');
    expect(invalidSeedMessage(() => new SeasonTraffic(seed))).toBe('forecast_error.lead_time_tau_days: must be at least 0.01');
  });

  it('reports both the days rule and the cap when per_publisher_max breaks both', () => {
    const seed = starter();
    seed.days = 50;
    seed.forecast_error.spikes = { ...SPIKES, per_publisher_max: 101 };
    const message = invalidSeedMessage(() => parseSeasonSeed(seed, 'both'));
    expect(message).toContain('forecast_error.spikes.per_publisher_max: must be at most the number of days in the season');
    expect(message).toContain('forecast_error.spikes.per_publisher_max: must be at most 100');
  });

  it('keeps the days rule below the cap', () => {
    const seed = starter();
    seed.days = 50;
    seed.forecast_error.spikes = { ...SPIKES, per_publisher_max: 51 };
    const message = invalidSeedMessage(() => parseSeasonSeed(seed, 'days'));
    expect(message).toContain('forecast_error.spikes.per_publisher_max: must be at most the number of days in the season');
    expect(message).not.toContain('must be at most 100');
  });

  it('accepts a spike count of exactly the days when that is within the cap', () => {
    const seed = starter();
    seed.days = 50;
    seed.forecast_error.spikes = { ...SPIKES, per_publisher_max: 50 };
    expect(() => parseSeasonSeed(seed, 'days')).not.toThrow();
  });

  it('fails the build, naming the first day and cell, when traffic overflows past every bound', () => {
    const seed = starter();
    seed.forecast_error.spikes = { per_publisher_min: 1, per_publisher_max: 1, size_min: 1e308, size_max: 1e308, decay: 0.5, decay_forecast_sigma: 0 };
    const message = invalidSeedMessage(() => new SeasonTraffic(seed));
    const date = /Traffic is not finite on (\d{4}-\d{2}-\d{2}) \(day (\d+)\) for cell /.exec(message);
    expect(date, message).not.toBeNull();
    const calendar = new SeasonCalendar(seed.start_date, seed.days);
    expect(calendar.dateOf(Number(date![2]))).toBe(date![1]);
    expect(message).toContain('harbor_daily');
    expect(invalidSeedMessage(() => parseSeasonSeed(seed, 'overflow'))).toContain('Traffic is not finite');
  });

  it('fails the build on a NaN that would otherwise vanish from the tables', () => {
    const seed = starter();
    const calendar = new SeasonCalendar(seed.start_date, seed.days);
    seed.forecast_error.spikes = { per_publisher_min: 2, per_publisher_max: 2, size_min: 1e308, size_max: 1e308, decay: 0.5, decay_forecast_sigma: 0 };
    // A zero multiplier times the infinite tail of two huge spikes is NaN.
    seed.events = [{ event_id: 'dark', type: 'traffic_multiplier', start_date: seed.start_date, end_date: calendar.dateOf(seed.days - 1), multiplier: 0 }];
    expect(invalidSeedMessage(() => new SeasonTraffic(seed))).toContain('Traffic is not finite on');
  });

  it('keeps the shipped seasons and the starter file within every bound', () => {
    for (const [, seed] of SEEDS) expect(() => new SeasonTraffic(seed)).not.toThrow();
    expect(() => parseSeasonSeed(starter(), 'starter')).not.toThrow();
  });
});

describe('season bounds', () => {
  const collection = {
    collection_id: 'show',
    name: 'Show',
    channel: 'podcast',
    property_id: 'site',
    placement_id: 'banner',
    first_date: '2027-01-02',
    cadence_days: 7,
    count: 3,
    expected_audience: 1000,
    audience_sigma: 0.1,
  };
  const withCollection = (patch: Record<string, unknown>) => {
    const seed = parseYaml(MINIMAL_YAML);
    seed.collections = [{ ...collection, ...patch }];
    return seed;
  };

  it('refuses a season with no placement', () => {
    const seed = parseYaml(MINIMAL_YAML);
    seed.placements = [];
    expect(invalidSeedMessage(() => parseSeasonSeed(seed, 'none'))).toContain('placements: needs at least one placement');
  });

  it('refuses a season with no product', () => {
    const seed = parseYaml(MINIMAL_YAML);
    seed.products = [];
    expect(invalidSeedMessage(() => parseSeasonSeed(seed, 'none'))).toContain('products: needs at least one product');
  });

  it('refuses a huge collection count at once, naming the first installment past the end', () => {
    const started = Date.now();
    const message = invalidSeedMessage(() => parseSeasonSeed(withCollection({ count: 1e9 }), 'huge'));
    expect(Date.now() - started).toBeLessThan(1000);
    expect(message).toContain('collections[0]: installment 6 on 2027-02-06 falls after the season ends (2027-01-30)');
  });

  it('refuses an installment scheduled after the season ends', () => {
    const message = invalidSeedMessage(() => parseSeasonSeed(withCollection({ count: 6 }), 'late'));
    expect(message).toContain('collections[0]: installment 6 on 2027-02-06 falls after the season ends (2027-01-30)');
  });

  it.each([1_000_000_000, Number.MAX_SAFE_INTEGER])('refuses a collection whose installments run past any representable date (cadence_days %d)', cadence => {
    const message = invalidSeedMessage(() => parseSeasonSeed(withCollection({ count: 2, cadence_days: cadence }), 'far'));
    expect(message).toContain('collections[0]');
    expect(message).toContain('falls');
    expect(message).toMatch(/installment 2 falls \d+ days after the season starts, past its end \(2027-01-30\)/);
    expect(message).not.toContain('Invalid time value');
  });

  it('refuses a first installment before the season starts', () => {
    const message = invalidSeedMessage(() => parseSeasonSeed(withCollection({ first_date: '2026-12-25' }), 'early'));
    expect(message).toContain('collections[0]: installment 1 on 2026-12-25 falls before the season starts (2027-01-01)');
  });

  it('lists every collection that runs past the end', () => {
    const seed = withCollection({ count: 100 });
    seed.collections.push({ ...collection, collection_id: 'show2', count: 100 });
    const message = invalidSeedMessage(() => parseSeasonSeed(seed, 'both'));
    expect(message).toContain('collections[0]:');
    expect(message).toContain('collections[1]:');
  });

  it('does not refuse installments that end on the last season day', () => {
    // 2027-01-02 plus 4 weeks is 2027-01-30, the last day of a 30-day season from 2027-01-01.
    let message = '';
    try {
      parseSeasonSeed(withCollection({ count: 5 }), 'edge');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain('season ends');
  });

  it('leaves an unusable season length to the engine\'s own check', () => {
    const seed = withCollection({});
    seed.days = 1e18;
    expect(invalidSeedMessage(() => parseSeasonSeed(seed, 'days'))).toContain('days');
  });

  it('refuses a file over the size limit before reading it', () => {
    const file = path.join(dir, 'huge.yaml');
    fs.writeFileSync(file, '');
    fs.truncateSync(file, MAX_SEASON_FILE_BYTES + 1);
    const message = invalidSeedMessage(() => readSeasonFile(file));
    expect(MAX_SEASON_FILE_BYTES).toBe(5_000_000);
    expect(message).toContain(`the file is ${MAX_SEASON_FILE_BYTES + 1} bytes; season files are limited to 5 MB`);
  });

  it('refuses a path that is not a regular file', () => {
    expect(invalidSeedMessage(() => readSeasonFile(dir))).toContain('not a regular file');
  });

  it('refuses a postponement to a date after the season ends', () => {
    const seed = withCollection({ count: 2 });
    seed.events = [
      { type: 'installment_postponed', event_id: 'late', description: 'Late', installment_id: 'show_001', to_date: '2027-02-10' },
      { type: 'installment_postponed', event_id: 'later', description: 'Later', installment_id: 'show_002', to_date: '2027-03-01' },
      { type: 'installment_postponed', event_id: 'ok', description: 'Fine', installment_id: 'show_002', to_date: '2027-01-30' },
    ];
    const message = invalidSeedMessage(() => parseSeasonSeed(seed, 'postponed'));
    expect(message).toContain('events[0].to_date: 2027-02-10 falls after the season ends (2027-01-30)');
    expect(message).toContain('events[1].to_date: 2027-03-01 falls after the season ends (2027-01-30)');
    expect(message).not.toContain('events[2]');
  });

  it('returns a YAML alias bomb as INVALID_SEED with the path', () => {
    const lines = ['a: &a0 [x, x, x, x, x, x, x, x, x, x]'];
    for (let i = 1; i < 12; i++) {
      const prev = `*a${i - 1}`;
      lines.push(`a${i}: &a${i} [${Array(10).fill(prev).join(', ')}]`);
    }
    const file = write('bomb.yaml', lines.join('\n') + '\n');
    const message = invalidSeedMessage(() => readSeasonFile(file));
    expect(message).toContain(`Season ${file} is invalid:`);
    expect(message.toLowerCase()).toContain('alias');
  });
});

describe('season file formats', () => {
  const CUSTOM = MINIMAL_YAML.replace('formats: [display_300x250]', 'formats: [custom_banner, display_300x250]');
  const FORMATS = new Set(['display_300x250', 'video_preroll']);

  it('refuses a format the host does not support', () => {
    const message = invalidSeedMessage(() => parseSeasonSeed(parseYaml(CUSTOM), 'custom', { formats: FORMATS }));
    expect(message).toContain('placements[0].formats[0]: unsupported format custom_banner');
    expect(message).not.toContain('formats[1]');
    expect(message).toContain('supported formats: display_300x250, video_preroll');
    const file = write('custom-format.yaml', CUSTOM);
    expect(invalidSeedMessage(() => readSeasonFile(file, { formats: FORMATS }))).toContain('custom_banner');
  });

  it('leaves formats to the host when none are given', () => {
    expect(parseSeasonSeed(parseYaml(CUSTOM), 'custom').placements[0].formats).toEqual(['custom_banner', 'display_300x250']);
    expect(readSeasonFile(write('custom-format-open.yaml', CUSTOM)).placements[0].formats[0]).toBe('custom_banner');
  });

  it('reports a format problem together with a reference problem', () => {
    const seed = parseYaml(CUSTOM);
    seed.products[0].property_ids = ['missing'];
    const message = invalidSeedMessage(() => parseSeasonSeed(seed, 'both', { formats: FORMATS }));
    expect(message).toContain('products[0].property_ids[0]: unknown property missing');
    expect(message).toContain('placements[0].formats[0]: unsupported format custom_banner');
    const lines = message.trim().split('\n');
    expect(lines[lines.length - 1]).toContain('supported formats:');
  });

  it('reports an unknown product placement without blaming its properties', () => {
    const seed = parseYaml(MINIMAL_YAML);
    seed.products[0].placement_ids = ['nowhere'];
    seed.products[0].property_ids = ['site'];
    const message = invalidSeedMessage(() => parseSeasonSeed(seed, 'placement'));
    expect(message).not.toContain('is not on any of the product');
    expect(message).toContain('nowhere');
  });

  it('knows every format the shipped seasons and the starter fixture use', () => {
    const starter = readSeasonFile(path.resolve(path.dirname(new URL(import.meta.url).pathname), '../fixtures/inventory-sim/small-season.yaml'));
    for (const seed of [ADSERVER_SEASON, CONTENT_SEASON, starter]) {
      for (const placement of seed.placements) {
        for (const format of placement.formats) expect(TRAINING_FORMAT_LABELS.has(format), `${seed.seed_id}: ${format}`).toBe(true);
      }
    }
  });
});

describe('resolveInventoryTenantProfiles', () => {
  const FIXTURE = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    '../fixtures/inventory-sim/small-season.yaml',
  );
  const ADSERVER_VAR = INVENTORY_SEASON_FILE_ENV[INVENTORY_ADSERVER_TENANT_ID];
  const CONTENT_VAR = INVENTORY_SEASON_FILE_ENV[INVENTORY_CONTENT_TENANT_ID];

  it('names one env var per tenant', () => {
    expect(ADSERVER_VAR).toBe('TRAINING_AGENT_INVENTORY_ADSERVER_SEASON_FILE');
    expect(CONTENT_VAR).toBe('TRAINING_AGENT_INVENTORY_CONTENT_SEASON_FILE');
  });

  it('uses the shipped seasons, by identity, when nothing is set', () => {
    for (const env of [{}, { [ADSERVER_VAR]: '', [CONTENT_VAR]: '   ' }]) {
      const profiles = resolveInventoryTenantProfiles(env);
      expect(profiles[INVENTORY_ADSERVER_TENANT_ID].seed).toBe(ADSERVER_SEASON);
      expect(profiles[INVENTORY_CONTENT_TENANT_ID].seed).toBe(CONTENT_SEASON);
    }
  });

  it('serves a tenant from its season file and leaves the other shipped', () => {
    const profiles = resolveInventoryTenantProfiles({ [ADSERVER_VAR]: FIXTURE });
    expect(profiles[INVENTORY_ADSERVER_TENANT_ID].seed).toEqual(readSeasonFile(FIXTURE));
    expect(profiles[INVENTORY_ADSERVER_TENANT_ID].seed.seed_id).toBe('small-season');
    expect(profiles[INVENTORY_CONTENT_TENANT_ID].seed).toBe(CONTENT_SEASON);
  });

  it('names the env var and the path when the file is missing', () => {
    const missing = path.join(dir, 'nope.yaml');
    expect(() => resolveInventoryTenantProfiles({ [CONTENT_VAR]: missing })).toThrow(
      new RegExp(`${CONTENT_VAR}.*${missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    );
  });

  it('names the env var, the path and the format when a season uses an unknown format', () => {
    const fixture = fs.readFileSync(FIXTURE, 'utf8');
    const custom = write('custom-format-tenant-season.yaml', fixture.replace('formats: [display_300x250]', 'formats: [custom_banner]'));
    expect(() => resolveInventoryTenantProfiles({ [ADSERVER_VAR]: custom })).toThrow(
      new RegExp(`${ADSERVER_VAR}=${custom.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*custom_banner`, 's'),
    );
  });

  it('names the env var and the path when the file is invalid', () => {
    const bad = write('bad-tenant-season.yaml', 'seed_id: x\n');
    expect(() => resolveInventoryTenantProfiles({ [ADSERVER_VAR]: bad })).toThrow(
      new RegExp(`${ADSERVER_VAR}.*${bad.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    );
  });
});
