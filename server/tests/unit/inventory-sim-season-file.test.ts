/**
 * Season files: the YAML/JSON loader that lets a season be supplied as data
 * instead of a compiled-in constant.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ADSERVER_SEASON,
  CONTENT_SEASON,
  EngineError,
  InventorySimulation,
  type SeasonSeed,
} from '../../src/training-agent/inventory-sim/engine/index.js';
import {
  parseSeasonSeed,
  readSeasonFile,
  seasonToYaml,
} from '../../src/training-agent/inventory-sim/season-file.js';

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
  day_sigma: 0.05
  cell_sigma: 0.1
`;

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

  it('refuses digit separators', () => {
    const file = write('separators.yaml', MINIMAL_YAML.replace('base_daily_impressions: 10000', 'base_daily_impressions: 2_200_000'));
    expect(invalidSeedMessage(() => readSeasonFile(file))).toContain('placements[0].base_daily_impressions');
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
