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
import { renderPreviewWithMetadata } from './preview-renderer.js';
import { MAX_PREVIEW_ASSET_BYTES, storePreview, storePreviewAsset } from './preview-store.js';

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

    // The hosted reference agent proxies media through a bounded cache. Make
    // that ceiling part of every affected advertised route so compatibility
    // fails before returning a preview URL that would later fail with 413.
    const effectiveSlots = (canonical.slots_override
      ?? canonicalDefaultSlots(canonical.kind)) as CanonicalSlot[];
    if (effectiveSlots.some(slot => ['image', 'video', 'audio'].includes(slot.asset_type ?? ''))) {
      if (canonical.kind === 'image') params.max_file_size_kb ??= MAX_PREVIEW_ASSET_BYTES / 1000;
      if (canonical.kind === 'video_hosted' || canonical.kind === 'audio_hosted') {
        params.max_file_size_mb ??= MAX_PREVIEW_ASSET_BYTES / 1_000_000;
      }
    }

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
  const supportedFormats = buildCreativeCapabilities(formats);
  return {
    adcp_version: '3.2',
    adcp: {
      major_versions: [3],
      supported_versions: ['3.2'],
    },
    supported_protocols: ['creative'],
    creative: {
      supported_formats: supportedFormats,
      preview: {
        routes: supportedFormats.map(capability => ({
          capability_id: capability.capability_id,
          rendering_origin: 'agent_approximation',
        })),
      },
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

class PreviewAssetCapacityError extends Error {
  readonly code = 'PREVIEW_CAPACITY_EXCEEDED';
}

interface CanonicalSlot {
  asset_group_id?: string;
  asset_type?: string;
  required?: boolean;
  min?: number;
  max?: number;
}

function manifestAssetRecords(
  manifest: Record<string, unknown>,
  assetIds?: Set<string>,
): Array<Record<string, unknown>> {
  const assets = manifest.assets;
  if (!assets || typeof assets !== 'object' || Array.isArray(assets)) return [];
  return Object.entries(assets as Record<string, unknown>).flatMap(([assetId, value]) => {
    if (assetIds && !assetIds.has(assetId)) return [];
    const candidates = Array.isArray(value) ? value : [value];
    return candidates.filter((candidate): candidate is Record<string, unknown> =>
      Boolean(candidate && typeof candidate === 'object' && !Array.isArray(candidate))
    );
  });
}

function uniqueFact(values: unknown[]): unknown {
  const unique = [...new Map(values.map(value => [JSON.stringify(value), value])).values()];
  return unique.length > 1 ? { conflicting_asset_values: unique } : unique[0];
}

function manifestConstraintValue(
  manifest: Record<string, unknown>,
  key: string,
  relevantAssetIds: Set<string>,
): unknown {
  const assets = manifestAssetRecords(manifest, relevantAssetIds);
  if (key === 'width' || key === 'height') {
    const assetValues = assets.flatMap(asset => {
      const value = asset[key];
      if (typeof value !== 'number') return [];
      const pixelRatio = asset.pixel_ratio;
      return [typeof pixelRatio === 'number' && pixelRatio > 0 ? value / pixelRatio : value];
    });
    if (assetValues.length > 0) return uniqueFact(assetValues);
    const formatId = manifest.format_id;
    if (formatId && typeof formatId === 'object' && !Array.isArray(formatId)) {
      const value = (formatId as Record<string, unknown>)[key];
      if (typeof value === 'number') return value;
    }
  }
  if (key === 'duration_ms_exact') {
    const durations = assets.flatMap(asset => typeof asset.duration_ms === 'number' ? [asset.duration_ms] : []);
    if (durations.length > 0) return uniqueFact(durations);
  }
  if (key === 'duration_ms_range') {
    const durations = assets.flatMap(asset => typeof asset.duration_ms === 'number' ? [asset.duration_ms] : []);
    if (durations.length > 0) {
      const duration = uniqueFact(durations);
      return typeof duration === 'number' ? [duration, duration] : duration;
    }
  }
  if (key === 'containers') {
    const containers = assets.flatMap(asset => {
      if (typeof asset.container_format === 'string') return [asset.container_format];
      if (typeof asset.format === 'string') return [asset.format];
      if (typeof asset.mime_type === 'string' && asset.mime_type.includes('/')) {
        return [asset.mime_type.slice(asset.mime_type.indexOf('/') + 1).replace('jpeg', 'jpg')];
      }
      return [];
    });
    if (containers.length > 0) return [...new Set(containers)];
  }
  if (key === 'audio_codecs') {
    const codecByContainer: Record<string, string> = {
      mp3: 'mp3',
      wav: 'wav',
      m4a: 'aac',
      aac: 'aac',
      ogg: 'opus',
      opus: 'opus',
      flac: 'flac',
    };
    const codecs = assets.flatMap(asset => {
      if (typeof asset.codec === 'string') return [asset.codec];
      const container = typeof asset.container_format === 'string'
        ? asset.container_format
        : typeof asset.format === 'string'
          ? asset.format
          : typeof asset.mime_type === 'string' && asset.mime_type.includes('/')
            ? asset.mime_type.slice(asset.mime_type.indexOf('/') + 1)
            : undefined;
      return container && codecByContainer[container] ? [codecByContainer[container]] : [];
    });
    if (codecs.length > 0) return [...new Set(codecs)];
  }
  const params = manifest.params;
  if (params && typeof params === 'object' && !Array.isArray(params)
    && Object.prototype.hasOwnProperty.call(params, key)) {
    return (params as Record<string, unknown>)[key];
  }
  return undefined;
}

function canonicalDefaultSlots(kind: string): unknown[] {
  try {
    const schema = require(`../../../static/schemas/source/formats/canonical/${kind}.json`) as {
      properties?: { slots?: { default?: unknown[] } };
    };
    return Array.isArray(schema.properties?.slots?.default) ? schema.properties.slots.default : [];
  } catch {
    return [];
  }
}

function requiredSlotIssue(value: unknown, slot: CanonicalSlot): string | undefined {
  const slotId = slot.asset_group_id ?? 'unknown';
  const isPool = typeof slot.max === 'number' && slot.max > 1;
  if (isPool && !Array.isArray(value)) return `${slotId} must be an array`;
  if (!isPool && Array.isArray(value)) return `${slotId} must be a single asset`;
  const candidates = Array.isArray(value) ? value : [value];
  const minimum = slot.min ?? 1;
  if (candidates.length < minimum) return `${slotId} requires at least ${minimum} asset(s)`;
  if (typeof slot.max === 'number' && candidates.length > slot.max) {
    return `${slotId} allows at most ${slot.max} asset(s)`;
  }
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      return `${slotId} must contain typed asset objects`;
    }
    const asset = candidate as Record<string, unknown>;
    if (asset.asset_type !== slot.asset_type) {
      return `${slotId} requires asset_type ${slot.asset_type}`;
    }
    const stringValue = (field: string) => typeof asset[field] === 'string' && (asset[field] as string).trim().length > 0;
    if (['image', 'video', 'audio', 'url', 'webhook', 'zip'].includes(slot.asset_type ?? '') && !stringValue('url')) {
      return `${slotId} requires a usable url`;
    }
    if (['image', 'video', 'audio'].includes(slot.asset_type ?? '')) {
      try {
        const url = new URL(String(asset.url));
        if (url.protocol !== 'https:' || url.username || url.password) {
          return `${slotId} requires a credential-free HTTPS url`;
        }
      } catch {
        return `${slotId} requires a valid credential-free HTTPS url`;
      }
    }
    if (['text', 'markdown', 'html', 'css', 'javascript'].includes(slot.asset_type ?? '') && !stringValue('content')) {
      return `${slotId} requires usable content`;
    }
    if (['vast', 'daast'].includes(slot.asset_type ?? '')) {
      const hasPayload = asset.delivery_type === 'url' ? stringValue('url') : asset.delivery_type === 'inline' && stringValue('content');
      if (!hasPayload) return `${slotId} requires a valid ${slot.asset_type} delivery payload`;
    }
  }
  return undefined;
}

function manifestDimensions(manifest: Record<string, unknown>): { width?: number; height?: number } {
  const kind = typeof manifest.format_kind === 'string' ? manifest.format_kind : '';
  const requiredIds = new Set((canonicalDefaultSlots(kind) as CanonicalSlot[])
    .filter(slot => slot.required && slot.asset_group_id)
    .map(slot => slot.asset_group_id!));
  const width = manifestConstraintValue(manifest, 'width', requiredIds);
  const height = manifestConstraintValue(manifest, 'height', requiredIds);
  return {
    ...(typeof width === 'number' ? { width } : {}),
    ...(typeof height === 'number' ? { height } : {}),
  };
}

function rangeContains(declared: unknown[], received: unknown[]): boolean {
  const [declaredMin, declaredMax] = declared;
  const [receivedMin, receivedMax] = received;
  const lowerBounded = declaredMin === null
    || (typeof declaredMin === 'number' && typeof receivedMin === 'number' && receivedMin >= declaredMin);
  const upperBounded = declaredMax === null
    || (typeof declaredMax === 'number' && typeof receivedMax === 'number' && receivedMax <= declaredMax);
  return lowerBounded && upperBounded;
}

function constraintSatisfied(declared: unknown, received: unknown, key: string): boolean {
  if (Array.isArray(declared)) {
    if (!Array.isArray(received)) return declared.some(value => JSON.stringify(value) === JSON.stringify(received));
    if (key.endsWith('_range') && declared.length === 2 && received.length === 2) {
      return rangeContains(declared, received);
    }
    return received.every(value => declared.some(allowed => JSON.stringify(allowed) === JSON.stringify(value)));
  }
  return JSON.stringify(declared) === JSON.stringify(received);
}

function manifestCompatibilityIssue(
  manifest: Record<string, unknown>,
  format: Format,
): string | undefined {
  const declared = buildCreativeCapabilities([format])[0]?.format as { params?: Record<string, unknown> } | undefined;
  const declaredParams = declared?.params ?? {};
  const assets = manifest.assets && typeof manifest.assets === 'object' && !Array.isArray(manifest.assets)
    ? manifest.assets as Record<string, unknown>
    : {};

  const kind = (format.canonical as { kind?: string } | undefined)?.kind ?? '';
  const effectiveSlots = (Array.isArray(declaredParams.slots)
    ? declaredParams.slots
    : canonicalDefaultSlots(kind)) as CanonicalSlot[];
  const requiredSlots = effectiveSlots.filter(slot => slot?.required === true && slot.asset_group_id);
  const missingSlots = requiredSlots
    .map(slot => slot.asset_group_id!)
    .filter(assetId => !Object.prototype.hasOwnProperty.call(assets, assetId));
  if (missingSlots.length > 0) return `missing required assets: ${missingSlots.join(', ')}`;
  for (const slot of requiredSlots) {
    const issue = requiredSlotIssue(assets[slot.asset_group_id!], slot);
    if (issue) return `invalid required asset: ${issue}`;
  }
  const requiredAssetIds = new Set(requiredSlots.map(slot => slot.asset_group_id!));

  for (const [key, value] of Object.entries(declaredParams)) {
    if (key === 'asset_source') continue;
    if (key === 'slots' && Array.isArray(value)) {
      continue;
    }
    if (key === 'max_file_size_mb' || key === 'max_file_size_kb') {
      const divisor = key.endsWith('_mb') ? 1_000_000 : 1_000;
      const limit = typeof value === 'number' ? value * divisor : undefined;
      const mediaAssetIds = new Set(effectiveSlots
        .filter(slot => ['image', 'video', 'audio'].includes(slot.asset_type ?? ''))
        .flatMap(slot => slot.asset_group_id ? [slot.asset_group_id] : []));
      const mediaAssets = manifestAssetRecords(manifest, mediaAssetIds);
      if (mediaAssets.some(asset => typeof asset.file_size_bytes !== 'number')) {
        return `missing required file_size_bytes for params.${key}`;
      }
      const oversized = mediaAssets.some(asset =>
        typeof asset.file_size_bytes === 'number' && limit !== undefined && asset.file_size_bytes > limit
      );
      if (oversized) return `assets exceed params.${key}=${JSON.stringify(value)}`;
      continue;
    }
    const received = manifestConstraintValue(manifest, key, requiredAssetIds);
    if (received === undefined) return `missing required params.${key}`;
    if (!constraintSatisfied(value, received, key)) {
      return `requires params.${key} compatible with ${JSON.stringify(value)}, not ${JSON.stringify(received)}`;
    }
  }
  return undefined;
}

function proxyManifestAssets(
  manifest: Record<string, unknown>,
  baseUrl: string,
  format: Format | undefined,
  principalId: string,
): Record<string, unknown> {
  const assets = manifest.assets;
  if (!assets || typeof assets !== 'object' || Array.isArray(assets)) return manifest;
  const canonical = format?.canonical as { kind?: string; slots_override?: CanonicalSlot[] } | undefined;
  const canonicalSlots = canonical?.slots_override ?? (canonical?.kind
    ? canonicalDefaultSlots(canonical.kind) as CanonicalSlot[]
    : []);
  const legacySlots = Array.isArray(format?.assets)
    ? format.assets as Array<{ asset_id?: string; asset_type?: string }>
    : [];
  const proxyableIds = new Set([
    ...canonicalSlots
      .filter(slot => ['image', 'video', 'audio'].includes(slot.asset_type ?? ''))
      .flatMap(slot => slot.asset_group_id ? [slot.asset_group_id] : []),
    ...legacySlots
      .filter(slot => ['image', 'video', 'audio'].includes(slot.asset_type ?? ''))
      .flatMap(slot => slot.asset_id ? [slot.asset_id] : []),
  ]);
  const scopeId = randomUUID();
  const proxiedAssets = Object.fromEntries(Object.entries(assets as Record<string, unknown>).map(([key, value]) => {
    const proxyOne = (candidate: unknown): unknown => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return candidate;
      const asset = candidate as Record<string, unknown>;
      const { proxy_url: _untrustedProxyUrl, ...cleanAsset } = asset;
      if (!proxyableIds.has(key)) return cleanAsset;
      if (typeof asset.url !== 'string') return cleanAsset;
      try {
        const url = new URL(asset.url);
        if (url.protocol !== 'https:' || url.username || url.password) return cleanAsset;
      } catch {
        return cleanAsset;
      }
      const token = randomUUID();
      if (!storePreviewAsset(token, asset.url, scopeId, principalId)) {
        throw new PreviewAssetCapacityError('Preview media proxy capacity is temporarily unavailable. Retry later.');
      }
      return { ...cleanAsset, proxy_url: `${baseUrl}/preview-assets/${token}` };
    };
    return [key, Array.isArray(value) ? value.map(proxyOne) : proxyOne(value)];
  }));
  return { ...manifest, assets: proxiedAssets };
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
    assertManifestCompatibleWithFormat(req.creative_manifest, selected, `Preview capability_id "${selector}"`);
    return selected;
  }

  const manifest = req.creative_manifest;
  const formatId = req.format_id || manifest.format_id as { id?: string } | undefined;
  if (formatId?.id) {
    const selected = formats.find(format => getFormatId(format).id === formatId.id);
    if (selected) {
      const selectedKind = (selected.canonical as { kind?: string } | undefined)?.kind;
      if (manifest.format_kind && selectedKind && manifest.format_kind !== selectedKind) {
        throw new PreviewFormatNotSupportedError(
          `Format "${formatId.id}" renders format_kind "${selectedKind}", not "${manifest.format_kind}".`,
        );
      }
      if (manifest.format_kind) {
        assertManifestCompatibleWithFormat(manifest, selected, `Format "${formatId.id}"`);
      }
    }
    return selected;
  }
  if (!manifest.format_kind) return undefined;

  const candidates = formats.filter(format =>
    (format.canonical as { kind?: string } | undefined)?.kind === manifest.format_kind
  );
  if (candidates.length === 0) {
    throw new PreviewFormatNotSupportedError(
      `No advertised preview capability matches canonical format_kind "${manifest.format_kind}".`,
    );
  }
  if (candidates.length === 1) {
    assertManifestCompatibleWithFormat(manifest, candidates[0], `Canonical format_kind "${manifest.format_kind}"`);
    return candidates[0];
  }

  const dimensions = manifestDimensions(manifest);
  if (dimensions.width !== undefined || dimensions.height !== undefined) {
    const exact = candidates.filter(format => {
      const declared = buildCreativeCapabilities([format])[0]?.format as { params?: Record<string, unknown> } | undefined;
      const params = declared?.params ?? {};
      return (dimensions.width === undefined || params.width === dimensions.width)
        && (dimensions.height === undefined || params.height === dimensions.height);
    });
    if (exact.length === 1) {
      assertManifestCompatibleWithFormat(manifest, exact[0], `Canonical format_kind "${manifest.format_kind}"`);
      return exact[0];
    }
  }

  const generic = candidates.filter(format => {
    const declared = buildCreativeCapabilities([format])[0]?.format as { params?: Record<string, unknown> } | undefined;
    return declared?.params?.width === undefined && declared?.params?.height === undefined;
  });
  if (generic.length === 1) {
    assertManifestCompatibleWithFormat(manifest, generic[0], `Canonical format_kind "${manifest.format_kind}"`);
    return generic[0];
  }
  throw new PreviewFormatNotSupportedError(
    `Canonical format_kind "${manifest.format_kind}" matches multiple preview capabilities; provide target_capability_id.`,
  );
}

function assertManifestCompatibleWithFormat(
  manifest: Record<string, unknown>,
  format: Format,
  label: string,
): void {
  const issue = manifestCompatibilityIssue(manifest, format);
  if (issue) throw new PreviewFormatNotSupportedError(`${label} is incompatible: ${issue}.`);
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
    code: err instanceof PreviewFormatNotSupportedError
      || err instanceof PreviewCreativeNotFoundError
      || err instanceof PreviewAssetCapacityError
      ? err.code
      : 'render_error',
    message: err instanceof Error ? err.message : fallback,
  };
}

function renderSinglePreview(
  req: PreviewRequest,
  formats: Format[],
  baseUrl: string,
  principalId: string,
): { previews: unknown[]; quality_used: 'draft' | 'production'; expires_at: string } {
  if (!req.creative_manifest) {
    throw new PreviewCreativeNotFoundError(`Creative "${req.creative_id ?? 'unknown'}" was not found in this agent's creative library.`);
  }
  const manifest = req.creative_manifest;
  const format = resolveCanonicalPreviewFormat(req, formats);
  const requestedFormatId = req.format_id ?? manifest.format_id as PreviewRequest['format_id'];

  // The renderer still consumes the catalog's internal template key. Keep that
  // projection private; the caller-facing manifest remains canonical.
  const renderManifest = proxyManifestAssets({
    ...manifest,
    ...(format && {
      format_id: {
        ...getFormatId(format),
        ...(requestedFormatId?.width !== undefined && { width: requestedFormatId.width }),
        ...(requestedFormatId?.height !== undefined && { height: requestedFormatId.height }),
        ...(requestedFormatId?.pixel_ratio !== undefined && { pixel_ratio: requestedFormatId.pixel_ratio }),
      },
    }),
  }, baseUrl, format, principalId);

  const inputs = req.inputs?.length
    ? req.inputs
    : [{ name: 'Default preview' }];

  const outputFormat = req.output_format || 'url';
  let expiresAt: Date = new Date(Date.now() + 60 * 60 * 1000);

  const previews = inputs.map(input => {
    const previewId = `prev_${randomUUID().slice(0, 12)}`;
    const rendered = renderPreviewWithMetadata(renderManifest, format);
    const html = rendered.html;

    const render: Record<string, unknown> = {
      render_id: `r_${randomUUID().slice(0, 8)}`,
      role: 'primary',
      renderer: rendered.renderer,
      dimensions: rendered.dimensions,
    };

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

  return {
    previews,
    quality_used: req.quality ?? 'production',
    expires_at: expiresAt.toISOString(),
  };
}

export function handlePreviewCreative(
  args: Record<string, unknown>,
  formats: Format[],
  baseUrl: string,
  principalId = 'in-process',
): Record<string, unknown> {
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
        const result = renderSinglePreview(withBatchDefaults(args, req), formats, baseUrl, principalId);
        const { quality_used, ...response } = result;
        return {
          success: true,
          creative_id: (req.creative_manifest?.creative_id as string) || req.creative_id || `batch_${i}`,
          quality_used,
          response,
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
    const result = renderSinglePreview(args as unknown as PreviewRequest, formats, baseUrl, principalId);
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

export function createCreativeAgentServer(agentBaseUrl: string, principalId = 'in-process') {
  const formats = buildReferenceFormats(agentBaseUrl);

  const handlers: Record<string, ToolHandler> = {
    get_adcp_capabilities: () => handleGetAdcpCapabilities(formats),
    list_creative_formats: (args) => handleListCreativeFormats(args, formats),
    preview_creative: (args) => handlePreviewCreative(args, formats, agentBaseUrl, principalId),
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
