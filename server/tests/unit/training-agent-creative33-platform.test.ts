import { beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { InMemoryStateStore, type Account, type CreativeAdServerPlatform, type RequestContext } from '@adcp/sdk/server';
import type { ComplyControllerContext } from '@adcp/sdk/testing';
import { createCreative33Sandbox, creative33AccountId } from '../../src/training-agent/creative33/platform.js';
import { creative33Catalog, creative33FixtureManifest } from '../../src/training-agent/creative33/catalog.js';
import { ensureTrainingAgentSchemaBundle } from '../../src/training-agent/schema-compat.js';
// The installed SDK may not package every release the training agent serves
// (3.3.0-beta.0 here); register the retained bundles first, as the server does.
beforeAll(() => ensureTrainingAgentSchemaBundle());


type Json = Record<string, unknown>;
function harness() {
  const sandbox = createCreative33Sandbox(new InMemoryStateStore());
  const account: Account = { id: creative33AccountId('platform-test'), name: 'Sandbox', status: 'active', mode: 'sandbox', ctx_metadata: {} };
  const ctx = { authInfo: { clientId: 'platform-test' }, account, input: {} } as unknown as RequestContext<Account>;
  const creative = sandbox.platform.creative as CreativeAdServerPlatform;
  const syncMany = async (items: Json[], extras: Json = {}) => {
    const input = { account: { account_id: 'creative33_sandbox' }, idempotency_key: randomUUID(), creatives: items, ...extras };
    return await creative.syncCreatives!(items as unknown as Parameters<NonNullable<CreativeAdServerPlatform['syncCreatives']>>[0], { ...ctx, input }) as unknown as Json[];
  };
  const sync = async (item: Json, extras: Json = {}) => await syncMany([item], extras);
  const list = async (req: Json = {}) => await creative.listCreatives(req as Parameters<CreativeAdServerPlatform['listCreatives']>[0], ctx) as unknown as { creatives: Json[]; pagination: Json };
  const delivery = async (req: Json = { creative_ids: ['banner'] }) => await creative.getCreativeDelivery(req as Parameters<CreativeAdServerPlatform['getCreativeDelivery']>[0], ctx) as unknown as { creatives: Array<Json & { variants: Json[] }> };
  const build = async (manifest: Json) => await creative.buildCreativeLegacy({
    account: { account_id: 'creative33_sandbox' }, idempotency_key: randomUUID(),
    target_capability_id: 'beta_video_15s', creative_manifest: manifest,
  } as Parameters<CreativeAdServerPlatform['buildCreativeLegacy']>[0], ctx) as unknown as Json;
  const controller = { account, authInfo: ctx.authInfo, input: { account: { sandbox: true } } } as ComplyControllerContext;
  return { ...sandbox, creative, ctx, sync, syncMany, list, delivery, build, controller };
}
function banner(id = 'banner', revision = 'r1'): Json {
  return { creative_id: id, name: 'Acme banner', revision_id: revision, ...creative33FixtureManifest('beta_html5_responsive') };
}
function brief(): Json {
  return { format_kind: 'video_hosted', assets: { video_brief: { asset_type: 'video_brief', segments: [
    { order: 1, duration_ms: 6000, prompt: 'Acme trail gear', vo: 'Head outside', caption: 'Acme', future_segment_field: { keep: true } },
    { order: 2, duration_ms: 9000, prompt: 'Acme end card', caption: 'Explore' },
  ] } } };
}

it('reports unchanged for the same revision and source with fresh replay keys, while metadata changes update', async () => {
  const h = harness();
  const item = banner();
  expect((await h.sync(item))[0]).toMatchObject({ action: 'created', revision_id: 'r1' });
  const before = (await h.list()).creatives[0];
  expect((await h.sync(item))[0]).toMatchObject({ action: 'unchanged', revision_id: 'r1' });
  expect((await h.list()).creatives[0].updated_date).toEqual(before.updated_date);
  expect((await h.sync({ ...item, name: 'Acme renamed' }))[0]).toMatchObject({ action: 'updated', revision_id: 'r1' });
});

it('binds complete unknown source fields to immutable revisions and keeps dry runs read-only', async () => {
  const h = harness();
  const source = { ...banner(), future_content: { nested: ['kept', { value: 1 }] } };
  expect((await h.sync(source))[0]).toMatchObject({ action: 'created', revision_id: 'r1' });
  expect((await h.sync({ ...source, name: 'Renamed', tags: ['approved-direction'] }))[0]).toMatchObject({ action: 'updated', revision_id: 'r1' });
  const changed = { ...source, future_content: { nested: ['changed'] } };
  expect((await h.sync(changed))[0]).toMatchObject({ action: 'failed', errors: [{ code: 'CREATIVE_REVISION_CONTENT_MISMATCH' }] });
  await h.sync(banner('dry'), { dry_run: true });
  const rows = (await h.list()).creatives;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ ...source, name: 'Renamed', tags: ['approved-direction'] });
});

it('rejects malformed dimensions, unknown slots, missing required slots, and unsupported backup promises', async () => {
  const h = harness();
  const malformed = banner();
  malformed.assets = { html5_bundle: { asset_type: 'zip', url: 'https://cdn.acme.example/a.zip', width: 300 } };
  await expect(h.sync(malformed)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  for (const assets of [
    {},
    { ...creative33FixtureManifest('beta_html5_responsive').assets as Json, unadvertised: { asset_type: 'text', content: 'Extra' } },
    { ...creative33FixtureManifest('beta_html5_responsive').assets as Json, backup_image: { asset_type: 'image', url: 'https://cdn.acme.example/backup.png', width: 300, height: 250 } },
  ]) expect((await h.sync({ ...banner(), assets }))[0]).toMatchObject({ action: 'failed' });
  expect((await h.list()).creatives).toHaveLength(0);
});

it('requires the exact declared custom HTML shape and pinned schema', async () => {
  const h = harness();
  const format = creative33Catalog().find(item => item.capability_id === 'beta_inline_html')!.format as Json;
  const source = { creative_id: 'html', name: 'Inline document', format_kind: 'custom',
    format_shape: format.format_shape, format_schema: format.format_schema,
    assets: { html_document: { asset_type: 'html', content: '<script>neverExecuted()</script><b>Acme</b>', width: 300, height: 250 } } };
  expect((await h.sync(source))[0]).toMatchObject({ action: 'created' });
  for (const change of [
    { format_shape: 'some_other_shape' },
    { format_schema: { ...(format.format_schema as Json), digest: `sha256:${'a'.repeat(64)}` } },
    { format_schema: { ...(format.format_schema as Json), uri: 'https://other.acme.example/schema.json' } },
  ]) expect((await h.sync({ ...source, ...change }))[0]).toMatchObject({ action: 'failed' });
});

it('consumes complete typed briefs into fixture video without copying source rights or provenance claims', async () => {
  const h = harness();
  const source = { ...brief(), provenance: { digital_source_type: 'digital_capture' }, rights: [{ rights_id: 'source-right', rights_agent: { id: 'agent', url: 'https://rights.acme.example/mcp' }, uses: ['commercial'] }] };
  const result = await h.build(source);
  const manifest = result.creative_manifest as Json;
  expect(manifest.assets).toMatchObject({ video_main: { asset_type: 'video', width: 640, height: 360, duration_ms: 15000, container_format: 'mp4', video_codec: 'h264' } });
  expect(manifest).not.toHaveProperty('provenance');
  expect(manifest).not.toHaveProperty('rights');
  expect(manifest.ext).toEqual({ creative33: { mode: 'deterministic_sandbox_fixture', source_manifest: source } });
  expect(result.build_variant_id).toMatch(/^bv_/);
});

it('rejects invalid brief duration and sequencing instead of emitting generic HTML or a fake video', async () => {
  const h = harness();
  for (const segments of [
    [{ order: 1, duration_ms: 14999, prompt: 'Wrong duration' }],
    [{ order: 2, duration_ms: 15000, prompt: 'Missing first segment' }],
    [],
  ]) await expect(h.build({ format_kind: 'video_hosted', assets: { video_brief: { asset_type: 'video_brief', segments } } })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
});

it('records per-size simulated executions only after explicit controller simulation and preserves old revisions', async () => {
  const h = harness();
  await h.sync(banner());
  expect((await h.delivery()).creatives[0].variants).toEqual([]);
  const fixtures = [{ id: 'mrec', width: 300, height: 250 }, { id: 'leaderboard', width: 728, height: 90 }];
  for (const size of fixtures) {
    await h.complyTest.seed!.media_buy!({ media_buy_id: size.id, fixture: { packages: [{ package_id: size.id, format_kind: 'html5', params: { width: size.width, height: size.height }, creative_assignments: [{ creative_id: 'banner' }] }] } }, h.controller);
    const params = { media_buy_id: size.id, impressions: 10, clicks: 1, reported_spend: { amount: 2, currency: 'USD' } };
    await h.complyTest.simulate!.delivery!(params, h.controller);
    await h.complyTest.simulate!.delivery!(params, h.controller);
  }
  const before = (await h.delivery()).creatives.flatMap(item => item.variants);
  expect(before).toHaveLength(2);
  expect(new Set(before.map(item => item.variant_id)).size).toBe(2);
  for (const variant of before) {
    expect(variant.revision_id).toBe('r1');
    expect(variant.impressions).toBe(10);
    const main = ((variant.manifest as Json).assets as Json).html5_bundle as Json;
    expect(main).not.toHaveProperty('sizes');
    expect(fixtures.some(size => size.width === main.width && size.height === main.height)).toBe(true);
  }
  const next = banner('banner', 'r2');
  next.assets = { html5_bundle: { ...((next.assets as Json).html5_bundle as Json), future_build_field: 'revision-two' } };
  await h.sync(next);
  expect((await h.delivery()).creatives.flatMap(item => item.variants)).toEqual(before);
  expect((await h.list()).creatives[0].revision_id).toBe('r2');
  expect((await h.delivery({ media_buy_ids: ['unknown'] })).creatives).toEqual([]);
  await h.complyTest.simulate!.delivery!({ media_buy_id: 'mrec', impressions: 10, clicks: 1, reported_spend: { amount: 2, currency: 'USD' } }, h.controller);
  const truncated = await h.delivery({ media_buy_ids: ['mrec'], max_variants: 1 });
  expect(truncated.creatives[0].variant_count).toBe(2);
  expect(truncated.creatives[0].variants).toHaveLength(1);
});

it('rejects unknown seeded canvas selections and library-only brief trafficking', async () => {
  const h = harness();
  await h.sync(banner());
  await expect(h.complyTest.seed!.media_buy!({ media_buy_id: 'bad', fixture: { packages: [{ package_id: 'bad', format_kind: 'html5', params: { width: 300, height: 90 }, creative_assignments: [{ creative_id: 'banner' }] }] } }, h.controller)).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  await h.sync({ creative_id: 'brief', name: 'Source only', ...brief() });
  await expect(h.complyTest.seed!.media_buy!({ media_buy_id: 'brief', fixture: { packages: [{ package_id: 'brief', format_kind: 'video_hosted', params: { width: 640, height: 360 }, creative_assignments: [{ creative_id: 'brief' }] }] } }, h.controller)).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
});

it('honors common library filtering and pagination while rejecting unsupported modifiers', async () => {
  const h = harness();
  await h.sync({ ...banner('one'), tags: ['outdoor'], concept_id: 'launch' });
  await h.sync(banner('two'));
  const first = await h.list({ pagination: { max_results: 1 } });
  expect(first.creatives).toHaveLength(1);
  expect(first.pagination.has_more).toBe(true);
  const second = await h.list({ pagination: { max_results: 1, cursor: first.pagination.cursor } });
  expect(second.creatives).toHaveLength(1);
  expect(second.creatives[0].creative_id).not.toBe(first.creatives[0].creative_id);
  expect((await h.list({ filters: { tags: ['outdoor'], format_kinds: ['html5'], asset_types: ['zip'] } })).creatives.map(item => item.creative_id)).toEqual(['one']);
  for (const req of [{ include_pricing: true }, { include_assignments: true }, { filters: { has_variables: true } }]) {
    await expect(h.list({ account: { account_id: 'creative33_sandbox' }, ...req })).rejects.toMatchObject({ code: 'UNSUPPORTED_FEATURE' });
  }
});

it('hard purge cleans owned source/execution fixtures and starts a fresh revision incarnation', async () => {
  const h = harness();
  await h.sync(banner());
  await h.complyTest.seed!.media_buy!({ media_buy_id: 'cleanup', fixture: { packages: [{ package_id: 'cleanup', format_kind: 'html5', params: { width: 300, height: 250 }, creative_assignments: [{ creative_id: 'banner' }] }] } }, h.controller);
  await h.complyTest.simulate!.delivery!({ media_buy_id: 'cleanup', impressions: 1 }, h.controller);
  await expect(h.complyTest.force!.creative_purge!({ creative_id: 'banner', purge_kind: 'soft' }, h.controller)).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  await h.complyTest.force!.creative_purge!({ creative_id: 'banner', purge_kind: 'hard' }, h.controller);
  expect((await h.list()).creatives).toEqual([]);
  expect((await h.delivery()).creatives).toEqual([]);
  await expect(h.complyTest.simulate!.delivery!({ media_buy_id: 'cleanup', impressions: 1 }, h.controller)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect((await h.sync({ ...banner(), future_source: 'new incarnation bytes' }))[0]).toMatchObject({ action: 'created', revision_id: 'r1' });
});

it.each([
  ['default', {}],
  ['strict', { validation_mode: 'strict' }],
  ['strict dry run', { validation_mode: 'strict', dry_run: true }],
])('rejects an entire %s batch without publishing source rows or binding future revisions', async (_mode, extras) => {
  const h = harness();
  const good = banner('good');
  const bad = { creative_id: 'bad', name: 'Missing ZIP slot', revision_id: 'r1', format_kind: 'html5', assets: {} };
  const result = await h.syncMany([good, bad], extras);
  expect(result.map(item => item.action)).toEqual(['failed', 'failed']);
  expect((await h.list()).creatives).toEqual([]);
  expect((await h.sync({ ...good, future_content: 'A different accepted source after abort' }))[0]).toMatchObject({ action: 'created', revision_id: 'r1' });
});

it('explicit lenient validation commits valid rows and reports the bad row', async () => {
  const h = harness();
  const bad = { creative_id: 'bad', name: 'Missing ZIP slot', revision_id: 'r1', format_kind: 'html5', assets: {} };
  const result = await h.syncMany([banner('good'), bad], { validation_mode: 'lenient' });
  expect(result.map(item => item.action)).toEqual(['created', 'failed']);
  expect((await h.list()).creatives.map(item => item.creative_id)).toEqual(['good']);
});

it('strict batch failure rolls back an update of an existing creative and its new revision binding', async () => {
  const h = harness();
  await h.sync(banner());
  const updated = { ...banner('banner', 'r2'), future_content: 'Uncommitted replacement' };
  await h.syncMany([updated, { creative_id: 'bad', name: 'Bad', format_kind: 'html5', assets: {} }]);
  expect((await h.list()).creatives[0].revision_id).toBe('r1');
  expect((await h.sync({ ...updated, future_content: 'Different committed replacement' }))[0]).toMatchObject({ action: 'updated', revision_id: 'r2' });
});

it('strict dry run of an otherwise valid batch keeps source and revision namespaces untouched', async () => {
  const h = harness();
  expect((await h.syncMany([banner('first'), banner('second')], { dry_run: true })).map(item => item.action)).toEqual(['created', 'created']);
  expect((await h.list()).creatives).toEqual([]);
  expect((await h.sync({ ...banner('first'), future_content: 'First actual accepted bytes' }))[0]).toMatchObject({ action: 'created', revision_id: 'r1' });
});

it('rejects unsized ZIP, display tag and inline HTML assets for these bounded sized options', async () => {
  const h = harness();
  const html = creative33Catalog().find(item => item.capability_id === 'beta_inline_html')!.format as Json;
  const manifests = [
    creative33FixtureManifest('beta_html5_responsive'),
    creative33FixtureManifest('beta_display_inline'),
    creative33FixtureManifest('beta_display_url'),
    { format_kind: 'custom', format_shape: html.format_shape, format_schema: html.format_schema, assets: { html_document: { asset_type: 'html', content: '<div>Acme</div>' } } },
  ];
  for (const [index, manifest] of manifests.entries()) {
    const source = structuredClone(manifest);
    for (const value of Object.values(source.assets as Json)) {
      const asset = value as Json;
      delete asset.sizes; delete asset.width; delete asset.height;
    }
    expect((await h.sync({ ...source, creative_id: `unsized-${index}`, name: 'Unknown canvas', revision_id: 'r1' }))[0]).toMatchObject({ action: 'failed' });
  }
  expect((await h.list()).creatives).toEqual([]);
});
