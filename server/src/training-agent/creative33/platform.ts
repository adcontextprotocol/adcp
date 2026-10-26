/** Isolated fixture-backed beta platform. No legacy handlers, outbound fetches, or buyer-code execution. */
import { createHash } from 'node:crypto';
import { canonicalize } from '@adcp/sdk';
import { getCanonicalToolValidator } from '@adcp/sdk/schemas';
import { getAgentUrl } from '../config.js';
import { AdcpError, TestControllerError, scopedStore, patchWithRetry, type Account, type AdcpStateStore, type DecisioningPlatform, type CreativeAdServerPlatform } from '@adcp/sdk/server';
import type { ComplyControllerConfig, ComplyControllerContext } from '@adcp/sdk/testing';
import {
  CREATIVE33_ROUTE, CREATIVE33_SCHEMA_VERSION, CREATIVE33_SIZES, CREATIVE33_WIRE_VERSION,
  CREATIVE33_HTML_SCHEMA_DIGEST,
  creative33Catalog, creative33FixtureManifest, creative33FixtureUrl,
} from './catalog.js';

type Json = Record<string, unknown>;
type CallContext = { account?: { id: string; mode?: string }; authInfo?: { clientId?: string }; input?: unknown };
type Creative = { record: Json; fingerprint: string; created: string; updated: string };
type Revision = { creativeId: string; revisionId: string; fingerprint: string };
type Variant = { id: string; binding: string; creativeId: string; mediaBuyId: string; packageId: string; revisionId?: string; manifest: Json; impressions: number; clicks: number; spend: number; occurredAt: string };
type State = Json & { creatives: Creative[]; revisions: Revision[]; buys: Json[]; variants: Variant[]; simulations: Json[] };
const clone = <T>(value: T): T => structuredClone(value);
const record = (value: unknown): Json => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const hash = (value: unknown) => createHash('sha256').update(canonicalize(value)).digest('hex');
const empty = (): State => ({ creatives: [], revisions: [], buys: [], variants: [], simulations: [] });
class StrictSyncRejected extends Error {
  constructor(readonly results: Json[]) { super('Strict sync rejected without committing the candidate state.'); }
}
const EXCLUDED = new Set(['creative_id', 'revision_id', 'name', 'tags', 'status', 'weight', 'placement_refs', 'placement_ids']);
function fail(code: string, message: string, field?: string): never { throw new AdcpError(code, { message, ...(code === 'CONFIGURATION_ERROR' ? { recovery: 'terminal' as const } : { recovery: 'correctable' as const }), ...(field ? { field } : {}) }); }
async function controllerOperation<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof TestControllerError) throw error;
    if (!(error instanceof AdcpError)) throw error;
    const code = ['AUTH_REQUIRED', 'ACCOUNT_REQUIRED', 'ACCOUNT_NOT_FOUND'].includes(error.code)
      ? 'FORBIDDEN' : ['CREATIVE_NOT_FOUND', 'REFERENCE_NOT_FOUND'].includes(error.code) ? 'NOT_FOUND' : 'INVALID_PARAMS';
    throw new TestControllerError(code, error.message);
  }
}
function principal(ctx: CallContext): string {
  const id = ctx.authInfo?.clientId;
  if (!id) return fail('AUTH_REQUIRED', 'An authenticated sandbox caller is required.');
  return id;
}
export function creative33AccountId(clientId: string): string {
  return `acct_creative33_${hash(clientId).slice(0, 24)}`;
}
function ownedAccount(ctx: CallContext): string {
  const expected = creative33AccountId(principal(ctx));
  if (ctx.account?.id !== expected || ctx.account.mode !== 'sandbox') {
    return fail('ACCOUNT_REQUIRED', 'Use this caller’s creative33_sandbox account.');
  }
  return expected;
}
function scope(store: AdcpStateStore, ctx: CallContext): AdcpStateStore {
  return scopedStore(store, hash({ route: CREATIVE33_ROUTE, principal: principal(ctx), account: ownedAccount(ctx) }));
}
function assertSizeLimit(value: unknown): void {
  if (Buffer.byteLength(canonicalize(value)) > 65536) fail('INVALID_REQUEST', 'Sandbox creative inputs are limited to 64 KB.');
}
function assertCanonical(tool: string, input: unknown): void {
  const validate = getCanonicalToolValidator(tool, 'request', { adcpVersion: CREATIVE33_SCHEMA_VERSION });
  if (!validate) fail('CONFIGURATION_ERROR', 'The published beta validator is unavailable.');
  if (!validate(input)) fail('INVALID_REQUEST', `Request does not satisfy the published beta contract: ${validate.errors?.[0]?.message ?? 'invalid request'}.`);
}
function manifestOf(item: Json): Json {
  const { creative_id: _id, revision_id: _revision, name: _name, tags: _tags, status: _status,
    weight: _weight, placement_refs: _placements, placement_ids: _ids, ...manifest } = item;
  return clone(manifest);
}
function sizesOf(asset: Json): Json[] {
  if (Array.isArray(asset.sizes)) return asset.sizes.map(record);
  return typeof asset.width === 'number' && typeof asset.height === 'number'
    ? [{ width: asset.width, height: asset.height }] : [];
}
const sameSize = (a: Json, b: Json) => a.width === b.width && a.height === b.height;
function optionFor(manifest: Json, capabilityId?: string) {
  const options = creative33Catalog().filter(option => option.format.format_kind === manifest.format_kind);
  const selected = capabilityId ? options.find(option => option.capability_id === capabilityId) : options.find(option => {
    const slot = option.format.params.slots[0];
    const asset = record(record(manifest.assets)[slot.asset_group_id]);
    if (asset.asset_type !== slot.asset_type) return false;
    if (option.capability_id === 'beta_display_inline') return asset.delivery_type === 'inline_markup';
    if (option.capability_id === 'beta_display_url') return asset.delivery_type === 'tag_url';
    return true;
  });
  if (!selected) return fail('FORMAT_NOT_SUPPORTED', 'No advertised beta contract matches this manifest.', 'creative_manifest');
  const suppliedAssets = record(manifest.assets);
  const declaredSlots = selected.format.params.slots;
  for (const key of Object.keys(suppliedAssets)) {
    if (!declaredSlots.some(slot => slot.asset_group_id === key)) fail('INVALID_REQUEST', `Unknown asset slot ${key} for the selected sandbox contract.`, `assets.${key}`);
  }
  for (const slot of declaredSlots) {
    const value = suppliedAssets[slot.asset_group_id];
    if (value === undefined && !slot.required) continue;
    if (Array.isArray(value) || record(value).asset_type !== slot.asset_type) {
      fail('INVALID_REQUEST', `Slot ${slot.asset_group_id} requires one ${slot.asset_type} asset.`, `assets.${slot.asset_group_id}`);
    }
  }
  if (selected.capability_id === 'beta_inline_html') {
    const schema = record(manifest.format_schema);
    if (manifest.format_shape !== 'inline_html_document'
      || schema.uri !== `${getAgentUrl()}${CREATIVE33_ROUTE}/formats/inline-html.json`
      || schema.digest !== CREATIVE33_HTML_SCHEMA_DIGEST) {
      fail('FORMAT_NOT_SUPPORTED', 'Inline HTML requires the exact discovered custom shape and pinned schema reference.', 'creative_manifest.format_schema');
    }
  }
  const primarySlot = selected.format.params.slots[0];
  const asset = record(record(manifest.assets)[primarySlot.asset_group_id]);
  if (asset.asset_type !== primarySlot.asset_type) fail('INVALID_REQUEST', 'The declared primary asset is missing or has the wrong type.', `assets.${primarySlot.asset_group_id}`);
  if (selected.capability_id.startsWith('beta_display_')) {
    const expected = selected.capability_id === 'beta_display_inline' ? 'inline_markup' : 'tag_url';
    if (asset.delivery_type !== expected) fail('FORMAT_NOT_SUPPORTED', 'Display-tag delivery type does not match the selected contract.');
  }
  if (selected.capability_id === 'beta_video_15s'
    && (asset.width !== 640 || asset.height !== 360 || asset.duration_ms !== 15000)) {
    fail('INVALID_REQUEST', 'The deterministic video contract requires 640×360 and 15000 ms.', 'assets.video_main');
  }
  const sizes = sizesOf(asset);
  if (!selected.capability_id.startsWith('beta_video_') && sizes.length === 0) fail('INVALID_REQUEST', 'This bounded sized contract requires a fixed canvas or a nonempty selectable size list.', 'assets');
  if (!selected.capability_id.startsWith('beta_video_') && sizes.length
    && !sizes.some(size => CREATIVE33_SIZES.some(allowed => sameSize(size, allowed)))) {
    fail('INVALID_REQUEST', 'This sandbox accepts only 300×250 or 728×90 canvases.', 'assets');
  }
  return { selected, asset, primarySlot };
}
function validateManifest(manifest: Json): void {
  assertSizeLimit(manifest);
  assertCanonical('sync_creatives', {
    account: { account_id: 'creative33_sandbox' }, idempotency_key: 'beta-manifest-validation',
    creatives: [{ ...manifest, creative_id: 'beta-validation', name: 'Beta validation' }],
  });
  if (manifest.representation_selection || manifest.localization) fail('UNSUPPORTED_FEATURE', 'Representation sets and localization are outside this bounded beta sandbox.');
  optionFor(manifest);
}
function selectCanvas(manifest: Json, requested?: Json): { manifest: Json; dimensions: Json } {
  const { selected, asset, primarySlot } = optionFor(manifest);
  if (selected.capability_id === 'beta_video_brief_input') fail('INVALID_REQUEST', 'Build the typed brief into a finished video before previewing or simulating delivery.');
  const sizes = sizesOf(asset);
  const dimensions = requested ?? (sizes.length === 1 ? sizes[0] : undefined);
  if (!dimensions || !sizes.some(size => sameSize(size, dimensions))) {
    return fail('INVALID_REQUEST', 'Select one of the asset’s concrete supported canvas sizes.', 'inputs.macros');
  }
  if (selected.capability_id !== 'beta_video_15s' && !CREATIVE33_SIZES.some(size => sameSize(size, dimensions))) {
    fail('INVALID_REQUEST', 'The selected canvas is not supported by the sandbox.');
  }
  const output = clone(manifest);
  const fixedAsset = record(record(output.assets)[primarySlot.asset_group_id]);
  delete fixedAsset.sizes;
  fixedAsset.width = dimensions.width; fixedAsset.height = dimensions.height;
  return { manifest: output, dimensions };
}
function page(raw: unknown, queryHash: string) {
  const pagination = record(raw);
  let offset = 0;
  if (pagination.cursor !== undefined) {
    try {
      const parsed = JSON.parse(Buffer.from(String(pagination.cursor), 'base64url').toString('utf8')) as { offset: number; query: string };
      if (!Number.isSafeInteger(parsed.offset) || parsed.offset < 0 || parsed.query !== queryHash) throw new Error('invalid cursor');
      offset = parsed.offset;
    } catch { fail('INVALID_REQUEST', 'The pagination cursor does not match this query.', 'pagination.cursor'); }
  }
  const limit = typeof pagination.max_results === 'number' ? pagination.max_results : 100;
  return { offset, limit, cursorFor: (next: number) => Buffer.from(JSON.stringify({ offset: next, query: queryHash })).toString('base64url') };
}
function previewDimensions(input: Json): Json | undefined {
  const macros = record(input.macros);
  const rawWidth = macros.AD_WIDTH ?? macros['{AD_WIDTH}'];
  const rawHeight = macros.AD_HEIGHT ?? macros['{AD_HEIGHT}'];
  if (rawWidth === undefined && rawHeight === undefined) return undefined;
  const width = Number(rawWidth); const height = Number(rawHeight);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) fail('INVALID_REQUEST', 'Preview dimensions must be a positive integer pair.');
  return { width, height };
}
function escape(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
function previewHtml(manifest: Json, dimensions: Json): string {
  // Content is shown as text. No arbitrary buyer HTML, ZIP, tag or remote script is executed.
  const slot = optionFor(manifest).asset;
  const label = typeof slot.content === 'string' ? slot.content : typeof slot.markup === 'string' ? slot.markup : String(slot.url ?? manifest.format_kind);
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"></head><body><div style="width:${Number(dimensions.width)}px;height:${Number(dimensions.height)}px;overflow:hidden;border:1px solid black"><p>Deterministic sandbox draft — selected canvas only</p><pre>${escape(label)}</pre></div></body></html>`;
}

export function createCreative33Sandbox(store: AdcpStateStore) {
  const read = async (ctx: CallContext): Promise<State> => clone(await scope(store, ctx).get<State>('library', 'state') ?? empty());
  const mutate = async (ctx: CallContext, fn: (state: State) => void) => {
    return patchWithRetry<State>(scope(store, ctx), 'library', 'state', current => {
      const next = clone(current ?? empty()); fn(next); return next;
    });
  };
  const lookup = async (id: string, ctx: CallContext) => {
    const found = (await read(ctx)).creatives.find(item => item.record.creative_id === id);
    if (!found) return fail('CREATIVE_NOT_FOUND', 'Creative was not found in this caller’s sandbox library.', 'creative_id');
    return clone(found.record);
  };
  const preview = async (req: Json, ctx: CallContext): Promise<Json> => {
    assertCanonical('preview_creative', req);
    if (req.request_type === 'variant') {
      const variant = (await read(ctx)).variants.find(item => item.id === req.variant_id);
      if (!variant) fail('REFERENCE_NOT_FOUND', 'The simulated served execution is not retained in this sandbox.');
      // This renderer is intentionally a draft visualization, so do not claim exact variant replay.
      return fail('UNSUPPORTED_FEATURE', 'Exact variant replay is not supported. Preview the retained manifest in single mode at draft quality.');
    }
    if (req.request_type === 'batch') {
      const results = [];
      for (const raw of req.requests as Json[]) {
        try {
          const response = await preview({ ...req, ...raw, request_type: 'single', requests: undefined }, ctx);
          results.push({ success: true, creative_id: raw.creative_id ?? 'inline', quality_used: 'draft', response: { previews: response.previews } });
        } catch (error) {
          const failure = error as { code?: string; message?: string };
          results.push({ success: false, creative_id: raw.creative_id ?? 'inline', errors: [{ code: failure.code ?? 'INVALID_REQUEST', message: failure.message ?? 'Invalid preview' }] });
        }
      }
      return { response_type: 'batch', results };
    }
    const manifest = req.creative_id ? manifestOf(await lookup(String(req.creative_id), ctx)) : clone(record(req.creative_manifest));
    validateManifest(manifest);
    const { selected } = optionFor(manifest, typeof req.target_capability_id === 'string' ? req.target_capability_id : undefined);
    if (!selected.operations.includes('preview')) fail('FORMAT_NOT_SUPPORTED', 'This capability does not offer preview.');
    const inputs = Array.isArray(req.inputs) ? req.inputs.map(record) : [{ name: 'Default' }];
    const previews = inputs.map(input => {
      const resolved = selectCanvas(manifest, previewDimensions(input));
      const html = previewHtml(resolved.manifest, resolved.dimensions);
      const outputFormat = req.output_format === 'html' ? 'html' : req.output_format === 'both' ? 'both' : 'url';
      return {
        preview_id: `preview_${hash({ manifest: resolved.manifest, input }).slice(0, 24)}`,
        input,
        renders: [{ render_id: 'primary', role: 'primary', output_format: outputFormat, dimensions: resolved.dimensions,
          ...(outputFormat !== 'html' ? { preview_url: `data:text/html;base64,${Buffer.from(html).toString('base64')}` } : {}),
          ...(outputFormat !== 'url' ? { preview_html: html } : {}),
        }],
      };
    });
    return { response_type: 'single', previews, quality_used: 'draft' };
  };

  const creative: CreativeAdServerPlatform = {
    syncCreatives: async (items, ctx) => {
      const input = record(ctx.input);
      const source = Array.isArray(input.creatives) ? input.creatives.map(record) : items as unknown as Json[];
      assertCanonical('sync_creatives', { ...input, account: input.account ?? { account_id: 'creative33_sandbox' }, creatives: source });
      if (input.delete_missing || input.assignments || input.assignment_operations) fail('UNSUPPORTED_FEATURE', 'Use seed_media_buy fixtures for simulated assignments; destructive library operations are not supported.');
      const strict = input.validation_mode !== 'lenient';
      let results: Json[] = [];
      const applyBatch = (state: State) => {
        results = [];
        for (const item of source) {
          try {
            validateManifest(manifestOf(item));
            if (item.localization !== undefined || item.representation_selection !== undefined) fail('UNSUPPORTED_FEATURE', 'Localization and representation sets are not supported.');
            const fingerprint = hash(Object.fromEntries(Object.entries(item).filter(([key]) => !EXCLUDED.has(key))));
            const existing = state.creatives.find(value => value.record.creative_id === item.creative_id);
            if (item.revision_id) {
              const prior = state.revisions.find(value => value.creativeId === item.creative_id && value.revisionId === item.revision_id);
              if (prior && prior.fingerprint !== fingerprint) fail('CREATIVE_REVISION_CONTENT_MISMATCH', 'This creative revision is bound to different source content.', 'revision_id');
            }
            const recordToStore = clone(item);
            if (item.revision_id === undefined && existing?.fingerprint === fingerprint && existing.record.revision_id !== undefined) recordToStore.revision_id = existing.record.revision_id;
            if (!item.revision_id && existing?.fingerprint !== fingerprint) delete recordToStore.revision_id;
            const unchanged = existing !== undefined && hash(existing.record) === hash(recordToStore);
            if (!existing && state.creatives.length >= 100) fail('INVALID_REQUEST', 'Sandbox library is limited to 100 creatives.');
            if (item.revision_id && !state.revisions.some(value => value.creativeId === item.creative_id && value.revisionId === item.revision_id)) {
              if (state.revisions.length >= 1000) fail('INVALID_REQUEST', 'Sandbox revision capacity reached.');
              state.revisions.push({ creativeId: String(item.creative_id), revisionId: String(item.revision_id), fingerprint });
            }
            state.creatives = state.creatives.filter(value => value.record.creative_id !== item.creative_id);
            const now = new Date().toISOString();
            state.creatives.push({ record: recordToStore, fingerprint, created: existing?.created ?? now, updated: unchanged ? existing.updated : now });
            results.push({ creative_id: item.creative_id, action: unchanged ? 'unchanged' : existing ? 'updated' : 'created', status: 'approved', ...(recordToStore.revision_id ? { revision_id: recordToStore.revision_id } : {}) });
          } catch (error) {
            const failure = error as { code?: string; message?: string };
            results.push({ creative_id: item.creative_id, action: 'failed', errors: [{ code: failure.code ?? 'INVALID_REQUEST', message: failure.message ?? 'Invalid creative' }] });
          }
        }
        if (strict && results.some(row => row.action === 'failed')) {
          throw new StrictSyncRejected(results.map(row => row.action === 'failed' ? row : {
            creative_id: row.creative_id, action: 'failed', errors: [{ code: 'VALIDATION_ERROR', message: 'Strict sync aborted because another item is invalid; no changes were applied.' }],
          }));
        }
      };
      try {
        // The CAS callback evaluates the entire candidate snapshot. Throwing on
        // strict failure prevents both creative rows and revision fingerprints
        // from being committed. Dry runs execute exactly the same logic on a clone.
        if (input.dry_run === true) applyBatch(await read(ctx)); else await mutate(ctx, applyBatch);
      } catch (error) {
        if (!(error instanceof StrictSyncRejected)) throw error;
        results = error.results;
      }
      return results as unknown as Awaited<ReturnType<NonNullable<CreativeAdServerPlatform['syncCreatives']>>>;
    },
    listCreatives: async (req, ctx) => {
      const input = req as unknown as Json;
      assertCanonical('list_creatives', input);
      for (const key of ['include_assignments', 'include_pricing', 'include_snapshot', 'include_webhook_activity', 'include_items', 'include_variables', 'include_purged']) {
        if (input[key] === true) fail('UNSUPPORTED_FEATURE', `The bounded beta library does not implement ${key}.`, key);
      }
      if (input.sort) fail('UNSUPPORTED_FEATURE', 'Custom library sorting is not implemented.', 'sort');
      const filters = record(input.filters);
      const supported = new Set(['accounts', 'statuses', 'tags', 'tags_any', 'name_contains', 'creative_ids', 'created_after', 'created_before', 'updated_after', 'updated_before', 'has_served', 'concept_ids', 'format_kinds', 'asset_types']);
      for (const key of Object.keys(filters)) if (!supported.has(key)) fail('UNSUPPORTED_FEATURE', `Filter ${key} is not implemented by the bounded beta library.`, `filters.${key}`);
      const state = await read(ctx);
      const contains = (key: string, value: unknown) => !Array.isArray(filters[key]) || (filters[key] as unknown[]).includes(value);
      const rows = state.creatives.filter(item => {
        const value = item.record;
        const tags = Array.isArray(value.tags) ? value.tags : [];
        if (!contains('creative_ids', value.creative_id) || !contains('format_kinds', value.format_kind)
          || !contains('statuses', 'approved') || !contains('concept_ids', value.concept_id)) return false;
        if (Array.isArray(filters.tags) && !filters.tags.every(tag => tags.includes(tag))) return false;
        if (Array.isArray(filters.tags_any) && !filters.tags_any.some(tag => tags.includes(tag))) return false;
        if (typeof filters.name_contains === 'string' && !String(value.name ?? '').toLowerCase().includes(filters.name_contains.toLowerCase())) return false;
        if (Array.isArray(filters.accounts) && !filters.accounts.some(ref => ['creative33_sandbox', ctx.account.id].includes(String(record(ref).account_id)))) return false;
        if (Array.isArray(filters.asset_types) && !Object.values(record(value.assets)).some(asset => !Array.isArray(asset) && (filters.asset_types as unknown[]).includes(record(asset).asset_type))) return false;
        if (typeof filters.has_served === 'boolean' && state.variants.some(variant => variant.creativeId === value.creative_id && variant.impressions > 0) !== filters.has_served) return false;
        for (const [key, date] of [['created', item.created], ['updated', item.updated]]) {
          if (typeof filters[`${key}_after`] === 'string' && !(date > String(filters[`${key}_after`]))) return false;
          if (typeof filters[`${key}_before`] === 'string' && !(date < String(filters[`${key}_before`]))) return false;
        }
        return true;
      });
      const { offset, limit, cursorFor } = page(input.pagination, hash({ filters, account: ownedAccount(ctx) }));
      const selected = rows.slice(offset, offset + limit);
      const fields = Array.isArray(input.fields) ? new Set(input.fields) : undefined;
      const always = new Set(['creative_id', 'name', 'format_kind', 'format_option_ref', 'status', 'created_date', 'updated_date', 'revision_id']);
      const creatives = selected.map(item => {
        const full = { ...clone(item.record), status: 'approved', created_date: item.created, updated_date: item.updated };
        return fields ? Object.fromEntries(Object.entries(full).filter(([key]) => fields.has(key) || always.has(key))) : full;
      });
      const hasMore = offset + selected.length < rows.length;
      return { creatives, query_summary: { total_matching: rows.length, returned: creatives.length }, pagination: { has_more: hasMore, total_count: rows.length, ...(hasMore ? { cursor: cursorFor(offset + selected.length) } : {}) } } as unknown as Awaited<ReturnType<CreativeAdServerPlatform['listCreatives']>>;
    },
    buildCreativeLegacy: async (request, ctx) => {
      const req = request as unknown as Json;
      assertCanonical('build_creative', req);
      const source = req.creative_id ? manifestOf(await lookup(String(req.creative_id), ctx)) : clone(record(req.creative_manifest));
      if (req.creative_id && !req.target_capability_id) return { creative_manifest: source } as unknown as Awaited<ReturnType<CreativeAdServerPlatform['buildCreativeLegacy']>>;
      const target = String(req.target_capability_id ?? '');
      const capability = creative33Catalog().find(item => item.capability_id === target && item.operations.includes('build'));
      if (!capability) fail('FORMAT_NOT_SUPPORTED', 'Select one advertised beta build capability.', 'target_capability_id');
      let output: Json;
      if (target === 'beta_video_15s') {
        validateManifest(source);
        const brief = record(record(source.assets).video_brief);
        const segments = Array.isArray(brief.segments) ? brief.segments.map(record) : [];
        if (brief.asset_type !== 'video_brief' || segments.length === 0
          || segments.reduce((sum, segment) => sum + Number(segment.duration_ms), 0) !== 15000
          || segments.some((segment, index) => segment.order !== index + 1)) {
          fail('INVALID_REQUEST', 'The fixture builder requires sequential typed video-brief segments totaling 15000 ms.', 'creative_manifest.assets.video_brief.segments');
        }
        output = { format_kind: 'video_hosted', assets: { video_main: {
          asset_type: 'video', url: creative33FixtureUrl('video-15s.mp4'), width: 640, height: 360,
          duration_ms: 15000, container_format: 'mp4', video_codec: 'h264', frame_rate: '15',
        } }, ext: { creative33: { mode: 'deterministic_sandbox_fixture', source_manifest: clone(source) } } };
        // The source's input-route selection is not the output serving contract.
        delete output.format_option_ref;
      } else {
        if (Object.keys(source).length) validateManifest(source);
        output = { ...creative33FixtureManifest(target), ext: { creative33: { mode: 'deterministic_sandbox_fixture', ...(Object.keys(source).length ? { source_manifest: clone(source) } : {}) } } };
        delete output.format_option_ref;
      }
      validateManifest(output);
      return { creative_manifest: output, build_variant_id: `bv_${hash({ account: ownedAccount(ctx), target, source }).slice(0, 32)}` } as unknown as Awaited<ReturnType<CreativeAdServerPlatform['buildCreativeLegacy']>>;
    },
    previewCreative: async (req, ctx) => await preview(req as unknown as Json, ctx) as unknown as Awaited<ReturnType<NonNullable<CreativeAdServerPlatform['previewCreative']>>>,
    getCreativeDelivery: async (request, ctx) => {
      const req = request as unknown as Json;
      assertCanonical('get_creative_delivery', req);
      const state = await read(ctx);
      const ids = Array.isArray(req.creative_ids) ? req.creative_ids : undefined;
      const buys = Array.isArray(req.media_buy_ids) ? req.media_buy_ids : undefined;
      const eligible = state.creatives.filter(item => !ids || ids.includes(item.record.creative_id));
      const entries = eligible.flatMap(item => {
        const selected = state.variants.filter(variant => variant.creativeId === item.record.creative_id && (!buys || buys.includes(variant.mediaBuyId))
          && (typeof req.start_date !== 'string' || variant.occurredAt >= `${req.start_date}T00:00:00Z`)
          && (typeof req.end_date !== 'string' || variant.occurredAt <= `${req.end_date}T23:59:59.999Z`));
        const buyIds = buys
          ? state.buys.filter(buy => buys.includes(buy.media_buy_id)
            && (record(buy.fixture).packages as Json[]).some(pkg => (pkg.creative_assignments as Json[]).some(assignment => assignment.creative_id === item.record.creative_id)))
            .map(buy => String(buy.media_buy_id))
          : [...new Set(selected.map(variant => variant.mediaBuyId))];
        const groups = buyIds.length ? buyIds : buys ? [] : [undefined];
        return groups.map(mediaBuyId => {
          const variants = selected.filter(variant => mediaBuyId === undefined || variant.mediaBuyId === mediaBuyId);
          const limit = typeof req.max_variants === 'number' ? req.max_variants : variants.length;
          return { creative_id: item.record.creative_id, ...(mediaBuyId ? { media_buy_id: mediaBuyId } : {}),
            format_kind: item.record.format_kind, ...(item.record.format_option_ref ? { format_option_ref: clone(item.record.format_option_ref) } : {}),
            ext: { creative33: { delivery_source: 'explicit_sandbox_simulation' } },
            totals: { impressions: variants.reduce((sum, variant) => sum + variant.impressions, 0), clicks: variants.reduce((sum, variant) => sum + variant.clicks, 0), spend: variants.reduce((sum, variant) => sum + variant.spend, 0) },
            variant_count: variants.length,
            variants: variants.slice(0, limit).map(variant => ({ variant_id: variant.id,
              ...(variant.revisionId ? { revision_id: variant.revisionId } : {}), manifest: clone(variant.manifest),
              ext: { creative33: { simulated: true } },
              impressions: variant.impressions, clicks: variant.clicks, spend: variant.spend,
            })),
          };
        });
      });
      const { offset, limit, cursorFor } = page(req.pagination, hash({ ids, buys, account: ownedAccount(ctx) }));
      const selectedEntries = entries.slice(offset, offset + limit);
      const hasMore = offset + selectedEntries.length < entries.length;
      return { currency: 'USD', reporting_period: { start: typeof req.start_date === 'string' ? `${req.start_date}T00:00:00Z` : '2026-01-01T00:00:00Z', end: typeof req.end_date === 'string' ? `${req.end_date}T23:59:59.999Z` : new Date().toISOString(), timezone: 'UTC' }, creatives: selectedEntries, pagination: { limit, offset, has_more: hasMore, total_count: entries.length, total: entries.length, ...(hasMore ? { cursor: cursorFor(offset + selectedEntries.length) } : {}) } } as unknown as Awaited<ReturnType<CreativeAdServerPlatform['getCreativeDelivery']>>;
    },
  };

  const accountFor = (ctx: CallContext): Account => ({ id: creative33AccountId(principal(ctx)), name: 'AdCP 3.3 beta creative sandbox', status: 'active', mode: 'sandbox', sandbox: true, ctx_metadata: {} });
  const formats = creative33Catalog();
  const platform: DecisioningPlatform = {
    capabilities: {
      specialisms: ['creative-ad-server'], creative_agents: [], channels: ['display', 'olv'], pricingModels: [],
      requireOperatorAuth: true, supportedBillings: ['agent'], supported_versions: [CREATIVE33_WIRE_VERSION],
      compliance_testing: {}, config: {},
      creative: { hasCreativeLibrary: true, supportsGeneration: false, supportsTransformation: true, supportsCompliance: false },
      overrides: { creative: { has_creative_library: true, supports_revisions: true, supported_formats: formats,
        preview: { routes: formats.filter(item => item.operations.includes('preview')).map(item => ({ capability_id: item.capability_id, rendering_origin: 'agent_approximation' })) },
      } } as DecisioningPlatform['capabilities']['overrides'],
    },
    accounts: {
      resolution: 'explicit',
      resolve: async (ref, ctx) => {
        if (!ref) return accountFor(ctx ?? {});
        const raw = ref as unknown as Json;
        const account = accountFor(ctx ?? {});
        if (raw.sandbox === false || raw.mode === 'live' || (raw.account_id !== 'creative33_sandbox' && raw.account_id !== account.id)) {
          fail('ACCOUNT_NOT_FOUND', 'This beta endpoint accepts only the authenticated caller’s sandbox account.');
        }
        return account;
      },
      list: async (_req, ctx) => ({ items: [accountFor(ctx ?? {})], totalCount: 1 }),
    },
    creative,
  };

  const complyTest: ComplyControllerConfig = {
    force: { creative_purge: async (params, ctx) => controllerOperation(async () => {
      if (params.purge_kind !== 'hard') fail('INVALID_REQUEST', 'This bounded sandbox supports explicit hard cleanup only; set purge_kind to hard.');
      await mutate(ctx, state => {
        const existing = state.creatives.find(item => item.record.creative_id === params.creative_id);
        if (!existing) fail('CREATIVE_NOT_FOUND', 'The creative is not present in this caller’s sandbox.');
        const removed = state.variants.filter(item => item.creativeId === params.creative_id);
        const bindings = new Set(removed.map(item => item.binding));
        state.creatives = state.creatives.filter(item => item.record.creative_id !== params.creative_id);
        state.variants = state.variants.filter(item => item.creativeId !== params.creative_id);
        state.simulations = state.simulations.filter(item => !bindings.has(String(item.binding)));
        state.buys = state.buys.filter(buy => !(record(buy.fixture).packages as Json[]).some(pkg => (pkg.creative_assignments as Json[]).some(assignment => assignment.creative_id === params.creative_id)));
        // Published hard purge starts a new creative incarnation, including
        // its revision namespace. Soft tombstones are not implemented here.
        state.revisions = state.revisions.filter(item => item.creativeId !== params.creative_id);
      });
      return { success: true as const, previous_state: 'approved', current_state: 'purged', message: 'Caller-owned creative, simulated executions and revision bindings removed for a new incarnation.' };
    }) },
    seed: { media_buy: async (params, ctx) => controllerOperation(async () => {
      const fixture = clone(params.fixture);
      const packages = Array.isArray(fixture.packages) ? fixture.packages.map(record) : [];
      if (packages.length !== 1) fail('INVALID_REQUEST', 'Seed exactly one sandbox package per media buy.');
      const pkg = packages[0];
      const assignments = Array.isArray(pkg.creative_assignments) ? pkg.creative_assignments.map(record) : [];
      if (assignments.length !== 1) fail('INVALID_REQUEST', 'Seed one creative assignment per sandbox package.');
      const stored = await lookup(String(assignments[0].creative_id), ctx);
      const manifest = manifestOf(stored);
      const option = optionFor(manifest);
      if (option.selected.capability_id === 'beta_inline_html' || option.selected.capability_id === 'beta_video_brief_input') fail('INVALID_REQUEST', 'This library-only input contract cannot be trafficked.');
      if (pkg.format_kind !== manifest.format_kind) fail('INVALID_REQUEST', 'Package and creative canonical kinds must match.');
      selectCanvas(manifest, record(pkg.params));
      await mutate(ctx, state => {
        const existing = state.buys.find(buy => buy.media_buy_id === params.media_buy_id);
        if (existing && hash(existing.fixture) !== hash(fixture)) fail('INVALID_REQUEST', 'A seeded media-buy identity is immutable.');
        if (!existing) {
          if (state.buys.length >= 100) fail('INVALID_REQUEST', 'Sandbox media-buy capacity reached.');
          state.buys.push({ media_buy_id: params.media_buy_id, fixture });
        }
      });
    }) },
    simulate: { delivery: async (params, ctx: ComplyControllerContext) => controllerOperation(async () => {
      const impressions = params.impressions ?? 0; const clicks = params.clicks ?? 0;
      const spend = params.reported_spend?.amount ?? 0;
      if (!Number.isSafeInteger(impressions) || impressions < 0 || !Number.isSafeInteger(clicks) || clicks < 0
        || clicks > impressions || !Number.isFinite(spend) || spend < 0 || (params.reported_spend && params.reported_spend.currency !== 'USD')) {
        fail('INVALID_REQUEST', 'Simulation requires nonnegative USD metrics and clicks no greater than impressions.');
      }
      const fingerprint = hash(params);
      await mutate(ctx, state => {
        const buy = state.buys.find(item => item.media_buy_id === params.media_buy_id);
        if (!buy) fail('REFERENCE_NOT_FOUND', 'Seed the sandbox media buy before simulating delivery.');
        const pkg = record((record(buy.fixture).packages as Json[])[0]);
        const creativeId = String(((pkg.creative_assignments as Json[])[0]).creative_id);
        const current = state.creatives.find(item => item.record.creative_id === creativeId);
        if (!current) fail('CREATIVE_NOT_FOUND', 'The assigned creative is unavailable.');
        const resolved = selectCanvas(manifestOf(current.record), record(pkg.params));
        const binding = hash({ buy: params.media_buy_id, package: pkg.package_id, source: current.fingerprint, revision: current.record.revision_id ?? null });
        const prior = state.simulations.find(item => item.binding === binding);
        if (prior) {
          if (prior.fingerprint !== fingerprint) fail('INVALID_REQUEST', 'An identical simulated execution must retain its metric payload. Seed another buy for a different simulation.');
          return;
        }
        if (state.variants.length >= 1000) fail('INVALID_REQUEST', 'Sandbox execution capacity reached.');
        const id = `sv_${hash({ scope: ownedAccount(ctx), binding, manifest: resolved.manifest }).slice(0, 40)}`;
        state.variants.push({ id, binding, creativeId, mediaBuyId: params.media_buy_id, packageId: String(pkg.package_id),
          ...(typeof current.record.revision_id === 'string' ? { revisionId: current.record.revision_id } : {}),
          manifest: resolved.manifest, impressions, clicks, spend, occurredAt: new Date().toISOString() });
        state.simulations.push({ binding, fingerprint });
      });
      return { success: true as const, simulated: { impressions, clicks, reported_spend: { amount: spend, currency: 'USD' } }, message: 'Deterministic sandbox simulation recorded; this is not physical campaign delivery.' };
    }) },
  };

  const validateInput = async (input: Json): Promise<Json> => {
    assertCanonical('validate_input', input);
    const manifest = record(input.manifest);
    const targets = Array.isArray(input.targets) ? input.targets.map(record) : [];
    if (!targets.length) fail('INVALID_REQUEST', 'Choose an advertised validation capability.');
    return { status: 'completed', results: targets.map(target => {
      try {
        if (target.kind !== 'capability') fail('FORMAT_NOT_SUPPORTED', 'This bounded sandbox validates advertised capability targets.');
        validateManifest(manifest);
        const { selected } = optionFor(manifest, String(target.id));
        if (!selected.operations.includes('validate')) fail('FORMAT_NOT_SUPPORTED', 'Target is not a validation capability.');
        return { target, result_kind: 'validated_pass' };
      } catch (error) {
        return { target, result_kind: 'validated_fail', violations: [{ rule: 'sandbox_contract', field: 'manifest', expected: (error as Error).message }] };
      }
    }) };
  };
  return { platform, complyTest, validateInput };
}

export function createCreative33Platform(store: AdcpStateStore): DecisioningPlatform {
  return createCreative33Sandbox(store).platform;
}
