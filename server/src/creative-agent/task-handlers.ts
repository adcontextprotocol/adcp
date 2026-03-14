/**
 * MCP tool handlers for the reference creative agent.
 *
 * Implements list_creative_formats and preview_creative using
 * the shared canonical format library and template-based rendering.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { renderPreview } from './preview-renderer.js';
import { storePreview } from './preview-store.js';

const require = createRequire(import.meta.url);
const referenceFormatsData = require('./reference-formats.json');

// ── Types ───────────────────────────────────────────────────────────

type Format = Record<string, unknown>;

interface FormatId {
  agent_url: string;
  id: string;
}

const MAX_BATCH_SIZE = 20;

/**
 * Build formats with agent_url rewritten to the local endpoint.
 * Source data is the exact format catalog from the live creative.adcontextprotocol.org agent.
 */
export function buildReferenceFormats(agentUrl: string): Format[] {
  const formats = structuredClone(referenceFormatsData) as Format[];
  for (const f of formats) {
    const fid = f.format_id as { agent_url: string; id: string };
    fid.agent_url = agentUrl;
  }
  return formats;
}

// ── Format filtering helpers ────────────────────────────────────────

function getFormatId(format: Format): FormatId {
  return format.format_id as FormatId;
}

function matchesType(format: Format, type: string): boolean {
  const fid = getFormatId(format).id;
  const typeMap: Record<string, string[]> = {
    display: ['display_', 'dooh_', 'email_', 'gaming_interstitial', 'native_', 'carousel_'],
    video: ['video_', 'ctv_', 'gaming_rewarded', 'social_video'],
    audio: ['audio_', 'radio_'],
    dooh: ['dooh_'],
  };
  const prefixes = typeMap[type];
  if (!prefixes) return false;
  return prefixes.some(p => fid.startsWith(p));
}

function matchesDimensions(format: Format, opts: { min_width?: number; max_width?: number; min_height?: number; max_height?: number }): boolean {
  const renders = format.renders as Array<{ dimensions?: { width?: number; height?: number } }> | undefined;
  if (!renders?.[0]?.dimensions) return true; // No fixed dimensions — include by default
  const d = renders[0].dimensions;
  if (!d.width || !d.height) return true;
  if (opts.min_width && d.width < opts.min_width) return false;
  if (opts.max_width && d.width > opts.max_width) return false;
  if (opts.min_height && d.height < opts.min_height) return false;
  if (opts.max_height && d.height > opts.max_height) return false;
  return true;
}

function matchesAssetTypes(format: Format, assetTypes: string[]): boolean {
  const assets = format.assets as Array<{ asset_type?: string; assets?: Array<{ asset_type?: string }> }> | undefined;
  if (!assets) return false;
  const formatAssetTypes = new Set<string>();
  for (const asset of assets) {
    if (asset.asset_type) formatAssetTypes.add(asset.asset_type);
    // Repeatable groups
    if (asset.assets) {
      for (const inner of asset.assets) {
        if (inner.asset_type) formatAssetTypes.add(inner.asset_type);
      }
    }
  }
  return assetTypes.some(t => formatAssetTypes.has(t));
}

function matchesNameSearch(format: Format, search: string): boolean {
  const name = (format.name as string || '').toLowerCase();
  const desc = (format.description as string || '').toLowerCase();
  const term = search.toLowerCase();
  return name.includes(term) || desc.includes(term);
}

// ── list_creative_formats ───────────────────────────────────────────

export function handleListCreativeFormats(args: Record<string, unknown>, formats: Format[]): Record<string, unknown> {
  let filtered = [...formats];

  // Filter by specific format IDs
  const formatIds = args.format_ids as Array<{ id?: string } | string> | undefined;
  if (formatIds?.length) {
    const ids = new Set(formatIds.map(f => typeof f === 'string' ? f : f.id));
    filtered = filtered.filter(f => ids.has(getFormatId(f).id));
  }

  // Filter by type
  const type = args.type as string | undefined;
  if (type) {
    filtered = filtered.filter(f => matchesType(f, type));
  }

  // Filter by dimensions
  if (args.min_width || args.max_width || args.min_height || args.max_height) {
    filtered = filtered.filter(f => matchesDimensions(f, {
      min_width: args.min_width as number | undefined,
      max_width: args.max_width as number | undefined,
      min_height: args.min_height as number | undefined,
      max_height: args.max_height as number | undefined,
    }));
  }

  // Filter by asset types
  const assetTypes = args.asset_types as string[] | undefined;
  if (assetTypes?.length) {
    filtered = filtered.filter(f => matchesAssetTypes(f, assetTypes));
  }

  // Filter by name search
  const nameSearch = args.name_search as string | undefined;
  if (nameSearch) {
    filtered = filtered.filter(f => matchesNameSearch(f, nameSearch));
  }

  // Filter by responsive
  if (args.is_responsive !== undefined) {
    filtered = filtered.filter(f => {
      const renders = f.renders as Array<{ dimensions?: { responsive?: unknown } }> | undefined;
      const isResponsive = !!renders?.[0]?.dimensions?.responsive;
      return isResponsive === args.is_responsive;
    });
  }

  return { formats: filtered };
}

// ── preview_creative ────────────────────────────────────────────────

interface PreviewRequest {
  creative_manifest: Record<string, unknown>;
  format_id?: { agent_url?: string; id?: string; width?: number; height?: number };
  inputs?: Array<{ name: string; macros?: Record<string, string>; context_description?: string }>;
  output_format?: 'url' | 'html' | 'both';
  template_id?: string;
  item_limit?: number;
}

function renderSinglePreview(
  req: PreviewRequest,
  formats: Format[],
  baseUrl: string,
): { previews: unknown[]; expires_at: string } {
  const manifest = req.creative_manifest;
  const formatId = req.format_id || manifest.format_id as { id?: string } | undefined;
  const format = formatId?.id ? formats.find(f => getFormatId(f).id === formatId.id) : undefined;

  // Merge format_id into manifest for the renderer
  const renderManifest = { ...manifest, format_id: formatId };

  const inputs = req.inputs?.length
    ? req.inputs
    : [{ name: 'Default preview' }];

  const outputFormat = req.output_format || 'url';
  let expiresAt: Date = new Date(Date.now() + 60 * 60 * 1000);

  const previews = inputs.map(input => {
    const previewId = `prev_${randomUUID().slice(0, 12)}`;
    const html = renderPreview(renderManifest, format);

    const render: Record<string, unknown> = {
      render_id: `r_${randomUUID().slice(0, 8)}`,
      role: 'primary',
    };

    // Add dimensions if known
    if (format) {
      const renders = format.renders as Array<{ dimensions?: { width?: number; height?: number } }> | undefined;
      if (renders?.[0]?.dimensions?.width && renders?.[0]?.dimensions?.height) {
        render.dimensions = {
          width: renders[0].dimensions.width,
          height: renders[0].dimensions.height,
        };
      }
    }

    if (outputFormat === 'html' || outputFormat === 'both') {
      render.output_format = outputFormat === 'both' ? 'both' : 'html';
      render.preview_html = html;
    }

    if (outputFormat === 'url' || outputFormat === 'both') {
      render.output_format = outputFormat === 'both' ? 'both' : 'url';
      expiresAt = storePreview(previewId, html);
      render.preview_url = `${baseUrl}/api/creative-agent/preview/${previewId}`;
    }

    return {
      preview_id: previewId,
      renders: [render],
      input,
    };
  });

  return { previews, expires_at: expiresAt.toISOString() };
}

export function handlePreviewCreative(args: Record<string, unknown>, formats: Format[], baseUrl: string): Record<string, unknown> {
  const requestType = args.request_type as string;

  if (requestType === 'batch') {
    const requests = args.requests as PreviewRequest[];
    if (!requests?.length) {
      return { errors: [{ code: 'validation_error', message: 'Batch request requires at least one request in requests array.' }] };
    }
    if (requests.length > MAX_BATCH_SIZE) {
      return { errors: [{ code: 'validation_error', message: `Batch limited to ${MAX_BATCH_SIZE} requests.` }] };
    }

    const results = requests.map((req, i) => {
      try {
        const result = renderSinglePreview(req, formats, baseUrl);
        return {
          success: true,
          creative_id: (req.creative_manifest?.creative_id as string) || `batch_${i}`,
          response: result,
        };
      } catch (err) {
        return {
          success: false,
          creative_id: (req.creative_manifest?.creative_id as string) || `batch_${i}`,
          errors: [{ code: 'render_error', message: err instanceof Error ? err.message : 'Preview rendering failed' }],
        };
      }
    });

    return { response_type: 'batch', results };
  }

  if (requestType === 'variant') {
    return {
      errors: [{
        code: 'not_supported',
        message: 'Variant preview mode requires delivery state. The reference creative agent does not support variant previews.',
      }],
    };
  }

  // Single preview (default)
  if (!args.creative_manifest) {
    return { errors: [{ code: 'validation_error', message: 'creative_manifest is required.' }] };
  }

  const result = renderSinglePreview(args as unknown as PreviewRequest, formats, baseUrl);
  return { response_type: 'single', ...result };
}

// ── Server factory ──────────────────────────────────────────────────

export function createCreativeAgentServer(baseUrl: string) {
  const agentUrl = `${baseUrl}/api/creative-agent`;
  const formats = buildReferenceFormats(agentUrl);

  const server = new McpServer({
    name: 'AdCP Reference Creative Agent',
    version: '1.0.0',
  });

  server.tool(
    'list_creative_formats',
    'List supported creative formats with asset requirements, dimensions, and rendering specifications. Use filters to avoid large responses. Do not call without filters if you already know the format_id.',
    {
      format_ids: z.array(z.union([z.string(), z.object({ id: z.string() })])).optional().describe('Filter by specific format IDs'),
      type: z.enum(['display', 'video', 'audio', 'dooh']).optional().describe('Filter by format type'),
      asset_types: z.array(z.string()).optional().describe('Filter by asset types: image, video, audio, text, html, vast, etc.'),
      name_search: z.string().optional().describe('Case-insensitive partial match on name or description'),
      min_width: z.number().optional().describe('Minimum width in pixels'),
      max_width: z.number().optional().describe('Maximum width in pixels'),
      min_height: z.number().optional().describe('Minimum height in pixels'),
      max_height: z.number().optional().describe('Maximum height in pixels'),
      is_responsive: z.boolean().optional().describe('Filter for responsive formats'),
    },
    async (args) => ({
      content: [{
        type: 'text' as const,
        text: JSON.stringify(handleListCreativeFormats(args as Record<string, unknown>, formats)),
      }],
    }),
  );

  server.tool(
    'preview_creative',
    'Generate HTML previews of creative manifests. Supports single and batch modes. Returns preview URLs (iframe-embeddable) and/or raw HTML. Previews expire after 1 hour. Not for production ad serving.',
    {
      request_type: z.enum(['single', 'batch', 'variant']).optional().describe('Request type. Defaults to single.'),
      creative_manifest: z.record(z.string(), z.unknown()).optional().describe('Creative manifest with format_id and assets (required for single mode)'),
      format_id: z.object({
        agent_url: z.string().optional(),
        id: z.string().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
      }).optional().describe('Format identifier for rendering. Defaults to manifest format_id.'),
      inputs: z.array(z.object({
        name: z.string(),
        macros: z.record(z.string(), z.string()).optional(),
        context_description: z.string().optional(),
      })).optional().describe('Array of input sets for multiple preview variants'),
      output_format: z.enum(['url', 'html', 'both']).optional().describe('Output format. Defaults to url.'),
      requests: z.array(z.object({
        creative_manifest: z.record(z.string(), z.unknown()),
        format_id: z.object({ agent_url: z.string().optional(), id: z.string().optional() }).optional(),
        output_format: z.enum(['url', 'html', 'both']).optional(),
        inputs: z.array(z.object({ name: z.string() })).optional(),
      })).optional().describe('Array of preview requests (batch mode, max 20)'),
      variant_id: z.string().optional().describe('Variant ID (variant mode — not supported by reference agent)'),
      template_id: z.string().optional().describe('Custom template ID'),
      item_limit: z.number().optional().describe('Max catalog items to render'),
    },
    async (args) => ({
      content: [{
        type: 'text' as const,
        text: JSON.stringify(handlePreviewCreative(args as Record<string, unknown>, formats, baseUrl)),
      }],
    }),
  );

  return server;
}
