/**
 * End to end: the training `sales` tenant behaves as a guaranteed-only, a
 * non-guaranteed-only, and an undeclared (mixed) seller, and the real SDK
 * runner grades the delivery-mode-aware media-buy baseline accordingly
 * (adcp#7852). The seam is test-only: TRAINING_SALES_DELIVERY_MODES unset
 * leaves the tenant exactly as it was.
 *
 * Slow (each mode runs several storyboards through the SDK runner), so it is
 * opt-in: `npm run test:delivery-mode-e2e` builds the schema and compliance
 * bundles and sets DELIVERY_MODE_E2E=1.
 */
import express from 'express';
import http from 'node:http';
import type { Socket } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import YAML from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  listAllComplianceStoryboards,
  runStoryboard,
  testCapabilityDiscovery,
} from '@adcp/sdk/testing';
import type { Storyboard, StoryboardResult } from '@adcp/sdk/testing';
import {
  authForStoryboard,
  testKitOptionsFromKit,
  type LoadedTestKit,
} from '../../src/compliance/storyboard-runner-options.js';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const COMPLIANCE_DIR = join(REPO_ROOT, 'dist', 'compliance', 'latest');
const SCHEMA_ROOT = join(REPO_ROOT, 'dist', 'schemas', 'latest');
const ENABLED = process.env.DELIVERY_MODE_E2E === '1'
  && existsSync(join(COMPLIANCE_DIR, 'index.json'))
  && existsSync(join(SCHEMA_ROOT, 'index.json'));

const AUTH_TOKEN = 'delivery-mode-e2e-token';
const BASELINE = 'media_buy_seller';
const GUARANTEED_BASELINE = 'media_buy_seller_guaranteed';

type Mode = 'guaranteed' | 'non_guaranteed' | undefined;

interface Harness {
  url: string;
  close: () => Promise<void>;
}

async function startTenant(): Promise<Harness> {
  process.env.PUBLIC_TEST_AGENT_TOKEN = AUTH_TOKEN;
  process.env.NODE_ENV ??= 'test';
  process.env.LOG_LEVEL = 'silent';
  const { createTrainingAgentRouter } = await import('../../src/training-agent/index.js');
  const app = express();
  app.use(express.json({
    limit: '5mb',
    verify: (req, _res, buf) => {
      (req as unknown as { rawBody?: string }).rawBody = buf.toString('utf8');
    },
  }));
  app.use('/api/training-agent', createTrainingAgentRouter({ disableRateLimit: true }));
  const server = http.createServer(app);
  const sockets = new Set<Socket>();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  const port = await new Promise<number>((resolvePort, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') reject(new Error('no listen address'));
      else resolvePort(address.port);
    });
  });
  return {
    url: `http://127.0.0.1:${port}/api/training-agent/sales/mcp`,
    close: async () => {
      server.close();
      for (const socket of sockets) socket.destroy();
    },
  };
}

async function resetTenantState(): Promise<void> {
  const { clearSessions } = await import('../../src/training-agent/state.js');
  const { clearAccountStore } = await import('../../src/training-agent/account-handlers.js');
  const { clearSeededCreativeFormats, clearForcedTaskCompletions } = await import(
    '../../src/training-agent/comply-test-controller.js'
  );
  const { clearCatalogEventStores } = await import('../../src/training-agent/catalog-event-handlers.js');
  await clearSessions();
  clearAccountStore();
  clearSeededCreativeFormats();
  clearForcedTaskCompletions();
  clearCatalogEventStores();
}

function loadKit(storyboard: Storyboard): LoadedTestKit | undefined {
  const ref = storyboard.prerequisites?.test_kit;
  if (!ref) return undefined;
  const path = join(COMPLIANCE_DIR, ref);
  return existsSync(path) ? YAML.parse(readFileSync(path, 'utf8')) as LoadedTestKit : undefined;
}

describe.skipIf(!ENABLED)('training sales tenant graded as a single-mode or mixed seller', () => {
  // The tenant resolves its capabilities when the router is built, so each mode
  // gets its own router and server (the env seam is read at that point).
  let harness: Harness | undefined;
  let storyboards: Map<string, Storyboard>;

  async function useMode(mode: Mode): Promise<Harness> {
    await harness?.close();
    if (mode) process.env.TRAINING_SALES_DELIVERY_MODES = mode;
    else delete process.env.TRAINING_SALES_DELIVERY_MODES;
    delete process.env.TRAINING_SALES_SEED_POLICY; // `store`: seeded fixtures of an unsold mode stay unsellable
    harness = await startTenant();
    return harness;
  }

  beforeAll(async () => {
    process.env.TENANT_PATH = 'sales';
    process.env.ADCP_COMPLIANCE_DIR = COMPLIANCE_DIR;
    process.env.ADCP_SCHEMA_ROOT = SCHEMA_ROOT;
    storyboards = new Map(
      listAllComplianceStoryboards({ complianceDir: COMPLIANCE_DIR, schemaRoot: SCHEMA_ROOT })
        .map(storyboard => [storyboard.id, storyboard]),
    );
  }, 120_000);

  afterAll(async () => {
    delete process.env.TRAINING_SALES_DELIVERY_MODES;
    await harness?.close();
  });

  async function run(id: string): Promise<StoryboardResult> {
    const storyboard = storyboards.get(id);
    if (!storyboard) throw new Error(`storyboard ${id} not in the compiled compliance bundle`);
    await resetTenantState();
    const kit = loadKit(storyboard);
    const domain = kit?.brand?.house?.domain;
    const testKit = testKitOptionsFromKit(kit);
    return await runStoryboard(harness!.url, storyboard, {
      auth: authForStoryboard(storyboard.id, kit, AUTH_TOKEN),
      allow_http: true,
      schemaRoot: SCHEMA_ROOT,
      ...(domain && { brand: { domain } }),
      ...(testKit && { test_kit: testKit }),
    });
  }

  const notApplicable = (result: StoryboardResult): boolean =>
    result.overall_passed
    && result.passed_count === 0
    && result.phases[0]?.phase_id === 'capability_unsupported';

  async function declaredDeliveryTypes(): Promise<unknown> {
    const discovery = await testCapabilityDiscovery(harness!.url, {
      auth: { type: 'bearer', token: AUTH_TOKEN },
      allow_http: true,
    });
    return (discovery.profile?.raw_capabilities as { media_buy?: { supported_delivery_types?: unknown } } | undefined)
      ?.media_buy?.supported_delivery_types;
  }

  it('guaranteed-only seller: base is not applicable, guaranteed baseline and sales_guaranteed pass fully', async () => {
    await useMode('guaranteed');
    expect(await declaredDeliveryTypes()).toEqual(['guaranteed']);

    const base = await run(BASELINE);
    expect(base.failed_count).toBe(0);
    expect(notApplicable(base)).toBe(true);

    // Scenarios the experiment showed cannot run for a faithful guaranteed-only seller.
    for (const id of [
      'media_buy_seller/delivery_reporting',
      'media_buy_seller/invalid_transitions',
      'media_buy_seller/total_budget_redistribution',
    ]) {
      const scenario = await run(id);
      expect(scenario.failed_count, id).toBe(0);
      expect(notApplicable(scenario), id).toBe(true);
    }

    const guaranteedBaseline = await run(GUARANTEED_BASELINE);
    expect(guaranteedBaseline.failed_count).toBe(0);
    expect(guaranteedBaseline.skipped_count).toBe(0);
    expect(guaranteedBaseline.overall_passed).toBe(true);
    expect(guaranteedBaseline.passed_count).toBeGreaterThan(10);

    const specialism = await run('sales_guaranteed');
    expect(specialism.failed_count).toBe(0);
    expect(specialism.overall_passed).toBe(true);
  }, 600_000);

  it('mixed seller that declares nothing: baseline runs as before, guaranteed baseline is not selected', async () => {
    await useMode(undefined);
    expect(await declaredDeliveryTypes()).toBeUndefined();

    const base = await run(BASELINE);
    expect(base.failed_count).toBe(0);
    expect(base.passed_count).toBeGreaterThan(0);
    expect(notApplicable(base)).toBe(false);

    const scenario = await run('media_buy_seller/delivery_reporting');
    expect(scenario.failed_count).toBe(0);
    expect(scenario.passed_count).toBeGreaterThan(0);

    expect(notApplicable(await run(GUARANTEED_BASELINE))).toBe(true);
  }, 600_000);

  it('non-guaranteed-only seller: base runs, guaranteed baseline is not selected', async () => {
    await useMode('non_guaranteed');
    expect(await declaredDeliveryTypes()).toEqual(['non_guaranteed']);

    const base = await run(BASELINE);
    expect(base.failed_count).toBe(0);
    expect(base.passed_count).toBeGreaterThan(0);

    const scenario = await run('media_buy_seller/delivery_reporting');
    expect(scenario.failed_count).toBe(0);
    expect(scenario.passed_count).toBeGreaterThan(0);

    expect(notApplicable(await run(GUARANTEED_BASELINE))).toBe(true);
  }, 600_000);
});
