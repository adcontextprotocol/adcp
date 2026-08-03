import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildFormats } from '../../src/shared/formats.js';
import { handleListCreativeFormats, handlePreviewCreative, buildReferenceFormats, buildCreativeCapabilities, createCreativeAgentServer } from '../../src/creative-agent/task-handlers.js';
import { renderPreview } from '../../src/creative-agent/preview-renderer.js';
import { storePreview, getPreview, cleanExpiredPreviews } from '../../src/creative-agent/preview-store.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { sanitizeCreativeCapabilities } from '../../src/capabilities.js';

const TEST_BASE_URL = 'http://localhost:3000';
const TEST_AGENT_URL = `${TEST_BASE_URL}/api/creative-agent`;
const TEST_TRAINING_URL = `${TEST_BASE_URL}/api/training-agent`;

// ── Training agent formats (shared/formats.ts) ─────────────────────

describe('training agent formats', () => {
  it('builds formats with correct agent_url', () => {
    const formats = buildFormats(TEST_TRAINING_URL);
    expect(formats.length).toBeGreaterThan(0);
    for (const f of formats) {
      const fid = f.format_id as { agent_url: string; id: string };
      expect(fid.agent_url).toBe(TEST_TRAINING_URL);
      expect(fid.id).toBeTruthy();
    }
  });

  it('publishes reviewed canonical mappings for deployed legacy IDs', () => {
    const formats = buildReferenceFormats(TEST_AGENT_URL);
    const byId = new Map(
      formats.map(format => [(format.format_id as { id: string }).id, format as Record<string, unknown>])
    );

    for (const [id, width] of [
      ['display_320x50_html', 320],
      ['display_300x50_html', 300],
    ] as const) {
      const format = byId.get(id)!;
      expect(format.canonical).toEqual({ kind: 'html5' });
      expect(format.renders).toEqual([
        {
          dimensions: {
            height: 50,
            responsive: { height: false, width: false },
            width,
          },
          role: 'primary',
        },
      ]);
      const htmlAsset = (format.assets as Array<Record<string, unknown>>).find(
        asset => asset.asset_id === 'html_creative'
      )!;
      expect(htmlAsset.requirements).toMatchObject({ width, height: 50 });
    }

    expect(byId.get('display_static')).toMatchObject({
      accepts_parameters: ['dimensions'],
      canonical: { kind: 'image' },
    });
    expect(byId.get('video_hosted')).toMatchObject({
      accepts_parameters: ['duration'],
      canonical: { kind: 'video_hosted' },
    });
    expect(byId.get('audio_30s')).toMatchObject({
      canonical: { kind: 'audio_hosted' },
    });
    const audioAsset = (byId.get('audio_30s')!.assets as Array<Record<string, unknown>>).find(
      asset => asset.asset_id === 'audio_file'
    )!;
    expect(audioAsset.requirements).toMatchObject({
      min_duration_ms: 30_000,
      max_duration_ms: 30_000,
    });
  });


  it('all format IDs are unique', () => {
    const formats = buildFormats(TEST_TRAINING_URL);
    const ids = formats.map(f => (f.format_id as { id: string }).id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('FORMAT_CHANNEL_MAP covers all format IDs', async () => {
    const { FORMAT_CHANNEL_MAP } = await import('../../src/shared/formats.js');
    const formats = buildFormats(TEST_TRAINING_URL);
    const formatIds = formats.map(f => (f.format_id as { id: string }).id);
    for (const id of formatIds) {
      expect(FORMAT_CHANNEL_MAP[id], `Missing channel mapping for ${id}`).toBeDefined();
      expect(Array.isArray(FORMAT_CHANNEL_MAP[id])).toBe(true);
      expect(FORMAT_CHANNEL_MAP[id].length).toBeGreaterThan(0);
    }
  });
});
// ── Reference formats (creative agent) ──────────────────────────────

describe('reference formats', () => {
  it('loads reference formats and rewrites agent_url', () => {
    const formats = buildReferenceFormats(TEST_AGENT_URL);
    expect(formats.length).toBe(62);
    for (const f of formats) {
      const fid = f.format_id as { agent_url: string; id: string };
      expect(fid.agent_url).toBe(TEST_AGENT_URL);
    }
  });

  it('includes all expected format categories', () => {
    const formats = buildReferenceFormats(TEST_AGENT_URL);
    const ids = formats.map(f => (f.format_id as { id: string }).id);
    // Display
    expect(ids).toContain('display_image');
    expect(ids).toContain('display_300x250_image');
    expect(ids).toContain('display_generative');
    expect(ids).toContain('display_html');
    expect(ids).toContain('display_js');
    // Video
    expect(ids).toContain('video_standard');
    expect(ids).toContain('video_vast');
    expect(ids).toContain('video_ctv_preroll_30s');
    // Broadcast
    expect(ids).toContain('broadcast_spot_15s');
    expect(ids).toContain('broadcast_spot_30s');
    expect(ids).toContain('broadcast_spot_60s');
    // Native
    expect(ids).toContain('native_standard');
    expect(ids).toContain('native_content');
    // Audio
    expect(ids).toContain('audio_standard_15s');
    expect(ids).toContain('audio_standard_30s');
    expect(ids).toContain('audio_standard_60s');
    // DOOH
    expect(ids).toContain('dooh_billboard_1920x1080');
    expect(ids).toContain('dooh_billboard_landscape');
    // Product/format/proposal cards
    expect(ids).toContain('product_card_standard');
    expect(ids).toContain('proposal_card_standard');
    expect(ids).toContain('format_card_standard');
  });

  it('all format IDs are unique', () => {
    const formats = buildReferenceFormats(TEST_AGENT_URL);
    const ids = formats.map(f => (f.format_id as { id: string }).id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('each format has required fields', () => {
    const formats = buildReferenceFormats(TEST_AGENT_URL);
    for (const f of formats) {
      const fid = f.format_id as { agent_url: string; id: string };
      expect(fid.agent_url).toBeTruthy();
      expect(fid.id).toMatch(/^[a-zA-Z0-9_-]+$/);
      expect(typeof f.name).toBe('string');
      expect(typeof f.description).toBe('string');
    }
  });

  it('projects reviewed mappings into canonical preview capabilities', () => {
    const capabilities = buildCreativeCapabilities(buildReferenceFormats(TEST_AGENT_URL));
    expect(capabilities).toHaveLength(55);
    expect(capabilities[0]).toMatchObject({
      capability_id: expect.stringMatching(/^preview_[a-zA-Z0-9_-]+$/),
      operations: ['preview'],
      format: { format_kind: expect.any(String), params: expect.any(Object) },
    });
    expect(capabilities.every(capability => capability.format_id === undefined)).toBe(true);

    const byId = new Map(capabilities.map(capability => [capability.capability_id, capability]));
    expect(byId.get('preview_video_vast_30s')).toMatchObject({
      format: { format_kind: 'video_vast', params: { duration_ms_exact: 30000 } },
    });
    expect(byId.get('preview_video_standard_15s')).toMatchObject({
      format: {
        format_kind: 'video_hosted',
        params: {
          duration_ms_exact: 15000,
          containers: ['mp4', 'mov', 'webm'],
        },
      },
    });
  });

  it('emits a schema-valid canonical capability catalog', async () => {
    const supportedFormats = buildCreativeCapabilities(buildReferenceFormats(TEST_AGENT_URL));
    await expect(sanitizeCreativeCapabilities({ supported_formats: supportedFormats })).resolves.toBeDefined();
  });
});

// ── list_creative_formats handler ───────────────────────────────────

describe('handleListCreativeFormats', () => {
  const formats = buildReferenceFormats(TEST_AGENT_URL);

  it('returns all formats when no filters provided', () => {
    const result = handleListCreativeFormats({}, formats);
    const returned = result.formats as unknown[];
    expect(returned.length).toBe(62);
  });

  it('response structure matches schema: { formats: [...] }', () => {
    const result = handleListCreativeFormats({}, formats);
    expect(result).toHaveProperty('formats');
    expect(Array.isArray(result.formats)).toBe(true);
  });

  it('filters by name_search (case-insensitive)', () => {
    const result = handleListCreativeFormats({ name_search: 'medium rectangle' }, formats);
    const returned = result.formats as Array<{ format_id: { id: string } }>;
    expect(returned.length).toBeGreaterThan(0);
    expect(returned.some(f => f.format_id.id === 'display_300x250_generative')).toBe(true);
  });

  it('filters by min/max dimensions', () => {
    const result = handleListCreativeFormats({
      min_width: 290, max_width: 310,
      min_height: 240, max_height: 260,
    }, formats);
    const returned = result.formats as Array<{ format_id: { id: string } }>;
    expect(returned.length).toBeGreaterThan(0);
    // Should include 300x250 variants
    const ids = returned.map(f => f.format_id.id);
    expect(ids.some(id => id.includes('300x250'))).toBe(true);
  });

  it('filters by asset_types', () => {
    const result = handleListCreativeFormats({ asset_types: ['vast'] }, formats);
    const returned = result.formats as Array<{ format_id: { id: string }; assets: Array<{ asset_type?: string }> }>;
    expect(returned.length).toBeGreaterThan(0);
    for (const f of returned) {
      const hasVast = f.assets?.some(a => a.asset_type === 'vast');
      expect(hasVast).toBe(true);
    }
  });

  it('filters by is_responsive: true', () => {
    const result = handleListCreativeFormats({ is_responsive: true }, formats);
    const returned = result.formats as Array<{ format_id: { id: string } }>;
    expect(returned.length).toBeGreaterThan(0);
  });

  it('filters by specific format_ids (object form)', () => {
    const result = handleListCreativeFormats({
      format_ids: [{ id: 'display_300x250_image' }, { id: 'video_standard' }],
    }, formats);
    const returned = result.formats as Array<{ format_id: { id: string } }>;
    expect(returned).toHaveLength(2);
    const ids = returned.map(f => f.format_id.id);
    expect(ids).toContain('display_300x250_image');
    expect(ids).toContain('video_standard');
  });

  it('filters by specific format_ids (string form)', () => {
    const result = handleListCreativeFormats({
      format_ids: ['audio_standard_30s'],
    }, formats);
    const returned = result.formats as Array<{ format_id: { id: string } }>;
    expect(returned).toHaveLength(1);
    expect(returned[0].format_id.id).toBe('audio_standard_30s');
  });

  it('combines multiple filters (AND logic)', () => {
    const result = handleListCreativeFormats({
      type: 'display',
      name_search: 'AI Generated',
    }, formats);
    const returned = result.formats as Array<{ format_id: { id: string } }>;
    expect(returned.length).toBeGreaterThan(0);
    for (const f of returned) {
      expect(f.format_id.id).toMatch(/display.*generative|generative.*display/);
    }
  });
});

// ── handlePreviewCreative ───────────────────────────────────────────

describe('handlePreviewCreative', () => {
  const formats = buildReferenceFormats(TEST_AGENT_URL);

  it('returns single preview with correct response structure', () => {
    const result = handlePreviewCreative({
      request_type: 'single',
      creative_manifest: {
        format_id: { agent_url: TEST_AGENT_URL, id: 'display_300x250_image' },
        name: 'Test ad',
        assets: {
          banner_image: { url: 'https://example.com/ad.jpg' },
          click_url: { url: 'https://example.com' },
        },
      },
    }, formats, TEST_BASE_URL);

    expect(result.response_type).toBe('single');
    expect(result.expires_at).toBeTruthy();
    const previews = result.previews as Array<Record<string, unknown>>;
    expect(previews).toHaveLength(1);
    expect(previews[0].preview_id).toBeTruthy();
    expect(previews[0].input).toEqual({ name: 'Default preview' });

    const renders = previews[0].renders as Array<Record<string, unknown>>;
    expect(renders).toHaveLength(1);
    expect(renders[0].role).toBe('primary');
    expect(renders[0].preview_url).toBeTruthy();
    expect((renders[0].preview_url as string)).toContain('/preview/');
  });

  it('requires a selector when a canonical manifest matches multiple renderers', () => {
    const result = handlePreviewCreative({
      request_type: 'single',
      creative_manifest: {
        format_kind: 'image',
        assets: {
          image_main: { asset_type: 'image', url: 'https://example.com/canonical-ad.jpg' },
        },
      },
    }, formats, TEST_BASE_URL);

    expect(result.errors).toEqual([expect.objectContaining({
      code: 'FORMAT_NOT_SUPPORTED',
      message: expect.stringContaining('matches multiple preview capabilities'),
    })]);
  });

  it('does not silently pick the first renderer when dimensions remain ambiguous', () => {
    const result = handlePreviewCreative({
      request_type: 'single',
      creative_manifest: {
        format_kind: 'image',
        assets: {
          image_main: {
            asset_type: 'image',
            url: 'https://example.com/leaderboard.jpg',
            width: 728,
            height: 90,
          },
        },
      },
    }, formats, TEST_BASE_URL);

    expect(result.errors).toEqual([expect.objectContaining({
      code: 'FORMAT_NOT_SUPPORTED',
      message: expect.stringContaining('matches multiple preview capabilities'),
    })]);
  });

  it('routes an advertised target_capability_id to its exact renderer', () => {
    const result = handlePreviewCreative({
      request_type: 'single',
      target_capability_id: 'preview_display_300x250_image',
      creative_manifest: { format_kind: 'image', assets: {} },
    }, formats, TEST_BASE_URL);

    const renders = ((result.previews as any[])[0].renders as any[]);
    expect(renders[0].dimensions).toEqual({ width: 300, height: 250 });
  });

  it('fails closed for an unknown canonical preview selector', () => {
    const result = handlePreviewCreative({
      request_type: 'single',
      target_capability_id: 'preview_not_declared',
      creative_manifest: { format_kind: 'image', assets: {} },
    }, formats, TEST_BASE_URL);

    expect(result.errors).toEqual([expect.objectContaining({
      code: 'FORMAT_NOT_SUPPORTED',
      message: expect.stringContaining('Unknown preview capability_id'),
    })]);
  });

  it('rejects mixed canonical and deprecated routing', () => {
    const manifest = { format_kind: 'image', assets: {} };
    const single = handlePreviewCreative({
      request_type: 'single',
      creative_manifest: manifest,
      target_capability_id: 'preview_display_300x250_image',
      format_id: { id: 'display_300x250_image' },
    }, formats, TEST_BASE_URL);
    expect(single.errors).toEqual([expect.objectContaining({ code: 'validation_error' })]);

    const batch = handlePreviewCreative({
      request_type: 'batch',
      requests: [{
        creative_manifest: manifest,
        target_capability_id: 'preview_display_300x250_image',
      }, {
        creative_manifest: manifest,
        format_id: { id: 'display_300x250_image' },
      }],
    }, formats, TEST_BASE_URL);
    expect(batch.errors).toEqual([expect.objectContaining({ code: 'validation_error' })]);
  });

  it('returns CREATIVE_NOT_FOUND for a library identifier absent from the reference agent', () => {
    const result = handlePreviewCreative({
      request_type: 'single',
      creative_id: 'missing_library_creative',
      target_capability_id: 'preview_display_300x250_image',
    }, formats, TEST_BASE_URL);

    expect(result.errors).toEqual([expect.objectContaining({
      code: 'CREATIVE_NOT_FOUND',
      message: expect.stringContaining('missing_library_creative'),
    })]);
  });

  it('fails closed when no advertised canonical preview capability matches', () => {
    const result = handlePreviewCreative({
      request_type: 'single',
      creative_manifest: { format_kind: 'custom', assets: {} },
    }, formats, TEST_BASE_URL);

    expect(result.errors).toEqual([expect.objectContaining({
      code: 'FORMAT_NOT_SUPPORTED',
      message: expect.stringContaining('No advertised preview capability matches'),
    })]);
  });

  it('rejects a capability whose canonical kind does not match the manifest', () => {
    const result = handlePreviewCreative({
      request_type: 'single',
      target_capability_id: 'preview_display_300x250_image',
      creative_manifest: { format_kind: 'video_hosted', assets: {} },
    }, formats, TEST_BASE_URL);

    expect(result.errors).toEqual([expect.objectContaining({
      code: 'FORMAT_NOT_SUPPORTED',
      message: expect.stringContaining('not "video_hosted"'),
    })]);
  });

  it('returns html output when requested', () => {
    const result = handlePreviewCreative({
      request_type: 'single',
      output_format: 'html',
      creative_manifest: {
        format_id: { agent_url: TEST_AGENT_URL, id: 'display_300x250_image' },
        assets: {},
      },
    }, formats, TEST_BASE_URL);

    const renders = ((result.previews as any[])[0].renders as any[]);
    expect(renders[0].output_format).toBe('html');
    expect(renders[0].preview_html).toContain('<!DOCTYPE html>');
    expect(renders[0].preview_url).toBeUndefined();
  });

  it('returns both url and html when output_format is both', () => {
    const result = handlePreviewCreative({
      request_type: 'single',
      output_format: 'both',
      creative_manifest: {
        format_id: { agent_url: TEST_AGENT_URL, id: 'display_300x250_image' },
        assets: {},
      },
    }, formats, TEST_BASE_URL);

    const renders = ((result.previews as any[])[0].renders as any[]);
    expect(renders[0].output_format).toBe('both');
    expect(renders[0].preview_html).toContain('<!DOCTYPE html>');
    expect(renders[0].preview_url).toContain('/preview/');
  });

  it('generates multiple previews from inputs array', () => {
    const result = handlePreviewCreative({
      request_type: 'single',
      creative_manifest: {
        format_id: { agent_url: TEST_AGENT_URL, id: 'display_300x250_image' },
        assets: {},
      },
      inputs: [
        { name: 'Morning context' },
        { name: 'Evening context' },
        { name: 'Mobile', macros: { DEVICE_TYPE: 'mobile' } },
      ],
    }, formats, TEST_BASE_URL);

    const previews = result.previews as Array<Record<string, unknown>>;
    expect(previews).toHaveLength(3);
    const ids = previews.map(p => p.preview_id);
    expect(new Set(ids).size).toBe(3);
  });

  it('includes dimensions in renders when format has fixed dimensions', () => {
    const result = handlePreviewCreative({
      request_type: 'single',
      creative_manifest: {
        format_id: { agent_url: TEST_AGENT_URL, id: 'display_300x250_image' },
        assets: {},
      },
    }, formats, TEST_BASE_URL);

    const renders = ((result.previews as any[])[0].renders as any[]);
    expect(renders[0].dimensions).toEqual({ width: 300, height: 250 });
  });

  it('handles batch requests', () => {
    const result = handlePreviewCreative({
      request_type: 'batch',
      requests: [
        {
          creative_manifest: {
            creative_id: 'cr_display',
            format_id: { agent_url: TEST_AGENT_URL, id: 'display_300x250_image' },
            assets: {},
          },
        },
        {
          creative_manifest: {
            creative_id: 'cr_video',
            format_id: { agent_url: TEST_AGENT_URL, id: 'video_standard' },
            assets: {},
          },
        },
      ],
    }, formats, TEST_BASE_URL);

    expect(result.response_type).toBe('batch');
    const results = result.results as Array<Record<string, unknown>>;
    expect(results).toHaveLength(2);
    expect(results[0].success).toBe(true);
    expect(results[0].creative_id).toBe('cr_display');
    expect(results[1].success).toBe(true);
    expect(results[1].creative_id).toBe('cr_video');
  });

  it('applies batch defaults while preserving per-item overrides', () => {
    const result = handlePreviewCreative({
      request_type: 'batch',
      target_capability_id: 'preview_display_300x250_image',
      output_format: 'html',
      quality: 'draft',
      requests: [
        {
          creative_manifest: {
            creative_id: 'cr_default',
            format_kind: 'image',
            assets: {},
          },
        },
        {
          target_capability_id: 'preview_display_728x90_image',
          output_format: 'url',
          inputs: [{ name: 'Item override input' }],
          creative_manifest: {
            creative_id: 'cr_override',
            format_kind: 'image',
            assets: {},
          },
        },
      ],
    }, formats, TEST_BASE_URL);

    const results = result.results as Array<{
      success: boolean;
      response: { previews: Array<{ input: { name: string }; renders: Array<Record<string, unknown>> }> };
    }>;
    expect(results.map(item => item.success)).toEqual([true, true]);

    const defaultPreview = results[0].response.previews[0];
    expect(defaultPreview.input.name).toBe('Default preview');
    expect(defaultPreview.renders[0]).toMatchObject({
      output_format: 'html',
      dimensions: { width: 300, height: 250 },
    });
    expect(defaultPreview.renders[0].preview_url).toBeUndefined();

    const overridePreview = results[1].response.previews[0];
    expect(overridePreview.input.name).toBe('Item override input');
    expect(overridePreview.renders[0]).toMatchObject({
      output_format: 'url',
      dimensions: { width: 728, height: 90 },
    });
    expect(overridePreview.renders[0].preview_html).toBeUndefined();
  });

  it('returns FORMAT_NOT_SUPPORTED per item for unknown and ambiguous batch routes', () => {
    const result = handlePreviewCreative({
      request_type: 'batch',
      requests: [
        {
          target_capability_id: 'preview_not_declared',
          creative_manifest: { creative_id: 'cr_unknown', format_kind: 'image', assets: {} },
        },
        {
          creative_manifest: { creative_id: 'cr_ambiguous', format_kind: 'image', assets: {} },
        },
        {
          creative_manifest: { creative_id: 'cr_zero', format_kind: 'custom', assets: {} },
        },
      ],
    }, formats, TEST_BASE_URL);

    const results = result.results as Array<{ success: boolean; errors: Array<{ code: string }> }>;
    expect(results).toHaveLength(3);
    expect(results.every(item => item.success === false)).toBe(true);
    expect(results.map(item => item.errors[0].code)).toEqual([
      'FORMAT_NOT_SUPPORTED',
      'FORMAT_NOT_SUPPORTED',
      'FORMAT_NOT_SUPPORTED',
    ]);
  });

  it('batch returns error for empty requests', () => {
    const result = handlePreviewCreative({
      request_type: 'batch',
      requests: [],
    }, formats, TEST_BASE_URL);
    expect(result.errors).toBeTruthy();
  });

  it('accepts 50 batch items and rejects 51', () => {
    const item = {
      creative_manifest: {
        format_id: { agent_url: TEST_AGENT_URL, id: 'display_300x250_image' },
        assets: {},
      },
    };
    const accepted = handlePreviewCreative({
      request_type: 'batch',
      requests: Array.from({ length: 50 }, () => item),
    }, formats, TEST_BASE_URL);
    expect(accepted.results).toHaveLength(50);

    const rejected = handlePreviewCreative({
      request_type: 'batch',
      requests: Array.from({ length: 51 }, () => item),
    }, formats, TEST_BASE_URL);
    expect(rejected.errors).toEqual([expect.objectContaining({
      code: 'validation_error',
      message: expect.stringContaining('50'),
    })]);
  });

  it('rejects variant mode', () => {
    const result = handlePreviewCreative({
      request_type: 'variant',
      variant_id: 'v_123',
    }, formats, TEST_BASE_URL);
    expect(result.errors).toBeTruthy();
    expect((result.errors as any[])[0].code).toBe('not_supported');
  });

  it('requires creative_manifest for single mode', () => {
    const result = handlePreviewCreative({
      request_type: 'single',
    }, formats, TEST_BASE_URL);
    expect(result.errors).toBeTruthy();
  });

  it('defaults to single mode when request_type is omitted', () => {
    const result = handlePreviewCreative({
      creative_manifest: {
        format_id: { agent_url: TEST_AGENT_URL, id: 'display_300x250_image' },
        assets: {},
      },
    }, formats, TEST_BASE_URL);
    expect(result.response_type).toBe('single');
    expect(result.previews).toBeTruthy();
  });

  it('stored preview is retrievable from store', () => {
    const result = handlePreviewCreative({
      request_type: 'single',
      creative_manifest: {
        format_id: { agent_url: TEST_AGENT_URL, id: 'display_300x250_image' },
        assets: {
          banner_image: { url: 'https://example.com/stored.jpg' },
        },
      },
    }, formats, TEST_BASE_URL);

    const previewId = ((result.previews as any[])[0] as any).preview_id;
    const html = getPreview(previewId);
    expect(html).toContain('stored.jpg');
  });

  it('works with unknown format_id', () => {
    const result = handlePreviewCreative({
      request_type: 'single',
      creative_manifest: {
        format_id: { agent_url: 'https://other-agent.com', id: 'custom_format' },
        assets: {},
      },
    }, formats, TEST_BASE_URL);
    expect(result.response_type).toBe('single');
    expect((result.previews as any[]).length).toBe(1);
  });
});

// ── Preview renderer ────────────────────────────────────────────────

describe('preview renderer', () => {
  const refFormats = buildReferenceFormats(TEST_AGENT_URL);

  function findFormat(id: string) {
    return refFormats.find(f => (f.format_id as { id: string }).id === id);
  }

  it('renders display_image format with image and click URL', () => {
    const html = renderPreview(
      {
        format_id: { agent_url: TEST_AGENT_URL, id: 'display_300x250_image' },
        assets: {
          banner_image: { url: 'https://example.com/ad.jpg' },
          click_url: { url: 'https://example.com' },
        },
      },
      findFormat('display_300x250_image'),
    );

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('example.com/ad.jpg');
    expect(html).toContain('300px');
    expect(html).toContain('250px');
  });

  it('renders video format as placeholder', () => {
    const html = renderPreview(
      { format_id: { agent_url: TEST_AGENT_URL, id: 'video_standard' }, assets: {} },
      findFormat('video_standard'),
    );
    expect(html).toContain('<!DOCTYPE html>');
  });

  it('renders native format with canonical text assets', () => {
    const html = renderPreview(
      {
        format_id: { agent_url: TEST_AGENT_URL, id: 'native_standard' },
        assets: {
          title: { content: 'Test Headline' },
          main_image: { url: 'https://example.com/native.jpg' },
        },
      },
      findFormat('native_standard'),
    );
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Test Headline');
  });

  it('escapes HTML in asset values to prevent XSS', () => {
    const html = renderPreview(
      {
        format_id: { agent_url: TEST_AGENT_URL, id: 'native_content' },
        assets: {
          title: { content: '<script>alert("xss")</script>' },
        },
      },
      findFormat('native_content'),
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders all reference format types without errors', () => {
    for (const format of refFormats) {
      const fid = format.format_id as { agent_url: string; id: string };
      const html = renderPreview(
        { format_id: fid, assets: {} },
        format,
      );
      expect(html, `Failed to render ${fid.id}`).toContain('<!DOCTYPE html>');
    }
  });
});

// ── Preview store ───────────────────────────────────────────────────

describe('preview store', () => {
  it('stores and retrieves previews', () => {
    const expiresAt = storePreview('test_store_1', '<html>test</html>');
    expect(expiresAt).toBeInstanceOf(Date);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(getPreview('test_store_1')).toBe('<html>test</html>');
  });

  it('returns null for missing previews', () => {
    expect(getPreview('nonexistent_id')).toBeNull();
  });

  it('overwrites existing previews', () => {
    storePreview('test_overwrite', '<html>v1</html>');
    storePreview('test_overwrite', '<html>v2</html>');
    expect(getPreview('test_overwrite')).toBe('<html>v2</html>');
  });

  it('cleanExpiredPreviews runs without error on active previews', () => {
    storePreview('test_active', '<html>active</html>');
    cleanExpiredPreviews();
    expect(getPreview('test_active')).toBe('<html>active</html>');
  });

  it('returns null for expired previews', () => {
    vi.useFakeTimers();
    try {
      storePreview('test_expired', '<html>old</html>');
      vi.advanceTimersByTime(61 * 60 * 1000); // Past 1 hour TTL
      expect(getPreview('test_expired')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── MCP tool responses: structuredContent (regression #1519) ────────

describe('MCP tool responses include structuredContent', () => {
  let client: Client;
  let server: ReturnType<typeof createCreativeAgentServer>;

  beforeEach(async () => {
    server = createCreativeAgentServer(TEST_AGENT_URL);
    client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it('get_adcp_capabilities returns canonical supported_formats', async () => {
    const response = await client.callTool({ name: 'get_adcp_capabilities', arguments: {} });
    const structured = response.structuredContent as Record<string, any>;
    expect(structured.creative.supported_formats).toHaveLength(55);
    expect(structured.creative.supported_formats[0]).toMatchObject({ operations: ['preview'] });
    expect(structured).toMatchObject({
      adcp_version: '3.2',
      adcp: { major_versions: [3], supported_versions: ['3.2'] },
      supported_protocols: ['creative'],
    });
  });

  it('list_creative_formats returns structuredContent with formats array', async () => {
    const result = await client.callTool({
      name: 'list_creative_formats',
      arguments: { asset_types: ['audio'] },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toBeDefined();
    const structured = result.structuredContent as { formats: unknown[] };
    expect(structured.formats).toBeDefined();
    expect(Array.isArray(structured.formats)).toBe(true);
    expect(structured.formats.length).toBe(4);
  });

  it('list_creative_formats structuredContent matches content text', async () => {
    const result = await client.callTool({
      name: 'list_creative_formats',
      arguments: {},
    });

    const structured = result.structuredContent as Record<string, unknown>;
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content).toHaveLength(1);
    expect(JSON.parse(content[0].text)).toEqual(structured);
  });

  it('preview_creative returns structuredContent with previews', async () => {
    const result = await client.callTool({
      name: 'preview_creative',
      arguments: {
        request_type: 'single',
        creative_manifest: {
          format_id: { agent_url: TEST_AGENT_URL, id: 'display_300x250_image' },
          assets: {
            banner_image: { url: 'https://example.com/ad.jpg' },
            click_url: { url: 'https://example.com' },
          },
        },
      },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toBeDefined();
    const structured = result.structuredContent as { response_type: string; previews: unknown[] };
    expect(structured.response_type).toBe('single');
    expect(structured.previews).toBeDefined();
    expect(structured.previews.length).toBe(1);
  });

  it('preview_creative structuredContent matches content text', async () => {
    const result = await client.callTool({
      name: 'preview_creative',
      arguments: {
        creative_manifest: {
          format_id: { agent_url: TEST_AGENT_URL, id: 'display_300x250_image' },
          assets: {},
        },
      },
    });

    const structured = result.structuredContent as Record<string, unknown>;
    const content = result.content as Array<{ type: string; text: string }>;
    expect(JSON.parse(content[0].text)).toEqual(structured);
  });

  it('list_creative_formats structuredContent has 54 formats with proposal cards', async () => {
    const result = await client.callTool({
      name: 'list_creative_formats',
      arguments: {},
    });

    const structured = result.structuredContent as { formats: unknown[] };
    expect(structured.formats.length).toBe(62);
  });

  it('preview_creative batch mode returns structuredContent', async () => {
    const result = await client.callTool({
      name: 'preview_creative',
      arguments: {
        request_type: 'batch',
        requests: [
          {
            creative_manifest: {
              creative_id: 'cr_1',
              format_id: { agent_url: TEST_AGENT_URL, id: 'display_300x250_image' },
              assets: {},
            },
          },
        ],
      },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toBeDefined();
    const structured = result.structuredContent as { response_type: string; results: unknown[] };
    expect(structured.response_type).toBe('batch');
    expect(structured.results).toHaveLength(1);
  });
});

// ── Product card renderers ──────────────────────────────────────────

describe('product card renderer', () => {
  const refFormats = buildReferenceFormats(TEST_AGENT_URL);
  function findFormat(id: string) {
    return refFormats.find(f => (f.format_id as { id: string }).id === id);
  }

  it('renders product card with all assets', () => {
    const html = renderPreview(
      {
        format_id: { agent_url: TEST_AGENT_URL, id: 'product_card_standard' },
        assets: {
          product_name: { content: 'Pinnacle News Video' },
          product_description: { content: 'Premium video inventory across CTV and OLV' },
          pricing_model: { content: 'CPM' },
          pricing_amount: { content: '25.00' },
          pricing_currency: { content: 'USD' },
          delivery_type: { content: 'guaranteed' },
          primary_asset_type: { content: 'video' },
        },
      },
      findFormat('product_card_standard'),
    );

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Pinnacle News Video');
    expect(html).toContain('Premium video inventory');
    expect(html).toContain('CPM');
    expect(html).toContain('25.00');
    expect(html).toContain('Guaranteed');
    expect(html).toContain('video');
  });

  it('renders product card with hero image', () => {
    const html = renderPreview(
      {
        format_id: { agent_url: TEST_AGENT_URL, id: 'product_card_standard' },
        assets: {
          product_name: { content: 'Pinnacle News Video' },
          product_description: { content: 'Premium video' },
          product_image: { url: 'https://picsum.photos/seed/pinnacle/600/300' },
          primary_asset_type: { content: 'video' },
        },
      },
      findFormat('product_card_standard'),
    );

    expect(html).toContain('<img src="https://picsum.photos/seed/pinnacle/600/300"');
    // Body should use the real image, not the placeholder div
    expect(html).toContain('product-card__image"><img');
  });

  it('renders product card with click-through link', () => {
    const html = renderPreview(
      {
        format_id: { agent_url: TEST_AGENT_URL, id: 'product_card_standard' },
        assets: {
          product_name: { content: 'Clickable Product' },
          product_description: { content: 'Click me' },
          click_url: { url: 'https://publisher.example/products/123' },
        },
      },
      findFormat('product_card_standard'),
    );

    expect(html).toContain('href="https://publisher.example/products/123"');
    expect(html).toContain('class="card-link"');
    expect(html).toContain('target="_blank"');
  });

  it('does not wrap in link when click_url is absent', () => {
    const html = renderPreview(
      {
        format_id: { agent_url: TEST_AGENT_URL, id: 'product_card_standard' },
        assets: {
          product_name: { content: 'No Link Product' },
          product_description: { content: 'Static card' },
        },
      },
      findFormat('product_card_standard'),
    );

    // Body should not have an <a> wrapping the card
    expect(html).not.toContain('<a href=');
  });

  it('renders product card with missing optional assets', () => {
    const html = renderPreview(
      {
        format_id: { agent_url: TEST_AGENT_URL, id: 'product_card_standard' },
        assets: {
          product_name: { content: 'Basic Product' },
          product_description: { content: 'A simple product' },
        },
      },
      findFormat('product_card_standard'),
    );

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Basic Product');
    // No pricing div rendered in the body (CSS still defines the class)
    expect(html).not.toContain('class="product-card__pricing">');
  });

  it('escapes HTML in product card assets', () => {
    const html = renderPreview(
      {
        format_id: { agent_url: TEST_AGENT_URL, id: 'product_card_standard' },
        assets: {
          product_name: { content: '<script>alert("xss")</script>' },
          product_description: { content: 'Safe description' },
        },
      },
      findFormat('product_card_standard'),
    );

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders detailed product card with responsive layout', () => {
    const html = renderPreview(
      {
        format_id: { agent_url: TEST_AGENT_URL, id: 'product_card_detailed' },
        assets: {
          product_name: { content: 'Viewpoint Sports Video' },
          product_description: { content: 'Live sports coverage across CTV, OLV, and linear TV' },
          pricing_model: { content: 'CPM' },
          pricing_amount: { content: '45.00' },
          pricing_currency: { content: 'USD' },
          delivery_type: { content: 'guaranteed' },
          primary_asset_type: { content: 'video' },
        },
      },
      findFormat('product_card_detailed'),
    );

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Viewpoint Sports Video');
    expect(html).toContain('max-width: 600px');
    expect(html).toContain('product-card-detailed');
  });

  it('renders detailed product card with click-through', () => {
    const html = renderPreview(
      {
        format_id: { agent_url: TEST_AGENT_URL, id: 'product_card_detailed' },
        assets: {
          product_name: { content: 'Linked Detail Card' },
          product_description: { content: 'Has a click-through' },
          click_url: { url: 'https://publisher.example/products/detail' },
          product_image: { url: 'https://picsum.photos/seed/test/600/300' },
        },
      },
      findFormat('product_card_detailed'),
    );

    expect(html).toContain('href="https://publisher.example/products/detail"');
    expect(html).toContain('class="card-link"');
    expect(html).toContain('<img src="https://picsum.photos/seed/test/600/300"');
  });
});

// ── Proposal card renderers ──────────────────────────────────────────

describe('proposal card renderer', () => {
  const refFormats = buildReferenceFormats(TEST_AGENT_URL);
  function findFormat(id: string) {
    return refFormats.find(f => (f.format_id as { id: string }).id === id);
  }

  it('renders proposal card with allocation bars', () => {
    const html = renderPreview(
      {
        format_id: { agent_url: TEST_AGENT_URL, id: 'proposal_card_standard' },
        assets: {
          proposal_name: { content: 'Cross-Channel News Reach' },
          proposal_description: { content: 'Balanced video and display plan' },
          allocation_data: { content: JSON.stringify([
            { product_id: 'pinnacle_news_video_premium', allocation_percentage: 45, rationale: 'Premium video' },
            { product_id: 'pinnacle_news_video_standard', allocation_percentage: 30, rationale: 'Auction video' },
            { product_id: 'pinnacle_news_display_standard', allocation_percentage: 25, rationale: 'Display retargeting' },
          ]) },
          budget_min: { content: '25000' },
          budget_recommended: { content: '75000' },
          budget_currency: { content: 'USD' },
          proposal_status: { content: 'draft' },
        },
      },
      findFormat('proposal_card_standard'),
    );

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Cross-Channel News Reach');
    expect(html).toContain('45%');
    expect(html).toContain('30%');
    expect(html).toContain('25%');
    expect(html).toContain('draft');
    expect(html).toContain('25K');
    expect(html).toContain('75K');
  });

  it('renders proposal card with hero image', () => {
    const html = renderPreview(
      {
        format_id: { agent_url: TEST_AGENT_URL, id: 'proposal_card_standard' },
        assets: {
          proposal_name: { content: 'Imaged Proposal' },
          proposal_description: { content: 'Has a hero' },
          allocation_data: { content: '[]' },
          proposal_image: { url: 'https://picsum.photos/seed/proposal/600/300' },
        },
      },
      findFormat('proposal_card_standard'),
    );

    expect(html).toContain('<img');
    expect(html).toContain('proposal-card__image');
    expect(html).toContain('https://picsum.photos/seed/proposal/600/300');
  });

  it('renders proposal card with click-through', () => {
    const html = renderPreview(
      {
        format_id: { agent_url: TEST_AGENT_URL, id: 'proposal_card_standard' },
        assets: {
          proposal_name: { content: 'Clickable Proposal' },
          proposal_description: { content: 'Interactive' },
          allocation_data: { content: '[]' },
          click_url: { url: 'https://publisher.example/proposals/abc' },
        },
      },
      findFormat('proposal_card_standard'),
    );

    expect(html).toContain('href="https://publisher.example/proposals/abc"');
    expect(html).toContain('class="card-link"');
  });

  it('handles invalid allocation_data JSON gracefully', () => {
    const html = renderPreview(
      {
        format_id: { agent_url: TEST_AGENT_URL, id: 'proposal_card_standard' },
        assets: {
          proposal_name: { content: 'Bad Data Proposal' },
          proposal_description: { content: 'Test' },
          allocation_data: { content: 'not valid json{{{' },
        },
      },
      findFormat('proposal_card_standard'),
    );

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Bad Data Proposal');
    expect(html).toContain('No allocations');
  });

  it('renders detailed proposal card with rationale', () => {
    const html = renderPreview(
      {
        format_id: { agent_url: TEST_AGENT_URL, id: 'proposal_card_detailed' },
        assets: {
          proposal_name: { content: 'Sports Multi-Screen' },
          proposal_description: { content: 'Live sports across all screens' },
          allocation_data: { content: JSON.stringify([
            { product_id: 'viewpoint_video_premium', allocation_percentage: 100, rationale: 'All video bundled for cross-screen sports reach' },
          ]) },
          budget_min: { content: '75000' },
          budget_recommended: { content: '200000' },
          budget_currency: { content: 'USD' },
          brief_alignment: { content: 'Premium sports video inventory across all screens with guaranteed delivery.' },
        },
      },
      findFormat('proposal_card_detailed'),
    );

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Sports Multi-Screen');
    expect(html).toContain('100%');
    expect(html).toContain('cross-screen sports reach');
    expect(html).toContain('Premium sports video inventory across all screens');
    expect(html).toContain('max-width: 600px');
  });

  it('renders detailed proposal card with hero image overlay', () => {
    const html = renderPreview(
      {
        format_id: { agent_url: TEST_AGENT_URL, id: 'proposal_card_detailed' },
        assets: {
          proposal_name: { content: 'Hero Proposal' },
          proposal_description: { content: 'Detailed with image' },
          allocation_data: { content: JSON.stringify([
            { product_id: 'test_product', allocation_percentage: 100, rationale: 'All in' },
          ]) },
          proposal_image: { url: 'https://picsum.photos/seed/hero/600/300' },
          click_url: { url: 'https://publisher.example/proposals/hero' },
        },
      },
      findFormat('proposal_card_detailed'),
    );

    expect(html).toContain('proposal-card-detailed__image');
    expect(html).toContain('https://picsum.photos/seed/hero/600/300');
    expect(html).toContain('href="https://publisher.example/proposals/hero"');
    expect(html).toContain('class="card-link"');
  });
});
