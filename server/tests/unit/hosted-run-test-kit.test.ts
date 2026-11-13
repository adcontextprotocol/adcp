/**
 * #8882 — hosted heartbeats graded the `$build_assets_from_format`
 * storyboards `untested` on 3.1.33 while the same seller passed them locally
 * with the bundle's test kit.
 *
 * Hosted `comply()` copies the owner's grading credential into a run-level
 * `test_kit`, and the SDK only loads a storyboard's declared kit
 * (`prerequisites.test_kit`) when the run has none. The run kit carried no
 * `assets`, so the directive could not fill a required image slot and the
 * step skipped as `fixture_unavailable`. These tests prove the hosted run now
 * hands the SDK the bundle kit's fixtures alongside the hosted credential,
 * and that the SDK's own directive expansion builds the creative from it.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';

const mocks = vi.hoisted(() => ({
  sdkComply: vi.fn(),
  discovery: vi.fn(),
}));

vi.mock('@adcp/sdk/testing', async importOriginal => ({
  ...(await importOriginal<typeof import('@adcp/sdk/testing')>()),
  comply: mocks.sdkComply,
  testCapabilityDiscovery: mocks.discovery,
}));

import {
  expandCreativeAssetDirectives,
  findUnresolvedCreativeAssetDirectives,
  injectContext,
  loadStoryboardFile,
  type StoryboardContext,
} from '@adcp/sdk/testing';
import {
  HOSTED_RUN_FIXTURE_TEST_KIT_PATH,
  withHostedRunFixtureTestKit,
} from '../../src/compliance/hosted-run-test-kit.js';
import { comply } from '../../src/addie/services/compliance-testing.js';
import { hostedComplianceTarget } from '../../src/services/hosted-compliance-version.js';
import type { TestKit } from '../../src/services/storyboards.js';

const REPO = resolve(__dirname, '../../..');
// The bundle the issue's heartbeat graded against.
const VERSION = '3.1.33';
const BUNDLE = resolve(REPO, 'dist/compliance', VERSION);
const SELLER_URL = 'https://seller.fixture-kit-8882.example/mcp';
const OWNER_TOKEN = 'owner-grading-credential-8882-0123456789';

const BUNDLE_KIT = YAML.parse(readFileSync(join(BUNDLE, HOSTED_RUN_FIXTURE_TEST_KIT_PATH), 'utf8')) as TestKit;

// The issue's seller: a 300x250 display format with a required image and a
// required click URL, matching `hero-300x250.jpg` in the kit.
const FORMAT_ID = { agent_url: 'https://seller.fixture-kit-8882.example/creative', id: 'display_300x250' };
const CONTEXT: StoryboardContext = {
  product_format_id: FORMAT_ID,
  formats: [{
    format_id: FORMAT_ID,
    name: 'Medium rectangle',
    assets: [
      {
        item_type: 'individual',
        asset_id: 'image',
        asset_type: 'image',
        required: true,
        requirements: { width: 300, height: 250 },
      },
      {
        item_type: 'individual',
        asset_id: 'click_url',
        asset_type: 'url',
        required: true,
        requirements: { role: 'clickthrough' },
      },
    ],
  }],
};

/** The media_buy_seller `sync_creatives` request, as the 3.1.33 bundle authors it. */
function syncCreativesRequest(): Record<string, unknown> {
  const storyboard = loadStoryboardFile(join(BUNDLE, 'protocols/media-buy/index.yaml'));
  const step = storyboard.phases.flatMap(phase => phase.steps).find(s => s.id === 'sync_creatives');
  if (!step?.sample_request) throw new Error('media_buy_seller has no sync_creatives sample_request');
  const creatives = (step.sample_request as { creatives: unknown[] }).creatives;
  expect(JSON.stringify(creatives)).toContain('$build_assets_from_format');
  return injectContext({ creatives }, CONTEXT);
}

function buildCreatives(testKit: unknown) {
  const expanded = expandCreativeAssetDirectives(syncCreativesRequest(), CONTEXT, testKit) as {
    creatives: Array<{ assets: Record<string, Record<string, unknown>> }>;
  };
  return { expanded, unresolved: findUnresolvedCreativeAssetDirectives(expanded) };
}

describe('withHostedRunFixtureTestKit', () => {
  it('adds only the kit assets to the run kit, keeping the hosted credential', () => {
    const options = withHostedRunFixtureTestKit(
      { test_kit: { auth: { api_key: OWNER_TOKEN, probe_task: 'list_creatives' } } },
      () => BUNDLE_KIT,
    );
    expect(options.test_kit).toEqual({
      auth: { api_key: OWNER_TOKEN, probe_task: 'list_creatives' },
      assets: BUNDLE_KIT.assets,
    });
    expect(JSON.stringify(options)).not.toContain('demo-acme-outdoor-v1');
  });

  it('never copies other kit fields a storyboard declaring another kit could read', () => {
    const kit = {
      ...BUNDLE_KIT,
      account: { unsupported_billing_probe: 'x' },
      commercial_relationship: 'passthrough_only',
      creative_build_probes: [],
      creative_formats: [],
    } as TestKit;
    const options = withHostedRunFixtureTestKit({ test_kit: {} as never }, () => kit);
    expect(options.test_kit).toEqual({ assets: BUNDLE_KIT.assets });
  });

  it('keeps assets the run kit already sets', () => {
    const options = withHostedRunFixtureTestKit(
      { test_kit: { auth: { probe_task: 'get_signals' }, assets: { images: [] } } },
      () => BUNDLE_KIT,
    );
    expect(options.test_kit?.assets).toEqual({ images: [] });
  });

  it('leaves a run without a test kit alone, so the SDK loads declared kits itself', () => {
    const resolveFixtureKit = vi.fn(() => BUNDLE_KIT);
    const options = { timeout_ms: 1 };
    expect(withHostedRunFixtureTestKit(options, resolveFixtureKit)).toBe(options);
    expect(resolveFixtureKit).not.toHaveBeenCalled();
  });
});

describe(`hosted comply() on ${VERSION} (#8882)`, () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  async function hostedRunTestKit(options: Record<string, unknown>) {
    mocks.discovery.mockResolvedValue({
      profile: { tools: ['list_creatives', 'sync_creatives'], supported_protocols: ['media_buy'] },
      steps: [],
    });
    mocks.sdkComply.mockResolvedValue({ agent_profile: {} });
    await comply(SELLER_URL, {
      auth: { type: 'bearer', token: OWNER_TOKEN },
      ...options,
    } as never, hostedComplianceTarget(VERSION));
    expect(mocks.sdkComply).toHaveBeenCalledTimes(1);
    return mocks.sdkComply.mock.calls[0][1].test_kit as Record<string, unknown> & {
      auth?: Record<string, unknown>;
    };
  }

  it('hands the SDK the bundle kit fixtures with the owner credential', async () => {
    const testKit = await hostedRunTestKit({});
    expect(Object.keys(testKit).sort()).toEqual(['assets', 'auth']);
    expect(testKit.assets).toEqual(BUNDLE_KIT.assets);
    expect(testKit.auth?.api_key).toBe(OWNER_TOKEN);
    expect(typeof testKit.auth?.probe_task).toBe('string');
  });

  it('builds the media_buy_seller creative from that kit, which the credential-only kit could not', async () => {
    const testKit = await hostedRunTestKit({});

    const hosted = buildCreatives(testKit);
    expect(hosted.unresolved).toEqual([]);
    expect(hosted.expanded.creatives[0].assets).toEqual({
      image: expect.objectContaining({
        asset_type: 'image',
        url: 'https://test-assets.adcontextprotocol.org/acme-outdoor/hero-300x250.jpg',
        width: 300,
        height: 250,
      }),
      click_url: { asset_type: 'url', url: 'https://acmeoutdoor.example/summer-sale' },
    });

    // The run-level kit hosted grading used before the fix.
    const before = buildCreatives({ auth: testKit.auth });
    expect(before.unresolved).toEqual(['$.creatives[0].assets.$build_assets_from_format']);
  });

  it('keeps a caller-supplied test kit authoritative', async () => {
    const testKit = await hostedRunTestKit({
      test_kit: { auth: { api_key: 'caller-key-0123456789', probe_task: 'list_creatives' } },
    });
    expect(testKit).toEqual({ auth: { api_key: 'caller-key-0123456789', probe_task: 'list_creatives' } });
  });
});

// The run-level kit is one kit for the whole run, and only its `assets` cross
// over. The SDK reads `test_kit.assets` only to expand this directive, so the
// copy is right while every storyboard that uses the directive declares the
// kit the assets come from. Other kit fields (creative_build_probes,
// creative_formats for `catalog: test_kit`, skip_if paths) are never copied.
describe('storyboards that use $build_assets_from_format', () => {
  const DIRECTIVE = '$build_assets_from_format';

  function yamlFiles(dir: string): string[] {
    return readdirSync(dir).flatMap(name => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return yamlFiles(path);
      return name.endsWith('.yaml') ? [path] : [];
    });
  }

  function bundleRoots(): string[] {
    const manifest = JSON.parse(
      readFileSync(resolve(REPO, 'static/compliance/published-versions.json'), 'utf8'),
    ) as { published_versions: string[] };
    return [
      resolve(REPO, 'static/compliance/source'),
      ...manifest.published_versions.map(version => resolve(REPO, 'dist/compliance', version)),
    ].filter(dir => existsSync(dir));
  }

  it(`declare ${HOSTED_RUN_FIXTURE_TEST_KIT_PATH}`, () => {
    const offenders: string[] = [];
    let users = 0;
    for (const root of bundleRoots()) {
      for (const file of yamlFiles(root)) {
        const text = readFileSync(file, 'utf8');
        if (!text.includes(DIRECTIVE)) continue;
        const doc = YAML.parse(text) as { phases?: unknown; prerequisites?: { test_kit?: string } } | null;
        // The schema and docs files that describe the directive are not storyboards.
        if (!doc || !Array.isArray(doc.phases)) continue;
        users += 1;
        const declared = doc.prerequisites?.test_kit?.trim();
        if (declared !== HOSTED_RUN_FIXTURE_TEST_KIT_PATH) {
          offenders.push(`${relative(REPO, file)} declares ${declared ?? 'no test kit'}`);
        }
      }
    }
    expect(users).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });
});
