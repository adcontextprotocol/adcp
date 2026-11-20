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
  type SeasonSeed,
} from '../../src/training-agent/inventory-sim/engine/index.js';
import {
  parseSeasonSeed,
  readSeasonFile,
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

  it('names the field of a date that is not YYYY-MM-DD', () => {
    const file = write('bad-date.yaml', MINIMAL_YAML.replace('start_date: 2027-01-01', 'start_date: 2027-1-5'));
    expect(invalidSeedMessage(() => readSeasonFile(file))).toContain('  start_date: ');
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
    ['a placement with no formats', y => y.replace('formats: [display_300x250]', 'formats: []'), 'placements[0].formats:'],
    ['a negative floor', y => y.replace('floor_cpm: 2', 'floor_cpm: -1'), 'placements[0].floor_cpm:'],
  ];

  it.each(refuses)('refuses %s', (_name, edit, where) => {
    expect(invalidSeedMessage(() => parseSeasonSeed(parseYaml(edit(MINIMAL_YAML)), 'wire'))).toContain(where);
  });

  it('accepts a zero floor and a hyphenated multi-label domain', () => {
    const yaml = MINIMAL_YAML.replace('floor_cpm: 2', 'floor_cpm: 0').replace('domain: site.example', 'domain: news-desk.example.co');
    expect(parseSeasonSeed(parseYaml(yaml), 'wire').placements[0].floor_cpm).toBe(0);
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
    const both = CUSTOM.replace('property_ids: [site]\n    formats', 'property_ids: [site, nowhere]\n    formats');
    const message = invalidSeedMessage(() => parseSeasonSeed(parseYaml(both), 'both', { formats: FORMATS }));
    expect(message).toContain('custom_banner');
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
