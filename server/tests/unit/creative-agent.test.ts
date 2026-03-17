import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildFormats } from '../../src/shared/formats.js';
import { handleListCreativeFormats, handlePreviewCreative, buildReferenceFormats, createCreativeAgentServer } from '../../src/creative-agent/task-handlers.js';
import { renderPreview } from '../../src/creative-agent/preview-renderer.js';
import { storePreview, getPreview, cleanExpiredPreviews } from '../../src/creative-agent/preview-store.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

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
    expect(formats.length).toBe(49);
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
    // Product/format cards
    expect(ids).toContain('product_card_standard');
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
});

// ── list_creative_formats handler ───────────────────────────────────

describe('handleListCreativeFormats', () => {
  const formats = buildReferenceFormats(TEST_AGENT_URL);

  it('returns all formats when no filters provided', () => {
    const result = handleListCreativeFormats({}, formats);
    const returned = result.formats as unknown[];
    expect(returned.length).toBe(49);
  });

  it('response structure matches schema: { formats: [...] }', () => {
    const result = handleListCreativeFormats({}, formats);
    expect(result).toHaveProperty('formats');
    expect(Array.isArray(result.formats)).toBe(true);
  });

  it('filters by type: display', () => {
    const result = handleListCreativeFormats({ type: 'display' }, formats);
    const returned = result.formats as Array<{ format_id: { id: string } }>;
    expect(returned.length).toBeGreaterThan(0);
    expect(returned.length).toBeLessThan(49);
  });

  it('filters by type: video', () => {
    const result = handleListCreativeFormats({ type: 'video' }, formats);
    const returned = result.formats as Array<{ format_id: { id: string } }>;
    expect(returned.length).toBeGreaterThan(0);
    for (const f of returned) {
      expect(f.format_id.id).toMatch(/video|ctv/);
    }
  });

  it('filters by type: audio', () => {
    const result = handleListCreativeFormats({ type: 'audio' }, formats);
    const returned = result.formats as Array<{ format_id: { id: string } }>;
    expect(returned.length).toBe(3);
    for (const f of returned) {
      expect(f.format_id.id).toMatch(/^audio_/);
    }
  });

  it('filters by type: dooh', () => {
    const result = handleListCreativeFormats({ type: 'dooh' }, formats);
    const returned = result.formats as Array<{ format_id: { id: string } }>;
    expect(returned.length).toBe(4);
  });

  it('returns empty array for unknown type', () => {
    const result = handleListCreativeFormats({ type: 'hologram' }, formats);
    expect((result.formats as unknown[]).length).toBe(0);
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

  it('batch returns error for empty requests', () => {
    const result = handlePreviewCreative({
      request_type: 'batch',
      requests: [],
    }, formats, TEST_BASE_URL);
    expect(result.errors).toBeTruthy();
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

// ── MCP server structuredContent ─────────────────────────────────────

describe('MCP server tool responses', () => {
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

  it('list_creative_formats returns structuredContent', async () => {
    const result = await client.callTool({
      name: 'list_creative_formats',
      arguments: { type: 'display' },
    });
    expect(result.structuredContent).toBeDefined();
    const structured = result.structuredContent as { formats: unknown[] };
    expect(structured.formats.length).toBeGreaterThan(0);
    expect(JSON.parse((result.content as Array<{ text: string }>)[0].text)).toEqual(result.structuredContent);
  });

  it('preview_creative returns structuredContent', async () => {
    const result = await client.callTool({
      name: 'preview_creative',
      arguments: {
        creative_manifest: {
          format_id: { agent_url: TEST_AGENT_URL, id: 'display_300x250_image' },
          assets: { banner_image: { url: 'https://example.com/ad.jpg' } },
        },
        output_format: 'html',
      },
    });
    expect(result.structuredContent).toBeDefined();
    expect((result.structuredContent as { response_type: string }).response_type).toBe('single');
    expect(JSON.parse((result.content as Array<{ text: string }>)[0].text)).toEqual(result.structuredContent);
  });
});
