import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { ADCPMultiAgentClient, type CreativeManifest } from '@adcp/sdk';
import { InMemoryStateStore } from '@adcp/sdk/server';
import { mountCreative33Sandbox } from '../../src/training-agent/creative33/router.js';
import { clearIdempotencyCache } from '../../src/training-agent/idempotency.js';
import { ensureTrainingAgentSchemaBundle } from '../../src/training-agent/schema-compat.js';

type Json = Record<string, unknown>;
const ACCOUNT = { account_id: 'creative33_sandbox' };
function data(result: { status: string; data?: unknown; error?: unknown }): Json {
  expect(result.status, JSON.stringify(result.error)).toBe('completed');
  expect(result.data).toBeTruthy();
  return result.data as Json;
}
const rows = (value: Json) => value.creatives as Json[];
const object = (value: unknown) => value as Json;

describe('published SDK buyer journeys on the frozen creative 3.3 beta', () => {
  let server: http.Server;
  let base: string;
  let agent: ReturnType<ADCPMultiAgentClient['agent']>;
  beforeAll(async () => {
    // The SDK buyer validates against 3.3.0-beta.0, which the installed SDK
    // may not package; register the retained bundles first, as the server does.
    await ensureTrainingAgentSchemaBundle();
    const app = express();
    app.use(express.json({ limit: '1mb', verify: (req, _res, bytes) => {
      (req as typeof req & { rawBody?: Buffer }).rawBody = Buffer.from(bytes);
    } }));
    mountCreative33Sandbox(app, {
      enabled: true, store: new InMemoryStateStore(),
      requireAuth: (req, res, next) => {
        if (req.get('authorization') !== 'Bearer buyer-flow-test') { res.status(401).end(); return; }
        res.locals.trainingPrincipal = 'test:creative33:buyer-flow'; next();
      },
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    agent = ADCPMultiAgentClient.simple(`${base}/beta/3.3/creative/mcp`, {
      authToken: 'buyer-flow-test', adcpVersion: '3.3.0-beta.0', wireAdcpVersion: '3.3-beta.0', timeout: 15000,
    }).agent('default-agent');
  });
  afterAll(async () => {
    server?.closeAllConnections();
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    await clearIdempotencyCache();
  });

  // These phases share one real HTTP session and creative. Keeping the
  // cold discovery/build work separate from upload and both executions gives
  // each buyer operation the existing test budget without relaxing timeouts.
  describe.each([
    ['beta_html5_responsive', 'html5_bundle', 'html5'],
    ['beta_display_inline', 'serving_tag', 'display_tag'],
    ['beta_display_url', 'serving_tag', 'display_tag'],
  ])('%s buyer journey', { concurrent: false, shuffle: false }, (capabilityId, slot, kind) => {
    const creativeId = `acme-${randomUUID()}`;
    let manifest: CreativeManifest;
    let sourceAsset: unknown;

    it('discovers the frozen contract', async () => {
      const discovered = data(await agent.getAdcpCapabilities({}));
      expect(discovered).toMatchObject({ adcp_version: '3.3-beta.0', adcp: { supported_versions: ['3.3-beta.0'] } });
      const formats = object(discovered.creative).supported_formats as Json[];
      expect(formats.find(value => value.capability_id === capabilityId)).toMatchObject({ format: { format_kind: kind }, operations: expect.arrayContaining(['build', 'preview']) });
    });

    it('builds a complete responsive source', async () => {
      const built = data(await agent.executeTask('build_creative', {
        account: ACCOUNT, target_capability_id: capabilityId,
        message: 'Build the deterministic Acme sandbox fixture.', idempotency_key: randomUUID(),
      }));
      manifest = built.creative_manifest as CreativeManifest;
      expect(manifest).toMatchObject({ format_kind: kind });
      sourceAsset = structuredClone(object(object(manifest).assets)[slot]);
      expect(sourceAsset).toMatchObject({ sizes: [{ width: 300, height: 250 }, { width: 728, height: 90 }] });
    });

    it('uploads a source revision and reads it back before any simulation', async () => {
      expect(manifest, 'The discovery/build phase must complete first.').toBeDefined();
      const item = { ...manifest, creative_id: creativeId, revision_id: 'source_r1', name: 'Acme responsive fixture' };
      const accepted = data(await agent.executeTask('sync_creatives', { account: ACCOUNT, creatives: [item], idempotency_key: randomUUID() }));
      expect(rows(accepted)[0]).toMatchObject({ creative_id: creativeId, revision_id: 'source_r1', action: 'created' });
      const listed = data(await agent.listCreatives({ account: ACCOUNT, filters: { creative_ids: [creativeId] } }));
      expect(rows(listed)).toHaveLength(1);
      expect(object(rows(listed)[0].assets)[slot]).toEqual(sourceAsset);
      expect(rows(data(await agent.getCreativeDelivery({ account: ACCOUNT, creative_ids: [creativeId] })))[0]).toMatchObject({ variant_count: 0, variants: [], totals: { impressions: 0 } });
    });

    it.each([{ width: 300, height: 250 }, { width: 728, height: 90 }])('previews and simulates the $width × $height canvas', async dimensions => {
      const preview = data(await agent.previewCreative({
        request_type: 'single', creative_id: creativeId, quality: 'production', output_format: 'html',
        inputs: [{ name: 'Selected placement', macros: { AD_WIDTH: String(dimensions.width), AD_HEIGHT: String(dimensions.height) } }],
      }));
      expect(preview).toMatchObject({ quality_used: 'draft', previews: [{ renders: [{ dimensions }] }] });
      const html = object((object((preview.previews as Json[])[0]).renders as Json[])[0]).preview_html;
      expect(html).toContain('Deterministic sandbox draft');
      const mediaBuyId = `simulation-${randomUUID()}`;
      data(await agent.executeTask('comply_test_controller', {
        account: ACCOUNT, scenario: 'seed_media_buy', params: { media_buy_id: mediaBuyId, fixture: {
          packages: [{ package_id: 'placement', format_kind: kind, params: dimensions, creative_assignments: [{ creative_id: creativeId }] }],
        } },
      }));
      data(await agent.executeTask('comply_test_controller', {
        account: ACCOUNT, scenario: 'simulate_delivery',
        params: { media_buy_id: mediaBuyId, impressions: 1000, clicks: 10, reported_spend: { amount: 5, currency: 'USD' } },
      }));
      const delivery = data(await agent.getCreativeDelivery({ account: ACCOUNT, creative_ids: [creativeId], media_buy_ids: [mediaBuyId] }));
      expect(rows(delivery)).toHaveLength(1);
      const entry = rows(delivery)[0];
      expect(entry).toMatchObject({ creative_id: creativeId, media_buy_id: mediaBuyId, variant_count: 1, totals: { impressions: 1000, clicks: 10, spend: 5 } });
      const variant = (entry.variants as Json[])[0];
      expect(variant.revision_id).toBe('source_r1');
      const output = object(object(variant.manifest).assets)[slot];
      const { sizes: _sizes, ...rest } = object(sourceAsset);
      expect(output).toEqual({ ...rest, ...dimensions });
    });

    it('preserves the responsive source after execution and rejects unsupported canvases', async () => {
      const after = rows(data(await agent.listCreatives({ account: ACCOUNT, filters: { creative_ids: [creativeId] } })))[0];
      expect(after.revision_id).toBe('source_r1');
      expect(object(after.assets)[slot]).toEqual(sourceAsset);
      const unsupported = await agent.previewCreative({
        request_type: 'single', creative_id: creativeId, output_format: 'html',
        inputs: [{ name: 'Unsupported placement', macros: { AD_WIDTH: '970', AD_HEIGHT: '250' } }],
      });
      expect(unsupported.status).toBe('failed');
    });
  });

  it('consumes a complete typed brief, emits playable fixture video, and preserves source revisions', async () => {
    const source = { format_kind: 'video_hosted', assets: { video_brief: {
      asset_type: 'video_brief', segments: [
        { order: 1, duration_ms: 5000, prompt: 'Acme boots on a trail.', vo: 'Start exploring.', caption: 'Acme outdoor' },
        { order: 2, duration_ms: 10000, prompt: 'Acme boots at the summit.', vo: 'Find your next trail.', caption: 'Find your trail' },
      ],
    } } } as CreativeManifest;
    const validation = data(await agent.executeTask('validate_input', {
      manifest: source, targets: [{ kind: 'capability', id: 'beta_video_brief_input' }],
    }));
    expect(validation).toMatchObject({ results: [{ result_kind: 'validated_pass' }] });
    const built = data(await agent.executeTask('build_creative', {
      account: ACCOUNT, target_capability_id: 'beta_video_15s', creative_manifest: source,
      message: 'Create the deterministic 15-second sample for this typed brief.', idempotency_key: randomUUID(),
    }));
    const manifest = built.creative_manifest as CreativeManifest;
    expect(manifest).toMatchObject({ format_kind: 'video_hosted', assets: { video_main: { asset_type: 'video', width: 640, height: 360, duration_ms: 15000 } }, ext: { creative33: { mode: 'deterministic_sandbox_fixture', source_manifest: source } } });
    expect(object(object(manifest).assets).video_brief).toBeUndefined();
    const video = object(object(object(manifest).assets).video_main);
    const downloaded = await fetch(`${base}${new URL(String(video.url)).pathname}`);
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get('content-type')).toMatch(/video\/mp4/);
    const bytes = Buffer.from(await downloaded.arrayBuffer());
    const mvhd = bytes.indexOf(Buffer.from('mvhd'));
    expect(mvhd).toBeGreaterThan(0);
    expect(bytes[mvhd + 4]).toBe(0);
    expect(bytes.readUInt32BE(mvhd + 20) / bytes.readUInt32BE(mvhd + 16)).toBe(15);

    const creativeId = `video-${randomUUID()}`;
    data(await agent.executeTask('sync_creatives', { account: ACCOUNT, idempotency_key: randomUUID(), creatives: [{ ...manifest, creative_id: creativeId, revision_id: 'video_r1', name: 'Acme video fixture' }] }));
    const preview = data(await agent.previewCreative({ request_type: 'single', creative_id: creativeId, output_format: 'html' }));
    expect(preview).toMatchObject({ quality_used: 'draft', previews: [{ renders: [{ dimensions: { width: 640, height: 360 } }] }] });
    const mediaBuyId = `video-simulation-${randomUUID()}`;
    data(await agent.executeTask('comply_test_controller', { account: ACCOUNT, scenario: 'seed_media_buy', params: { media_buy_id: mediaBuyId, fixture: {
      packages: [{ package_id: 'video-placement', format_kind: 'video_hosted', params: { width: 640, height: 360 }, creative_assignments: [{ creative_id: creativeId }] }],
    } } }));
    data(await agent.executeTask('comply_test_controller', { account: ACCOUNT, scenario: 'simulate_delivery', params: { media_buy_id: mediaBuyId, impressions: 10 } }));
    expect(rows(data(await agent.getCreativeDelivery({ account: ACCOUNT, creative_ids: [creativeId], media_buy_ids: [mediaBuyId] })))[0]).toMatchObject({ variants: [{ revision_id: 'video_r1', manifest }] });
  });

  it('preserves raw HTML only under its discovered custom library/preview contract', async () => {
    const discovered = data(await agent.getAdcpCapabilities({}));
    const option = (object(discovered.creative).supported_formats as Json[]).find(value => value.capability_id === 'beta_inline_html')!;
    const format = object(option.format);
    const schema = await fetch(`${base}${new URL(String(object(format.format_schema).uri)).pathname}`);
    expect(schema.status).toBe(200);
    const creativeId = `html-${randomUUID()}`;
    const asset = { asset_type: 'html', content: '<script>parent.escaped = true</script><div>Acme</div>', width: 300, height: 250 };
    const manifest = { format_kind: 'custom', format_shape: format.format_shape, format_schema: format.format_schema, assets: { html_document: asset } } as CreativeManifest;
    const result = data(await agent.executeTask('sync_creatives', { account: ACCOUNT, idempotency_key: randomUUID(), creatives: [{ ...manifest, creative_id: creativeId, revision_id: 'html_r1', name: 'Acme inline document' }] }));
    expect(rows(result)[0].action).toBe('created');
    const listed = rows(data(await agent.listCreatives({ account: ACCOUNT, filters: { creative_ids: [creativeId] } })))[0];
    expect(listed.assets).toEqual({ html_document: asset });
    const preview = data(await agent.previewCreative({ request_type: 'single', creative_id: creativeId, output_format: 'html' }));
    const html = ((object((preview.previews as Json[])[0]).renders as Json[])[0]).preview_html;
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>parent.escaped');
    const seeded = await agent.executeTask('comply_test_controller', { account: ACCOUNT, scenario: 'seed_media_buy', params: { media_buy_id: randomUUID(), fixture: {
      packages: [{ package_id: 'inline-placement', format_kind: 'custom', params: { width: 300, height: 250 }, creative_assignments: [{ creative_id: creativeId }] }],
    } } });
    expect(seeded.status).toBe('failed');
  });
});
