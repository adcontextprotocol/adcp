/**
 * MCP tool handlers for the reference creative agent.
 *
 * Implements canonical capability discovery and preview_creative using the
 * shared format library and template-based rendering. list_creative_formats
 * remains as a deprecated 3.x compatibility projection.
 *
 * Uses the low-level Server class (like the training agent) so tool
 * schemas are plain JSON Schema objects — no Zod round-trip that drops
 * adcp_major_version and additionalProperties.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { renderPreview } from './preview-renderer.js';
import { storePreview } from './preview-store.js';

const require = createRequire(import.meta.url);
const referenceFormatsData = require('./reference-formats.json');
const uiElementFormatsData = require('./ui-element-formats.json');

// ── Types ───────────────────────────────────────────────────────────

type Format = Record<string, unknown>;

interface FormatId {
  agent_url: string;
  id: string;
}

const MAX_BATCH_SIZE = 50;

/**
 * Build formats with agent_url rewritten to the local endpoint.
 * Source data is the exact format catalog from the live creative.adcontextprotocol.org agent.
 * Unions reference-formats (55 ad formats with canonical: {kind,...} annotations) with
 * ui-element-formats (7 card scaffolding formats used by training-agent + preview-renderer).
 * Cards are emitted in list_creative_formats so consumers (training-agent product-factory,
 * preview-renderer) can resolve them by format_id; they are NOT ad formats and never project
 * to ad canonicals.
 */
export function buildReferenceFormats(agentUrl: string): Format[] {
  const formats = [
    ...structuredClone(referenceFormatsData) as Format[],
    ...structuredClone(uiElementFormatsData) as Format[],
  ];
  for (const f of formats) {
    const fid = f.format_id as { agent_url: string; id: string };
    fid.agent_url = agentUrl;
  }
  return formats;
}

/**
 * Project the reviewed legacy reference catalog into the canonical 3.2
 * creative-capability surface. UI scaffolding formats have no canonical
 * projection and are intentionally excluded.
 */
export function buildCreativeCapabilities(formats: Format[]): Array<Record<string, unknown>> {
  return formats.flatMap(format => {
    const canonical = format.canonical as {
      kind?: string;
      asset_source?: string;
      slots_override?: unknown[];
      parameters?: Record<string, unknown>;
    } | undefined;
    if (!canonical?.kind) return [];

    const params: Record<string, unknown> = { ...(canonical.parameters ?? {}) };
    const renders = format.renders as Array<{
      dimensions?: { width?: number; height?: number };
      duration_ms?: number;
    }> | undefined;
    const dimensions = renders?.[0]?.dimensions;
    if (dimensions?.width) params.width = dimensions.width;
    if (dimensions?.height) params.height = dimensions.height;

    // Preserve constraints carried by the reviewed legacy catalog instead of
    // reducing every projection to only its canonical kind. Some older fixed-
    // duration entries encode duration in requirements (or, for the earliest
    // VAST entries, in their stable ID), while hosted assets carry file/container
    // constraints that remain meaningful on the canonical declaration.
    const assets = [
      ...(Array.isArray(format.assets) ? format.assets : []),
      ...(Array.isArray(format.assets_required) ? format.assets_required : []),
    ] as Array<{ requirements?: Record<string, unknown> }>;
    const requirements = assets
      .map(asset => asset.requirements)
      .filter((value): value is Record<string, unknown> => Boolean(value));
    const minDurations = requirements
      .map(value => value.min_duration_ms)
      .filter((value): value is number => typeof value === 'number');
    const maxDurations = requirements
      .map(value => value.max_duration_ms)
      .filter((value): value is number => typeof value === 'number');
    const renderedDuration = renders?.find(render => typeof render.duration_ms === 'number')?.duration_ms;
    const idDurationMatch = getFormatId(format).id.match(/_(\d+)s$/);
    const idDuration = idDurationMatch ? Number(idDurationMatch[1]) * 1000 : undefined;
    const minimumDuration = minDurations.length ? Math.max(...minDurations) : undefined;
    const maximumDuration = maxDurations.length ? Math.min(...maxDurations) : undefined;
    if (renderedDuration) {
      params.duration_ms_exact = renderedDuration;
    } else if (minimumDuration !== undefined && minimumDuration === maximumDuration) {
      params.duration_ms_exact = minimumDuration;
    } else if (minimumDuration !== undefined || maximumDuration !== undefined) {
      params.duration_ms_range = [minimumDuration ?? 0, maximumDuration ?? Number.MAX_SAFE_INTEGER];
    } else if (idDuration && ['video_hosted', 'video_vast', 'audio_hosted', 'audio_daast'].includes(canonical.kind)) {
      params.duration_ms_exact = idDuration;
    }

    const maxFileSizes = requirements
      .map(value => value.max_file_size_bytes)
      .filter((value): value is number => typeof value === 'number');
    if (maxFileSizes.length) {
      const maxBytes = Math.min(...maxFileSizes);
      if (canonical.kind === 'video_hosted') params.max_file_size_mb = Math.max(1, Math.ceil(maxBytes / 1_000_000));
      else params.max_file_size_kb = Math.max(1, Math.ceil(maxBytes / 1000));
    }
    const containers = [...new Set(requirements.flatMap(value =>
      Array.isArray(value.containers)
        ? value.containers.filter((item): item is string => typeof item === 'string')
        : []
    ))];
    if (containers.length && canonical.kind === 'video_hosted') params.containers = containers;
    if (containers.length && canonical.kind === 'audio_hosted') {
      const codecByLegacyContainer: Record<string, string> = {
        mp3: 'mp3',
        wav: 'wav',
        m4a: 'aac',
        ogg: 'opus',
        flac: 'flac',
      };
      const audioCodecs = [...new Set(containers.flatMap(container =>
        codecByLegacyContainer[container] ? [codecByLegacyContainer[container]] : []
      ))];
      if (audioCodecs.length) params.audio_codecs = audioCodecs;
    }
    if (canonical.asset_source) params.asset_source = canonical.asset_source;
    if (canonical.slots_override) params.slots = canonical.slots_override;

    return [{
      capability_id: `preview_${getFormatId(format).id}`,
      operations: ['preview'],
      format: {
        format_kind: canonical.kind,
        params,
      },
    }];
  });
}

export function handleGetAdcpCapabilities(formats: Format[]): Record<string, unknown> {
  return {
    adcp_version: '3.2',
    adcp: {
      major_versions: [3],
      supported_versions: ['3.2'],
    },
    supported_protocols: ['creative'],
    creative: {
      supported_formats: buildCreativeCapabilities(formats),
    },
  };
}

// ── Format filtering helpers ────────────────────────────────────────

function getFormatId(format: Format): FormatId {
  return format.format_id as FormatId;
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
  creative_manifest?: Record<string, unknown> & { format_kind?: string };
  creative_id?: string;
  capability_id?: string;
  target_capability_id?: string;
  format_id?: { agent_url?: string; id?: string; width?: number; height?: number; pixel_ratio?: number };
  inputs?: Array<{ name: string; macros?: Record<string, string>; context_description?: string }>;
  quality?: 'draft' | 'production';
  output_format?: 'url' | 'html' | 'both';
  template_id?: string;
  item_limit?: number;
}

class PreviewFormatNotSupportedError extends Error {
  readonly code = 'FORMAT_NOT_SUPPORTED';
}

class PreviewCreativeNotFoundError extends Error {
  readonly code = 'CREATIVE_NOT_FOUND';
}

function manifestDimensions(manifest: Record<string, unknown>): { width?: number; height?: number } {
  const params = manifest.params;
  if (params && typeof params === 'object' && !Array.isArray(params)) {
    const width = (params as Record<string, unknown>).width;
    const height = (params as Record<string, unknown>).height;
    if (typeof width === 'number' || typeof height === 'number') {
      return {
        ...(typeof width === 'number' ? { width } : {}),
        ...(typeof height === 'number' ? { height } : {}),
      };
    }
  }
  const assets = manifest.assets;
  if (!assets || typeof assets !== 'object' || Array.isArray(assets)) return {};
  for (const value of Object.values(assets as Record<string, unknown>)) {
    const candidates = Array.isArray(value) ? value : [value];
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
      const width = (candidate as Record<string, unknown>).width;
      const height = (candidate as Record<string, unknown>).height;
      if (typeof width === 'number' || typeof height === 'number') {
        return {
          ...(typeof width === 'number' ? { width } : {}),
          ...(typeof height === 'number' ? { height } : {}),
        };
      }
    }
  }
  return {};
}

function resolveCanonicalPreviewFormat(req: PreviewRequest, formats: Format[]): Format | undefined {
  if (!req.creative_manifest) {
    throw new PreviewCreativeNotFoundError(`Creative "${req.creative_id ?? 'unknown'}" was not found in this agent's creative library.`);
  }
  const selector = req.target_capability_id ?? req.capability_id;
  if (selector) {
    const legacyId = selector.startsWith('preview_') ? selector.slice('preview_'.length) : '';
    const selected = formats.find(format => getFormatId(format).id === legacyId);
    const selectedKind = (selected?.canonical as { kind?: string } | undefined)?.kind;
    if (!selected || !selectedKind) {
      throw new PreviewFormatNotSupportedError(`Unknown preview capability_id "${selector}".`);
    }
    if (req.creative_manifest.format_kind && req.creative_manifest.format_kind !== selectedKind) {
      throw new PreviewFormatNotSupportedError(
        `Preview capability_id "${selector}" renders format_kind "${selectedKind}", not "${req.creative_manifest.format_kind}".`,
      );
    }
    return selected;
  }

  const manifest = req.creative_manifest;
  const formatId = req.format_id || manifest.format_id as { id?: string } | undefined;
  if (formatId?.id) return formats.find(format => getFormatId(format).id === formatId.id);
  if (!manifest.format_kind) return undefined;

  const candidates = formats.filter(format =>
    (format.canonical as { kind?: string } | undefined)?.kind === manifest.format_kind
  );
  if (candidates.length === 0) {
    throw new PreviewFormatNotSupportedError(
      `No advertised preview capability matches canonical format_kind "${manifest.format_kind}".`,
    );
  }
  if (candidates.length === 1) return candidates[0];

  const dimensions = manifestDimensions(manifest);
  if (dimensions.width !== undefined || dimensions.height !== undefined) {
    const exact = candidates.filter(format => {
      const declared = buildCreativeCapabilities([format])[0]?.format as { params?: Record<string, unknown> } | undefined;
      const params = declared?.params ?? {};
      return (dimensions.width === undefined || params.width === dimensions.width)
        && (dimensions.height === undefined || params.height === dimensions.height);
    });
    if (exact.length === 1) return exact[0];
  }

  const generic = candidates.filter(format => {
    const declared = buildCreativeCapabilities([format])[0]?.format as { params?: Record<string, unknown> } | undefined;
    return declared?.params?.width === undefined && declared?.params?.height === undefined;
  });
  if (generic.length === 1) return generic[0];
  throw new PreviewFormatNotSupportedError(
    `Canonical format_kind "${manifest.format_kind}" matches multiple preview capabilities; provide target_capability_id.`,
  );
}

function withBatchDefaults(args: Record<string, unknown>, req: PreviewRequest): PreviewRequest {
  const batchTarget = args.target_capability_id ?? args.capability_id;
  const itemTarget = req.target_capability_id ?? req.capability_id;
  return {
    creative_manifest: req.creative_manifest,
    ...(req.creative_id !== undefined && { creative_id: req.creative_id }),
    ...((itemTarget ?? batchTarget) !== undefined && {
      target_capability_id: (itemTarget ?? batchTarget) as string,
    }),
    ...(req.format_id !== undefined
      ? { format_id: req.format_id }
      : itemTarget === undefined && batchTarget === undefined && args.format_id !== undefined
        ? { format_id: args.format_id as PreviewRequest['format_id'] }
        : {}),
    ...((req.quality ?? args.quality) !== undefined && {
      quality: (req.quality ?? args.quality) as PreviewRequest['quality'],
    }),
    ...((req.output_format ?? args.output_format) !== undefined && {
      output_format: (req.output_format ?? args.output_format) as PreviewRequest['output_format'],
    }),
    ...(req.inputs !== undefined && { inputs: req.inputs }),
    ...(req.template_id !== undefined && { template_id: req.template_id }),
    ...(req.item_limit !== undefined && { item_limit: req.item_limit }),
  };
}

function previewResolutionError(err: unknown, fallback: string): { code: string; message: string } {
  return {
    code: err instanceof PreviewFormatNotSupportedError || err instanceof PreviewCreativeNotFoundError
      ? err.code
      : 'render_error',
    message: err instanceof Error ? err.message : fallback,
  };
}

function renderSinglePreview(
  req: PreviewRequest,
  formats: Format[],
  baseUrl: string,
): { previews: unknown[]; expires_at: string } {
  if (!req.creative_manifest) {
    throw new PreviewCreativeNotFoundError(`Creative "${req.creative_id ?? 'unknown'}" was not found in this agent's creative library.`);
  }
  const manifest = req.creative_manifest;
  const formatId = req.format_id || manifest.format_id as PreviewRequest['format_id'];
  const format = resolveCanonicalPreviewFormat(req, formats);

  // The renderer still consumes the catalog's internal template key. Keep that
  // projection private; the caller-facing manifest remains canonical.
  const renderManifest = { ...manifest, ...(format && { format_id: getFormatId(format) }) };

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

    // Parameterized legacy ids carry logical render dimensions directly. Pixel
    // ratio changes intrinsic asset pixels, never the preview box size.
    if (formatId?.width && formatId?.height) {
      render.dimensions = { width: formatId.width, height: formatId.height };
    } else if (format) {
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
      render.preview_url = `${baseUrl}/preview/${previewId}`;
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

  if (args.creative_manifest && args.creative_id) {
    return { errors: [{ code: 'validation_error', message: 'Provide creative_manifest or creative_id, not both.' }] };
  }
  if ((args.target_capability_id || args.capability_id) && args.format_id) {
    return { errors: [{ code: 'validation_error', message: 'Use target_capability_id or deprecated format_id routing, not both.' }] };
  }

  if (requestType === 'batch') {
    const requests = args.requests as PreviewRequest[];
    if (!requests?.length) {
      return { errors: [{ code: 'validation_error', message: 'Batch request requires at least one request in requests array.' }] };
    }
    if (requests.length > MAX_BATCH_SIZE) {
      return { errors: [{ code: 'validation_error', message: `Batch limited to ${MAX_BATCH_SIZE} requests.` }] };
    }
    const usesCanonicalRouting = Boolean(args.target_capability_id || args.capability_id)
      || requests.some(req => Boolean(req.target_capability_id || req.capability_id));
    const usesLegacyRouting = Boolean(args.format_id)
      || requests.some(req => Boolean(req.format_id));
    if (usesCanonicalRouting && usesLegacyRouting) {
      return { errors: [{ code: 'validation_error', message: 'Use one routing generation across the batch: target_capability_id or deprecated format_id.' }] };
    }

    const results = requests.map((req, i) => {
      if (req.creative_manifest && req.creative_id) {
        return {
          success: false,
          creative_id: req.creative_id,
          errors: [{ code: 'validation_error', message: 'Provide creative_manifest or creative_id, not both.' }],
        };
      }
      try {
        const result = renderSinglePreview(withBatchDefaults(args, req), formats, baseUrl);
        return {
          success: true,
          creative_id: (req.creative_manifest?.creative_id as string) || req.creative_id || `batch_${i}`,
          response: result,
        };
      } catch (err) {
        return {
          success: false,
          creative_id: (req.creative_manifest?.creative_id as string) || req.creative_id || `batch_${i}`,
          errors: [previewResolutionError(err, 'Preview rendering failed')],
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
  if (!args.creative_manifest && !args.creative_id) {
    return { errors: [{ code: 'validation_error', message: 'creative_manifest is required.' }] };
  }

  try {
    const result = renderSinglePreview(args as unknown as PreviewRequest, formats, baseUrl);
    return { response_type: 'single', ...result };
  } catch (err) {
    return {
      errors: [previewResolutionError(err, 'Preview capability could not be resolved.')],
    };
  }
}

// ── Tool definitions (plain JSON Schema — matches canonical specs) ───

const ADCP_MAJOR_VERSION_PROP = {
  type: 'integer',
  description: 'The AdCP major version the buyer\'s payloads conform to. When omitted, the seller assumes its highest supported version.',
  minimum: 1,
  maximum: 99,
} as const;

const FORMAT_ID_SCHEMA = {
  type: 'object',
  properties: {
    agent_url: { type: 'string', format: 'uri' },
    id: { type: 'string' },
    width: { type: 'integer' },
    height: { type: 'integer' },
  },
  additionalProperties: true,
} as const;

const TOOLS = [
  {
    name: 'get_adcp_capabilities',
    description: 'Discover this endpoint\'s canonical AdCP 3.2 creative preview capabilities.',
    inputSchema: {
      type: 'object' as const,
      properties: { adcp_major_version: ADCP_MAJOR_VERSION_PROP },
      additionalProperties: true,
    },
    outputSchema: {
      type: 'object' as const,
      properties: {
        adcp_version: { type: 'string' },
        adcp: { type: 'object', additionalProperties: true },
        supported_protocols: { type: 'array', items: { type: 'string' } },
        creative: { type: 'object', additionalProperties: true },
      },
      required: ['adcp', 'supported_protocols', 'creative'],
      additionalProperties: true,
    },
  },
  {
    name: 'list_creative_formats',
    description: 'DEPRECATED in AdCP 3.2. Legacy named-format compatibility projection; use get_adcp_capabilities creative.supported_formats[].',
    inputSchema: {
      type: 'object' as const,
      properties: {
        adcp_major_version: ADCP_MAJOR_VERSION_PROP,
        format_ids: { type: 'array', description: 'Return only these specific format IDs', items: FORMAT_ID_SCHEMA, minItems: 1 },
        type: { type: 'string', description: 'Filter by format type', enum: ['audio', 'video', 'display', 'dooh'] },
        asset_types: { type: 'array', description: 'Filter to formats that include these asset types', items: { type: 'string', enum: ['image', 'video', 'audio', 'text', 'html', 'javascript', 'url'] }, minItems: 1 },
        name_search: { type: 'string', description: 'Case-insensitive partial match on name or description' },
        min_width: { type: 'integer', description: 'Minimum width in pixels (inclusive)' },
        max_width: { type: 'integer', description: 'Maximum width in pixels (inclusive)' },
        min_height: { type: 'integer', description: 'Minimum height in pixels (inclusive)' },
        max_height: { type: 'integer', description: 'Maximum height in pixels (inclusive)' },
        is_responsive: { type: 'boolean', description: 'Filter for responsive formats that adapt to container size' },
      },
      additionalProperties: true,
    },
    outputSchema: {
      type: 'object' as const,
      properties: {
        formats: { type: 'array', items: { type: 'object', additionalProperties: true } },
      },
      required: ['formats'],
      additionalProperties: true,
    },
  },
  {
    name: 'preview_creative',
    description: 'Generate HTML previews of creative manifests. Supports single and batch modes. Returns preview URLs (iframe-embeddable) and/or raw HTML. Previews expire after 1 hour. Not for production ad serving.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        adcp_major_version: ADCP_MAJOR_VERSION_PROP,
        request_type: { type: 'string', enum: ['single', 'batch', 'variant'], description: 'Request type. Defaults to single.' },
        creative_manifest: { type: 'object', description: 'Canonical creative manifest with format_kind and typed assets (required for single mode)', additionalProperties: true },
        creative_id: { type: 'string', description: 'Creative-library identifier used instead of creative_manifest.' },
        target_capability_id: { type: 'string', pattern: '^[a-zA-Z0-9_-]+$', description: 'Exact preview capability advertised by get_adcp_capabilities.' },
        capability_id: { type: 'string', pattern: '^[a-zA-Z0-9_-]+$', description: 'Alias for target_capability_id.' },
        format_id: { ...FORMAT_ID_SCHEMA, deprecated: true, description: 'Deprecated named-format override for older 3.x peers.' },
        inputs: {
          type: 'array', description: 'Array of input sets for multiple preview variants', minItems: 1,
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, macros: { type: 'object', additionalProperties: { type: 'string' } }, context_description: { type: 'string' } },
            required: ['name'], additionalProperties: true,
          },
        },
        output_format: { type: 'string', enum: ['url', 'html', 'both'], description: 'Output format. Defaults to url.' },
        quality: { type: 'string', enum: ['draft', 'production'], description: 'Render quality. In batch mode, defaults items that omit quality.' },
        requests: {
          type: 'array', description: 'Array of preview requests (batch mode, max 50)', minItems: 1, maxItems: 50,
          items: {
            type: 'object',
            properties: {
              creative_manifest: { type: 'object', additionalProperties: true },
              creative_id: { type: 'string' },
              target_capability_id: { type: 'string', pattern: '^[a-zA-Z0-9_-]+$' },
              capability_id: { type: 'string', pattern: '^[a-zA-Z0-9_-]+$' },
              format_id: { ...FORMAT_ID_SCHEMA, deprecated: true },
              output_format: { type: 'string', enum: ['url', 'html', 'both'] },
              quality: { type: 'string', enum: ['draft', 'production'] },
              inputs: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
              template_id: { type: 'string' },
              item_limit: { type: 'integer', minimum: 1 },
            },
            oneOf: [{ required: ['creative_manifest'] }, { required: ['creative_id'] }], additionalProperties: true,
          },
        },
        variant_id: { type: 'string', description: 'Variant ID (variant mode)' },
        template_id: { type: 'string', description: 'Specific template ID for custom format rendering' },
        item_limit: { type: 'integer', minimum: 1, description: 'Max catalog items to render' },
      },
      allOf: [{
        if: { properties: { request_type: { const: 'single' } } },
        then: { oneOf: [{ required: ['creative_manifest'] }, { required: ['creative_id'] }] },
      }, {
        not: { required: ['target_capability_id', 'format_id'] },
      }, {
        not: {
          anyOf: [{
            allOf: [
              { required: ['target_capability_id', 'requests'] },
              { properties: { requests: { contains: { required: ['format_id'] } } } },
            ],
          }, {
            allOf: [
              { required: ['format_id', 'requests'] },
              { properties: { requests: { contains: { required: ['target_capability_id'] } } } },
            ],
          }, {
            allOf: [
              { required: ['requests'] },
              { properties: { requests: { contains: { required: ['target_capability_id'] } } } },
              { properties: { requests: { contains: { required: ['format_id'] } } } },
            ],
          }],
        },
      }],
      additionalProperties: true,
    },
    outputSchema: {
      type: 'object' as const,
      properties: {
        response_type: { type: 'string' },
        previews: { type: 'array', items: { type: 'object', additionalProperties: true } },
        results: { type: 'array', items: { type: 'object', additionalProperties: true } },
        errors: { type: 'array', items: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } } } },
        expires_at: { type: 'string', format: 'date-time' },
      },
      additionalProperties: true,
    },
  },
];

type ToolArgs = Record<string, unknown>;
type ToolHandler = (args: ToolArgs) => Record<string, unknown>;

// ── Server factory ──────────────────────────────────────────────────

export function createCreativeAgentServer(agentBaseUrl: string) {
  const formats = buildReferenceFormats(agentBaseUrl);

  const handlers: Record<string, ToolHandler> = {
    get_adcp_capabilities: () => handleGetAdcpCapabilities(formats),
    list_creative_formats: (args) => handleListCreativeFormats(args, formats),
    preview_creative: (args) => handlePreviewCreative(args, formats, agentBaseUrl),
  };

  const server = new Server(
    { name: 'AdCP Reference Creative Agent', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOLS };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const handler = handlers[name];

    if (!handler) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ errors: [{ code: 'INVALID_REQUEST', message: `Unknown tool: ${name}` }] }) }],
        isError: true,
      };
    }

    try {
      const result = handler((args as ToolArgs) || {});
      return {
        structuredContent: result,
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ errors: [{ code: 'INTERNAL_ERROR', message }] }) }],
        isError: true,
      };
    }
  });

  return server;
}
