/**
 * MCP tool definitions and AdCP task handlers for the training agent.
 *
 * Creates a per-request MCP Server with tools matching AdCP tasks.
 * Responses are deterministic — built from the product catalog and
 * session state, not from LLM calls.
 */

import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { canonicalize, PostgresTaskStore } from '@adcp/sdk';
import { canonicalTargetUri } from '@adcp/sdk/signing';
import {
  createProposalRefinementHandler,
  type ProposalRefinementScope,
  type ProposalRefinementStore,
  type ProposalSourceExpectation,
} from '@adcp/sdk/server';
import {
  canonicalFormatLegacyResolverFromCatalogSnapshots,
  canonicalFormatLegacyResolverFromRoutes,
  legacyRoutesForProduct,
  legacyFormatConverterFromCatalogSnapshots,
  projectCreativeForDelivery,
  projectV1ProductToV2,
  toCanonicalOnlyResponse,
  type CreativeFormatWireMode,
  type CanonicalFormatLegacyResolver,
  type CanonicalFormatLegacyRoute,
  type CanonicalFormatKind,
  type ProjectionCatalogSnapshot,
  type V2ProductFormatDeclaration,
} from '@adcp/sdk/v2/projection';
import { mergeSeedProductLegacy as mergeSeedProduct } from '@adcp/sdk/testing';
import { createLogger } from '../logger.js';
import { isPrivateHostname, normalizeExternalHostname, safeFetchAxiosLike } from '../utils/url-security.js';
import { GET_PRODUCTS_REJECTED_ADCP_VERSION, supportsGetProductsRejected, type TrainingContext, type CatalogProduct, type MediaBuyState, type MediaBuyAvailableActionState, type MediaBuyProductAllowedActionState, type PackageState, type SignalActivationState, type CreativeState, type CreativeManifest, type ToolArgs, type ListReference, type PackageTargeting, type AccountRef, type SessionState } from './types.js';
import {
  AccountRefValidationError,
  accountScopeFromRef,
  canonicalizeAccountRef,
} from './account-scope.js';
import { encodeOffsetCursor, decodeOffsetCursor } from './pagination.js';
import type {
  LegacyProduct as Product,
  Proposal,
  LegacyFormatID as FormatID,
  LegacyCreateMediaBuyRequest as CreateMediaBuyRequest,
  LegacyUpdateMediaBuyRequest as UpdateMediaBuyRequest,
  LegacyGetProductsRequest as GetProductsRequest,
  LegacyGetProductsResponse as GetProductsResponse,
  GetMediaBuysRequest,
  GetMediaBuyDeliveryRequest,
  LegacyListCreativeFormatsRequest as ListCreativeFormatsRequest,
  LegacySyncCreativesRequest as SyncCreativesRequest,
  LegacyListCreativesRequest as ListCreativesRequest,
  GetSignalsRequest,
  ActivateSignalRequest,
  GetCreativeDeliveryRequest,
  GetAdCPCapabilitiesRequest,
  LegacyListCreativesResponse as ListCreativesResponse,
  LegacyPreviewCreativeResponse as PreviewCreativeResponse,
  LegacyBuildCreativeResponse as BuildCreativeResponse,
  LegacyCreativeManifest as AdcpCreativeManifest,
  CanonicalProposal,
  ProposalPurchase,
  RefineProposalsRequest,
} from '@adcp/sdk';
import { CreativeAssetSchema, CreativeManifestSchema, GetProductsRequestSchema } from '@adcp/sdk/schemas';
import { verifyGovernedServiceAuthorization } from './governance-verify.js';
import { getCanonicalBase } from './canonical-base.js';
import {
  evaluateTrainingProposal,
  proposalCapabilitiesForProfile,
  type TrainingProposalPolicyContext,
} from './proposal-negotiation-profiles.js';

/** Escape HTML special characters to prevent injection in generated HTML responses. */
function escapeHtmlAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Build a structured MCP error response for tool calls (L3 error compliance). */
export function adcpError(code: string, opts: { message: string; details?: unknown; recovery?: string; field?: string; retry_after?: number }, context?: unknown, adcpVersion?: string) {
  const errorObj = { code, ...opts };
  const body = context !== undefined
    ? { adcp_error: errorObj, context }
    : { adcp_error: errorObj };
  if (adcpVersion) {
    (body as Record<string, unknown>).adcp_version = adcpVersion;
  }
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify(body) }],
    structuredContent: body,
  };
}

// Derive types from SDK request types that aren't re-exported from main entry
type InlineCreativeInput = {
  creative_id?: string;
  name?: string;
  format_id?: FormatID;
  format_kind?: string;
  format_option_ref?: Record<string, unknown>;
  assets?: Record<string, unknown>;
  manifest?: CreativeManifest;
};
type InlineCreativeIdentity =
  | { kind: 'canonical'; formatKind: CanonicalFormatKind; formatOptionRef?: Record<string, unknown> }
  | { kind: 'legacy'; formatId: FormatID; formatOptionRef?: Record<string, unknown> };
type ValidatedInlineCreative = {
  creative: InlineCreativeInput;
  creativeId: string;
  identity: InlineCreativeIdentity;
};
type PackageUpdate = NonNullable<UpdateMediaBuyRequest['packages']>[number];
type PackageUpdateExt = PackageUpdate & {
  canceled?: boolean;
  cancellation_reason?: string;
  targeting?: PackageTargeting;
  targeting_overlay?: PackageTargeting;
  creatives?: InlineCreativeInput[];
};
type Destination = NonNullable<ActivateSignalRequest['destinations']>[number];
type SignalFilters = NonNullable<GetSignalsRequest['filters']>;
type GetProductsRejectedResponse = {
  status: 'rejected';
  adcp_version: string;
  reason: string;
  suggestions?: string[];
  context?: Record<string, unknown>;
};
type GetProductsReadDirectives = {
  rejection?: { reason: string; suggestions?: string[] };
  staleDirective?: { tool: string; upstreamName?: string; createdAt: string };
};
type PricingOption = Product['pricing_options'][number];
type PricingStructure = 'fixed' | 'auction' | 'contingent';
type PricingOptionView = {
  pricing_option_id?: string;
  pricing_model?: string;
  currency?: string;
  fixed_price?: number;
  floor_price?: number;
  price_guidance?: { p50?: number };
  commission_rate?: number;
  event_source_id?: string;
  min_spend_per_package?: number;
};
type WholesaleFeedRequest = {
  account?: AccountRef;
  if_wholesale_feed_version?: string;
  if_pricing_version?: string;
  pagination?: { max_results?: number; cursor?: string };
};
type WholesaleFeedMeta = {
  wholesale_feed_version: string;
  pricing_version: string;
  cache_scope: 'public' | 'account';
};
type ValidateInputTarget = {
  kind: 'canonical' | 'product' | 'capability' | 'third_party_format';
  id: string;
};
type ValidateInputArgs = ToolArgs & {
  account?: AccountRef;
  brand?: { domain?: string; name?: string };
  manifest?: {
    format_kind?: string;
    format_id?: FormatID;
    format_option_ref?: Record<string, unknown>;
    assets?: Record<string, unknown>;
  };
  targets?: ValidateInputTarget[];
};
type ValidateInputViolation = {
  rule: string;
  field: string;
  expected?: unknown;
  predicted?: unknown;
  retry_with?: Record<string, unknown>;
};
type ValidateInputResult = {
  target: ValidateInputTarget;
  result_kind: 'validated_pass' | 'validated_fail' | 'unvalidatable_nondeterministic';
  violations?: ValidateInputViolation[];
};
type CanonicalSlot = {
  asset_group_id: string;
  asset_type: string;
  required?: boolean;
  min?: number;
  max?: number;
};

const PRODUCT_WHOLESALE_FEED_VERSION = 'training-products-feed-v1';
const PRODUCT_WHOLESALE_PRICING_VERSION = 'training-products-pricing-v1';
const SIGNAL_WHOLESALE_FEED_VERSION = 'training-signals-feed-v1';
const SIGNAL_WHOLESALE_PRICING_VERSION = 'training-signals-pricing-v1';
// The current SDK storyboard runner injects this fallback on get_signals even
// when the authored sample_request declares discovery_mode: "wholesale".
const SDK_STORYBOARD_FALLBACK_SIGNAL_SPEC = 'E2E fallback signal discovery';
const PRODUCT_WHOLESALE_FEED_WEBHOOK_EVENT_TYPES = [
  'product.created',
  'product.updated',
  'product.priced',
  'product.removed',
] as const;
const SIGNAL_WHOLESALE_FEED_WEBHOOK_EVENT_TYPES = [
  'signal.created',
  'signal.updated',
  'signal.priced',
  'signal.removed',
] as const;
const CANONICAL_FORMAT_SLOTS: Record<string, CanonicalSlot[]> = {
  image: [
    { asset_group_id: 'image_main', asset_type: 'image', required: true },
    { asset_group_id: 'headline', asset_type: 'text' },
    { asset_group_id: 'body_text', asset_type: 'text' },
    { asset_group_id: 'primary_text', asset_type: 'text' },
    { asset_group_id: 'cta', asset_type: 'text' },
    { asset_group_id: 'landing_page_url', asset_type: 'url' },
  ],
  html5: [
    { asset_group_id: 'html5_bundle', asset_type: 'zip', required: true },
    { asset_group_id: 'backup_image', asset_type: 'image' },
    { asset_group_id: 'landing_page_url', asset_type: 'url' },
  ],
  display_tag: [
    { asset_group_id: 'tag_url', asset_type: 'url', required: true },
    { asset_group_id: 'backup_image', asset_type: 'image' },
  ],
  image_carousel: [
    { asset_group_id: 'cards', asset_type: 'card', required: true, min: 2, max: 10 },
    { asset_group_id: 'primary_text', asset_type: 'text' },
    { asset_group_id: 'landing_page_url', asset_type: 'url' },
  ],
  video_hosted: [
    { asset_group_id: 'video_main', asset_type: 'video', required: true },
    { asset_group_id: 'headline', asset_type: 'text' },
    { asset_group_id: 'primary_text', asset_type: 'text' },
    { asset_group_id: 'cta', asset_type: 'text' },
    { asset_group_id: 'brand_name', asset_type: 'text' },
    { asset_group_id: 'companion_banner', asset_type: 'image' },
    { asset_group_id: 'landing_page_url', asset_type: 'url' },
  ],
  video_vast: [
    { asset_group_id: 'vast_tag', asset_type: 'vast', required: true },
    { asset_group_id: 'landing_page_url', asset_type: 'url' },
  ],
  audio_hosted: [
    { asset_group_id: 'audio_main', asset_type: 'audio', required: true },
    { asset_group_id: 'companion_image', asset_type: 'image' },
    { asset_group_id: 'brand_name', asset_type: 'text' },
    { asset_group_id: 'landing_page_url', asset_type: 'url' },
  ],
  audio_daast: [
    { asset_group_id: 'daast_tag', asset_type: 'daast', required: true },
    { asset_group_id: 'landing_page_url', asset_type: 'url' },
  ],
  sponsored_placement: [
    { asset_group_id: 'source_catalog', asset_type: 'catalog', required: true },
    { asset_group_id: 'hero_asset', asset_type: 'image' },
    { asset_group_id: 'landing_page_url', asset_type: 'url' },
  ],
  native_in_feed: [
    { asset_group_id: 'title', asset_type: 'text', required: true },
    { asset_group_id: 'body_text', asset_type: 'text' },
    { asset_group_id: 'main_image', asset_type: 'image' },
    { asset_group_id: 'icon', asset_type: 'image' },
    { asset_group_id: 'cta', asset_type: 'text' },
    { asset_group_id: 'advertiser_name', asset_type: 'text', required: true },
    { asset_group_id: 'sponsored_label', asset_type: 'text' },
    { asset_group_id: 'landing_page_url', asset_type: 'url', required: true },
    { asset_group_id: 'display_url', asset_type: 'text' },
    { asset_group_id: 'rating', asset_type: 'text' },
    { asset_group_id: 'price', asset_type: 'text' },
    { asset_group_id: 'impression_tracker', asset_type: 'pixel_tracker' },
    { asset_group_id: 'viewability_tracker', asset_type: 'pixel_tracker' },
    { asset_group_id: 'click_tracker', asset_type: 'pixel_tracker' },
  ],
  responsive_creative: [
    { asset_group_id: 'headlines', asset_type: 'text', required: true, min: 3, max: 15 },
    { asset_group_id: 'long_headlines', asset_type: 'text', min: 1, max: 5 },
    { asset_group_id: 'descriptions', asset_type: 'text', required: true, min: 2, max: 5 },
    { asset_group_id: 'images_landscape', asset_type: 'image', min: 1, max: 20 },
    { asset_group_id: 'images_square', asset_type: 'image', min: 1, max: 20 },
    { asset_group_id: 'images_vertical', asset_type: 'image', min: 1, max: 20 },
    { asset_group_id: 'video', asset_type: 'video', min: 0, max: 5 },
    { asset_group_id: 'logo', asset_type: 'image', required: true, min: 1, max: 5 },
    { asset_group_id: 'landing_page_url', asset_type: 'url', required: true },
  ],
  agent_placement: [
    { asset_group_id: 'offering_ref', asset_type: 'text' },
    { asset_group_id: 'landing_page_url', asset_type: 'url' },
  ],
};
const BUILD_CREATIVE_FORMAT_ALIASES: Record<string, string> = {
  display_300x250_generative: 'display_300x250',
  display_728x90_generative: 'display_728x90',
  display_320x50_generative: 'display_320x50',
  audio_30s: 'audio_spot',
  vast_30s: 'video_preroll',
};
const SUPPORTED_CANONICAL_BUILD_CAPABILITIES = [
  { capabilityId: 'training_image_generation', formatKind: 'image' },
  { capabilityId: 'audio_vo', formatKind: 'audio_hosted' },
] as const;
const MAX_VALIDATE_INPUT_TARGETS = 50;
const VALID_CANONICAL_FORMAT_KINDS = new Set([...Object.keys(CANONICAL_FORMAT_SLOTS), 'custom']);
const NONDETERMINISTIC_INCOMPATIBLE_SOURCES = new Set(['buyer_uploaded', 'publisher_host_recorded']);

type GetMediaBuysArgs = GetMediaBuysRequest & ToolArgs & {
  status_filter?: string[];
  include_history?: number;
  include_snapshot?: boolean;
  pagination?: { max_results?: number; cursor?: string };
};

type UpdateMediaBuyArgs = UpdateMediaBuyRequest & ToolArgs & {
  revision?: number;
  canceled?: boolean;
  cancellation_reason?: string;
  paused?: boolean;
  new_packages?: PackageInput[];
};

interface PackageInput {
  product_id: string;
  pricing_option_id: string;
  budget: number;
  bid_price?: number;
  impressions?: number;
  paused?: boolean;
  start_time?: string;
  end_time?: string;
  format_ids?: FormatID[];
  format_option_refs?: unknown[];
  format_kind?: string;
  params?: Record<string, unknown>;
  targeting?: PackageTargeting;
  targeting_overlay?: PackageTargeting;
  creative_assignments?: Array<{ creative_id?: string }>;
  creatives?: InlineCreativeInput[];
  context?: Record<string, unknown>;
  committed_metrics?: Array<{
    scope: 'standard' | 'vendor';
    metric_id: string;
    vendor?: { domain: string; brand_id?: string };
    qualifier?: Record<string, unknown>;
  }>;
}

interface CreativeAssignmentInput {
  creative_id: string;
  package_id: string;
  media_buy_id: string;
}

function collectInlineCreativeIds(
  rawCreatives: InlineCreativeInput[] | undefined,
  fieldPrefix: string,
): { creativeIds: string[]; validatedCreatives: ValidatedInlineCreative[]; errors: TaskError[] } {
  const creativeIds: string[] = [];
  const validatedCreatives: ValidatedInlineCreative[] = [];
  const errors: TaskError[] = [];
  if (!Array.isArray(rawCreatives)) return { creativeIds, validatedCreatives, errors };

  for (let i = 0; i < rawCreatives.length; i++) {
    const creativeId = rawCreatives[i]?.creative_id;
    if (!creativeId) {
      errors.push({
        code: 'VALIDATION_ERROR',
        message: `${fieldPrefix}[${i}].creative_id is required`,
        field: `${fieldPrefix}[${i}].creative_id`,
      });
      continue;
    }
    const identity = validatedCreativeIdentity(rawCreatives[i]);
    if (!identity.ok) {
      errors.push({
        code: 'VALIDATION_ERROR',
        message: `${fieldPrefix}[${i}] ${identity.message}`,
        field: `${fieldPrefix}[${i}]`,
      });
      continue;
    }
    creativeIds.push(creativeId);
    validatedCreatives.push({ creative: rawCreatives[i], creativeId, identity: identity.identity });
  }
  return { creativeIds, validatedCreatives, errors };
}

function persistInlineCreatives(
  session: SessionState,
  validatedCreatives: ValidatedInlineCreative[],
  accountRef: AccountRef | undefined,
  accountId: string | undefined,
  syncedAt: string,
) {
  for (const { creative, creativeId, identity } of validatedCreatives) {
    const existing = session.creatives.get(creativeId);
    const manifest = normalizedCreativeManifest(creative, existing, identity);
    session.creatives.set(creativeId, {
      creativeId,
      accountId: accountId ?? existing?.accountId,
      accountRef: accountRef ?? existing?.accountRef,
      ...(identity.kind === 'legacy'
        ? {
          formatId: identity.formatId,
          ...(identity.formatOptionRef && { formatOptionRef: identity.formatOptionRef }),
        }
        : {
          formatKind: identity.formatKind,
          ...(identity.formatOptionRef && { formatOptionRef: identity.formatOptionRef }),
        }),
      ...(manifest && { assets: manifest.assets }),
      name: creative.name ?? existing?.name,
      status: existing?.status ?? 'approved',
      syncedAt,
      manifest,
      pricingOptionId: existing?.pricingOptionId,
      purge: existing?.purge,
      webhookActivity: existing?.webhookActivity,
    });
  }
}

type CanonicalPackageFormat = Record<string, unknown> & {
  format_kind?: string;
  format_option_id?: string;
  publisher_domain?: string;
  params?: Record<string, unknown>;
  v1_format_ref?: FormatID[];
};

type IndexedLegacyDeclaration = {
  declaration: CanonicalPackageFormat;
  legacyFormat: FormatID;
};

type IndexedDeclarations = {
  stable: CanonicalPackageFormat[];
  legacyAlias: IndexedLegacyDeclaration[];
};
type ProductFormatOptionIndex = Map<string, IndexedDeclarations>;
type ProductFormatOptionIndexCache = WeakMap<Product, ProductFormatOptionIndex>;

type ConstraintRange = { minimum: number | null; maximum: number | null };
type DimensionRegion = {
  minimumWidth: number;
  maximumWidth: number;
  minimumHeight: number;
  maximumHeight: number;
};

function constraintRange(parameter: string, value: unknown): ConstraintRange | undefined {
  if (isRecord(value) && value.kind === 'range') {
    const minimum = value.min === null || typeof value.min === 'number' ? value.min : undefined;
    const maximum = value.max === null || typeof value.max === 'number' ? value.max : undefined;
    if (minimum !== undefined && maximum !== undefined) return { minimum, maximum };
  }
  if (parameter.endsWith('_range') && Array.isArray(value) && value.length === 2) {
    const [minimum, maximum] = value;
    if ((minimum === null || typeof minimum === 'number') && (maximum === null || typeof maximum === 'number')) {
      return { minimum, maximum };
    }
  }
  return undefined;
}

function rangeContains(baseline: ConstraintRange, narrower: ConstraintRange): boolean {
  return (baseline.minimum === null || (narrower.minimum !== null && narrower.minimum >= baseline.minimum))
    && (baseline.maximum === null || (narrower.maximum !== null && narrower.maximum <= baseline.maximum));
}

/** Directional comparison: `value` must be no broader than `baseline`. */
function valueNarrowsBaseline(parameter: string, value: unknown, baseline: unknown): boolean {
  if (baseline === undefined) return true;
  if (isRecord(baseline) && baseline.kind === 'exact') {
    return isDeepStrictEqual(value, baseline.value);
  }
  if (isRecord(baseline) && baseline.kind === 'set' && Array.isArray(baseline.values)) {
    const allowedValues = baseline.values as unknown[];
    const values = Array.isArray(value) ? value : [value];
    return values.every(entry => allowedValues.some(candidate => isDeepStrictEqual(entry, candidate)));
  }

  const baselineRange = constraintRange(parameter, baseline);
  if (baselineRange) {
    if (typeof value === 'number') {
      return (baselineRange.minimum === null || value >= baselineRange.minimum)
        && (baselineRange.maximum === null || value <= baselineRange.maximum);
    }
    const narrowerRange = constraintRange(parameter, value);
    return narrowerRange !== undefined && rangeContains(baselineRange, narrowerRange);
  }

  if (Array.isArray(baseline)) {
    const values = Array.isArray(value) ? value : [value];
    return values.every(entry => baseline.some(candidate => isDeepStrictEqual(entry, candidate)));
  }
  if (typeof value === 'number' && typeof baseline === 'number') {
    if (parameter.startsWith('max_') || parameter.endsWith('_max_chars')) return value <= baseline;
    if (parameter.startsWith('min_')) return value >= baseline;
  }
  return isDeepStrictEqual(value, baseline);
}

function durationParamsNarrowBaseline(
  narrower: Record<string, unknown>,
  baseline: Record<string, unknown>,
): boolean {
  const baselineExact = baseline.duration_ms_exact;
  const baselineRange = constraintRange('duration_ms_range', baseline.duration_ms_range);
  if (baselineExact === undefined && baselineRange === undefined) return true;

  const narrowerExact = narrower.duration_ms_exact;
  if (typeof narrowerExact === 'number') {
    if (typeof baselineExact === 'number') return narrowerExact === baselineExact;
    return baselineRange !== undefined
      && valueNarrowsBaseline('duration_ms_range', narrowerExact, baseline.duration_ms_range);
  }
  const narrowerRange = constraintRange('duration_ms_range', narrower.duration_ms_range);
  if (!narrowerRange) return false;
  if (typeof baselineExact === 'number') {
    return narrowerRange.minimum === baselineExact && narrowerRange.maximum === baselineExact;
  }
  return baselineRange !== undefined && rangeContains(baselineRange, narrowerRange);
}

function dimensionRegions(params: Record<string, unknown>): DimensionRegion[] {
  if (typeof params.width === 'number' && typeof params.height === 'number') {
    return [{
      minimumWidth: params.width,
      maximumWidth: params.width,
      minimumHeight: params.height,
      maximumHeight: params.height,
    }];
  }
  if (Array.isArray(params.sizes)) {
    const sizes = params.sizes.flatMap(size => isRecord(size)
      && typeof size.width === 'number'
      && typeof size.height === 'number'
      ? [{
          minimumWidth: size.width,
          maximumWidth: size.width,
          minimumHeight: size.height,
          maximumHeight: size.height,
        }]
      : []);
    if (sizes.length > 0) return sizes;
  }

  const hasResponsiveBounds = ['min_width', 'max_width', 'min_height', 'max_height']
    .some(parameter => typeof params[parameter] === 'number');
  if (!hasResponsiveBounds) return [];
  return [{
    minimumWidth: typeof params.min_width === 'number' ? params.min_width : Number.NEGATIVE_INFINITY,
    maximumWidth: typeof params.max_width === 'number' ? params.max_width : Number.POSITIVE_INFINITY,
    minimumHeight: typeof params.min_height === 'number' ? params.min_height : Number.NEGATIVE_INFINITY,
    maximumHeight: typeof params.max_height === 'number' ? params.max_height : Number.POSITIVE_INFINITY,
  }];
}

function dimensionRegionContains(baseline: DimensionRegion, narrower: DimensionRegion): boolean {
  return narrower.minimumWidth >= baseline.minimumWidth
    && narrower.maximumWidth <= baseline.maximumWidth
    && narrower.minimumHeight >= baseline.minimumHeight
    && narrower.maximumHeight <= baseline.maximumHeight;
}

function dimensionsNarrowBaseline(
  narrower: Record<string, unknown>,
  baseline: Record<string, unknown>,
  requireWhenBaselineConstrained: boolean,
): boolean {
  const baselineRegions = dimensionRegions(baseline);
  const narrowerRegions = dimensionRegions(narrower);
  if (narrowerRegions.length === 0) {
    return !requireWhenBaselineConstrained || baselineRegions.length === 0;
  }
  if (baselineRegions.length === 0) return true;
  return narrowerRegions.every(region =>
    baselineRegions.some(accepted => dimensionRegionContains(accepted, region))
  );
}

function directOptionSatisfiesSelector(
  option: CanonicalPackageFormat,
  selector: CanonicalPackageFormat,
): boolean {
  if (option.format_kind !== selector.format_kind) return false;
  const optionParams = isRecord(option.params) ? option.params : {};
  const selectorParams = isRecord(selector.params) ? selector.params : {};

  if (!dimensionsNarrowBaseline(selectorParams, optionParams, true)) return false;
  if (!durationParamsNarrowBaseline(selectorParams, optionParams)) return false;

  return Object.entries(selectorParams).every(([parameter, value]) => {
    if (parameter === 'duration_ms_exact' || parameter === 'duration_ms_range') return true;
    if (['width', 'height', 'sizes', 'min_width', 'max_width', 'min_height', 'max_height'].includes(parameter)) {
      return true;
    }
    return valueNarrowsBaseline(parameter, value, optionParams[parameter]);
  });
}

/** Normative one-way v2-narrows-v1 comparison for a projected legacy route. */
function canonicalOptionNarrowsLegacy(
  option: CanonicalPackageFormat,
  legacyProjection: CanonicalPackageFormat,
): boolean {
  if (option.format_kind !== legacyProjection.format_kind) return false;
  const optionParams = isRecord(option.params) ? option.params : {};
  const legacyParams = isRecord(legacyProjection.params) ? legacyProjection.params : {};
  if (!dimensionsNarrowBaseline(optionParams, legacyParams, false)) return false;
  if (
    (optionParams.duration_ms_exact !== undefined || optionParams.duration_ms_range !== undefined)
    && !durationParamsNarrowBaseline(optionParams, legacyParams)
  ) return false;
  return Object.entries(optionParams).every(([parameter, value]) => {
    if (parameter === 'duration_ms_exact' || parameter === 'duration_ms_range') return true;
    if (['width', 'height', 'sizes', 'min_width', 'max_width', 'min_height', 'max_height'].includes(parameter)) {
      return true;
    }
    return valueNarrowsBaseline(parameter, value, legacyParams[parameter]);
  });
}

function directSelectorResolution(
  pkg: PackageInput,
  product: Product,
  packageIndex: number,
): { selector?: CanonicalPackageFormat; selected: Set<number>; error?: TaskError } {
  if (typeof pkg.format_kind !== 'string') return { selected: new Set() };
  if (!VALID_CANONICAL_FORMAT_KINDS.has(pkg.format_kind)) {
    return {
      selected: new Set(),
      error: {
        code: 'UNSUPPORTED_FEATURE',
        message: `Package ${packageIndex}: format selector format_kind "${pkg.format_kind}" cannot be resolved`,
        field: `packages[${packageIndex}].format_kind`,
        recovery: 'correctable',
      },
    };
  }

  const requestParams = isRecord(pkg.params) ? pkg.params : {};
  if (
    pkg.format_kind === 'image'
    && (('width' in requestParams) !== ('height' in requestParams))
  ) {
    return {
      selected: new Set(),
      error: {
        code: 'INVALID_REQUEST',
        message: `Package ${packageIndex}: fixed-size image width and height must be provided together`,
        field: `packages[${packageIndex}].params`,
        recovery: 'correctable',
      },
    };
  }

  const selector: CanonicalPackageFormat = {
    format_kind: pkg.format_kind,
    params: requestParams,
  };
  const declarations = (Array.isArray(product.format_options) ? product.format_options : [])
    .filter(isRecord) as CanonicalPackageFormat[];
  const selected = new Set<number>();
  declarations.forEach((declaration, index) => {
    if (directOptionSatisfiesSelector(declaration, selector)) selected.add(index);
  });
  return { selector, selected };
}

function validateDirectCanonicalPackageSelector(pkg: PackageInput, product: Product, index: number): TaskError | undefined {
  if (typeof pkg.format_kind !== 'string') return undefined;
  const resolution = directSelectorResolution(pkg, product, index);
  if (resolution.error) return resolution.error;
  if (resolution.selected.size > 0) return undefined;

  const declarations = (Array.isArray(product.format_options) ? product.format_options : [])
    .filter(isRecord) as CanonicalPackageFormat[];
  const sameKind = declarations.filter(declaration => declaration.format_kind === pkg.format_kind);
  const requestParams = isRecord(pkg.params) ? pkg.params : {};
  const missingParams = [...new Set(sameKind.flatMap(declaration => {
    const params = isRecord(declaration.params) ? declaration.params : {};
    const required = dimensionRegions(params).length > 0 ? ['width/height dimensions'] : [];
    if ('duration_ms_exact' in params || 'duration_ms_range' in params) {
      required.push('duration_ms_exact or duration_ms_range');
    }
    return required.filter(key => {
      if (key === 'width/height dimensions') return dimensionRegions(requestParams).length === 0;
      if (key.includes(' or ')) {
        return !('duration_ms_exact' in requestParams) && !('duration_ms_range' in requestParams);
      }
      return !(key in requestParams);
    });
  }))];
  return {
    code: 'UNSUPPORTED_FEATURE',
    message: missingParams.length > 0
      ? `Package ${index}: format selector "${pkg.format_kind}" omits product-required params: ${missingParams.join(', ')}`
      : `Package ${index}: format selector "${pkg.format_kind}" params do not satisfy product ${pkg.product_id}`,
    field: missingParams.length > 0
      ? `packages[${index}].params`
      : `packages[${index}].format_kind`,
    details: {
      format_kind: pkg.format_kind,
      product_options: sameKind,
      received_params: requestParams,
    },
    recovery: 'correctable',
  };
}

function cloneCanonicalFormat(format: CanonicalPackageFormat): CanonicalPackageFormat {
  return JSON.parse(JSON.stringify(format)) as CanonicalPackageFormat;
}

function cloneLegacyFormatId(formatId: FormatID): FormatID {
  return JSON.parse(JSON.stringify(formatId)) as FormatID;
}

function migratedOptionIdForLegacyFormat(formatId: FormatID): string | undefined {
  const projected = projectV1ProductToV2({
    product_id: 'legacy_request_projection',
    name: 'Legacy request projection',
    description: 'Ephemeral compatibility projection',
    format_ids: [{
      ...formatId,
      agent_url: formatId.agent_url ?? 'https://creative.adcontextprotocol.org/',
    }],
  });
  return projected.v2.format_options?.[0]?.format_option_id;
}

function legacyFormatsByMigratedOption(legacyFormats: FormatID[]): Map<string, FormatID[]> {
  const indexed = new Map<string, FormatID[]>();
  for (const format of legacyFormats) {
    const optionId = migratedOptionIdForLegacyFormat(format);
    if (!optionId) continue;
    indexed.set(optionId, [...(indexed.get(optionId) ?? []), cloneLegacyFormatId(format)]);
  }
  return indexed;
}

function flattenedManifestAssets(manifest: CreativeManifest): Array<Record<string, unknown>> {
  return Object.values(manifest.assets ?? {}).flatMap(value => {
    const values = Array.isArray(value) ? value : [value];
    return values.filter(isRecord);
  });
}

export function canonicalParamsSatisfied(manifest: CreativeManifest, params: Record<string, unknown>): boolean {
  const assets = flattenedManifestAssets(manifest);
  const width = typeof params.width === 'number' ? params.width : undefined;
  const height = typeof params.height === 'number' ? params.height : undefined;
  if (width !== undefined || height !== undefined) {
    const matchesDimensions = assets.some(asset =>
      (width === undefined || asset.width === width)
      && (height === undefined || asset.height === height)
    );
    if (!matchesDimensions) return false;
  }

  const minWidth = typeof params.min_width === 'number' ? params.min_width : undefined;
  const maxWidth = typeof params.max_width === 'number' ? params.max_width : undefined;
  const minHeight = typeof params.min_height === 'number' ? params.min_height : undefined;
  const maxHeight = typeof params.max_height === 'number' ? params.max_height : undefined;
  if (minWidth !== undefined || maxWidth !== undefined || minHeight !== undefined || maxHeight !== undefined) {
    const matchesBounds = assets.some(asset => {
      if (typeof asset.width !== 'number' || typeof asset.height !== 'number') return false;
      return (minWidth === undefined || asset.width >= minWidth)
        && (maxWidth === undefined || asset.width <= maxWidth)
        && (minHeight === undefined || asset.height >= minHeight)
        && (maxHeight === undefined || asset.height <= maxHeight);
    });
    if (!matchesBounds) return false;
  }

  const durationExact = typeof params.duration_ms_exact === 'number' ? params.duration_ms_exact : undefined;
  if (durationExact !== undefined && !assets.some(asset => asset.duration_ms === durationExact)) return false;

  if (Array.isArray(params.duration_ms_range)) {
    const [minimum, maximum] = params.duration_ms_range;
    const matchesDuration = assets.some(asset => {
      const duration = asset.duration_ms;
      if (typeof duration !== 'number') return false;
      return (typeof minimum !== 'number' || duration >= minimum)
        && (typeof maximum !== 'number' || duration <= maximum);
    });
    if (!matchesDuration) return false;
  }

  if (typeof params.aspect_ratio === 'string') {
    const [ratioWidth, ratioHeight] = params.aspect_ratio.split(':').map(Number);
    if (!Number.isFinite(ratioWidth) || !Number.isFinite(ratioHeight) || ratioHeight === 0) return false;
    const expectedRatio = ratioWidth / ratioHeight;
    if (!assets.some(asset =>
      typeof asset.width === 'number'
      && typeof asset.height === 'number'
      && asset.height > 0
      && Math.abs(asset.width / asset.height - expectedRatio) < 0.01
    )) return false;
  }

  if (params.orientation === 'horizontal' || params.orientation === 'vertical' || params.orientation === 'square') {
    const matchesOrientation = assets.some(asset => {
      if (typeof asset.width !== 'number' || typeof asset.height !== 'number') return false;
      if (params.orientation === 'horizontal') return asset.width > asset.height;
      if (params.orientation === 'vertical') return asset.height > asset.width;
      return asset.width === asset.height;
    });
    if (!matchesOrientation) return false;
  }

  for (const [key, value] of Object.entries(params)) {
    if ((key !== 'sizes' && !key.endsWith('_sizes')) || !Array.isArray(value) || value.length === 0) continue;
    const allowedSizes = value.filter(isRecord);
    if (!assets.some(asset => allowedSizes.some(size => asset.width === size.width && asset.height === size.height))) {
      return false;
    }
  }

  // title_max_chars: the manifest's title asset content must not exceed the limit.
  if (typeof params.title_max_chars === 'number') {
    const rawTitle = (manifest.assets as Record<string, unknown>).title;
    const titleAsset = Array.isArray(rawTitle) ? rawTitle[0] : rawTitle;
    if (isRecord(titleAsset) && typeof titleAsset.content === 'string') {
      if (titleAsset.content.length > params.title_max_chars) return false;
    }
  }

  // min_cards / max_cards: count card assets in the manifest (carousel formats).
  if (typeof params.min_cards === 'number' || typeof params.max_cards === 'number') {
    const rawCards = (manifest.assets as Record<string, unknown>).cards;
    const cardCount = Array.isArray(rawCards) ? rawCards.length : (rawCards != null ? 1 : 0);
    if (typeof params.min_cards === 'number' && cardCount < params.min_cards) return false;
    if (typeof params.max_cards === 'number' && cardCount > params.max_cards) return false;
  }

  // image_formats: primary image asset url extension must match the allowed list.
  if (Array.isArray(params.image_formats) && params.image_formats.length > 0) {
    const allowedFmts = (params.image_formats as unknown[])
      .filter((format): format is string => typeof format === 'string')
      .map(format => format.startsWith('.') ? format.slice(1).toLowerCase() : format.toLowerCase());
    const rawImage = (manifest.assets as Record<string, unknown>).image;
    const imageAsset = Array.isArray(rawImage) ? rawImage[0] : rawImage;
    if (isRecord(imageAsset) && typeof imageAsset.url === 'string') {
      const withoutFragment = imageAsset.url.split('#', 1)[0] ?? '';
      const withoutQuery = withoutFragment.split('?', 1)[0] ?? '';
      const filename = withoutQuery.split('/').pop() ?? '';
      const finalDot = filename.lastIndexOf('.');
      const extension = finalDot >= 0 ? filename.slice(finalDot + 1).toLowerCase() : undefined;
      if (extension && !allowedFmts.includes(extension)) return false;
    }
  }

  // min_resolution_dpi: image asset must meet the minimum DPI when declared.
  if (typeof params.min_resolution_dpi === 'number') {
    const rawImage = (manifest.assets as Record<string, unknown>).image;
    const imageAsset = Array.isArray(rawImage) ? rawImage[0] : rawImage;
    if (isRecord(imageAsset) && typeof imageAsset.dpi === 'number') {
      if (imageAsset.dpi < params.min_resolution_dpi) return false;
    }
  }

  return true;
}

/** Resolve the package selector to an immutable canonical checklist. */
function snapshotPackageFormats(
  pkg: PackageInput,
  product: Product,
  packageIndex: number,
  optionIndexCache: ProductFormatOptionIndexCache,
): {
  formats?: CanonicalPackageFormat[];
  legacyFormatIds?: FormatID[];
  selectedLegacyFormatIds?: FormatID[];
  error?: TaskError;
} {
  const declarations = (Array.isArray(product.format_options) ? product.format_options : [])
    .filter(isRecord) as CanonicalPackageFormat[];
  const advertisedLegacyIds = Array.isArray(product.format_ids) ? product.format_ids : [];

  if (declarations.length === 0) {
    if (Array.isArray(pkg.format_option_refs) && pkg.format_option_refs.length > 0) {
      const selectedLegacyIds: FormatID[] = [];
      const legacyIdsByAlias = legacyFormatsByMigratedOption(advertisedLegacyIds);
      for (let i = 0; i < pkg.format_option_refs.length; i++) {
        const ref = pkg.format_option_refs[i];
        if (!isRecord(ref) || typeof ref.format_option_id !== 'string') {
          return {
            error: {
              code: 'UNSUPPORTED_FEATURE',
              message: `Package ${packageIndex}: format_option_refs[${i}] is not a resolvable legacy format option`,
              field: `packages[${packageIndex}].format_option_refs[${i}]`,
              recovery: 'correctable',
            },
          };
        }
        if (ref.scope !== 'product' || ref.publisher_domain !== undefined) {
          return {
            error: {
              code: 'UNSUPPORTED_FEATURE',
              message: `Package ${packageIndex}: legacy-only format option "${ref.format_option_id}" must use product scope`,
              field: `packages[${packageIndex}].format_option_refs[${i}]`,
              recovery: 'correctable',
            },
          };
        }
        const matches = legacyIdsByAlias.get(ref.format_option_id) ?? [];
        if (matches.length !== 1) {
          return {
            error: {
              code: 'UNSUPPORTED_FEATURE',
              message: `Package ${packageIndex}: format option "${ref.format_option_id}" is not an unambiguous legacy format advertised by product ${pkg.product_id}`,
              field: `packages[${packageIndex}].format_option_refs[${i}]`,
              recovery: 'correctable',
            },
          };
        }
        selectedLegacyIds.push(matches[0]!);
      }
      return {
        legacyFormatIds: Array.isArray(pkg.format_ids) && pkg.format_ids.length > 0
          ? pkg.format_ids.map(cloneLegacyFormatId)
          : selectedLegacyIds,
        selectedLegacyFormatIds: selectedLegacyIds,
      };
    }
    if (Array.isArray(pkg.format_ids) && pkg.format_ids.length > 0) {
      const unavailable = pkg.format_ids.filter(requested => !advertisedLegacyIds.some(advertised =>
        legacyFormatIdMatches(requested, advertised)
      ));
      if (unavailable.length > 0) {
        return {
          error: {
            code: 'UNSUPPORTED_FEATURE',
            message: `Package ${packageIndex}: deprecated format_ids are not advertised by product ${pkg.product_id}`,
            field: `packages[${packageIndex}].format_ids`,
            recovery: 'correctable',
          },
        };
      }
      return {
        legacyFormatIds: pkg.format_ids.map(cloneLegacyFormatId),
        selectedLegacyFormatIds: pkg.format_ids.map(cloneLegacyFormatId),
      };
    }
    return {};
  }

  if (Array.isArray(pkg.format_option_refs) && pkg.format_option_refs.length > 0) {
    let declarationsByOptionId = optionIndexCache.get(product);
    const shouldBuildIndex = declarationsByOptionId === undefined;
    if (!declarationsByOptionId) {
      declarationsByOptionId = new Map<string, IndexedDeclarations>();
      optionIndexCache.set(product, declarationsByOptionId);
    }
    const declarationsFor = (optionId: string): IndexedDeclarations => {
      const indexed = declarationsByOptionId.get(optionId) ?? { stable: [], legacyAlias: [] };
      declarationsByOptionId.set(optionId, indexed);
      return indexed;
    };
    if (shouldBuildIndex) {
      for (const declaration of declarations) {
        if (typeof declaration.format_option_id === 'string') {
          declarationsFor(declaration.format_option_id).stable.push(declaration);
        }
        for (const legacyRef of Array.isArray(declaration.v1_format_ref) ? declaration.v1_format_ref : []) {
          if (typeof legacyRef?.id !== 'string') continue;
          const migratedId = migratedOptionIdForLegacyFormat(legacyRef);
          if (typeof migratedId === 'string') {
            declarationsFor(migratedId).legacyAlias.push({
              declaration,
              legacyFormat: cloneLegacyFormatId(legacyRef),
            });
          }
        }
      }
    }

    const selected: CanonicalPackageFormat[] = [];
    const selectedSet = new Set<CanonicalPackageFormat>();
    const projectedLegacyIds: FormatID[] = [];
    for (let i = 0; i < pkg.format_option_refs.length; i++) {
      const ref = pkg.format_option_refs[i];
      if (!isRecord(ref) || typeof ref.format_option_id !== 'string') {
        return {
          error: {
            code: 'UNSUPPORTED_FEATURE',
            message: `Package ${packageIndex}: format_option_refs[${i}] is not a resolvable canonical format option`,
            field: `packages[${packageIndex}].format_option_refs[${i}]`,
            recovery: 'correctable',
          },
        };
      }
      const indexed = declarationsByOptionId.get(ref.format_option_id);
      const matchesScope = (declaration: CanonicalPackageFormat) => {
        if (ref.scope === 'publisher') {
          return typeof ref.publisher_domain === 'string'
            && declaration.publisher_domain === ref.publisher_domain;
        }
        if (ref.scope === 'product') return declaration.publisher_domain === undefined;
        return ref.publisher_domain === undefined
          || declaration.publisher_domain === ref.publisher_domain;
      };
      const scopedStable = (indexed?.stable ?? []).filter(matchesScope);
      const scopedLegacyAliases = (indexed?.legacyAlias ?? [])
        .filter(entry => matchesScope(entry.declaration));
      const scopedDeclarations = new Set([
        ...scopedStable,
        ...scopedLegacyAliases.map(entry => entry.declaration),
      ]);
      if (scopedStable.length && scopedLegacyAliases.length && scopedDeclarations.size > 1) {
        return {
          error: {
            code: 'UNSUPPORTED_FEATURE',
            message: `Package ${packageIndex}: format option "${ref.format_option_id}" collides with a migrated legacy alias`,
            field: `packages[${packageIndex}].format_option_refs[${i}]`,
            recovery: 'correctable',
          },
        };
      }
      const selectedByLegacyAlias = scopedStable.length === 0;
      const candidates = scopedStable.length
        ? scopedStable
        : [...new Set(scopedLegacyAliases.map(entry => entry.declaration))];
      if (candidates.length > 1) {
        return {
          error: {
            code: 'UNSUPPORTED_FEATURE',
            message: `Package ${packageIndex}: format option "${ref.format_option_id}" is ambiguous without a narrower scope`,
            field: `packages[${packageIndex}].format_option_refs[${i}]`,
            recovery: 'correctable',
          },
        };
      }
      const matches = candidates.slice(0, 1);
      if (matches.length === 0) {
        return {
          error: {
            code: 'UNSUPPORTED_FEATURE',
            message: `Package ${packageIndex}: format option "${ref.format_option_id}" is not declared by product ${pkg.product_id}`,
            field: `packages[${packageIndex}].format_option_refs[${i}]`,
            recovery: 'correctable',
          },
        };
      }
      for (const match of matches) {
        if (selectedByLegacyAlias) {
          projectedLegacyIds.push(...scopedLegacyAliases
            .filter(entry => entry.declaration === match)
            .map(entry => cloneLegacyFormatId(entry.legacyFormat)));
        }
        if (selectedSet.has(match)) continue;
        selectedSet.add(match);
        selected.push(cloneCanonicalFormat(match));
      }
    }
    return {
      formats: selected,
      ...(projectedLegacyIds.length > 0 && {
        selectedLegacyFormatIds: projectedLegacyIds.map(cloneLegacyFormatId),
      }),
      ...((Array.isArray(pkg.format_ids) && pkg.format_ids.length > 0)
        ? { legacyFormatIds: pkg.format_ids.map(cloneLegacyFormatId) }
        : projectedLegacyIds.length > 0
          ? { legacyFormatIds: projectedLegacyIds }
          : {}),
    };
  }

  if (Array.isArray(pkg.format_ids) && pkg.format_ids.length > 0 && typeof pkg.format_kind !== 'string') {
    const selected = declarations.filter(declaration => {
      const legacyRefs = Array.isArray(declaration.v1_format_ref) ? declaration.v1_format_ref : [];
      return pkg.format_ids!.some(requested => legacyRefs.some(ref =>
        ref && legacyFormatIdMatches(requested, ref)
      ));
    });
    const unavailable = pkg.format_ids.filter(requested => !advertisedLegacyIds.some(advertised =>
      legacyFormatIdMatches(requested, advertised)
    ));
    if (unavailable.length > 0) {
      return {
        error: {
          code: 'UNSUPPORTED_FEATURE',
          message: `Package ${packageIndex}: deprecated format_ids are not advertised by product ${pkg.product_id}`,
          field: `packages[${packageIndex}].format_ids`,
          recovery: 'correctable',
        },
      };
    }
    // A legacy product may advertise a named format whose canonical kind is
    // intentionally non-equivalent (`canonical_formats_only`). Validate and
    // accept that independent legacy selector above, but do not fabricate a
    // canonical declaration for formats_to_provide.
    return {
      formats: selected.map(cloneCanonicalFormat),
      legacyFormatIds: pkg.format_ids.map(cloneLegacyFormatId),
      selectedLegacyFormatIds: pkg.format_ids.map(cloneLegacyFormatId),
    };
  }

  if (typeof pkg.format_kind === 'string') {
    return {
      formats: [{
        format_kind: pkg.format_kind,
        params: isRecord(pkg.params)
          ? JSON.parse(JSON.stringify(pkg.params)) as Record<string, unknown>
          : {},
      }],
      ...(Array.isArray(pkg.format_ids) && pkg.format_ids.length > 0 && {
        legacyFormatIds: pkg.format_ids.map(cloneLegacyFormatId),
        selectedLegacyFormatIds: pkg.format_ids.map(cloneLegacyFormatId),
      }),
    };
  }

  // Omitting selectors means every product format option is active.
  return { formats: declarations.map(cloneCanonicalFormat) };
}

function canonicalFormatIdentifierUrl(raw: string): string | undefined {
  try {
    return canonicalTargetUri(raw);
  } catch {
    return undefined;
  }
}

function legacyFormatVariant(format: FormatID): [unknown, unknown, unknown, unknown] {
  const record = format as unknown as Record<string, unknown>;
  const hasDimensions = typeof record.width === 'number' && typeof record.height === 'number';
  return [
    record.width ?? null,
    record.height ?? null,
    record.duration_ms ?? null,
    hasDimensions ? (record.pixel_ratio ?? 1) : null,
  ];
}

function legacyFormatIdMatches(left: FormatID, right: FormatID): boolean {
  if (left.id !== right.id || !isDeepStrictEqual(legacyFormatVariant(left), legacyFormatVariant(right))) {
    return false;
  }
  if (left.agent_url === undefined || right.agent_url === undefined) return true;
  const leftUrl = canonicalFormatIdentifierUrl(left.agent_url);
  const rightUrl = canonicalFormatIdentifierUrl(right.agent_url);
  return leftUrl !== undefined && rightUrl !== undefined && leftUrl === rightUrl;
}

function legacyFormatIdKey(format: FormatID): string {
  const agentUrl = format.agent_url ? canonicalFormatIdentifierUrl(format.agent_url) : '';
  return JSON.stringify([agentUrl ?? `invalid:${format.agent_url}`, format.id, ...legacyFormatVariant(format)]);
}

function selectedProductOptionsForFormats(
  formats: CanonicalPackageFormat[],
  productDeclarations: CanonicalPackageFormat[],
): Set<number> {
  const selected = new Set<number>();
  for (const format of formats) {
    const index = productDeclarations.findIndex(declaration => isDeepStrictEqual(declaration, format));
    if (index >= 0) selected.add(index);
  }
  return selected;
}

function legacySelectorResolution(
  pkg: PackageInput,
  product: Product,
  packageIndex: number,
): {
  selected: Set<number>;
  unmatchedEntries: number[];
  projectedSelectors: CanonicalPackageFormat[];
  error?: TaskError;
} {
  const requested = Array.isArray(pkg.format_ids) ? pkg.format_ids : [];
  const declarations = (Array.isArray(product.format_options) ? product.format_options : [])
    .filter(isRecord) as CanonicalPackageFormat[];
  const selected = new Set<number>();
  const unmatchedEntries: number[] = [];
  const projectedSelectors: CanonicalPackageFormat[] = [];

  for (let i = 0; i < requested.length; i++) {
    const legacy = requested[i]!;
    const linkedIndexes = declarations.flatMap((declaration, declarationIndex) => {
      const refs = Array.isArray(declaration.v1_format_ref) ? declaration.v1_format_ref : [];
      return refs.some(ref => legacyFormatIdMatches(legacy, ref)) ? [declarationIndex] : [];
    });
    const projected = projectV1ProductToV2({
      product_id: `package_${packageIndex}_legacy_${i}`,
      name: 'Package legacy selector projection',
      description: 'Ephemeral package selector compatibility projection',
      format_ids: [{
        ...legacy,
        agent_url: legacy.agent_url ?? 'https://creative.adcontextprotocol.org/',
      }],
    }).v2.format_options?.filter(isRecord) as CanonicalPackageFormat[] | undefined;
    if (!projected?.length && linkedIndexes.length === 0) {
      return {
        selected,
        unmatchedEntries,
        projectedSelectors,
        error: {
          code: 'UNSUPPORTED_FEATURE',
          message: `Package ${packageIndex}: format_ids[${i}] cannot be normalized through the canonical mapping path`,
          field: `packages[${packageIndex}].format_ids[${i}]`,
          recovery: 'correctable',
        },
      };
    }
    if (projected?.length) projectedSelectors.push(...projected);

    // Seller-authored v1_format_ref links are authoritative for custom IDs,
    // but registry-backed links must still agree dimensionally with the
    // canonical declaration they name.
    const candidateIndexes = linkedIndexes.length > 0
      ? linkedIndexes
      : declarations.map((_, declarationIndex) => declarationIndex);
    const matchedIndexes = candidateIndexes.filter(declarationIndex => {
      if (!projected?.length) return true;
      return projected.some(selector => canonicalOptionNarrowsLegacy(declarations[declarationIndex]!, selector));
    });
    if (matchedIndexes.length === 0) {
      unmatchedEntries.push(i);
    } else {
      matchedIndexes.forEach(declarationIndex => {
        selected.add(declarationIndex);
      });
    }
  }
  return { selected, unmatchedEntries, projectedSelectors };
}

function sameNumberSet(left: Set<number>, right: Set<number>): boolean {
  return left.size === right.size && [...left].every(value => right.has(value));
}

function validatePackageSelectorCompatibility(
  pkg: PackageInput,
  product: Product,
  packageIndex: number,
  optionIndexCache: ProductFormatOptionIndexCache,
): TaskError | undefined {
  const hasOptions = Array.isArray(pkg.format_option_refs) && pkg.format_option_refs.length > 0;
  const hasDirect = typeof pkg.format_kind === 'string';
  const hasLegacy = Array.isArray(pkg.format_ids) && pkg.format_ids.length > 0;
  const routeCount = Number(hasOptions) + Number(hasDirect) + Number(hasLegacy);
  if (routeCount === 0) return undefined;

  const declarations = (Array.isArray(product.format_options) ? product.format_options : [])
    .filter(isRecord) as CanonicalPackageFormat[];

  // Preserve the legacy-only 3.x path. An advertised named format may be
  // intentionally non-projectable; equivalence is required only when another
  // route is co-present. The SDK can also surface a legacy-only request as a
  // temporary migrated option ref when the product has no canonical options.
  if (routeCount === 1 && hasLegacy) {
    return snapshotPackageFormats(pkg, product, packageIndex, optionIndexCache).error;
  }
  if (routeCount === 1 && hasOptions && declarations.length === 0) {
    return snapshotPackageFormats(pkg, product, packageIndex, optionIndexCache).error;
  }

  if (declarations.length === 0 && hasOptions && hasLegacy && !hasDirect) {
    const optionSnapshot = snapshotPackageFormats({ ...pkg, format_ids: undefined }, product, packageIndex, optionIndexCache);
    if (optionSnapshot.error) return optionSnapshot.error;
    const legacySnapshot = snapshotPackageFormats({ ...pkg, format_option_refs: undefined }, product, packageIndex, optionIndexCache);
    if (legacySnapshot.error) return legacySnapshot.error;
    const optionSet = new Set((optionSnapshot.selectedLegacyFormatIds ?? []).map(legacyFormatIdKey));
    const legacySet = new Set((legacySnapshot.selectedLegacyFormatIds ?? []).map(legacyFormatIdKey));
    if (optionSet.size > 0 && optionSet.size === legacySet.size && [...optionSet].every(key => legacySet.has(key))) {
      return undefined;
    }
    return {
      code: 'CONFLICTING_SELECTORS',
      message: `Package ${packageIndex}: co-present legacy compatibility selector routes select different product formats`,
      field: `packages[${packageIndex}]`,
      recovery: 'correctable',
    };
  }

  const routes: Array<{ name: string; selected: Set<number>; unmatchedEntries?: number[] }> = [];
  let directSelector: CanonicalPackageFormat | undefined;
  let legacyProjectedSelectors: CanonicalPackageFormat[] = [];

  if (hasOptions) {
    const optionSnapshot = snapshotPackageFormats({
      ...pkg,
      format_kind: undefined,
      params: undefined,
      format_ids: undefined,
    }, product, packageIndex, optionIndexCache);
    if (optionSnapshot.error) return optionSnapshot.error;
    routes.push({
      name: 'format_option_refs',
      selected: selectedProductOptionsForFormats(optionSnapshot.formats ?? [], declarations),
    });
  }

  if (hasDirect) {
    const direct = directSelectorResolution(pkg, product, packageIndex);
    if (direct.error) return direct.error;
    directSelector = direct.selector;
    routes.push({ name: 'format_kind', selected: direct.selected });
  }

  if (hasLegacy) {
    const legacy = legacySelectorResolution(pkg, product, packageIndex);
    if (legacy.error) return legacy.error;
    legacyProjectedSelectors = legacy.projectedSelectors;
    routes.push({ name: 'format_ids', selected: legacy.selected, unmatchedEntries: legacy.unmatchedEntries });
  }

  if (routes.length === 1) {
    if (routes[0]!.selected.size > 0) return undefined;
    if (hasDirect) return validateDirectCanonicalPackageSelector(pkg, product, packageIndex);
    return {
      code: 'UNSUPPORTED_FEATURE',
      message: `Package ${packageIndex}: ${routes[0]!.name} resolves but does not satisfy product ${pkg.product_id}`,
      field: `packages[${packageIndex}].${routes[0]!.name}`,
      recovery: 'correctable',
    };
  }

  const expected = routes[0]!.selected;
  const allRoutesUnsatisfied = routes.every(route => route.selected.size === 0);
  const equivalentUnsatisfiedDirectLegacy = !hasOptions
    && allRoutesUnsatisfied
    && directSelector !== undefined
    && legacyProjectedSelectors.length > 0
    && legacyProjectedSelectors.every(projected => directOptionSatisfiesSelector(projected, directSelector!));
  if ((!equivalentUnsatisfiedDirectLegacy && routes.some(route => route.unmatchedEntries?.length))
    || routes.slice(1).some(route => !sameNumberSet(expected, route.selected))) {
    return {
      code: 'CONFLICTING_SELECTORS',
      message: `Package ${packageIndex}: co-present format selector routes select different product format options`,
      field: `packages[${packageIndex}]`,
      details: {
        routes: routes.map(route => ({
          selector: route.name,
          selected_format_option_ids: [...route.selected].map(index =>
            declarations[index]?.format_option_id ?? `product.format_options[${index}]`
          ),
          ...(route.unmatchedEntries?.length && { unmatched_selector_indexes: route.unmatchedEntries }),
        })),
      },
      recovery: 'correctable',
    };
  }

  if (expected.size === 0) {
    return {
      code: 'UNSUPPORTED_FEATURE',
      message: `Package ${packageIndex}: resolved format selectors do not satisfy product ${pkg.product_id}`,
      field: `packages[${packageIndex}]`,
      recovery: 'correctable',
    };
  }
  return undefined;
}

function packageFormatSelectorForState(
  pkg: PackageInput,
  formats: CanonicalPackageFormat[] | undefined,
  legacyFormatIds: FormatID[] | undefined,
  selectedLegacyFormatIds: FormatID[] | undefined,
): Pick<PackageState, 'formatIds' | 'formatOptionRefs' | 'formatKind' | 'selectedLegacyFormatIds'> {
  const selector: Pick<PackageState, 'formatIds' | 'formatOptionRefs' | 'formatKind' | 'selectedLegacyFormatIds'> = {};
  if (typeof pkg.format_kind === 'string') selector.formatKind = pkg.format_kind;
  if (legacyFormatIds?.length) selector.formatIds = legacyFormatIds.map(cloneLegacyFormatId);
  if (selectedLegacyFormatIds?.length) {
    selector.selectedLegacyFormatIds = selectedLegacyFormatIds.map(cloneLegacyFormatId);
  }
  if (
    (Array.isArray(pkg.format_option_refs) && pkg.format_option_refs.length > 0)
    || (Array.isArray(pkg.format_ids) && pkg.format_ids.length > 0)
  ) {
    const canonicalRefs = (formats ?? []).flatMap(format => {
      if (typeof format.format_option_id !== 'string') return [];
      return [typeof format.publisher_domain === 'string'
        ? {
          scope: 'publisher',
          publisher_domain: format.publisher_domain,
          format_option_id: format.format_option_id,
        }
        : { scope: 'product', format_option_id: format.format_option_id }];
    });
    if (formats?.length && canonicalRefs.length === formats.length) {
      // A legacy request selected concrete canonical declarations. Persist
      // their stable canonical refs; the SDK facade re-projects them for a
      // legacy caller from formats_to_provide[].v1_format_ref.
      selector.formatOptionRefs = canonicalRefs;
      return selector;
    }
  }
  if (selector.formatIds) {
    // The SDK canonical facade represents a recognized legacy-only selector
    // as a temporary migrated option ref. Retain the reversible legacy tuple,
    // never the facade-local alias, when the product has no canonical option.
    return selector;
  }
  if (Array.isArray(pkg.format_option_refs) && pkg.format_option_refs.length > 0) {
    selector.formatOptionRefs = pkg.format_option_refs;
    return selector;
  }
  if (!selector.formatIds && Array.isArray(pkg.format_ids) && pkg.format_ids.length > 0) {
    // Truly legacy-only products have no canonical declaration to retain.
    selector.formatIds = pkg.format_ids.map(cloneLegacyFormatId);
  }
  return selector;
}

function packageFormatSelectorForWire(pkg: PackageState, ctx: TrainingContext): Record<string, unknown> {
  return {
    ...(pkg.formatIds && { format_ids: pkg.formatIds }),
    ...(pkg.formatOptionRefs && { format_option_refs: pkg.formatOptionRefs }),
    ...(pkg.formatKind && { format_kind: pkg.formatKind }),
    ...(pkg.params && { params: pkg.params }),
    ...(ctx.tenantId === 'sales' && pkg.selectedLegacyFormatIds?.length && {
      __selected_legacy_format_ids: pkg.selectedLegacyFormatIds,
    }),
  };
}

function creativeCoversPackageFormat(
  creative: CreativeState | undefined,
  requirement: CanonicalPackageFormat,
  sameKindRequirementCount: number,
): boolean {
  if (!creative) return false;
  const creativeKind = creative.formatKind ?? creative.manifest?.format_kind;
  const requiredKind = requirement.format_kind;

  const legacyRefs = Array.isArray(requirement.v1_format_ref) ? requirement.v1_format_ref : [];
  if (creative.formatId && legacyRefs.some(ref => ref?.id === creative.formatId?.id
    && (!ref.agent_url || !creative.formatId?.agent_url || ref.agent_url === creative.formatId.agent_url))) {
    return true;
  }
  if (!requiredKind || creativeKind !== requiredKind) return false;

  const requiredOptionId = requirement.format_option_id;
  const ref = creative.formatOptionRef ?? creative.manifest?.format_option_ref;
  if (requiredOptionId && isRecord(ref)) {
    if (ref.format_option_id !== requiredOptionId) return false;
    return !requirement.publisher_domain || ref.publisher_domain === requirement.publisher_domain;
  }
  if (requiredOptionId && sameKindRequirementCount > 1) return false;

  // An explicit option reference is the strongest coverage proof. Portable
  // manifests may omit it, so for an unambiguous kind fall back to validating
  // the actual manifest slots against the frozen package declaration.
  const manifest = creative.manifest;
  if (!manifest) return !requiredOptionId && !requirement.params;
  const params = isRecord(requirement.params) ? requirement.params : {};
  const slots = normalizeCanonicalSlots(requirement.slots)
    ?? normalizeCanonicalSlots(params.slots)
    ?? CANONICAL_FORMAT_SLOTS[requiredKind ?? '']
    ?? [];
  return validateManifestSlots(manifest, slots).length === 0
    && canonicalParamsSatisfied(manifest, params);
}

function formatsPendingForPackage(pkg: PackageState, session: SessionState): CanonicalPackageFormat[] {
  const requirements = (pkg.formatsToProvide ?? []) as CanonicalPackageFormat[];
  if (requirements.length === 0) return [];
  return requirements.filter(requirement => {
    const sameKindCount = requirements.filter(other => other.format_kind === requirement.format_kind).length;
    return !pkg.creativeAssignments.some(creativeId =>
      creativeCoversPackageFormat(session.creatives.get(creativeId), requirement, sameKindCount)
    );
  });
}

function packageNeedsCreative(pkg: PackageState, session: SessionState): boolean {
  if (pkg.canceled) return false;
  if (pkg.formatsToProvide?.length) return formatsPendingForPackage(pkg, session).length > 0;
  return pkg.creativeAssignments.length === 0;
}

function packageReadinessFields(pkg: PackageState, session: SessionState): Record<string, unknown> {
  if (!pkg.formatsToProvide?.length) return {};
  return {
    formats_to_provide: pkg.formatsToProvide,
    formats_pending: formatsPendingForPackage(pkg, session),
  };
}

const MAX_URL_LEN = 2048;
const MAX_ID_LEN = 256;
const MAX_TOKEN_LEN = 4096;

function validateListRef(ref: unknown, pathLabel: string): { ref?: ListReference; error?: TaskError } {
  if (ref === undefined || ref === null) return {};
  if (typeof ref !== 'object' || Array.isArray(ref)) {
    return { error: { code: 'VALIDATION_ERROR', message: `${pathLabel}: must be an object with agent_url and list_id`, field: pathLabel } };
  }
  const r = ref as Record<string, unknown>;
  const agent_url = r.agent_url;
  const list_id = r.list_id;
  const auth_token = r.auth_token;
  if (typeof agent_url !== 'string' || agent_url.length === 0 || agent_url.length > MAX_URL_LEN) {
    return { error: { code: 'VALIDATION_ERROR', message: `${pathLabel}.agent_url: must be a non-empty string up to ${MAX_URL_LEN} chars`, field: `${pathLabel}.agent_url` } };
  }
  if (!/^https?:\/\//i.test(agent_url)) {
    return { error: { code: 'VALIDATION_ERROR', message: `${pathLabel}.agent_url: must use http:// or https://`, field: `${pathLabel}.agent_url` } };
  }
  if (typeof list_id !== 'string' || list_id.length === 0 || list_id.length > MAX_ID_LEN) {
    return { error: { code: 'VALIDATION_ERROR', message: `${pathLabel}.list_id: must be a non-empty string up to ${MAX_ID_LEN} chars`, field: `${pathLabel}.list_id` } };
  }
  if (auth_token !== undefined && (typeof auth_token !== 'string' || auth_token.length > MAX_TOKEN_LEN)) {
    return { error: { code: 'VALIDATION_ERROR', message: `${pathLabel}.auth_token: must be a string up to ${MAX_TOKEN_LEN} chars`, field: `${pathLabel}.auth_token` } };
  }
  return { ref: { agent_url, list_id, ...(typeof auth_token === 'string' && { auth_token }) } };
}

function validateTargeting(t: unknown, pathLabel: string): { targeting?: PackageTargeting; errors: TaskError[] } {
  if (t === undefined || t === null) return { errors: [] };
  if (typeof t !== 'object' || Array.isArray(t)) {
    return { errors: [{ code: 'VALIDATION_ERROR', message: `${pathLabel}: must be an object`, field: pathLabel }] };
  }
  const src = t as Record<string, unknown>;
  const errors: TaskError[] = [];
  const pl = validateListRef(src.property_list, `${pathLabel}.property_list`);
  const ple = validateListRef(src.property_list_exclude, `${pathLabel}.property_list_exclude`);
  const cl = validateListRef(src.collection_list, `${pathLabel}.collection_list`);
  const cle = validateListRef(src.collection_list_exclude, `${pathLabel}.collection_list_exclude`);
  const validateAudienceIds = (value: unknown, field: string): string[] | undefined => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) {
      errors.push({ code: 'VALIDATION_ERROR', message: `${pathLabel}.${field}: must be an array of audience IDs`, field: `${pathLabel}.${field}` });
      return undefined;
    }
    const ids: string[] = [];
    for (let i = 0; i < value.length; i++) {
      if (typeof value[i] !== 'string' || value[i].length === 0) {
        errors.push({ code: 'VALIDATION_ERROR', message: `${pathLabel}.${field}[${i}]: must be a non-empty audience ID`, field: `${pathLabel}.${field}[${i}]` });
      } else {
        ids.push(value[i]);
      }
    }
    return ids;
  };
  const audienceInclude = validateAudienceIds(src.audience_include, 'audience_include');
  const audienceExclude = validateAudienceIds(src.audience_exclude, 'audience_exclude');
  if (pl.error) errors.push(pl.error);
  if (ple.error) errors.push(ple.error);
  if (cl.error) errors.push(cl.error);
  if (cle.error) errors.push(cle.error);
  if (errors.length) return { errors };
  if (Object.keys(src).length === 0) return { errors: [] };
  return {
    targeting: {
      ...structuredClone(src),
      ...(pl.ref && { property_list: pl.ref }),
      ...(ple.ref && { property_list_exclude: ple.ref }),
      ...(cl.ref && { collection_list: cl.ref }),
      ...(cle.ref && { collection_list_exclude: cle.ref }),
      ...(audienceInclude && { audience_include: audienceInclude }),
      ...(audienceExclude && { audience_exclude: audienceExclude }),
    },
    errors: [],
  };
}

function targetingForWire(targeting: PackageTargeting): PackageTargeting {
  const outward = structuredClone(targeting) as unknown as Record<string, unknown>;
  for (const field of [
    'property_list',
    'property_list_exclude',
    'collection_list',
    'collection_list_exclude',
  ]) {
    const reference = outward[field];
    if (isRecord(reference)) delete reference.auth_token;
  }
  return outward as unknown as PackageTargeting;
}

interface VendorMetricRefView {
  vendor?: { domain?: unknown; brand_id?: unknown };
  metric_id?: unknown;
  supported_targets?: unknown;
  scope?: unknown;
}

interface CommittedMetricProposalView extends VendorMetricRefView {
  scope?: 'standard' | 'vendor';
  metric_id?: string;
  vendor?: { domain?: string; brand_id?: string };
  qualifier?: Record<string, unknown>;
  committed_at?: string;
}

interface VendorMetricOptimizationView {
  supported_metrics?: VendorMetricRefView[];
}

interface ReportingCapabilitiesView {
  vendor_metrics?: VendorMetricRefView[];
  available_metrics?: string[];
}

interface MeasurementCatalogView {
  vendor?: { domain?: unknown; brand_id?: unknown };
  metrics?: Array<{ metric_id?: unknown }>;
}

function vendorMetricKey(entry: VendorMetricRefView | undefined): string | null {
  const domain = entry?.vendor?.domain;
  const metricId = entry?.metric_id;
  if (typeof domain !== 'string' || domain.length === 0 || typeof metricId !== 'string' || metricId.length === 0) {
    return null;
  }
  const brandId = typeof entry?.vendor?.brand_id === 'string' ? entry.vendor.brand_id : '';
  return `${domain.toLowerCase()}|${brandId}|${metricId}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function committedMetricKey(entry: CommittedMetricProposalView): string | null {
  if (entry.scope === 'vendor') {
    const vendorKey = vendorMetricKey(entry);
    return vendorKey ? `vendor|${vendorKey}` : null;
  }
  if (entry.scope !== 'standard' || typeof entry.metric_id !== 'string' || entry.metric_id.length === 0) return null;
  return `standard|${entry.metric_id}|${canonicalJson(entry.qualifier ?? {})}`;
}

function validateCommittedMetricProposals(
  metrics: CommittedMetricProposalView[] | undefined,
  product: Product,
  fieldPrefix: string,
): TaskError | null {
  if (!metrics?.length) return null;
  const reporting = product.reporting_capabilities as ReportingCapabilitiesView | undefined;
  const availableMetrics = new Set(reporting?.available_metrics ?? []);
  const vendorMetrics = reporting?.vendor_metrics ?? [];
  const seen = new Set<string>();

  for (let i = 0; i < metrics.length; i++) {
    const metric = metrics[i]!;
    const key = committedMetricKey(metric);
    if (!key) {
      return {
        code: 'VALIDATION_ERROR',
        message: 'committed_metrics entries require a valid scope and metric identity',
        field: `${fieldPrefix}[${i}]`,
      };
    }
    if (seen.has(key)) {
      return {
        code: 'VALIDATION_ERROR',
        message: 'committed_metrics entries must be unique by scope, metric identity, and qualifier',
        field: `${fieldPrefix}[${i}]`,
      };
    }
    seen.add(key);

    if (metric.scope === 'standard' && !availableMetrics.has(metric.metric_id!)) {
      return {
        code: 'TERMS_REJECTED',
        message: `committed standard metric "${metric.metric_id}" is not in the product's reporting_capabilities.available_metrics`,
        field: `${fieldPrefix}[${i}].metric_id`,
      };
    }
    if (
      metric.scope === 'vendor'
      && !vendorMetrics.some(candidate => vendorMetricKey(candidate) === vendorMetricKey(metric))
    ) {
      return {
        code: 'TERMS_REJECTED',
        message: `committed vendor metric "${metric.metric_id}" is not in the product's reporting_capabilities.vendor_metrics`,
        field: `${fieldPrefix}[${i}].metric_id`,
      };
    }
  }
  return null;
}

function hasOwnMetric(metrics: Record<string, unknown>, metricId: string): boolean {
  return Object.prototype.hasOwnProperty.call(metrics, metricId) && metrics[metricId] !== undefined;
}

function standardMetricIsDelivered(
  metric: CommittedMetricProposalView,
  delivery: Record<string, unknown>,
): boolean {
  const metricId = metric.metric_id!;
  const qualifier = metric.qualifier;
  if (qualifier && Object.keys(qualifier).length > 0) {
    if (
      metricId === 'viewability'
      && typeof qualifier.viewability_standard === 'string'
      && isRecord(delivery.viewability)
    ) {
      return delivery.viewability.standard === qualifier.viewability_standard;
    }
    // A qualified commitment is satisfied only by a delivery path that makes
    // the same qualifier observable. The reference seller currently exposes
    // only viewability.standard at package grain.
    return false;
  }
  if (hasOwnMetric(delivery, metricId)) return true;
  switch (metricId) {
    case 'ctr':
      return hasOwnMetric(delivery, 'clicks') && hasOwnMetric(delivery, 'impressions');
    case 'cost_per_click':
    case 'cpm':
      return hasOwnMetric(delivery, 'spend') && hasOwnMetric(delivery, metricId === 'cpm' ? 'impressions' : 'clicks');
    case 'cost_per_completed_view':
      return hasOwnMetric(delivery, 'spend') && hasOwnMetric(delivery, 'completed_views');
    case 'roas':
      return hasOwnMetric(delivery, 'conversion_value') && hasOwnMetric(delivery, 'spend');
    case 'cost_per_acquisition':
      return hasOwnMetric(delivery, 'conversions') && hasOwnMetric(delivery, 'spend');
    case 'engagement_rate':
      return hasOwnMetric(delivery, 'engagements') && hasOwnMetric(delivery, 'impressions');
    default:
      return false;
  }
}

function vendorCatalogKey(entry: VendorMetricRefView | undefined): string | null {
  const domain = entry?.vendor?.domain;
  if (typeof domain !== 'string' || domain.length === 0) return null;
  const brandId = typeof entry?.vendor?.brand_id === 'string' ? entry.vendor.brand_id : '';
  return `${domain.toLowerCase()}|${brandId}`;
}

function productMeasurementCatalogForGoal(product: Product | undefined, goal: VendorMetricRefView): MeasurementCatalogView | undefined {
  if (!product) return undefined;
  const catalogKey = vendorCatalogKey(goal);
  if (!catalogKey) return undefined;
  const catalogs = (product as Product & {
    measurement_catalogs?: unknown;
    measurement_catalog?: unknown;
  }).measurement_catalogs ?? (product as Product & { measurement_catalog?: unknown }).measurement_catalog;
  const list = Array.isArray(catalogs) ? catalogs : catalogs ? [catalogs] : [];
  return list.find((entry): entry is MeasurementCatalogView => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    return vendorCatalogKey(entry as MeasurementCatalogView) === catalogKey;
  });
}

export function pricingStructureForOption(option: unknown): PricingStructure {
  if (!option || typeof option !== 'object' || Array.isArray(option)) return 'auction';
  const view = option as PricingOptionView;
  if (view.pricing_model === 'revenue_share') return 'contingent';
  return view.fixed_price !== undefined ? 'fixed' : 'auction';
}

function applyFixedPriceFilter(product: Product, fixedPrice: boolean): Product | null {
  const requested: PricingStructure = fixedPrice ? 'fixed' : 'auction';
  const pricing_options = product.pricing_options.filter(po => pricingStructureForOption(po) === requested);
  if (pricing_options.length === 0) return null;
  return { ...product, pricing_options };
}

export function applyFixedPriceFilterToProducts(products: Product[], fixedPrice: boolean): Product[] {
  return products
    .map(product => applyFixedPriceFilter(product, fixedPrice))
    .filter((product): product is Product => product !== null);
}

function applyPricingStructuresFilter(product: Product, structures: Set<PricingStructure>): Product | null {
  const pricing_options = product.pricing_options.filter(option => structures.has(pricingStructureForOption(option)));
  if (pricing_options.length === 0) return null;
  return { ...product, pricing_options };
}

export function applyPricingStructuresFilterToProducts(products: Product[], structures: PricingStructure[]): Product[] {
  const requested = new Set(structures);
  return products
    .map(product => applyPricingStructuresFilter(product, requested))
    .filter((product): product is Product => product !== null);
}

function pricingOptionCurrency(option: unknown): string | undefined {
  if (!option || typeof option !== 'object' || Array.isArray(option)) return undefined;
  const currency = (option as { currency?: unknown }).currency;
  return typeof currency === 'string' ? currency : undefined;
}

function applyPricingCurrenciesFilter(product: Product, currencies: Set<string>): Product | null {
  const pricingOptions = product.pricing_options.filter(option => {
    const currency = pricingOptionCurrency(option);
    return currency !== undefined && currencies.has(currency);
  });
  if (pricingOptions.length === 0) return null;
  if (!mandatoryProductSignalChargesSatisfied(product, currencies)) return null;
  return { ...product, pricing_options: pricingOptions };
}

function applyPricingCurrenciesFilterToProducts(products: Product[], currencies: string[]): Product[] {
  const currencySet = new Set(currencies);
  return products
    .map(product => applyPricingCurrenciesFilter(product, currencySet))
    .filter((product): product is Product => product !== null);
}

function productMatchesAnyFormatId(product: Product, requestedFormatIds: FormatID[]): boolean {
  if (!Array.isArray(product.format_ids) || product.format_ids.length === 0) return false;
  return product.format_ids.some(actual => {
    if (!actual?.id) return false;
    return requestedFormatIds.some(wanted => {
      if (!wanted?.id || actual.id !== wanted.id) return false;
      if (!wanted.agent_url || !actual.agent_url) return true;
      return canonicalizeAgentUrl(actual.agent_url) === canonicalizeAgentUrl(wanted.agent_url);
    });
  });
}

function applyFormatIdsFilterToProducts(products: Product[], requestedFormatIds: FormatID[]): Product[] {
  return products.filter(product => productMatchesAnyFormatId(product, requestedFormatIds));
}

function productCanonicalFormatOptions(product: Product): Array<{
  format_kind?: string;
  format_option_id?: string;
  publisher_domain?: string;
}> {
  const options = (product as unknown as { format_options?: unknown[] }).format_options;
  return Array.isArray(options)
    ? options.filter((option): option is { format_kind?: string; format_option_id?: string; publisher_domain?: string } => Boolean(option && typeof option === 'object'))
    : [];
}

function applyCanonicalFormatFiltersToProducts(
  products: Product[],
  formatKinds: string[],
  refs: Array<{ scope?: string; publisher_domain?: string; format_option_id?: string }>,
): Product[] {
  const kinds = new Set(formatKinds);
  return products.filter(product => {
    const options = productCanonicalFormatOptions(product);
    const kindMatches = kinds.size === 0 || options.some(option => Boolean(option.format_kind && kinds.has(option.format_kind)));
    const refMatches = refs.length === 0 || refs.some(ref => options.some(option => {
      if (!ref.format_option_id || option.format_option_id !== ref.format_option_id) return false;
      if (ref.scope === 'publisher') {
        return Boolean(ref.publisher_domain && option.publisher_domain?.toLowerCase() === ref.publisher_domain.toLowerCase());
      }
      return ref.scope === 'product' && !option.publisher_domain;
    }));
    return kindMatches && refMatches;
  });
}

function mandatoryProductSignalChargesSatisfied(product: Product, currencies: Set<string>): boolean {
  const rules = (product as unknown as { signal_targeting_rules?: { selection_mode?: unknown } }).signal_targeting_rules;
  if (rules?.selection_mode !== 'fixed') return true;

  const options = (product as unknown as { signal_targeting_options?: unknown }).signal_targeting_options;
  if (!Array.isArray(options)) return true;

  return options.every(option => {
    if (!option || typeof option !== 'object' || Array.isArray(option)) return true;
    const defaultSelected = (option as { default_selected?: unknown }).default_selected;
    if (defaultSelected !== true) return true;
    return signalPricingSatisfiedInCurrencies(option as { pricing_options?: unknown }, currencies);
  });
}

function signalPricingSatisfiedInCurrencies(signalOption: { pricing_options?: unknown }, currencies: Set<string>): boolean {
  if (!Array.isArray(signalOption.pricing_options) || signalOption.pricing_options.length === 0) return true;
  return signalOption.pricing_options.some(option => {
    const currency = pricingOptionCurrency(option);
    return currency !== undefined && currencies.has(currency);
  });
}

// Proposal lifecycle fields not yet in @adcp/sdk — remove after client update
interface ProposalLifecycle {
  proposal_status?: 'draft' | 'committed' | 'accepted';
  insertion_order?: { io_id: string; requires_signature: boolean; terms?: Record<string, unknown> };
}
function proposalLifecycle(proposal: Proposal): ProposalLifecycle {
  const internal = proposal as unknown as Record<string, unknown>;
  if (internal.__executed === true) return { ...proposal as unknown as ProposalLifecycle, proposal_status: 'accepted' };
  return proposal as unknown as ProposalLifecycle;
}

/** Return an exact proposal snapshot backed by a 24-hour inventory hold. */
function executableProposalSnapshot(proposal: Proposal, brandDomain?: string): Proposal {
  const executable = { ...proposal } as Record<string, unknown> & ProposalLifecycle;
  executable.proposal_status = 'committed';
  executable.expires_at = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  const hasGuaranteed = proposal.allocations.some(allocation => {
    const catalogProduct = getCatalog().find(entry => entry.product.product_id === allocation.product_id);
    return catalogProduct?.product.delivery_type === 'guaranteed';
  });
  if (hasGuaranteed) {
    const publisherProduct = getCatalog().find(
      entry => entry.product.product_id === proposal.allocations[0].product_id,
    );
    const ioDigest = createHash('sha256')
      .update(`${proposal.proposal_id}:${brandDomain ?? 'advertiser.example'}`)
      .digest('hex')
      .slice(0, 24);
    executable.insertion_order = {
      io_id: `io_${ioDigest}`,
      terms: {
        advertiser: brandDomain ?? 'advertiser.example',
        publisher: publisherProduct?.publisherId || 'unknown',
        total_budget: {
          amount: proposal.total_budget_guidance?.recommended ?? 0,
          currency: proposal.total_budget_guidance?.currency ?? 'USD',
        },
        flight_start: new Date().toISOString(),
        flight_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        payment_terms: 'net_30',
      },
      requires_signature: true,
    };
  }

  return executable as unknown as Proposal;
}

/** Return an immutable indicative proposal. Its expiry is a terms-freshness
 * deadline, not an inventory hold; only finalize creates a committed hold. */
function draftProposalSnapshot(proposal: Proposal): Proposal {
  const draft = { ...proposal } as Record<string, unknown> & ProposalLifecycle;
  draft.proposal_status = 'draft';
  draft.expires_at = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  delete draft.insertion_order;
  return draft as unknown as Proposal;
}

type ConcreteCpmAsk = {
  currency?: string;
  budget?: { amount: number; currency: string };
};

const ISO_CURRENCY_CODES = new Set(Intl.supportedValuesOf('currency'));

/**
 * Recognize the training agent's deterministic CPM-pricing refinement.
 * Other natural-language asks intentionally remain partial so buyers can test
 * both successful and honest incomplete refinement outcomes.
 */
function parseConcreteCpmAsk(ask?: string): ConcreteCpmAsk | undefined {
  if (!ask) return undefined;
  const normalized = ask.toLowerCase();
  if (!/\bcpm\b/.test(normalized)) return undefined;
  if (!/\b(?:concrete|firm|fixed|price|pricing|rate|per[ -]unit)\b/.test(normalized)) return undefined;

  const contextualCurrency = ask.match(/\b(?:in|currency(?:\s+of)?)\s+([a-z]{3})\b/i)?.[1]?.toUpperCase();
  const explicitCurrency = contextualCurrency && ISO_CURRENCY_CODES.has(contextualCurrency)
    ? contextualCurrency
    : ask.includes('$') ? 'USD' : undefined;
  const budgetClause = ask.match(/\b(?:budget|total)\b[^.!?]{0,120}/i)?.[0];
  const containsExplicitCpmAmount = /(?:\$\s*\d[\d,.]*|\b\d[\d,.]*\s*[a-z]{3})\s*(?:per[- ]unit\s+)?cpm\b/i.test(ask);
  if (containsExplicitCpmAmount) return undefined;
  if (!budgetClause) {
    return { ...(explicitCurrency && { currency: explicitCurrency }) };
  }

  const amountPattern = '([0-9][0-9,]*(?:\\.[0-9]{1,2})?)\\s*([km])?';
  const currencyBefore = budgetClause.match(new RegExp(`\\b([A-Z]{3})\\s*\\$?\\s*${amountPattern}\\b`, 'i'));
  const currencyAfter = budgetClause.match(new RegExp(`\\b${amountPattern}\\s*([A-Z]{3})\\b`, 'i'));
  const dollarAmount = budgetClause.match(new RegExp(`\\$\\s*${amountPattern}\\b`, 'i'));

  let amountText: string | undefined;
  let scale: string | undefined;
  let currency: string | undefined;
  if (currencyAfter) {
    [, amountText, scale, currency] = currencyAfter;
  } else if (currencyBefore) {
    [, currency, amountText, scale] = currencyBefore;
  } else if (dollarAmount) {
    [, amountText, scale] = dollarAmount;
    currency = 'USD';
  }

  if (!amountText || !currency) {
    return { ...(explicitCurrency && { currency: explicitCurrency }) };
  }
  const multiplier = scale?.toLowerCase() === 'm' ? 1_000_000 : scale?.toLowerCase() === 'k' ? 1_000 : 1;
  const amount = Number(amountText.replaceAll(',', '')) * multiplier;
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  const normalizedCurrency = currency.toUpperCase();
  if (!ISO_CURRENCY_CODES.has(normalizedCurrency)) return undefined;
  return {
    currency: normalizedCurrency,
    budget: { amount, currency: normalizedCurrency },
  };
}

/**
 * Recognize the request-level selection refinement that the training agent
 * can apply deterministically. Keeping this grammar deliberately narrow
 * leaves compound or arbitrary natural-language constraints on the honest
 * partial path.
 */
function requestsGuaranteedOnlyProducts(ask?: string): boolean {
  if (!ask) return false;
  const normalized = ask.trim().toLowerCase().replace(/[.!?]+$/, '').trim();
  return /^(?:(?:show|return|include|select|keep)\s+)?only\s+guaranteed\s+(?:products|packages)$/.test(normalized)
    || /^limit\s+(?:the\s+)?(?:results|selection)\s+to\s+guaranteed\s+(?:products|packages)$/.test(normalized);
}

function concreteCpmPricing(
  product: Product,
  requestedCurrency?: string,
): {
  product: Product;
  pricingOption: PricingOption;
  pricingOptionId: string;
  fixedPrice: number;
  currency: string;
} | undefined {
  const optionIndex = product.pricing_options.findIndex(option =>
    option.pricing_model === 'cpm'
    && (!requestedCurrency || option.currency === requestedCurrency),
  );
  if (optionIndex < 0) return undefined;

  const option = product.pricing_options[optionIndex] as Extract<PricingOption, { pricing_model: 'cpm' }>;
  const fixedPrice = option.fixed_price
    ?? option.price_guidance?.p50
    ?? option.floor_price;
  if (fixedPrice === undefined) return undefined;

  const {
    floor_price: _floorPrice,
    price_guidance: _priceGuidance,
    max_bid: _maxBid,
    min_spend_per_package: _minSpendPerPackage,
    ...concreteOptionBase
  } = option;
  const fingerprint = createHash('sha256')
    .update(`${product.product_id}|${option.pricing_option_id}|${option.currency}|${fixedPrice}`)
    .digest('hex')
    .slice(0, 32);
  const pricingOptionId = `${option.pricing_option_id}_concrete_${fingerprint}`;
  const pricingOptions = [...product.pricing_options];
  const negotiatedOption = { ...concreteOptionBase, pricing_option_id: pricingOptionId, fixed_price: fixedPrice } as PricingOption;
  const negotiatedIndex = pricingOptions.findIndex(candidate => candidate.pricing_option_id === pricingOptionId);
  let effectiveOption = negotiatedOption;
  if (negotiatedIndex >= 0) {
    const existing = pricingOptions[negotiatedIndex] as PricingOption;
    if (!isDeepStrictEqual(existing, negotiatedOption)) return undefined;
    effectiveOption = existing;
  } else {
    pricingOptions.push(negotiatedOption);
  }

  return {
    product: { ...product, pricing_options: pricingOptions },
    pricingOption: effectiveOption,
    pricingOptionId,
    fixedPrice,
    currency: option.currency,
  };
}

function withProposalBudgetGuidance(
  proposal: Proposal,
  budget: { amount: number; currency: string },
): Proposal {
  const guidance = {
    ...proposal.total_budget_guidance,
    min: Math.min(proposal.total_budget_guidance?.min ?? budget.amount, budget.amount),
    recommended: budget.amount,
    currency: budget.currency,
  };
  const ext = proposal.ext as unknown as Record<string, unknown> | undefined;
  const updateCard = (card: unknown): unknown => {
    if (!card || typeof card !== 'object' || Array.isArray(card)) return card;
    const typedCard = card as Record<string, unknown>;
    const manifest = typedCard.manifest;
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return card;
    const typedManifest = manifest as Record<string, unknown>;
    const assets = typedManifest.assets;
    if (!assets || typeof assets !== 'object' || Array.isArray(assets)) return card;
    const {
      estimated_delivery: _staleEstimatedDelivery,
      ...currentAssets
    } = assets as Record<string, unknown>;
    return {
      ...typedCard,
      manifest: {
        ...typedManifest,
        assets: {
          ...currentAssets,
          budget_min: { content: String(guidance.min) },
          budget_recommended: { content: String(guidance.recommended) },
          budget_currency: { content: guidance.currency },
        },
      },
    };
  };

  return {
    ...proposal,
    total_budget_guidance: guidance,
    ...(ext && {
      ext: {
        ...ext,
        proposal_card: updateCard(ext.proposal_card),
        proposal_card_detailed: updateCard(ext.proposal_card_detailed),
      },
    }),
  } as Proposal;
}

const THREE_ZERO_LEGACY_PROPOSAL_ID = 'balanced_reach_q2';
const THREE_ZERO_LEGACY_PROPOSAL_TARGET_ID = 'sparq_social_amplification';

function isThreeZeroStoryboardCompat(ctx: TrainingContext): boolean {
  return ctx.storyboardCompat?.version === '3.0';
}

function productForThreeZeroStoryboardCompat(product: Product): Product {
  const {
    product_card: _productCard,
    product_card_detailed: _productCardDetailed,
    ...rest
  } = product as Product & {
    product_card?: unknown;
    product_card_detailed?: unknown;
  };
  return rest as Product;
}

function includeThreeOneFields(ctx: TrainingContext): boolean {
  return !isThreeZeroStoryboardCompat(ctx);
}

function creativeBillsThroughAdcp(ctx: TrainingContext): boolean {
  return ctx.creativeBillsThroughAdcp !== false;
}

function resolveThreeZeroProposalAlias(proposals: Proposal[]): Proposal | undefined {
  return proposals.find(p => p.proposal_id === THREE_ZERO_LEGACY_PROPOSAL_TARGET_ID);
}

import { buildCatalog, buildShowsForProducts, buildProposals } from './product-factory.js';
import { buildFormats, FORMAT_CHANNEL_MAP } from './formats.js';
import { getAllSignals, SIGNAL_PROVIDERS } from './signal-providers.js';
import {
  controllerFixturePrincipal, getSession, getProductsSessionKeyFromArgs, sessionKeyFromArgs,
  findSessionMatching,
  runWithSessionContext, flushDirtySessions, evictSessionFromRequestCache,
  getComplianceCreatives, getComplianceCreative,
  getComplianceMediaBuys, getComplianceMediaBuy,
  MAX_MEDIA_BUYS_PER_SESSION, MAX_CREATIVES_PER_SESSION, MAX_USAGE_RECORDS_PER_SESSION,
} from './state.js';
import { getAgentUrl } from './config.js';
import {
  GOVERNANCE_TOOLS,
  handleSyncPlans,
  handleCheckGovernance,
  handleReportPlanOutcome,
  handleReportPlanAdjustment,
  handleGetPlanAuditLogs,
} from './governance-handlers.js';
import {
  BRAND_TOOLS,
  handleSearchBrands,
  handleGetBrandIdentity,
  handleGetRights,
  handleAcquireRights,
  handleUpdateRights,
  handleCreativeApproval,
} from './brand-handlers.js';
import {
  PROPERTY_TOOLS,
  handleCreatePropertyList,
  handleListPropertyLists,
  handleGetPropertyList,
  handleUpdatePropertyList,
  handleDeletePropertyList,
  handleValidatePropertyDelivery,
} from './property-handlers.js';
import {
  CONTENT_STANDARDS_TOOLS,
  handleCreateContentStandards,
  handleListContentStandards,
  handleGetContentStandards,
  handleUpdateContentStandards,
  handleCalibrateContent,
  handleValidateContentDelivery,
} from './content-standards-handlers.js';
import {
  ACCOUNT_REF_SCHEMA,
  ACCOUNT_TOOLS,
  SUPPORTED_BILLINGS,
  handleListAccounts,
  sandboxAccountRefForId,
  resolveAccountIdForRef,
  resolveAccountCurrencyForRef,
  resolveGovernanceAgentsForAccount,
  handleSyncAccounts,
  handleSyncGovernance,
} from './account-handlers.js';
import {
  COLLECTION_LIST_TOOLS,
  handleCreateCollectionList,
  handleGetCollectionList,
  handleUpdateCollectionList,
  handleListCollectionLists,
  handleDeleteCollectionList,
} from './inventory-governance-handlers.js';
import {
  CATALOG_EVENT_TOOLS,
  handleSyncCatalogs,
  handleSyncEventSources,
  handleLogEvent,
  handleProvidePerformanceFeedback,
  findEventSourceInSession,
} from './catalog-event-handlers.js';
import {
  AUDIENCE_TOOLS,
  handleSyncAudiences,
  findAudienceInSession,
} from './audience-handlers.js';
import {
  COMPLY_TEST_CONTROLLER_TOOL,
  handleComplyTestController,
  getDeliverySimulation,
  getDeliverySimulationForPeriod,
  getAccountStatus,
  getSeededCreativeFormats,
} from './comply-test-controller.js';
import { PUBLISHERS } from './publishers.js';
import {
  isMutatingTool,
  validateKeyFormat,
  scopedPrincipal,
  getIdempotencyStore,
  payloadHash,
  REPLAY_TTL_SECONDS,
} from './idempotency.js';
import { maybeEmitCompletionWebhook } from './webhooks.js';
import { selectSigningCapability } from './request-signing.js';
import {
  getTrainingTaskStore,
  resetTrainingTaskStore,
  type TrainingTaskStore,
} from './mcp-task-store.js';
import {
  loadProductDiscoveryInputSchema,
  validateProductDiscoverySourceInput,
} from './source-schema.js';

const SUPPORTED_MAJOR_VERSIONS = [3] as const;
const SUPPORTED_RELEASE_VERSIONS = ['3.0', '3.1-beta.5', '3.1-beta.7', '3.1-rc.4', '3.1-rc.6', '3.1-rc.7', '3.1-rc.8', '3.1-rc.9', '3.1-rc.10', '3.1-rc.14', '3.1-rc.15', GET_PRODUCTS_REJECTED_ADCP_VERSION] as const;
const DEFAULT_ADCP_VERSION = '3.0';
const CURRENT_ADCP_VERSION = '3.1-rc.15';
const MAX_PACKAGES_PER_BUY = 50;

interface ParsedAdcpReleaseVersion {
  raw: string;
  major: number;
  minor: number;
  prerelease?: string;
}

interface VersionUnsupportedDetails {
  adcp_version?: string;
  adcp_major_version?: number;
  supported_versions: string[];
  supported_majors: number[];
  rejected_adcp_version?: string;
}

type VersionResolution =
  | { ok: true; servedVersion: string }
  | { ok: false; message: string; field: 'adcp_version' | 'adcp_major_version'; details: VersionUnsupportedDetails };

type McpRequestHandler = (request: { params?: Record<string, unknown> }, extra: unknown) => Promise<unknown> | unknown;

const TASK_PROTOCOL_METHODS = ['tasks/get', 'tasks/result', 'tasks/list', 'tasks/cancel'] as const;

function parseAdcpReleaseVersion(value: unknown): ParsedAdcpReleaseVersion | undefined {
  if (typeof value !== 'string') return undefined;
  const match = value.match(/^(\d+)\.(\d+)(?:-([A-Za-z0-9.-]+))?$/);
  if (!match) return undefined;
  return {
    raw: value,
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    ...(match[3] && { prerelease: match[3] }),
  };
}

function compareAdcpReleaseVersions(left: ParsedAdcpReleaseVersion, right: ParsedAdcpReleaseVersion): number {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  if (left.prerelease === right.prerelease) return 0;
  if (!left.prerelease) return 1;
  if (!right.prerelease) return -1;
  return compareAdcpPrerelease(left.prerelease, right.prerelease);
}

function compareAdcpPrerelease(left: string, right: string): number {
  const leftParts = left.split('.');
  const rightParts = right.split('.');
  const maxParts = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < maxParts; index += 1) {
    const leftPart = leftParts[index];
    const rightPart = rightParts[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;

    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      return Number.parseInt(leftPart, 10) - Number.parseInt(rightPart, 10);
    }
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return leftPart.localeCompare(rightPart);
  }

  return 0;
}

const PARSED_SUPPORTED_RELEASE_VERSIONS = SUPPORTED_RELEASE_VERSIONS
  .map(version => parseAdcpReleaseVersion(version))
  .filter((version): version is ParsedAdcpReleaseVersion => version !== undefined)
  .sort(compareAdcpReleaseVersions);

function highestSupportedRelease(major?: number): string | undefined {
  const candidates = major === undefined
    ? PARSED_SUPPORTED_RELEASE_VERSIONS
    : PARSED_SUPPORTED_RELEASE_VERSIONS.filter(version => version.major === major);
  return candidates.at(-1)?.raw;
}

function supportedVersionDetails(args: Record<string, unknown>): VersionUnsupportedDetails {
  const requestedRelease = parseAdcpReleaseVersion(args.adcp_version);
  const requestedMajor = typeof args.adcp_major_version === 'number' && Number.isInteger(args.adcp_major_version)
    ? args.adcp_major_version
    : undefined;
  return {
    ...(requestedRelease && { adcp_version: requestedRelease.raw }),
    ...(requestedMajor !== undefined && { adcp_major_version: requestedMajor }),
    ...(!requestedRelease && typeof args.adcp_version === 'string' && { rejected_adcp_version: args.adcp_version }),
    supported_versions: [...SUPPORTED_RELEASE_VERSIONS],
    supported_majors: [...SUPPORTED_MAJOR_VERSIONS],
  };
}

export function resolveServedAdcpVersion(args: Record<string, unknown>): VersionResolution {
  const requestedReleaseRaw = args.adcp_version;
  const requestedMajorRaw = args.adcp_major_version;
  const requestedMajor = typeof requestedMajorRaw === 'number' && Number.isInteger(requestedMajorRaw)
    ? requestedMajorRaw
    : undefined;

  if (requestedReleaseRaw !== undefined) {
    const requestedRelease = parseAdcpReleaseVersion(requestedReleaseRaw);
    if (!requestedRelease) {
      return {
        ok: false,
        message: `AdCP version ${JSON.stringify(requestedReleaseRaw)} is not supported`,
        field: 'adcp_version',
        details: supportedVersionDetails(args),
      };
    }

    if (requestedMajor !== undefined && requestedMajor !== requestedRelease.major) {
      return {
        ok: false,
        message: `Request carries adcp_version="${requestedRelease.raw}" (major ${requestedRelease.major}) and adcp_major_version=${requestedMajor}; majors must agree.`,
        field: 'adcp_version',
        details: supportedVersionDetails(args),
      };
    }

    if ((SUPPORTED_RELEASE_VERSIONS as readonly string[]).includes(requestedRelease.raw)) {
      return { ok: true, servedVersion: requestedRelease.raw };
    }

    if (requestedRelease.prerelease) {
      return {
        ok: false,
        message: `AdCP version ${requestedRelease.raw} is not supported`,
        field: 'adcp_version',
        details: supportedVersionDetails(args),
      };
    }

    const downshift = PARSED_SUPPORTED_RELEASE_VERSIONS
      .filter(version => version.major === requestedRelease.major)
      .filter(version => !version.prerelease)
      .filter(version => compareAdcpReleaseVersions(version, requestedRelease) <= 0)
      .at(-1);

    if (downshift) {
      return { ok: true, servedVersion: downshift.raw };
    }

    return {
      ok: false,
      message: `AdCP version ${requestedRelease.raw} is not supported`,
      field: 'adcp_version',
      details: supportedVersionDetails(args),
    };
  }

  if (requestedMajorRaw !== undefined) {
    if (requestedMajor === undefined) {
      return {
        ok: false,
        message: `AdCP major version ${JSON.stringify(requestedMajorRaw)} is not supported`,
        field: 'adcp_major_version',
        details: supportedVersionDetails(args),
      };
    }
    const servedVersion = highestSupportedRelease(requestedMajor);
    if (servedVersion) return { ok: true, servedVersion };
    return {
      ok: false,
      message: `AdCP major version ${requestedMajor} is not supported`,
      field: 'adcp_major_version',
      details: supportedVersionDetails(args),
    };
  }

  return { ok: true, servedVersion: DEFAULT_ADCP_VERSION };
}

export function resolveServedAdcpVersionForTool(toolName: string, args: Record<string, unknown>): VersionResolution {
  const splitProductTool = isProductDiscoveryTool(toolName) && toolName !== 'get_products';
  if (
    (toolName === 'validate_input' || splitProductTool)
    && args.adcp_version === undefined
    && args.adcp_major_version === undefined
  ) {
    return resolveServedAdcpVersion({
      ...args,
      adcp_version: splitProductTool ? GET_PRODUCTS_REJECTED_ADCP_VERSION : CURRENT_ADCP_VERSION,
    });
  }
  return resolveServedAdcpVersion(args);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validatedCreativeIdentity(
  creative: Pick<InlineCreativeInput, 'format_id' | 'format_kind' | 'format_option_ref'>,
): { ok: true; identity: InlineCreativeIdentity } | { ok: false; message: string } {
  const hasLegacyIdentity = creative.format_id !== undefined;
  const hasCanonicalIdentity = creative.format_kind !== undefined;
  if (hasLegacyIdentity === hasCanonicalIdentity) {
    return {
      ok: false,
      message: hasLegacyIdentity
        ? 'must provide exactly one of format_id or format_kind, not both'
        : 'requires exactly one of format_id or format_kind',
    };
  }

  if (hasCanonicalIdentity) {
    const formatKind = canonicalFormatKind(creative.format_kind);
    const parsed = CreativeAssetSchema.safeParse({
      creative_id: '__identity_validation__',
      name: 'Identity validation',
      assets: {},
      format_kind: creative.format_kind,
      ...(creative.format_option_ref !== undefined && { format_option_ref: creative.format_option_ref }),
    });
    if (!formatKind || !parsed.success) {
      return { ok: false, message: 'has an invalid canonical format_kind or format_option_ref' };
    }
    return {
      ok: true,
      identity: {
        kind: 'canonical',
        formatKind,
        ...(isRecord(creative.format_option_ref) && { formatOptionRef: creative.format_option_ref }),
      },
    };
  }

  const parsed = CreativeAssetSchema.safeParse({
    creative_id: '__identity_validation__',
    name: 'Identity validation',
    assets: {},
    format_id: creative.format_id,
    ...(creative.format_option_ref !== undefined && { format_option_ref: creative.format_option_ref }),
  });
  if (!parsed.success || !isRecord(creative.format_id)) {
    return { ok: false, message: 'has an invalid legacy format_id' };
  }
  const agentUrl = creative.format_id.agent_url;
  if (
    typeof agentUrl !== 'string'
    || agentUrl.length === 0
    || agentUrl.length > MAX_URL_LEN
    || agentUrl !== agentUrl.trim()
  ) {
    return { ok: false, message: `has an invalid legacy format_id.agent_url (expected a URL up to ${MAX_URL_LEN} characters)` };
  }
  try {
    const url = new URL(agentUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { ok: false, message: 'has an invalid legacy format_id.agent_url (expected http:// or https://)' };
    }
  } catch {
    return { ok: false, message: 'has an invalid legacy format_id.agent_url' };
  }
  const width = creative.format_id.width;
  const height = creative.format_id.height;
  const durationMs = creative.format_id.duration_ms;
  const pixelRatio = creative.format_id.pixel_ratio;
  if (
    (width !== undefined && (typeof width !== 'number' || !Number.isInteger(width) || width < 1))
    || (height !== undefined && (typeof height !== 'number' || !Number.isInteger(height) || height < 1))
    || (width === undefined) !== (height === undefined)
    || (durationMs !== undefined && (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 1))
    || (pixelRatio !== undefined && (typeof pixelRatio !== 'number' || !Number.isFinite(pixelRatio) || pixelRatio <= 0))
    || (pixelRatio !== undefined && (width === undefined || height === undefined))
  ) {
    return { ok: false, message: 'has invalid legacy format_id dimensions, duration_ms, or pixel_ratio parameters' };
  }
  return {
    ok: true,
    identity: {
      kind: 'legacy',
      formatId: creative.format_id as unknown as FormatID,
      ...(isRecord(creative.format_option_ref) && { formatOptionRef: creative.format_option_ref }),
    },
  };
}

function normalizedCreativeManifest(
  creative: InlineCreativeInput,
  existing: CreativeState | undefined,
  identity: InlineCreativeIdentity,
): CreativeManifest | undefined {
  const inlineAssets = isRecord(creative.assets)
    ? creative.assets as CreativeManifest['assets']
    : undefined;
  const manifestAssets = isRecord(creative.manifest) && isRecord(creative.manifest.assets)
    ? creative.manifest.assets as CreativeManifest['assets']
    : undefined;
  const assets = inlineAssets
    ?? manifestAssets
    ?? existing?.manifest?.assets
    ?? existing?.assets;
  if (!assets) return undefined;

  const sourceManifest = isRecord(creative.manifest)
    ? creative.manifest
    : isRecord(existing?.manifest)
      ? existing.manifest
      : undefined;
  const {
    format_id: _staleFormatId,
    format_kind: _staleFormatKind,
    format_option_ref: _staleFormatOptionRef,
    assets: _staleAssets,
    ...manifestMetadata
  } = sourceManifest ?? {};

  return identity.kind === 'canonical'
    ? {
      ...manifestMetadata,
      format_kind: identity.formatKind,
      ...(identity.formatOptionRef && { format_option_ref: identity.formatOptionRef }),
      assets,
    }
    : {
      ...manifestMetadata,
      format_id: identity.formatId,
      ...(identity.formatOptionRef && { format_option_ref: identity.formatOptionRef }),
      assets,
    };
}

function mcpErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.message.replace(/^MCP error -?\d+: /, '');
}

function versionUnsupportedJsonRpcError(resolution: Extract<VersionResolution, { ok: false }>, context?: unknown): McpError {
  const adcpError = {
    code: 'VERSION_UNSUPPORTED',
    message: resolution.message,
    details: resolution.details,
    field: resolution.field,
  };
  return new McpError(ErrorCode.InvalidParams, resolution.message, {
    ...resolution.details,
    adcp_error: adcpError,
    ...(context !== undefined && { context }),
  });
}

function rethrowWithServedAdcpVersion(error: unknown, servedAdcpVersion: string): never {
  if (error instanceof McpError) {
    const existingData = isRecord(error.data) ? error.data : {};
    throw new McpError(error.code, mcpErrorMessage(error), {
      ...existingData,
      adcp_version: servedAdcpVersion,
    });
  }
  throw error;
}

function addServedAdcpVersion(result: unknown, servedAdcpVersion: string, context?: unknown): unknown {
  if (!isRecord(result)) return result;
  return {
    ...result,
    adcp_version: servedAdcpVersion,
    ...(context !== undefined && result.context === undefined && { context }),
  };
}

function installTaskProtocolVersionNegotiation(server: Server): void {
  const handlers = (server as unknown as { _requestHandlers?: Map<string, McpRequestHandler> })._requestHandlers;
  if (!handlers) return;

  for (const method of TASK_PROTOCOL_METHODS) {
    const original = handlers.get(method);
    if (!original) continue;
    handlers.set(method, async (request, extra) => {
      const rawParams = isRecord(request.params) ? request.params : {};
      const { context: callerContext, ...versionArgs } = rawParams;
      const versionResolution = resolveServedAdcpVersion(versionArgs);
      if (!versionResolution.ok) {
        throw versionUnsupportedJsonRpcError(versionResolution, callerContext);
      }
      try {
        const result = await original(request, extra);
        return addServedAdcpVersion(result, versionResolution.servedVersion, callerContext);
      } catch (error) {
        rethrowWithServedAdcpVersion(error, versionResolution.servedVersion);
      }
    });
  }
}

// ── MCP Tasks store (SDK-managed) ─────────────────────────────────

/**
 * Shared task store across per-request Server instances.
 *
 * In production (database available), uses PostgresTaskStore so tasks
 * survive across Fly.io instances. In tests (no database), falls back
 * to InMemoryTaskStore.
 *
 * Note: no session isolation — any session can see/cancel tasks from
 * another. This is intentional for the training agent where all sessions
 * are sandboxed. Production servers should scope tasks by sessionId.
 */
const inMemoryTaskIdsByNaturalKey = new Map<string, string>();
const IDEMPOTENT_TASK_MAX_GENERATIONS = 64;

function idempotentTaskNaturalKey(
  principal: string,
  toolName: string,
  idempotencyKey: string,
  payloadHash: string,
): string {
  return [principal, toolName, `success:${idempotencyKey}:${payloadHash}`].join('\0');
}

export function idempotentTaskId(naturalKey: string, generation: number): string {
  const generationKey = generation === 0 ? naturalKey : `${naturalKey}\0replacement:${generation}`;
  return createHash('sha256').update(generationKey).digest('hex');
}

function taskReceiptCanBeReused(task: { status: string }): boolean {
  return task.status !== 'cancelled' && task.status !== 'failed';
}

function isTaskIdCollision(error: unknown, taskId: string): boolean {
  return error instanceof Error
    && error.message === `Task with ID ${taskId} already exists. Use a different taskId or retrieve the existing task via getTask().`;
}

export async function createOrReuseIdempotentTask(
  taskStore: TrainingTaskStore,
  naturalKey: string,
  ttl: number,
  request: { method: string; params?: { _meta?: Record<string, unknown> } },
) {
  if (taskStore instanceof PostgresTaskStore) {
    const taskIds = Array.from(
      { length: IDEMPOTENT_TASK_MAX_GENERATIONS },
      (_, generation) => idempotentTaskId(naturalKey, generation),
    );
    const existingTasks = await Promise.all(taskIds.map(taskId => taskStore.getTask(taskId)));
    // Prefer the newest live generation. Missing entries may be expired rows
    // hidden by PostgresTaskStore, so the complete scan must happen before an
    // insertion attempt; an older hole cannot prove that later generations
    // do not exist.
    for (let generation = existingTasks.length - 1; generation >= 0; generation -= 1) {
      const existing = existingTasks[generation];
      if (existing && taskReceiptCanBeReused(existing)) return existing;
    }

    for (let generation = 0; generation < taskIds.length; generation += 1) {
      if (existingTasks[generation]) continue;
      const deterministicTaskId = taskIds[generation]!;
      try {
        return await taskStore.createTask({ ttl, taskId: deterministicTaskId }, 0, request);
      } catch (error) {
        // A sibling process may have inserted the same naturally keyed task
        // between getTask() and createTask(). Re-read instead of allocating a
        // second task or surfacing a false failure.
        const raced = await taskStore.getTask(deterministicTaskId);
        if (raced) {
          if (taskReceiptCanBeReused(raced)) return raced;
          continue;
        }
        // getTask() filters expired rows, but their primary keys remain until
        // cleanup. A confirmed SDK duplicate for an invisible row occupies
        // this generation; advance instead of failing or recreating gen0.
        if (isTaskIdCollision(error, deterministicTaskId)) continue;
        throw error;
      }
    }
    throw new Error('Too many cancelled or failed idempotent task receipt generations');
  }

  const priorId = inMemoryTaskIdsByNaturalKey.get(naturalKey);
  if (priorId) {
    const existing = await taskStore.getTask(priorId);
    if (existing && taskReceiptCanBeReused(existing)) return existing;
    inMemoryTaskIdsByNaturalKey.delete(naturalKey);
  }
  const created = await taskStore.createTask({ ttl }, 0, request);
  inMemoryTaskIdsByNaturalKey.set(naturalKey, created.taskId);
  return created;
}

export async function getIdempotentTask(
  taskStore: TrainingTaskStore,
  naturalKey: string,
) {
  if (taskStore instanceof PostgresTaskStore) {
    const tasks = await Promise.all(Array.from(
      { length: IDEMPOTENT_TASK_MAX_GENERATIONS },
      (_, generation) => taskStore.getTask(idempotentTaskId(naturalKey, generation)),
    ));
    let latestTerminalTask: Awaited<ReturnType<typeof taskStore.getTask>> = null;
    for (let generation = tasks.length - 1; generation >= 0; generation -= 1) {
      const task = tasks[generation];
      if (!task) continue;
      if (taskReceiptCanBeReused(task)) return task;
      if (!latestTerminalTask) latestTerminalTask = task;
    }
    return latestTerminalTask;
  }
  const taskId = inMemoryTaskIdsByNaturalKey.get(naturalKey);
  if (!taskId) return null;
  const task = await taskStore.getTask(taskId);
  if (!task) inMemoryTaskIdsByNaturalKey.delete(naturalKey);
  return task;
}

/** Look up which tools allow task augmentation. */
function toolSupportsTask(toolName: string): boolean {
  const tool = TOOLS.find(t => t.name === toolName);
  const support = tool?.execution?.taskSupport as string | undefined;
  return support === 'optional' || support === 'required';
}

/**
 * Extract an account-scoping string for the idempotency cache from the
 * tool arguments. Mirrors `sessionKeyFromArgs` but returns just the scope
 * portion (no `open:` prefix) so callers can feed it to `scopedPrincipal`.
 *
 * The scope is caller-controlled, so it doesn't authenticate anything —
 * its only job is to keep two different buyers on the same shared token
 * from seeing each other's idempotency outcomes.
 */
function deriveAccountScope(args: Record<string, unknown>, strictAccountRef = true): string | undefined {
  const usageAccount = Array.isArray(args.usage)
    ? (args.usage[0] as { account?: unknown } | undefined)?.account
    : undefined;
  const account = Object.prototype.hasOwnProperty.call(args, 'account')
    ? args.account
    : usageAccount;
  if (account !== undefined) {
    try {
      return accountScopeFromRef(account);
    } catch (error) {
      if (strictAccountRef || !(error instanceof AccountRefValidationError)) throw error;
      const legacy = account as { account_id?: unknown; brand?: { domain?: unknown } };
      if (typeof legacy.account_id === 'string' && legacy.account_id.length > 0) {
        return `a:${legacy.account_id}`;
      }
      if (typeof legacy.brand?.domain === 'string' && legacy.brand.domain.length > 0) {
        return `b:${legacy.brand.domain.toLowerCase()}`;
      }
      return undefined;
    }
  }
  if (typeof args.account_id === 'string' && args.account_id.length > 0) {
    return `a:${args.account_id}`;
  }
  return compactBrandScope(args.brand);
}

async function deriveProductDiscoveryAccountScope(
  toolName: string,
  originalArgs: Record<string, unknown>,
  normalizedArgs: Record<string, unknown>,
  ctx: TrainingContext,
): Promise<string | undefined> {
  const directScope = deriveAccountScope(normalizedArgs, isProductDiscoveryTool(toolName));
  if (
    directScope
    || (toolName !== 'refine_proposals' && toolName !== 'decline_proposals')
  ) {
    return directScope;
  }

  const proposalIds = toolName === 'refine_proposals' && Array.isArray(originalArgs.refinements)
    ? originalArgs.refinements
        .filter(isRecord)
        .map(refinement => refinement.proposal_id)
        .filter((id): id is string => typeof id === 'string')
    : toolName === 'decline_proposals' && Array.isArray(originalArgs.declines)
      ? originalArgs.declines
          .filter(isRecord)
          .map(decline => decline.proposal_id)
          .filter((id): id is string => typeof id === 'string')
      : [];
  const proposalSession = await getSession(
    sessionKeyFromArgs({}, ctx.mode, ctx.userId, ctx.moduleId, ctx.principal ?? 'anonymous'),
  );
  const proposalsById = new Map(
    (proposalSession.lastGetProductsContext?.proposals ?? []).map(proposal => [proposal.proposal_id, proposal]),
  );
  const scopes = new Set<string>();
  for (const proposalId of proposalIds) {
    const internal = proposalsById.get(proposalId) as unknown as Record<string, unknown> | undefined;
    if (typeof internal?.__account_scope === 'string') scopes.add(internal.__account_scope);
    else if (typeof internal?.__account_id === 'string') scopes.add(`a:${internal.__account_id}`);
    else if (typeof internal?.__brand_domain === 'string') {
      scopes.add(compactBrandScope({
        domain: internal.__brand_domain,
        ...(typeof internal.__brand_id === 'string' && { brand_id: internal.__brand_id }),
        ...(Array.isArray(internal.__brand_countries) && { countries: internal.__brand_countries }),
      })!);
    }
  }
  if (scopes.size > 1) {
    throw new AccountRefValidationError('All proposal IDs in one lifecycle request must resolve to the same account.');
  }
  return scopes.values().next().value ?? 'proposal-lookup:unresolved';
}

/**
 * Resolve the one principal-bound controller fixture session that an
 * authenticated sandbox request may read. Account-id requests must prove the
 * id was synced for the same principal and brand before a fixture key is
 * returned; production/nonsandbox and malformed refs never bridge.
 */
function controllerFixtureSessionKey(
  args: ToolArgs,
  ctx: TrainingContext,
): string | undefined {
  if (!args.account) {
    // Frozen 3.0 natural-account adapters intentionally project the SDK's
    // synthetic account back to its legacy brand session. Permit that one
    // static sandbox surface to read the principal-bound fixture projection;
    // real principals and ordinary brand-only requests remain ineligible.
    const compatBrandDomain = ctx.storyboardCompat?.version === '3.0'
      && ctx.principal?.startsWith('static:')
      && typeof args.brand?.domain === 'string'
      ? args.brand.domain
      : undefined;
    if (compatBrandDomain) {
      return sessionKeyFromArgs(
        { brand: { domain: compatBrandDomain } },
        ctx.mode,
        ctx.userId,
        ctx.moduleId,
        controllerFixturePrincipal(ctx.principal),
      );
    }
  }
  const requestedAccount = args.account ?? ctx.resolvedAccount ?? (
    ctx.requestInput?.account && typeof ctx.requestInput.account === 'object'
      ? ctx.requestInput.account as ToolArgs['account']
      : undefined
  );
  if (!requestedAccount) return undefined;
  let fixtureAccount: ToolArgs['account'];
  try {
    const account = canonicalizeAccountRef(requestedAccount);
    if (account.kind === 'natural') {
      // Public/static training-agent traffic is itself a sandbox boundary, so
      // ordinary task calls may omit the controller-only `sandbox: true`
      // assertion while still reading fixtures seeded for the same complete
      // natural identity. Authenticated non-static callers must resolve to an
      // explicitly sandboxed account before any fixture projection occurs.
      if (!account.sandbox && ctx.principal && !ctx.principal.startsWith('static:')) return undefined;
      fixtureAccount = {
        brand: account.brand,
        // SDK controller seeding uses the brand domain as operator. Public
        // static credentials intentionally share one demo fixture sandbox,
        // so task examples using a buyer operator resolve the same brand-owned
        // fixtures. Authenticated principals retain full operator isolation.
        operator: ctx.principal?.startsWith('static:')
          ? account.brand.domain
          : account.operator,
        sandbox: true,
      };
    } else {
      // Resolve first so an opaque ID is usable only by the principal that
      // owns that sandbox account. Keep the opaque identity for projection:
      // controller fixture writes are keyed by account_id, and resolving it
      // to a natural ref here would fork reads into a different partition.
      if (!sandboxAccountRefForId(account.account_id, ctx.principal)) return undefined;
      fixtureAccount = { account_id: account.account_id };
    }
  } catch {
    return undefined;
  }

  return sessionKeyFromArgs({
    account: fixtureAccount,
  }, ctx.mode, ctx.userId, ctx.moduleId, controllerFixturePrincipal(ctx.principal));
}

/** Clear the task store (for tests). Calls cleanup() to cancel TTL timers. */
export function clearTaskStore(): void {
  resetTrainingTaskStore();
  inMemoryTaskIdsByNaturalKey.clear();
}

/** Translate the agent's internal governance check shape into the wire-format
 * details block carried on a GOVERNANCE_DENIED error. Storyboards assert
 * `findings[]` and (when status is `conditions`) `conditions[]` on the error,
 * so surfacing them here is load-bearing. */
function governanceErrorDetails(check: import('./types.js').GovernanceCheckState): Record<string, unknown> {
  const details: Record<string, unknown> = {
    findings: check.findings.map(f => ({
      category_id: f.categoryId,
      severity: f.severity,
      explanation: f.explanation,
      ...(f.policyId && { policy_id: f.policyId }),
      ...(f.confidence !== undefined && { confidence: f.confidence }),
    })),
    plan_id: check.planId,
    check_id: check.checkId,
  };
  if (check.conditions?.length) {
    details.conditions = check.conditions.map(c => ({
      field: c.field,
      ...(c.requiredValue !== undefined && { required_value: c.requiredValue }),
      reason: c.reason,
    }));
  }
  return details;
}

/** Verify the signed authorization at the service boundary. */
async function governedCommitmentError(
  governanceContext: string,
  authenticatedCaller: string | undefined,
  expectedTool: string,
  expectedAudience: string,
  actualPayload: Record<string, unknown>,
  actualAmount: number,
  actualCurrency: string,
): Promise<TaskError | undefined> {
  const result = await verifyGovernedServiceAuthorization({
    token: governanceContext,
    expectedIssuer: `${getCanonicalBase()}/governance`,
    expectedTask: expectedTool,
    expectedAudience,
    payload: actualPayload,
    actualCommitment: { amount: actualAmount, currency: actualCurrency },
    authenticatedCaller,
  });
  return result.ok ? undefined : {
    code: 'PERMISSION_DENIED',
    message: result.message ?? 'The signed governance authorization is invalid.',
  };
}

function governedRequestPayload(
  ctx: TrainingContext,
  fallback: Record<string, unknown>,
): Record<string, unknown> {
  return ctx.requestInput ?? fallback;
}

function projectedPackageBudgetTotal(mb: MediaBuyState, req: UpdateMediaBuyArgs): number {
  const currentBudgets = new Map(
    mb.packages.map(pkg => [pkg.packageId, pkg.canceled ? 0 : pkg.budget]),
  );
  for (const update of req.packages ?? []) {
    const packageId = update.package_id;
    if (!packageId || !currentBudgets.has(packageId)) continue;
    if ((update as PackageUpdateExt).canceled === true) {
      currentBudgets.set(packageId, 0);
    } else if (update.budget !== undefined) {
      currentBudgets.set(packageId, update.budget);
    }
  }
  const nextExisting = [...currentBudgets.values()].reduce((sum, budget) => sum + budget, 0);
  const added = (req.new_packages ?? []).reduce((sum, pkg) => sum + pkg.budget, 0);
  return nextExisting + added;
}

function proportionalFixedPackageBudgets(
  mb: MediaBuyState,
  requestedTotal: number,
): { budgets?: Map<string, number>; error?: TaskError } {
  const activePackages = mb.packages.filter(pkg => !pkg.canceled);
  const currentTotal = activePackages.reduce((sum, pkg) => sum + pkg.budget, 0);
  if (
    activePackages.length === 0
    || !Number.isFinite(currentTotal)
    || currentTotal <= 0
    || activePackages.some(pkg => !Number.isFinite(pkg.budget) || pkg.budget <= 0)
  ) {
    return {
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Cannot proportionally update total_budget without positive, finite committed budgets on active packages.',
      },
    };
  }

  const budgets = new Map<string, number>();
  let allocated = 0;
  activePackages.forEach((pkg, index) => {
    const amount = index === activePackages.length - 1
      ? requestedTotal - allocated
      : requestedTotal * (pkg.budget / currentTotal);
    budgets.set(pkg.packageId, amount);
    allocated += amount;
  });
  return { budgets };
}

interface MediaBuyAggregateUpdate {
  total_budget?: { amount: number; currency: string };
  budget_allocation?: Record<string, unknown>;
  pacing?: string;
  bidding?: Record<string, unknown> | null;
}

function aggregateMediaBuyUpdate(req: UpdateMediaBuyArgs): MediaBuyAggregateUpdate {
  return req as unknown as MediaBuyAggregateUpdate;
}

function resultingMediaBuyIsSellerOptimized(mb: MediaBuyState, req: UpdateMediaBuyArgs): boolean {
  const update = aggregateMediaBuyUpdate(req);
  return (update.budget_allocation ?? mb.budgetAllocation)?.mode === 'seller_optimized';
}

function positiveMediaBuyUpdateDelta(mb: MediaBuyState, req: UpdateMediaBuyArgs): number {
  const packageBaseline = mb.packages.reduce(
    (sum, pkg) => sum + (pkg.canceled ? 0 : pkg.budget),
    0,
  );
  const baseline = mb.totalBudget ?? packageBaseline;
  const requestedTotal = aggregateMediaBuyUpdate(req).total_budget?.amount;
  // In seller-optimized mode package budgets are optional package caps, not
  // allocations. They may sum above the shared hard total, and changing them
  // MUST NOT silently replace or increase that total. Only an explicit
  // total_budget changes the shared monetary obligation.
  const nextTotal = requestedTotal
    ?? (resultingMediaBuyIsSellerOptimized(mb, req)
      ? baseline
      : projectedPackageBudgetTotal(mb, req));
  return Math.max(0, nextTotal - baseline);
}

function mediaBuyUpdateRequiresGovernance(mb: MediaBuyState, req: UpdateMediaBuyArgs, delta: number): boolean {
  if (delta > 0 || req.paused === false || (req.new_packages?.length ?? 0) > 0) return true;
  if (req.end_time && new Date(req.end_time) > new Date(mb.endTime)) return true;
  if ((req.packages ?? []).some(update => {
    const current = mb.packages.find(pkg => pkg.packageId === update.package_id);
    if (!current || !Object.prototype.hasOwnProperty.call(update, 'budget')) return false;
    const nextBudget = (update as unknown as { budget?: number | null }).budget;
    // Removing a seller-optimized cap or raising any package cap widens the
    // effective delivery envelope even when the shared/fixed aggregate total
    // stays flat. A pure numeric decrease remains the decrease_only exemption.
    return nextBudget === null
      || (typeof nextBudget === 'number' && nextBudget > current.budget);
  })) return true;
  const aggregateUpdate = aggregateMediaBuyUpdate(req);
  const currentAllocation = mb.budgetAllocation ?? { mode: 'fixed' };
  if (
    aggregateUpdate.budget_allocation !== undefined
    && !isDeepStrictEqual(aggregateUpdate.budget_allocation, currentAllocation)
  ) return true;
  if (
    aggregateUpdate.pacing !== undefined
    && aggregateUpdate.pacing !== (mb.aggregatePacing ?? 'even')
  ) return true;
  if (aggregateUpdate.bidding !== undefined) {
    const resultingBidding = aggregateUpdate.bidding === null ? undefined : aggregateUpdate.bidding;
    if (!isDeepStrictEqual(resultingBidding, mb.aggregateBidding)) return true;
  }
  return (req.packages ?? []).some(update =>
    update.paused === false
    || Boolean(update.targeting_overlay ?? (update as PackageUpdateExt).targeting)
    || Boolean(update.end_time && new Date(update.end_time) > new Date(
      mb.packages.find(pkg => pkg.packageId === update.package_id)?.endTime ?? mb.endTime,
    )));
}

/** Wire-format error shared by all training agent responses. */
interface TaskError {
  code: string;
  message: string;
  field?: string;
  details?: unknown;
  recovery?: string;
  source?: 'producer' | 'sdk';
  sdk_id?: string;
}

const RESPONSE_ENVELOPE_KEYS = new Set([
  'errors',
  'context',
  'ext',
  'status',
  'context_id',
  'task_id',
  'timestamp',
  'message',
  'replayed',
  'adcp_error',
  'push_notification_config',
  'governance_context',
  'adcp_version',
  'adcp_major_version',
]);

export function hasAdcpSuccessPayload(resultObj: Record<string, unknown> | undefined): boolean {
  if (!resultObj) return false;
  if (resultObj.status === 'submitted' && typeof resultObj.task_id === 'string') return true;
  return Object.keys(resultObj).some(key => !RESPONSE_ENVELOPE_KEYS.has(key) && resultObj[key] !== undefined);
}

function permitsAdvisoryErrors(toolName: string, resultObj: Record<string, unknown> | undefined): boolean {
  if (isProductDiscoveryTool(toolName)) return hasAdcpSuccessPayload(resultObj);
  if (toolName === 'create_media_buy') {
    return resultObj?.status === 'submitted' && typeof resultObj.task_id === 'string';
  }
  return false;
}

/** Signal deployment entry in get_signals response. */
interface SignalDeployment {
  type: 'agent' | 'platform';
  agent_url?: string;
  platform?: string;
  account?: string;
  is_live: boolean;
  activation_key?: { type: string; key: string; value: string };
  deployed_at?: string;
  estimated_activation_duration_minutes?: number;
}

/** Signal entry in get_signals response. */
interface SignalResponse {
  signal_agent_segment_id: string;
  signal_id: { source: string; data_provider_domain: string; id: string };
  name: string;
  description: string;
  value_type: string;
  signal_type: string;
  data_provider: string;
  coverage_percentage?: number;
  deployments: SignalDeployment[];
  pricing_options: SignalPricingOption[];
  categories?: string[];
  range?: { min: number; max: number };
}

/** Signal pricing option in get_signals response. */
interface SignalPricingOption {
  pricing_option_id: string;
  model: string;
  currency: string;
  cpm?: number;
  percent?: number;
  max_cpm?: number;
  amount?: number;
  period?: string;
}

/** Package delivery metrics in get_media_buy_delivery response. */
interface PackageDeliveryMetrics {
  package_id: string;
  spend: number;
  impressions: number;
  clicks: number;
  pricing_model: string;
  model: string;
  rate: number;
  currency: string;
  paused: boolean;
  delivery_status: 'delivering' | 'completed';
}

/** Creative variant in get_creative_delivery response. */
interface CreativeVariant {
  variant_id: string;
  generation_context: { context_type: string; topic: string; device_class: string };
  manifest: CreativeManifest;
  impressions: number;
  spend: number;
  clicks: number;
  ctr: number;
}

/** Creative delivery entry in get_creative_delivery response. */
interface CreativeDeliveryEntry {
  creative_id: string;
  media_buy_id?: string;
  format_id?: FormatID;
  format_kind?: string;
  format_option_ref?: Record<string, unknown>;
  totals: { impressions: number; spend: number; clicks: number; ctr: number };
  variant_count: number;
  variants: CreativeVariant[];
}

/** Sync creative result entry. */
interface SyncCreativeResult {
  creative_id: string;
  action: 'created' | 'updated' | 'failed';
  errors?: TaskError[];
}

/** Creative assignment result. */
interface AssignmentResult {
  creative_id: string;
  package_id: string;
  status: 'assigned' | 'error';
  message?: string;
}


const logger = createLogger('training-agent');

/** Map natural vocabulary to terms that match signal tags and descriptions. */
const SYNONYM_MAP: Record<string, string[]> = {
  geographic: ['geo'],
  geospatial: ['geo'],
  geofence: ['geo'],
  geofencing: ['geo'],
  geotargeting: ['geo'],
  audience: ['segment'],
  audiences: ['segment'],
  segments: ['segment'],
  location: ['geo', 'proximity'],
  locations: ['geo', 'proximity'],
  identity: ['demographic', 'identity'],
  identities: ['demographic', 'identity'],
  purchase: ['retail', 'purchase'],
  purchases: ['retail', 'purchase'],
  buying: ['retail', 'purchase'],
  automotive: ['automotive'],
  auto: ['automotive'],
  car: ['automotive'],
  vehicle: ['automotive'],
  cars: ['automotive'],
  vehicles: ['automotive'],
  mobility: ['geo', 'behavioral'],
  movement: ['geo', 'behavioral'],
  travel: ['geo', 'behavioral'],
  footfall: ['geo', 'foot_traffic'],
  targeting: ['targeting', 'target'],
  credit: ['demographic', 'financial', 'credit'],
  loyalty: ['retail', 'behavioral', 'loyalty'],
  attribution: ['measurement'],
  shopper: ['retail', 'purchase'],
  brand: ['brand', 'retail'],
  buyer: ['retail', 'purchase'],
  basket: ['retail', 'purchase'],
  conquest: ['conquest', 'acquisition'],
  affinity: ['loyalty', 'behavioral'],
  frequency: ['frequency', 'behavioral'],
  dwell: ['dwell', 'behavioral'],
  engagement: ['engagement', 'behavioral'],
  sentiment: ['contextual', 'sentiment'],
  household: ['household', 'demographic'],
  income: ['income', 'financial'],
  demographic: ['demographic', 'identity'],
  contextual: ['contextual', 'content'],
  subscriber: ['subscriber', 'engagement'],
};

/** Derive lifecycle status from stored status and flight dates. */
export function deriveStatus(mb: MediaBuyState, session?: SessionState): string {
  if (mb.canceledAt) return 'canceled';
  if (mb.status === 'rejected') return 'rejected';
  const needsCreative = session
    ? mb.packages.some(pkg => packageNeedsCreative(pkg, session))
    : mb.packages.some(pkg => pkg.creativeAssignments.length === 0);
  if (needsCreative && mb.status !== 'completed' && !mb.complyControllerForced) {
    return 'pending_creatives';
  }
  const now = new Date();
  if (mb.status === 'active' || mb.status === 'paused') {
    if (new Date(mb.endTime) < now) return 'completed';
    if (new Date(mb.startTime) > now) return 'pending_start';
  }
  if (mb.status === 'paused') return 'paused';
  return mb.status;
}

/** Map lifecycle status to valid buyer actions. */
function validActionsForStatus(status: string): string[] {
  switch (status) {
    case 'pending_creatives':
    case 'pending_start':
      return ['pause', 'cancel', 'sync_creatives'];
    case 'active':
      return ['pause', 'cancel', 'update_budget', 'update_dates', 'update_packages', 'add_packages', 'sync_creatives'];
    case 'paused':
      return ['resume', 'cancel', 'update_budget', 'update_dates', 'update_packages', 'add_packages', 'sync_creatives'];
    default:
      return [];
  }
}

function availableActionsForStatus(status: string, explicit?: MediaBuyAvailableActionState[]): MediaBuyAvailableActionState[] {
  if (explicit !== undefined) return explicit;
  return validActionsForStatus(status).map(action => ({
    action,
    mode: 'self_serve' as const,
  }));
}

const NON_TERMINAL_MEDIA_BUY_STATUSES = new Set(['pending_creatives', 'pending_start', 'active', 'paused']);

function hasLatentMediaBuyPause(mb: MediaBuyState, status: string): boolean {
  return mb.status === 'paused' && status !== 'paused' && NON_TERMINAL_MEDIA_BUY_STATUSES.has(status);
}

function validActionsForMediaBuy(mb: MediaBuyState, status: string): string[] {
  const actions = validActionsForStatus(status);
  if (!hasLatentMediaBuyPause(mb, status) || actions.includes('resume')) return actions;
  return ['resume', ...actions];
}

function allowedActionAppliesToStatus(action: MediaBuyProductAllowedActionState, status: string): boolean {
  if (action.allowed_statuses?.length) return action.allowed_statuses.includes(status);
  return NON_TERMINAL_MEDIA_BUY_STATUSES.has(status);
}

function normalizeProductAllowedActions(product: Product | undefined): MediaBuyProductAllowedActionState[] {
  const rawActions = (product as unknown as { allowed_actions?: unknown } | undefined)?.allowed_actions;
  if (!Array.isArray(rawActions)) return [];

  const normalized: MediaBuyProductAllowedActionState[] = [];
  const seen = new Set<string>();
  for (const rawAction of rawActions) {
    if (!rawAction || typeof rawAction !== 'object' || Array.isArray(rawAction)) continue;
    const src = rawAction as Record<string, unknown>;
    if (typeof src.action !== 'string' || seen.has(src.action)) continue;
    if (!Array.isArray(src.modes)) continue;
    const modes = src.modes.filter((mode): mode is MediaBuyAvailableActionState['mode'] =>
      mode === 'self_serve'
      || mode === 'conditional_self_serve'
      || mode === 'requires_approval',
    );
    if (modes.length === 0) continue;
    const sla = src.sla && typeof src.sla === 'object' && !Array.isArray(src.sla)
      ? src.sla as Record<string, unknown>
      : undefined;
    normalized.push({
      action: src.action,
      modes,
      ...(Array.isArray(src.allowed_statuses) && {
        allowed_statuses: src.allowed_statuses.filter(status => typeof status === 'string') as string[],
      }),
      ...(sla && {
        sla: {
          ...(typeof sla.response_max === 'string' && { response_max: sla.response_max }),
          ...(typeof sla.completion_max === 'string' && { completion_max: sla.completion_max }),
        },
      }),
      ...(typeof src.terms_ref === 'string' && { terms_ref: src.terms_ref }),
    });
    seen.add(src.action);
  }
  return normalized;
}

function deriveProductAllowedActionsForPackages(
  packages: PackageState[],
  productMap: Map<string, Product>,
): MediaBuyProductAllowedActionState[] | undefined {
  const actions: MediaBuyProductAllowedActionState[] = [];
  const seen = new Set<string>();
  for (const pkg of packages) {
    for (const action of normalizeProductAllowedActions(productMap.get(pkg.productId))) {
      if (seen.has(action.action)) continue;
      actions.push(action);
      seen.add(action.action);
    }
  }
  return actions.length ? actions : undefined;
}

function deriveAvailableActionsFromProductAllowedActions(
  allowedActions: MediaBuyProductAllowedActionState[] | undefined,
  status: string,
): MediaBuyAvailableActionState[] | undefined {
  if (!allowedActions) return undefined;
  return allowedActions
    .filter(action => allowedActionAppliesToStatus(action, status))
    .map(action => ({
      action: action.action,
      mode: action.modes[0],
      ...(action.sla && { sla: action.sla }),
      ...(action.terms_ref && { terms_ref: action.terms_ref }),
    }));
}

function availableActionsForMediaBuy(mb: MediaBuyState, status: string): MediaBuyAvailableActionState[] {
  const productDerived = deriveAvailableActionsFromProductAllowedActions(mb.productAllowedActions, status);
  const actions = productDerived !== undefined
    ? productDerived
    : availableActionsForStatus(status, mb.availableActions);
  if (!hasLatentMediaBuyPause(mb, status) || actions.some(action => action.action === 'resume')) return actions;
  return [{ action: 'resume', mode: 'self_serve' }, ...actions];
}

type AttemptedMediaBuyAction =
  | 'pause'
  | 'resume'
  | 'cancel'
  | 'extend_flight'
  | 'shorten_flight'
  | 'update_flight_dates'
  | 'increase_budget'
  | 'decrease_budget'
  | 'reallocate_budget'
  | 'update_targeting'
  | 'update_pacing'
  | 'update_frequency_caps'
  | 'replace_creative'
  | 'update_creative_assignments'
  | 'add_packages'
  | 'remove_packages';

interface AttemptedMediaBuyActionEntry {
  action: AttemptedMediaBuyAction;
  packageId?: string;
}

function actionsForUpdateRequest(mb: MediaBuyState, req: UpdateMediaBuyArgs): AttemptedMediaBuyActionEntry[] {
  const actions: AttemptedMediaBuyActionEntry[] = [];
  const seen = new Set<string>();
  const addAction = (action: AttemptedMediaBuyAction, packageId?: string) => {
    const key = `${packageId ?? '*'}:${action}`;
    if (seen.has(key)) return;
    seen.add(key);
    actions.push({ action, ...(packageId && { packageId }) });
  };

  if (req.paused === true) addAction('pause');
  if (req.paused === false) addAction('resume');
  if (req.canceled === true) addAction('cancel');

  const currentStart = new Date(mb.startTime).getTime();
  const currentEnd = new Date(mb.endTime).getTime();
  const requestedStart = req.start_time as unknown;
  if (typeof requestedStart === 'string') {
    const nextStart = new Date(requestedStart).getTime();
    if (!Number.isNaN(nextStart) && nextStart !== currentStart) addAction('update_flight_dates');
  } else if (requestedStart && typeof requestedStart === 'object' && typeof (requestedStart as { datetime?: unknown }).datetime === 'string') {
    const nextStart = new Date((requestedStart as { datetime: string }).datetime).getTime();
    if (!Number.isNaN(nextStart) && nextStart !== currentStart) addAction('update_flight_dates');
  }
  if (typeof req.end_time === 'string') {
    const nextEnd = new Date(req.end_time).getTime();
    if (!Number.isNaN(nextEnd)) {
      if (nextEnd > currentEnd) addAction('extend_flight');
      if (nextEnd < currentEnd) addAction('shorten_flight');
    }
  }

  if (req.packages?.length) {
    let totalBefore = 0;
    let totalAfter = 0;
    let sawBudget = false;
    for (const update of req.packages as PackageUpdateExt[]) {
      const pkgId = update.package_id || '';
      const pkg = mb.packages.find(p => p.packageId === pkgId);
      if (!pkg) continue;
      totalBefore += pkg.budget;
      totalAfter += update.budget ?? pkg.budget;
      if (update.budget !== undefined) {
        sawBudget = true;
        if (update.budget > pkg.budget) addAction('increase_budget', pkgId);
        if (update.budget < pkg.budget) addAction('decrease_budget', pkgId);
      }
      if (update.start_time) addAction('update_flight_dates', pkgId);
      if (update.end_time) {
        const currentPackageEnd = new Date(pkg.endTime).getTime();
        const nextPackageEnd = new Date(update.end_time).getTime();
        if (!Number.isNaN(nextPackageEnd)) {
          if (nextPackageEnd > currentPackageEnd) addAction('extend_flight', pkgId);
          if (nextPackageEnd < currentPackageEnd) addAction('shorten_flight', pkgId);
        }
      }
      if (update.targeting_overlay || update.targeting || update.keyword_targets_add || update.keyword_targets_remove || update.negative_keywords_add || update.negative_keywords_remove) addAction('update_targeting', pkgId);
      if (update.pacing) addAction('update_pacing', pkgId);
      if (
        update.targeting_overlay
        && typeof update.targeting_overlay === 'object'
        && 'frequency_cap' in (update.targeting_overlay as Record<string, unknown>)
      ) addAction('update_frequency_caps', pkgId);
      if (update.creative_assignments) addAction('update_creative_assignments', pkgId);
      if (update.creatives) addAction('replace_creative', pkgId);
      if (update.canceled === true) addAction('remove_packages', pkgId);
    }
    if (sawBudget && totalAfter === totalBefore && seenHasAction(seen, 'increase_budget') && seenHasAction(seen, 'decrease_budget')) {
      addAction('reallocate_budget');
    }
  }

  if (req.new_packages?.length) addAction('add_packages');
  return actions;
}

function seenHasAction(seen: Set<string>, action: AttemptedMediaBuyAction): boolean {
  for (const key of seen) {
    if (key.endsWith(`:${action}`)) return true;
  }
  return false;
}

function actionNotAllowedError(
  attemptedAction: string,
  reason: 'wrong_status' | 'not_supported_on_product' | 'not_supported_on_buy' | 'mode_mismatch',
  availableActions: MediaBuyAvailableActionState[],
  context?: unknown,
): { errors: TaskError[]; context?: unknown } {
  return {
    errors: [{
      code: 'ACTION_NOT_ALLOWED',
      message: `Action ${attemptedAction} is not available through direct update_media_buy`,
      recovery: reason === 'wrong_status' || reason === 'mode_mismatch' ? 'correctable' : 'terminal',
      details: {
        attempted_action: attemptedAction,
        reason,
        currently_available_actions: availableActions,
      },
    }],
    ...(context !== undefined && { context }),
  };
}

function rejectUnavailableAction(
  mb: MediaBuyState,
  req: UpdateMediaBuyArgs,
  status: string,
  productMap: Map<string, Product>,
): { errors: TaskError[]; context?: unknown } | null {
  if (!mb.productAllowedActions && !mb.availableActions) return null;

  const availableActions = availableActionsForMediaBuy(mb, status);
  for (const attempt of actionsForUpdateRequest(mb, req)) {
    const packageAllowedActions = attempt.packageId
      ? normalizeProductAllowedActions(productMap.get(mb.packages.find(pkg => pkg.packageId === attempt.packageId)?.productId ?? ''))
      : undefined;
    const scopedAvailableActions = packageAllowedActions
      ? deriveAvailableActionsFromProductAllowedActions(packageAllowedActions, status) ?? []
      : availableActions;
    const advertised = new Map(scopedAvailableActions.map(entry => [entry.action, entry]));
    const entry = advertised.get(attempt.action);
    if (!entry) {
      const productAction = packageAllowedActions
        ? packageAllowedActions.find(action => action.action === attempt.action)
        : mb.productAllowedActions?.find(action => action.action === attempt.action);
      const reason = productAction
        ? 'wrong_status'
        : packageAllowedActions || mb.productAllowedActions
          ? 'not_supported_on_product'
          : 'not_supported_on_buy';
      return actionNotAllowedError(attempt.action, reason, availableActions, req.context);
    }
    if (entry.mode !== 'self_serve' && entry.mode !== 'conditional_self_serve') {
      return actionNotAllowedError(attempt.action, 'mode_mismatch', availableActions, req.context);
    }
  }
  return null;
}

// ── Cached catalog and formats (built once at first use) ──────────
let cachedCatalog: CatalogProduct[] | null = null;
let cachedFormats: ReturnType<typeof buildFormats> | null = null;
let cachedProposals: import('@adcp/sdk').Proposal[] | null = null;

function getCatalog(): CatalogProduct[] {
  if (!cachedCatalog) cachedCatalog = buildCatalog();
  return cachedCatalog;
}

function getProposals(): import('@adcp/sdk').Proposal[] {
  if (!cachedProposals) cachedProposals = buildProposals(getCatalog());
  return cachedProposals;
}

function getFormats(): ReturnType<typeof buildFormats> {
  if (!cachedFormats) {
    cachedFormats = buildFormats(getAgentUrl());
  }
  return cachedFormats;
}

function requestedCreativeWireMode(args: Record<string, unknown>): CreativeFormatWireMode {
  const ext = args.ext as { adcp?: { creative_wire?: unknown } } | undefined;
  const explicit = ext?.adcp?.creative_wire;
  if (explicit === 'canonical' || explicit === 'legacy') return explicit;
  return typeof args.adcp_version === 'string' && args.adcp_version.startsWith('3.0')
    ? 'legacy'
    : 'unknown';
}

function formatProjectionCatalogs(): ProjectionCatalogSnapshot[] {
  const declarations = new Map<string, Record<string, unknown>>();
  for (const catalogProduct of getCatalog()) {
    for (const rawDeclaration of catalogProduct.product.format_options ?? []) {
      if (!isRecord(rawDeclaration)) continue;
      declarations.set(JSON.stringify(rawDeclaration), rawDeclaration);
    }
  }
  return [{
    source: 'configured',
    formats: [...declarations.values()] as unknown as ProjectionCatalogSnapshot['formats'],
  }];
}

function legacyFormatRef(value: unknown): FormatID | undefined {
  if (!isRecord(value) || typeof value.agent_url !== 'string' || typeof value.id !== 'string') return undefined;
  return {
    agent_url: value.agent_url,
    id: value.id,
    ...(typeof value.width === 'number' && Number.isFinite(value.width) && { width: value.width }),
    ...(typeof value.height === 'number' && Number.isFinite(value.height) && { height: value.height }),
    ...(typeof value.duration_ms === 'number' && Number.isFinite(value.duration_ms) && { duration_ms: value.duration_ms }),
  };
}

function canonicalFormatKind(value: unknown): CanonicalFormatKind | undefined {
  switch (value) {
    case 'image':
    case 'html5':
    case 'display_tag':
    case 'image_carousel':
    case 'video_hosted':
    case 'video_vast':
    case 'audio_hosted':
    case 'audio_daast':
    case 'sponsored_placement':
    case 'native_in_feed':
    case 'responsive_creative':
    case 'agent_placement':
    case 'custom':
      return value;
    default:
      return undefined;
  }
}

function requestScopedLegacyRoutes(selector: Readonly<Record<string, unknown>>): CanonicalFormatLegacyRoute[] | undefined {
  const productId = typeof selector.product_id === 'string' ? selector.product_id : undefined;
  let hasRequestScopedDeclarations = false;
  const mappedDeclarations: V2ProductFormatDeclaration[] = [];
  for (const field of ['formats_to_provide', 'formats_pending'] as const) {
    const declarations = selector[field];
    if (!Array.isArray(declarations)) continue;
    hasRequestScopedDeclarations = true;
    for (const declaration of declarations) {
      if (
        !isRecord(declaration)
        || declaration.canonical_formats_only === true
        || !Array.isArray(declaration.v1_format_ref)
      ) continue;
      const formatKind = canonicalFormatKind(declaration.format_kind);
      const formatOptionId = typeof declaration.format_option_id === 'string'
        ? declaration.format_option_id
        : undefined;
      if (!formatKind || !formatOptionId) continue;
      const refs: FormatID[] = [];
      for (const value of declaration.v1_format_ref) {
        const ref = legacyFormatRef(value);
        if (!ref) continue;
        refs.push(ref);
      }
      if (refs.length === 0) continue;
      mappedDeclarations.push({
        format_kind: formatKind,
        params: isRecord(declaration.params) ? declaration.params : {},
        format_option_id: formatOptionId,
        ...(typeof declaration.publisher_domain === 'string' && { publisher_domain: declaration.publisher_domain }),
        v1_format_ref: refs,
      });
    }
  }
  if (!hasRequestScopedDeclarations) return undefined;
  return productId ? legacyRoutesForProduct(productId, mappedDeclarations) : [];
}

export const trainingCatalogLegacyResolver: CanonicalFormatLegacyResolver = context => {
  if (context.source !== 'product') {
    // The platform response carries the exact declarations selected for this
    // package. Prefer their serializable v1_format_ref sidecars over a global
    // catalog lookup: seeded storyboard products are request-scoped and may
    // not exist in the configured training catalog.
    const requestScopedRoutes = requestScopedLegacyRoutes(context.selector);
    if (requestScopedRoutes !== undefined) {
      return canonicalFormatLegacyResolverFromRoutes(requestScopedRoutes)(context);
    }
  }
  const candidate = context.source === 'creative'
    ? context.creative.format_option_ref
    : context.source === 'selector'
      ? context.selector.format_option_ref
      : undefined;
  if (!isRecord(candidate) || typeof candidate.format_option_id !== 'string') return undefined;

  const matches = new Map<string, FormatID>();
  for (const catalogProduct of getCatalog()) {
    for (const rawDeclaration of catalogProduct.product.format_options ?? []) {
      if (!isRecord(rawDeclaration) || rawDeclaration.format_option_id !== candidate.format_option_id) continue;
      if (candidate.scope === 'publisher') {
        if (rawDeclaration.publisher_domain !== candidate.publisher_domain) continue;
      } else if (candidate.scope === 'product' && rawDeclaration.publisher_domain !== undefined) {
        continue;
      }
      for (const ref of Array.isArray(rawDeclaration.v1_format_ref) ? rawDeclaration.v1_format_ref : []) {
        if (!isRecord(ref) || typeof ref.id !== 'string') continue;
        const typedRef = ref as FormatID;
        matches.set(JSON.stringify(typedRef), typedRef);
      }
    }
  }
  return matches.size === 1 ? [...matches.values()][0] : undefined;
};

/** Project a raw compatibility response to the wire arm explicitly requested by the caller. */
export function projectGetProductsCompatibilityWire(
  response: { products?: Product[]; [key: string]: unknown },
  args: Record<string, unknown>,
): unknown {
  const wireMode = requestedCreativeWireMode(args);
  if (wireMode === 'unknown') return response;
  if (wireMode === 'canonical') return toCanonicalOnlyResponse(response as never).response;

  const products = (response.products ?? []).flatMap(product => {
    if (!Array.isArray(product.format_ids) || product.format_ids.length === 0) return [];
    const { format_options: _formatOptions, ...legacyProduct } = product as Product & { format_options?: unknown };
    return [legacyProduct as Product];
  });
  return { ...response, products };
}

/**
 * Preserve stored identity for ambiguous 3.1 callers, and use exact catalog
 * aliases only when a caller explicitly asks for the other wire generation.
 */
export function projectListCreativesCompatibilityWire<T extends {
  creatives?: Array<Record<string, unknown>>;
  errors?: unknown[];
  query_summary?: Record<string, unknown>;
}>(response: T, args: Record<string, unknown>): T {
  const wireMode = requestedCreativeWireMode(args);
  if (wireMode === 'unknown' || !Array.isArray(response.creatives)) return response;

  const adapters = creativeProjectionAdapters();
  const projected: Array<Record<string, unknown>> = [];
  const projectionErrors: unknown[] = [];
  for (const creative of response.creatives) {
    try {
      projected.push(projectCreativeRecordForWire(creative, wireMode, adapters));
    } catch (error) {
      projectionErrors.push({
        code: 'FORMAT_PROJECTION_FAILED',
        message: error instanceof Error ? error.message : 'Creative format projection failed',
        recovery: 'correctable',
      });
    }
  }
  return {
    ...response,
    creatives: projected,
    ...(response.query_summary && {
      query_summary: { ...response.query_summary, returned: projected.length },
    }),
    ...(projectionErrors.length > 0 && { errors: [...(response.errors ?? []), ...projectionErrors] }),
  };
}

type CreativeProjectionAdapters = {
  legacyFormatConverter: ReturnType<typeof legacyFormatConverterFromCatalogSnapshots>;
  canonicalFormatLegacyResolver: ReturnType<typeof canonicalFormatLegacyResolverFromCatalogSnapshots>;
};

export function creativeProjectionAdapters(): CreativeProjectionAdapters {
  const catalogs = formatProjectionCatalogs();
  return {
    legacyFormatConverter: legacyFormatConverterFromCatalogSnapshots(catalogs),
    canonicalFormatLegacyResolver: canonicalFormatLegacyResolverFromCatalogSnapshots(
      catalogs,
      trainingCatalogLegacyResolver,
    ),
  };
}

function projectCreativeRecordForWire(
  creative: Record<string, unknown>,
  wireMode: Exclude<CreativeFormatWireMode, 'unknown'>,
  adapters: CreativeProjectionAdapters,
): Record<string, unknown> {
  if (wireMode === 'legacy' && isRecord(creative.format_id)) return creative;
  if (wireMode === 'canonical' && typeof creative.format_kind === 'string') return creative;
  return projectCreativeForDelivery(
    creative as never,
    {
      ...(typeof creative.format_kind === 'string' && { format_kind: creative.format_kind }),
      ...(isRecord(creative.format_option_ref) && { format_option_refs: [creative.format_option_ref] }),
    },
    wireMode,
    'list_creatives',
    adapters.legacyFormatConverter,
    adapters.canonicalFormatLegacyResolver,
  ) as Record<string, unknown>;
}

/** Invalidate cached catalog/formats (for tests or hot-reload) */
export function invalidateCache(): void {
  cachedCatalog = null;
  cachedFormats = null;
  cachedProposals = null;
}

/**
 * Canonicalize an agent URL for equality comparison: lowercase scheme + host,
 * strip default port, strip a single trailing slash, preserve path case.
 * Used both for `format_id.agent_url` (does this point at this agent?) and
 * for cross-checking buyer-supplied `verify_agent.agent_url` against the
 * seller's `creative_policy.accepted_verifiers` allowlist (per the rule
 * inlined into provenance.json: lowercase scheme and host, strip default
 * port, normalize path dot-segments).
 */
function canonicalizeAgentUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hostname = u.hostname.toLowerCase();
    u.protocol = u.protocol.toLowerCase();
    const s = u.toString();
    return s.endsWith('/') ? s.slice(0, -1) : s;
  } catch {
    return url.replace(/\/$/, '');
  }
}

/**
 * Backfill required Product fields for *fixture-seeded* products only.
 * Catalog products are guaranteed complete by `buildCatalog`, so we never
 * mutate them — that would alias the cached singleton across every
 * subsequent request (`getCatalog().map(cp => ({...cp.product}))` is a
 * shallow copy; `format_ids[]` and `reporting_capabilities` are shared
 * references). Restrict to seeded IDs to keep the cache pristine.
 *
 * Defaults are sentinel values that pass spec validation; storyboards
 * that need specific values still seed them explicitly via the fixture.
 * `publisher_domain: 'training.example.com'` uses the IETF reserved
 * `example.*` namespace (RFC 6761) — it cannot collide with a real
 * publisher claim, but is still a sentinel: if any consumer of
 * `publisher_properties` ever resolves the domain (DNS, brand.json
 * fetch), the resolution will fail loudly rather than silently match an
 * arbitrary domain.
 */
function backfillTrainingProductDefaults(product: Product, ownAgentUrl: string): void {
  const p = product as unknown as {
    product_id?: string;
    name?: string;
    description?: string;
    publisher_properties?: Array<{ publisher_domain: string; selection_type: string }>;
    format_ids?: Array<{ agent_url?: string; id?: string }>;
    format_options?: unknown[];
    pricing_options?: unknown[];
    reporting_capabilities?: Record<string, unknown>;
  };
  if ((!Array.isArray(p.format_ids) || p.format_ids.length === 0) && (!Array.isArray(p.format_options) || p.format_options.length === 0)) {
    p.format_options = [{
      format_kind: 'image',
      format_option_id: 'fixture_default_image_300x250',
      params: { width: 300, height: 250 },
    }];
  } else {
    for (const fid of p.format_ids ?? []) {
      if (typeof fid === 'object' && fid !== null && !fid.agent_url) {
        fid.agent_url = ownAgentUrl;
      }
    }
  }
  if (typeof p.name !== 'string' || p.name.length === 0) {
    p.name = p.product_id ?? 'Test Product';
  }
  if (typeof p.description !== 'string' || p.description.length === 0) {
    p.description = `Fixture-seeded product ${p.product_id ?? ''}`.trim();
  }
  if (!Array.isArray(p.publisher_properties) || p.publisher_properties.length === 0) {
    p.publisher_properties = [{ publisher_domain: 'training.example.com', selection_type: 'all' }];
  }
  if (!Array.isArray(p.pricing_options) || p.pricing_options.length === 0) {
    p.pricing_options = [{ pricing_option_id: 'fixture_default_cpm', pricing_model: 'cpm', currency: 'USD', rate: 5 }];
  }
  // reporting_capabilities is required and has six required sub-fields. Fill
  // each missing sub-field individually so fixtures that seed *some* (e.g.,
  // available_metrics, vendor_metrics) don't fail validation on the rest.
  const rc = (p.reporting_capabilities ?? {}) as Record<string, unknown>;
  if (!Array.isArray(rc.available_reporting_frequencies) || (rc.available_reporting_frequencies as unknown[]).length === 0) {
    rc.available_reporting_frequencies = ['daily'];
  }
  if (typeof rc.expected_delay_minutes !== 'number') rc.expected_delay_minutes = 60;
  if (typeof rc.timezone !== 'string') rc.timezone = 'UTC';
  if (typeof rc.supports_webhooks !== 'boolean') rc.supports_webhooks = false;
  if (!Array.isArray(rc.available_metrics)) rc.available_metrics = ['impressions', 'spend'];
  if (typeof rc.date_range_support !== 'string') rc.date_range_support = 'date_range';
  p.reporting_capabilities = rc;
}

// ── Provenance enforcement (creative_policy) ──────────────────────

interface AcceptedVerifierEntry {
  agent_url: string;
  feature_id?: string;
  providers?: string[];
}

interface ProvenanceRequirements {
  require_digital_source_type?: boolean;
  require_disclosure_metadata?: boolean;
  require_embedded_provenance?: boolean;
}

interface CreativePolicyView {
  provenance_required?: boolean;
  provenance_requirements?: ProvenanceRequirements;
  accepted_verifiers?: AcceptedVerifierEntry[];
}

/**
 * Aggregate `creative_policy` across the session's seeded products. The
 * training agent applies the most-restrictive aggregation: if any product
 * in the session demands a field, every `sync_creatives` submission is
 * checked against that field. Mirrors how a real seller would treat a
 * buyer's creative library — if the buyer might assign the creative to
 * any product whose policy requires `disclosure`, the disclosure must be
 * present on submission.
 *
 * Field-aggregation directions are deliberately asymmetric:
 *   - Requirement booleans (`provenance_required`, `require_*`) are
 *     ORed across products — most-restrictive wins because they're
 *     gates the buyer must clear.
 *   - `accepted_verifiers[]` is UNIONed across products — least-
 *     restrictive wins because it's an allowlist. A buyer pointing at a
 *     verifier accepted by *any* of the seller's products in this
 *     session passes the cross-check.
 * That's allowlists union, gates intersect — the standard pattern.
 *
 * Returns `null` when no seeded product carries provenance policy. Pre-
 * existing storyboards that don't seed provenance fields keep their
 * "accept everything" behavior; only storyboards seeding policy fields
 * trigger enforcement.
 */
function aggregateCreativePolicy(session: import('./types.js').SessionState): CreativePolicyView | null {
  const { seededProducts } = session.complyExtensions;
  if (seededProducts.size === 0) return null;
  const acc: CreativePolicyView = {};
  let anyPolicy = false;
  for (const fixture of seededProducts.values()) {
    const policy = (fixture as { creative_policy?: CreativePolicyView } | undefined)?.creative_policy;
    if (!policy) continue;
    anyPolicy = true;
    if (policy.provenance_required) acc.provenance_required = true;
    if (policy.provenance_requirements) {
      acc.provenance_requirements = acc.provenance_requirements ?? {};
      const req = policy.provenance_requirements;
      if (req.require_digital_source_type) acc.provenance_requirements.require_digital_source_type = true;
      if (req.require_disclosure_metadata) acc.provenance_requirements.require_disclosure_metadata = true;
      if (req.require_embedded_provenance) acc.provenance_requirements.require_embedded_provenance = true;
    }
    if (policy.accepted_verifiers?.length) {
      acc.accepted_verifiers = acc.accepted_verifiers ?? [];
      acc.accepted_verifiers.push(...policy.accepted_verifiers);
    }
  }
  return anyPolicy ? acc : null;
}

interface CreativeManifestView {
  provenance?: Record<string, unknown>;
  assets?: Record<string, { provenance?: Record<string, unknown> }>;
}

interface CreativeForEnforcement {
  creative_id: string;
  provenance?: Record<string, unknown>;
  // sync_creatives carries assets directly on the creative entry
  // (alongside format_id, click_url, etc.).
  assets?: Record<string, { url?: unknown; provenance?: Record<string, unknown> }>;
  manifest?: CreativeManifestView;
  // build_creative / preview_creative use the nested `creative_manifest`
  // shape per the spec; sync_creatives does not.
  creative_manifest?: CreativeManifestView;
}

/**
 * Resolve the manifest-level provenance for enforcement. Walks the spec's
 * inheritance chain: most-specific wins, replace-not-merge. Asset-level
 * overrides exist on the spec but the storyboard exercises manifest-level
 * provenance; this implementation checks the manifest level first and
 * falls back to creative-asset-level. Asset-level overrides aren't yet
 * exercised by conformance, so they're not aggregated here.
 */
function resolveManifestProvenance(creative: CreativeForEnforcement): Record<string, unknown> | undefined {
  const manifest = creative.creative_manifest ?? creative.manifest;
  return manifest?.provenance ?? creative.provenance;
}

/**
 * Clamp a buyer-supplied string before interpolating it into an error
 * message or field path. Strips C0 controls (newlines, tabs, NUL,
 * escape sequences) and caps length so log/transcript consumers that
 * render the message in a terminal or HTML pane don't get poisoned by
 * an attacker-shaped value. Length cap is generous enough to fit any
 * legitimate URL or creative_id but small enough to bound an abusive
 * payload's blast radius.
 */
function sanitizeForError(value: string, maxLen = 256): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\x00-\x1F\x7F]/g, '').slice(0, maxLen);
}

/**
 * Build a `TaskError` for a structural-rejection PROVENANCE_* code.
 */
function provenanceError(
  code:
    | 'PROVENANCE_REQUIRED'
    | 'PROVENANCE_DIGITAL_SOURCE_TYPE_MISSING'
    | 'PROVENANCE_DISCLOSURE_MISSING'
    | 'PROVENANCE_EMBEDDED_MISSING'
    | 'PROVENANCE_VERIFIER_NOT_ACCEPTED'
    | 'PROVENANCE_CLAIM_CONTRADICTED',
  message: string,
  field: string,
): TaskError {
  return { code, message, field, recovery: 'correctable' } as TaskError;
}

/**
 * Apply seller-side `creative_policy` enforcement to a single creative
 * submission. Returns the first PROVENANCE_* error if any check fails, plus
 * any non-blocking audit observations returned by the verifier.
 *
 * Cascade order (stable; storyboard assertions on `errors[0]` rely on it):
 *   1. PROVENANCE_REQUIRED                       — provenance object absent
 *   2. PROVENANCE_DIGITAL_SOURCE_TYPE_MISSING    — required field absent
 *   3. PROVENANCE_DISCLOSURE_MISSING             — required field absent
 *   4. PROVENANCE_EMBEDDED_MISSING               — required field absent
 *   5. PROVENANCE_VERIFIER_NOT_ACCEPTED          — verify_agent off-list
 *
 * Reordering this cascade would change the first-error a buyer sees on a
 * creative that fails multiple checks — keep it stable. If a future
 * implementation accumulates errors instead of returning the first, the
 * order above is the canonical priority for sorting.
 *
 * The truth-of-claim and audit-observation surfaces call `get_creative_features`
 * against an on-list verifier after structural checks pass.
 */
async function enforceProvenancePolicy(
  creative: CreativeForEnforcement,
  policy: CreativePolicyView | null,
): Promise<{ error: TaskError | null; auditObservations: CreativeAuditObservation[] }> {
  if (!policy) return { error: null, auditObservations: [] };
  const provenance = resolveManifestProvenance(creative);
  // creative_id is buyer-controlled — sanitize before interpolating into
  // the field path so a payload with newlines or oversized strings can't
  // poison the path a downstream consumer renders.
  const safeId = sanitizeForError(creative.creative_id, 128);
  const fieldRoot = `creatives[${safeId}].creative_manifest.provenance`;

  // 1. provenance_required — any provenance object must exist
  if (policy.provenance_required && !provenance) {
    return { error: provenanceError(
      'PROVENANCE_REQUIRED',
      `Seller's creative_policy.provenance_required is true; the submitted creative has no provenance object on the manifest.`,
      `creatives[${safeId}].creative_manifest`,
    ), auditObservations: [] };
  }

  // 2. require_digital_source_type
  if (policy.provenance_requirements?.require_digital_source_type) {
    const dst = provenance?.digital_source_type;
    if (dst === undefined || dst === null) {
      return { error: provenanceError(
        'PROVENANCE_DIGITAL_SOURCE_TYPE_MISSING',
        `Seller requires digital_source_type but the resolved provenance has none.`,
        `${fieldRoot}.digital_source_type`,
      ), auditObservations: [] };
    }
  }

  // 3. require_disclosure_metadata: disclosure.required must be a boolean,
  //    and when true at least one disclosure.jurisdictions entry expected.
  if (policy.provenance_requirements?.require_disclosure_metadata) {
    const disclosure = provenance?.disclosure as { required?: unknown; jurisdictions?: unknown[] } | undefined;
    if (!disclosure || typeof disclosure.required !== 'boolean') {
      return { error: provenanceError(
        'PROVENANCE_DISCLOSURE_MISSING',
        `Seller requires disclosure metadata but the resolved provenance has no disclosure.required boolean.`,
        `${fieldRoot}.disclosure`,
      ), auditObservations: [] };
    }
    if (disclosure.required === true && (!Array.isArray(disclosure.jurisdictions) || disclosure.jurisdictions.length === 0)) {
      return { error: provenanceError(
        'PROVENANCE_DISCLOSURE_MISSING',
        `Seller requires disclosure metadata; disclosure.required is true but disclosure.jurisdictions is empty.`,
        `${fieldRoot}.disclosure.jurisdictions`,
      ), auditObservations: [] };
    }
  }

  // 4. require_embedded_provenance — at least one entry
  if (policy.provenance_requirements?.require_embedded_provenance) {
    const embedded = provenance?.embedded_provenance;
    if (!Array.isArray(embedded) || embedded.length === 0) {
      return { error: provenanceError(
        'PROVENANCE_EMBEDDED_MISSING',
        `Seller requires embedded_provenance but the resolved provenance has none.`,
        `${fieldRoot}.embedded_provenance`,
      ), auditObservations: [] };
    }
  }

  // 5. accepted_verifiers cross-check on every embedded_provenance[].verify_agent
  //    and watermarks[].verify_agent reference. Buyer-supplied agent_urls MUST
  //    canonicalize-match an entry in the seller's allowlist before the seller
  //    would call them. Off-list URLs are rejected without any outbound call.
  if (policy.accepted_verifiers?.length) {
    const allowed = new Set(policy.accepted_verifiers.map(v => canonicalizeAgentUrl(v.agent_url)));
    type LayerWithVerifyAgent = { verify_agent?: { agent_url?: unknown } };
    const layers: Array<{ kind: 'embedded_provenance' | 'watermarks'; index: number; entry: LayerWithVerifyAgent }> = [];
    const embedded = provenance?.embedded_provenance;
    if (Array.isArray(embedded)) {
      embedded.forEach((entry, index) => layers.push({ kind: 'embedded_provenance', index, entry: entry as LayerWithVerifyAgent }));
    }
    const watermarks = provenance?.watermarks;
    if (Array.isArray(watermarks)) {
      watermarks.forEach((entry, index) => layers.push({ kind: 'watermarks', index, entry: entry as LayerWithVerifyAgent }));
    }
    for (const layer of layers) {
      const url = layer.entry.verify_agent?.agent_url;
      if (typeof url !== 'string' || url.length === 0) continue;
      if (!allowed.has(canonicalizeAgentUrl(url))) {
        // `url` is buyer-controlled — sanitize before interpolation so a
        // payload with newlines / ANSI escapes / oversized strings can't
        // poison the message a downstream consumer renders. The field path
        // is server-constructed from constants (no buyer data), so it's safe.
        return { error: provenanceError(
          'PROVENANCE_VERIFIER_NOT_ACCEPTED',
          `Buyer's verify_agent.agent_url "${sanitizeForError(url)}" is not in the seller's accepted_verifiers list.`,
          `${fieldRoot}.${layer.kind}[${layer.index}].verify_agent.agent_url`,
        ), auditObservations: [] };
      }
    }
  }

  // 6. Truth-of-claim: invoke the verifier when accepted_verifiers is set
  //    and reconcile its result against the buyer's digital_source_type
  //    claim. Closes adcp#3802. Returns the verifier-emitted contradiction
  //    metadata (audit-safe allowlist only — no detail_url, no extension
  //    fields) for error.details.
  const { contradiction, auditObservations } = await runProvenanceVerifier(creative, policy);
  if (contradiction) {
    const err = provenanceError(
      'PROVENANCE_CLAIM_CONTRADICTED',
      `Verifier ${sanitizeForError(contradiction.agent_url, 256)} (feature ${sanitizeForError(contradiction.feature_id, 64)}) returned ai_generated=${contradiction.observed_value} with confidence ${contradiction.confidence.toFixed(2)} — contradicts buyer claim digital_source_type="${sanitizeForError(contradiction.claimed_value, 64)}".`,
      `${fieldRoot}.digital_source_type`,
    );
    (err as TaskError & { details?: Record<string, unknown> }).details = {
      agent_url: contradiction.agent_url,
      feature_id: contradiction.feature_id,
      claimed_value: contradiction.claimed_value,
      observed_value: contradiction.observed_value,
      confidence: contradiction.confidence,
      ...(contradiction.substituted_for ? { substituted_for: contradiction.substituted_for } : {}),
    };
    return { error: err, auditObservations };
  }

  return { error: null, auditObservations };
}

/**
 * Merge products and pricing options seeded via comply_test_controller
 * (`seed_product`, `seed_pricing_option`) into the in-memory product map
 * used for create/validate flows. Seeded fixtures are permissive objects
 * (spec: additionalProperties: true) — we synthesize the minimum shape
 * the handlers consult (pricing_options with pricing_model/floor_price/
 * fixed_price/etc) so fixture-driven storyboards can reference products
 * that don't live in the static catalog.
 *
 * The overlay also runs `backfillTrainingProductDefaults` on each seeded
 * entry so missing required Product fields don't fail response-schema
 * validation when get_products serializes them. Catalog products in the
 * map are left untouched — `getCatalog().map(cp => ({...cp.product}))`
 * is a shallow copy whose nested arrays/objects (`format_ids[]`,
 * `reporting_capabilities`, ...) alias the cached catalog singleton, so
 * mutating them would leak across requests. Restricting backfill to
 * seeded IDs keeps the cache pristine.
 */
function overlaySeededProducts(
  session: import('./types.js').SessionState,
  productMap: Map<string, import('@adcp/sdk').LegacyProduct>,
): void {
  const { seededProducts, seededPricingOptions } = session.complyExtensions;
  if (seededProducts.size === 0 && seededPricingOptions.size === 0) return;

  const pricingByProduct = new Map<string, Array<Record<string, unknown>>>();
  for (const [key, pxFx] of seededPricingOptions) {
    const sep = key.indexOf(':');
    const productId = sep > 0 ? key.slice(0, sep) : key;
    const list = pricingByProduct.get(productId) ?? [];
    list.push(pxFx);
    pricingByProduct.set(productId, list);
  }

  const productIds = new Set<string>([
    ...seededProducts.keys(),
    ...pricingByProduct.keys(),
  ]);
  const ownAgentUrl = getAgentUrl();
  for (const productId of productIds) {
    const existing = productMap.get(productId) ?? {} as Partial<Product>;
    const fixture = seededProducts.get(productId) as Partial<Product> | undefined;
    const seededPricing = pricingByProduct.get(productId);
    let merged = mergeSeedProduct(existing as Partial<Product>, fixture ?? null);
    merged = { ...merged, product_id: productId } as Partial<Product>;
    if (seededPricing && seededPricing.length > 0) {
      merged = mergeSeedProduct(merged, {
        pricing_options: seededPricing as unknown as Product['pricing_options'],
      });
    }
    backfillTrainingProductDefaults(merged as Product, ownAgentUrl);
    productMap.set(productId, merged as Product);
  }
}

/** Overlay proposal-specific pricing created by successful refine asks. */
function overlayNegotiatedPricingOptions(
  session: import('./types.js').SessionState,
  productMap: Map<string, Product>,
): void {
  for (const { productId, option } of session.negotiatedPricingOptions.values()) {
    const product = productMap.get(productId);
    if (!product) continue;
    const pricingOptions = [...product.pricing_options];
    const existingIndex = pricingOptions.findIndex(
      candidate => candidate.pricing_option_id === option.pricing_option_id,
    );
    if (existingIndex >= 0) {
      pricingOptions[existingIndex] = option;
    } else {
      pricingOptions.push(option);
    }
    productMap.set(productId, { ...product, pricing_options: pricingOptions });
  }
}

function seededProductIds(session: import('./types.js').SessionState): Set<string> {
  const ids = new Set<string>(session.complyExtensions.seededProducts.keys());
  for (const key of session.complyExtensions.seededPricingOptions.keys()) {
    const sep = key.indexOf(':');
    ids.add(sep > 0 ? key.slice(0, sep) : key);
  }
  return ids;
}

type CanonicalFormatRef = { agent_url?: string; id?: string };
type CanonicalFormatOption = {
  format_option_id?: string;
  format_kind?: string;
  v1_format_ref?: CanonicalFormatRef[];
};

function collectCanonicalFormatAdvisories(products: Product[]): TaskError[] {
  const errors: TaskError[] = [];

  for (let productIndex = 0; productIndex < products.length; productIndex++) {
    const product = products[productIndex] as Product & {
      format_ids?: CanonicalFormatRef[];
      format_options?: CanonicalFormatOption[];
    };
    if (!Array.isArray(product.format_ids) || !Array.isArray(product.format_options)) continue;
    if (product.format_ids.length === 0 || product.format_options.length === 0) continue;

    const declaredRefs = new Set(
      product.format_ids
        .filter((ref): ref is Required<CanonicalFormatRef> =>
          typeof ref.agent_url === 'string' && typeof ref.id === 'string',
        )
        .map(ref => `${canonicalizeAgentUrl(ref.agent_url)}#${ref.id}`),
    );
    const missingRefs: Array<{
      format_option_index: number;
      ref_index: number;
      agent_url: string;
      id: string;
      format_option_id?: string;
      format_kind?: string;
    }> = [];

    product.format_options.forEach((option, optionIndex) => {
      if (!Array.isArray(option.v1_format_ref)) return;
      option.v1_format_ref.forEach((ref, refIndex) => {
        if (typeof ref.agent_url !== 'string' || typeof ref.id !== 'string') return;
        const key = `${canonicalizeAgentUrl(ref.agent_url)}#${ref.id}`;
        if (!declaredRefs.has(key)) {
          const missingRef: (typeof missingRefs)[number] = {
            format_option_index: optionIndex,
            ref_index: refIndex,
            agent_url: ref.agent_url,
            id: ref.id,
          };
          if (typeof option.format_option_id === 'string') {
            missingRef.format_option_id = option.format_option_id;
          }
          if (typeof option.format_kind === 'string') {
            missingRef.format_kind = option.format_kind;
          }
          missingRefs.push(missingRef);
        }
      });
    });

    if (missingRefs.length > 0) {
      errors.push({
        code: 'FORMAT_DECLARATION_DIVERGENT',
        message: `Product ${product.product_id} dual-emits format_options v1_format_ref entries that are absent from format_ids.`,
        field: `products[${productIndex}].format_options`,
        recovery: 'correctable',
        source: 'producer',
        details: {
          product_id: product.product_id,
          divergence_reason: 'v1_format_ref_not_declared_on_product',
          missing_refs: missingRefs,
        },
      });
    }
  }

  return errors;
}

function packageHasMetricGoal(pkg: PackageInput, metrics: readonly string[]): boolean {
  const goals = (pkg as unknown as { optimization_goals?: unknown }).optimization_goals;
  if (!Array.isArray(goals)) return false;
  return goals.some(goal => (
    isRecord(goal)
    && goal.kind === 'metric'
    && typeof goal.metric === 'string'
    && metrics.includes(goal.metric)
  ));
}

// ── Channel aliases for brief matching (module-scoped for perf) ──

const BRIEF_CHANNEL_ALIASES: Record<string, string> = {
  'ctv': 'ctv', 'connected tv': 'ctv', 'ott': 'ctv',
  'olv': 'olv', 'online video': 'olv', 'pre-roll': 'olv', 'preroll': 'olv',
  'display': 'display', 'banner': 'display',
  'social': 'social', 'social media': 'social',
  'native': 'native',
  'audio': 'streaming_audio', 'streaming audio': 'streaming_audio', 'podcast': 'podcast',
  'search': 'search', 'sem': 'search',
  'linear tv': 'linear_tv', 'linear': 'linear_tv',
  'dooh': 'dooh', 'digital out of home': 'dooh',
  'gaming': 'gaming', 'in-game': 'gaming',
  'email': 'email', 'newsletter': 'email',
  'print': 'print',
  'influencer': 'influencer',
  'radio': 'radio',
};

// Vendor-metric briefs often ask for a measurement outcome (emissions,
// brand lift, attention) rather than the literal field name. Score against
// each product's declared vendor metrics so the named vendor/metric pair wins
// even when the product card text has no ordinary keyword overlap.
function inferVendorMetricBriefTerms(domain: string, metricId: string): string[] {
  const identity = `${domain} ${metricId} ${metricId.replace(/[_-]+/g, ' ')}`;
  const terms = new Set<string>();

  if (/(attention|focus)/.test(identity)) terms.add('attention');
  if (/(gco2e|co2|carbon|emission|scope3|sustainability)/.test(identity)) {
    terms.add('emission');
    terms.add('emissions');
    terms.add('carbon');
    terms.add('scope3');
    terms.add('sustainability');
  }
  if (/(brand.?lift|awareness|incremental|panel)/.test(identity)) {
    terms.add('brand lift');
    terms.add('brand-lift');
    terms.add('awareness');
    terms.add('incremental');
    terms.add('panel');
  }

  return [...terms];
}

function vendorMetricBriefScore(product: Product, briefLower: string): number {
  const supportedMetrics = (product as Product & { vendor_metric_optimization?: VendorMetricOptimizationView })
    .vendor_metric_optimization?.supported_metrics;
  if (!supportedMetrics?.length) return 0;

  let bestScore = 0;
  for (const metric of supportedMetrics) {
    const domain = typeof metric.vendor?.domain === 'string' ? metric.vendor.domain.toLowerCase() : '';
    const metricId = typeof metric.metric_id === 'string' ? metric.metric_id.toLowerCase() : '';
    const metricPhrase = metricId.replace(/[_-]+/g, ' ');
    const categoryTerms = inferVendorMetricBriefTerms(domain, metricId);

    let score = 0;
    if (domain && briefLower.includes(domain)) score += 14;
    if (metricId && (briefLower.includes(metricId) || briefLower.includes(metricPhrase))) score += 14;
    if (categoryTerms.some(term => briefLower.includes(term))) {
      score += 6;
    }
    if (briefLower.includes('vendor metric') || briefLower.includes('vendor-metric')) score += 2;
    bestScore = Math.max(bestScore, score);
  }

  return bestScore;
}

// ── Shared schema fragments ──────────────────────────────────────

const FORMAT_ID_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    agent_url: { type: 'string', format: 'uri' },
    id: { type: 'string', pattern: '^[a-zA-Z0-9_-]+$' },
    width: { type: 'integer', minimum: 1 },
    height: { type: 'integer', minimum: 1 },
    duration_ms: { type: 'number', minimum: 1 },
  },
  required: ['agent_url', 'id'],
  dependencies: {
    width: ['height'],
    height: ['width'],
  },
} as const;

// Tools whose response schema defines an Error variant at top level
// (oneOf success | {errors: [...]}). Handler-returned errors are placed
// in the response body rather than wrapped in an MCP isError envelope,
// matching spec-compliant agents and allowing field_present validations
// on the errors array.
const ERROR_IN_BODY_TOOLS = new Set<string>([
  'update_media_buy',
  // activate_signal errors (e.g. GOVERNANCE_DENIED) are returned in body
  // on the legacy /mcp path. The v6 per-tenant path handles this in
  // v6-platform.ts:activateSignal directly (translateV5Result bypass).
  'activate_signal',
]);

function accountDomain(account: AccountRef | undefined): string | undefined {
  if (!account || typeof account !== 'object') return undefined;
  const brand = (account as { brand?: { domain?: unknown } }).brand;
  return typeof brand?.domain === 'string' ? brand.domain : undefined;
}

function accountId(account: AccountRef | undefined): string | undefined {
  if (!account || typeof account !== 'object') return undefined;
  const value = (account as { account_id?: unknown }).account_id;
  return typeof value === 'string' ? value : undefined;
}

function cacheScopeForWholesaleRequest(req: WholesaleFeedRequest): 'public' | 'account' {
  const domain = accountDomain(req.account);
  const id = accountId(req.account);
  // The reference training agent models public-rate-card accounts by default
  // and reserves one deterministic account identity for account-overlay
  // storyboards. Production sellers use their real account pricing state.
  return domain === 'account-overlay.example' || id === 'acct_account_overlay'
    ? 'account'
    : 'public';
}

function stableMapDigest(map: Map<string, Record<string, unknown>>): string {
  if (map.size === 0) return 'base';
  const entries = [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex').slice(0, 16);
}

function productWholesaleFeedMeta(req: WholesaleFeedRequest, session: SessionState): WholesaleFeedMeta {
  const seededProductsRevision = stableMapDigest(session.complyExtensions.seededProducts);
  const seededPricingRevision = stableMapDigest(session.complyExtensions.seededPricingOptions);
  const cacheScope = cacheScopeForWholesaleRequest(req);
  // Tokens are scope-keyed: the same feed state yields a distinct token per
  // cache_scope so a token minted under one scope never short-circuits a probe
  // the seller resolves to another. See media-buy/get-products-response.json#unchanged.
  return {
    wholesale_feed_version: `${PRODUCT_WHOLESALE_FEED_VERSION}.${cacheScope}.${seededProductsRevision}`,
    pricing_version: `${PRODUCT_WHOLESALE_PRICING_VERSION}.${cacheScope}.${seededPricingRevision}`,
    cache_scope: cacheScope,
  };
}

function signalWholesaleFeedMeta(req: WholesaleFeedRequest): WholesaleFeedMeta {
  const cacheScope = cacheScopeForWholesaleRequest(req);
  // Tokens are scope-keyed: the same feed state yields a distinct token per
  // cache_scope so a token minted under one scope never short-circuits a probe
  // the agent resolves to another. See signals/get-signals-response.json#unchanged.
  return {
    wholesale_feed_version: `${SIGNAL_WHOLESALE_FEED_VERSION}.${cacheScope}`,
    pricing_version: `${SIGNAL_WHOLESALE_PRICING_VERSION}.${cacheScope}`,
    cache_scope: cacheScope,
  };
}

function wholesaleFeedUnchanged(req: WholesaleFeedRequest, meta: WholesaleFeedMeta): boolean {
  return req.if_wholesale_feed_version === meta.wholesale_feed_version
    && (req.if_pricing_version === undefined || req.if_pricing_version === meta.pricing_version);
}

function wholesaleCapabilityProfile(ctx: TrainingContext): {
  productWholesale: boolean;
  signalWholesale: boolean;
  eventTypes: string[];
} {
  if (ctx.storyboardCompat?.version === '3.0') {
    return {
      productWholesale: false,
      signalWholesale: false,
      eventTypes: [],
    };
  }
  const productWholesale = ctx.tenantId === undefined || ctx.tenantId === 'sales';
  const signalWholesale = ctx.tenantId === undefined || ctx.tenantId === 'signals';
  return {
    productWholesale,
    signalWholesale,
    eventTypes: [
      ...(productWholesale ? PRODUCT_WHOLESALE_FEED_WEBHOOK_EVENT_TYPES : []),
      ...(signalWholesale ? SIGNAL_WHOLESALE_FEED_WEBHOOK_EVENT_TYPES : []),
      ...(productWholesale || signalWholesale ? ['wholesale_feed.bulk_change'] : []),
    ],
  };
}

export function supportedCanonicalFormatsCapability(): Array<Record<string, unknown>> {
  return SUPPORTED_CANONICAL_BUILD_CAPABILITIES.map(({ capabilityId, formatKind }) => ({
    capability_id: capabilityId,
    operations: ['build', 'validate', 'preview'],
    format: {
      format_kind: formatKind,
      params: {
        slots: CANONICAL_FORMAT_SLOTS[formatKind].map(slot => ({ ...slot })),
      },
    },
  }));
}

function supportedCanonicalBuildCapability(formatId: string): { formatKind: string; slots: CanonicalSlot[] } | undefined {
  const capability = SUPPORTED_CANONICAL_BUILD_CAPABILITIES.find(item => item.capabilityId === formatId);
  if (!capability) return undefined;
  const { formatKind } = capability;
  const slots = CANONICAL_FORMAT_SLOTS[formatKind];
  return slots ? { formatKind, slots } : undefined;
}

function nativeInFeedValidationError(creative: { format_id?: FormatID; assets?: Record<string, unknown> }): TaskError | null {
  if (creative.format_id?.id !== 'native_in_feed') return null;
  const assets = creative.assets;
  if (!assets || typeof assets !== 'object' || Array.isArray(assets)) return null;

  const title = assets.title as { content?: unknown } | undefined;
  if (typeof title?.content === 'string' && title.content.length > 80) {
    return {
      code: 'VALIDATION_ERROR',
      message: 'native_in_feed title exceeds title_max_chars (80).',
      field: 'creatives[0].assets.title.content',
      recovery: 'correctable',
    };
  }

  const mainImage = assets.main_image as { width?: unknown; height?: unknown } | undefined;
  if (
    mainImage
    && !(
      (mainImage.width === 1200 && mainImage.height === 627)
      || (mainImage.width === 1080 && mainImage.height === 1080)
    )
  ) {
    return {
      code: 'VALIDATION_ERROR',
      message: 'native_in_feed main_image size must be one of 1200x627 or 1080x1080.',
      field: 'creatives[0].assets.main_image',
      recovery: 'correctable',
      details: { allowed_sizes: [{ width: 1200, height: 627 }, { width: 1080, height: 1080 }] },
    };
  }

  const cta = assets.cta as { content?: unknown } | undefined;
  if (typeof cta?.content === 'string') {
    const allowed = ['LEARN_MORE', 'SHOP_NOW', 'SIGN_UP', 'DOWNLOAD', 'APPLY_NOW'];
    if (!allowed.includes(cta.content)) {
      return {
        code: 'CREATIVE_VALUE_NOT_ALLOWED',
        message: `native_in_feed cta value "${cta.content}" is not allowed.`,
        field: 'creatives[0].assets.cta.content',
        recovery: 'correctable',
        details: { allowed_values: allowed },
      };
    }
  }

  for (const [assetName, asset] of Object.entries(assets)) {
    const record = asset as { asset_type?: unknown; event?: unknown; custom_event_name?: unknown };
    if (
      record?.asset_type === 'pixel_tracker'
      && record.event === 'custom'
      && typeof record.custom_event_name !== 'string'
    ) {
      return {
        code: 'VALIDATION_ERROR',
        message: 'native_in_feed pixel_tracker event=custom requires custom_event_name.',
        field: `creatives[0].assets.${assetName}.custom_event_name`,
        recovery: 'correctable',
      };
    }
  }

  return null;
}

function signalMatchesRef(
  signal: ReturnType<typeof getAllSignals>[number],
  ref: Record<string, unknown>,
  signalSourceUrl: string,
): boolean {
  const signalId = typeof ref.signal_id === 'string' ? ref.signal_id : undefined;
  if (!signalId || signalId !== signal.signalAgentSegmentId) return false;
  if (ref.scope === 'data_provider') {
    return ref.data_provider_domain === signal.providerDomain;
  }
  if (ref.scope === 'signal_source') {
    return ref.signal_source_url === signalSourceUrl;
  }
  if (ref.scope === 'product') {
    return true;
  }
  return false;
}

// ── Tool definitions ──────────────────────────────────────────────

const PRODUCT_DISCOVERY_TOOLS = new Set([
  'get_products',
  'list_products',
  'request_proposals',
  'refine_proposals',
  'decline_proposals',
]);

function isProductDiscoveryTool(toolName: string): boolean {
  return PRODUCT_DISCOVERY_TOOLS.has(toolName);
}

function compactBrandScope(brand: unknown): string | undefined {
  if (!isRecord(brand) || typeof brand.domain !== 'string' || brand.domain.length === 0) return undefined;
  const brandId = typeof brand.brand_id === 'string' ? brand.brand_id : '';
  const countries = Array.isArray(brand.countries)
    ? brand.countries.filter((country): country is string => typeof country === 'string').sort()
    : [];
  return `b:${brand.domain.toLowerCase()}#${brandId}${countries.length ? `@${countries.join(',')}` : ''}`;
}

function productDiscoverySourceSchemaName(toolName: string): string | undefined {
  switch (toolName) {
    case 'list_products': return 'list-products-request';
    case 'request_proposals': return 'request-proposals-request';
    case 'refine_proposals': return 'refine-proposals-request';
    case 'decline_proposals': return 'decline-proposals-request';
    default: return undefined;
  }
}

export function canonicalProductDiscoveryTool(toolName: string): string {
  return isProductDiscoveryTool(toolName) ? 'get_products' : toolName;
}

function expandProductDiscoveryCriteria(criteria: unknown): Record<string, unknown> {
  if (!isRecord(criteria)) return {};
  const {
    offer_filters: filters,
    policy_ids: requiredPolicies,
    ...rest
  } = criteria;
  return {
    ...rest,
    ...(filters !== undefined && { filters }),
    ...(requiredPolicies !== undefined && { required_policies: requiredPolicies }),
  };
}

function expandProductDiscoveryIdentity(args: Record<string, unknown>): Record<string, unknown> {
  const { account_id: accountId, ...rest } = args;
  return {
    ...rest,
    ...(typeof accountId === 'string' && { account: { account_id: accountId } }),
  };
}

/** Envelope fields are accepted uniformly on every AdCP call but are not part
 * of the legacy get_products domain payload. Dispatch retains the original
 * wire args for source validation and idempotency equivalence. */
function stripProductDiscoveryEnvelope(args: Record<string, unknown>): Record<string, unknown> {
  const {
    context: _context,
    context_id: _contextId,
    governance_context: _governanceContext,
    push_notification_config: _pushNotificationConfig,
    ...domainArgs
  } = args;
  return domainArgs;
}

/** Normalize the compact 3.2 tools into the legacy get_products handler shape.
 * The split operations retain distinct idempotency identities and project
 * task-specific responses; this adapter exists only for 3.x implementation
 * reuse. */
export function normalizeProductDiscoveryArgs(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const domainArgs = isProductDiscoveryTool(toolName)
    ? stripProductDiscoveryEnvelope(args)
    : args;
  if (toolName === 'list_products') {
    const {
      criteria,
      cursor,
      max_results: maxResults,
      if_feed_version: ifFeedVersion,
      ...rest
    } = expandProductDiscoveryIdentity(domainArgs);
    return {
      ...rest,
      ...expandProductDiscoveryCriteria(criteria),
      ...(cursor !== undefined || maxResults !== undefined
        ? { pagination: { ...(cursor !== undefined && { cursor }), ...(maxResults !== undefined && { max_results: maxResults }) } }
        : {}),
      ...(ifFeedVersion !== undefined && { if_wholesale_feed_version: ifFeedVersion }),
      buying_mode: 'wholesale',
    };
  }
  if (toolName === 'request_proposals') {
    const { criteria, ...rest } = expandProductDiscoveryIdentity(domainArgs);
    return {
      ...rest,
      ...expandProductDiscoveryCriteria(criteria),
      buying_mode: 'brief',
      __compact_proposal_lifecycle: true,
      __require_proposals: true,
    };
  }
  if (toolName === 'refine_proposals') {
    const { refinements, ...rest } = domainArgs;
    return {
      ...rest,
      buying_mode: 'refine',
      __compact_proposal_lifecycle: true,
      __immutable_refine: true,
      refine: Array.isArray(refinements)
        ? refinements.map(entry => {
            if (!isRecord(entry)) return entry;
            return {
              scope: 'proposal',
              proposal_id: entry.proposal_id,
              action: entry.action === 'finalize' ? 'finalize' : 'include',
              ...(entry.action !== 'finalize' && isRecord(entry.constraints) && { constraints: entry.constraints }),
              ...(entry.action !== 'finalize' && isRecord(entry.product_changes) && { product_changes: entry.product_changes }),
              ...(entry.action !== 'finalize' && isRecord(entry.alternatives) && { alternatives: entry.alternatives }),
              ...(entry.action !== 'finalize' && isRecord(entry.criteria) && { criteria: entry.criteria }),
              ...(entry.action !== 'finalize'
                && typeof entry.ask === 'string'
                && { ask: entry.ask }),
              ...(entry.action !== 'finalize'
                && (entry.change_kind === 'amendment' || entry.change_kind === 'cancellation')
                && { change_kind: entry.change_kind }),
            };
          })
        : [],
    };
  }
  if (toolName === 'decline_proposals') {
    const { declines, ...rest } = domainArgs;
    return {
      ...rest,
      buying_mode: 'refine',
      __compact_proposal_lifecycle: true,
      __decline_proposals: true,
      refine: Array.isArray(declines)
        ? declines.map(entry => {
            if (!isRecord(entry)) return entry;
            return {
              scope: 'proposal',
              proposal_id: entry.proposal_id,
              action: 'decline',
              reason: entry.reason,
              ...(typeof entry.detail === 'string' && { detail: entry.detail }),
            };
          })
        : [],
    };
  }
  return args;
}

function supportingProductsForProposals(
  proposals: Array<Record<string, unknown>>,
  products: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const referenced = new Set<string>();
  for (const proposal of proposals) {
    const commercialTerms = isRecord(proposal.commercial_terms) ? proposal.commercial_terms : undefined;
    const selections = Array.isArray(commercialTerms?.purchases)
      ? commercialTerms.purchases
      : Array.isArray(proposal.allocations) ? proposal.allocations : [];
    for (const allocation of selections) {
      if (isRecord(allocation) && typeof allocation.product_id === 'string') {
        referenced.add(allocation.product_id);
      }
    }
  }
  return products.filter(product => typeof product.product_id === 'string' && referenced.has(product.product_id));
}

const CANONICAL_PRICING_FIELDS = [
  'pricing_option_id', 'pricing_model', 'currency', 'price_guidance',
  'min_spend_per_package', 'price_breakdown', 'eligible_adjustments',
  'parameters', 'event_type', 'custom_event_name', 'event_source_id',
  'commission_rate', 'commission_basis_description',
] as const;

function canonicalPricingSnapshot(raw: unknown, pricingOptionId: string): Record<string, unknown> {
  const source = isRecord(raw) ? raw : {};
  const snapshot: Record<string, unknown> = {};
  for (const field of CANONICAL_PRICING_FIELDS) {
    if (source[field] !== undefined) snapshot[field] = structuredClone(source[field]);
  }
  snapshot.pricing_option_id = pricingOptionId;
  if (typeof snapshot.pricing_model !== 'string') snapshot.pricing_model = 'cpm';
  if (typeof snapshot.currency !== 'string') snapshot.currency = 'USD';
  // A selected fixed price supersedes an auction floor in the canonical
  // snapshot; the schema intentionally forbids carrying both.
  if (typeof source.fixed_price === 'number') snapshot.fixed_price = source.fixed_price;
  else if (typeof source.floor_price === 'number') snapshot.floor_price = source.floor_price;
  return snapshot;
}

function proposalTermsDigest(commercialTerms: Record<string, unknown>): string {
  return `sha256:${createHash('sha256').update(canonicalize(commercialTerms), 'utf8').digest('base64url')}`;
}

function buildCanonicalCommercialTerms(
  proposal: Proposal,
  products: Map<string, Product>,
  brand: { domain: string; brand_id?: string; countries?: string[] },
): Record<string, unknown> {
  const internal = proposal as unknown as Record<string, unknown>;
  if (isRecord(internal.__canonical_commercial_terms)) {
    return structuredClone(internal.__canonical_commercial_terms);
  }
  const startTime = typeof internal.__commercial_start_time === 'string'
    ? internal.__commercial_start_time
    : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const endTime = typeof internal.__commercial_end_time === 'string'
    ? internal.__commercial_end_time
    : new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString();
  const recommendedBudget = proposal.total_budget_guidance?.recommended;
  const currency = proposal.total_budget_guidance?.currency ?? 'USD';
  const purchases = proposal.allocations.map(allocation => {
    const product = products.get(allocation.product_id)
      ?? getCatalog().find(entry => entry.product.product_id === allocation.product_id)?.product;
    const pricingOptionId = allocation.pricing_option_id
      ?? product?.pricing_options?.[0]?.pricing_option_id
      ?? `${allocation.product_id}_pricing`;
    const pricing = product?.pricing_options?.find(option => option.pricing_option_id === pricingOptionId)
      ?? product?.pricing_options?.[0];
    return {
      product_id: allocation.product_id,
      pricing_option_id: pricingOptionId,
      pricing: canonicalPricingSnapshot(pricing, pricingOptionId),
      start_time: startTime,
      end_time: endTime,
      ...(typeof recommendedBudget === 'number' && {
        budget: recommendedBudget * allocation.allocation_percentage / 100,
      }),
      ...(isRecord((product as unknown as Record<string, unknown> | undefined)?.measurement_terms)
        && { measurement_terms: structuredClone((product as unknown as Record<string, unknown>).measurement_terms) }),
      ...(Array.isArray((product as unknown as Record<string, unknown> | undefined)?.performance_standards)
        && { performance_standards: structuredClone((product as unknown as Record<string, unknown>).performance_standards) }),
    };
  });
  return {
    brand,
    purchases,
    start_time: startTime,
    end_time: endTime,
    ...(typeof recommendedBudget === 'number' && {
      total_budget: { amount: recommendedBudget, currency },
    }),
  };
}

function withCanonicalProposalEnvelope(
  proposal: Proposal,
  products: Map<string, Product>,
  brand: { domain: string; brand_id?: string; countries?: string[] },
  options: { rebuild?: boolean } = {},
): Proposal {
  const internal = { ...proposal } as unknown as Record<string, unknown>;
  if (options.rebuild) {
    delete internal.__canonical_commercial_terms;
    delete internal.__canonical_terms_digest;
  }
  internal.__commercial_start_time ??= new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  internal.__commercial_end_time ??= new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString();
  internal.__proposal_kind ??= 'new_media_buy';
  const commercialTerms = buildCanonicalCommercialTerms(internal as unknown as Proposal, products, brand);
  internal.__canonical_commercial_terms = commercialTerms;
  internal.__canonical_terms_digest = proposalTermsDigest(commercialTerms);
  return internal as unknown as Proposal;
}

function compactCanonicalProduct(product: Record<string, unknown>): Record<string, unknown> {
  return {
    product_id: product.product_id,
    name: product.name,
  };
}

function outwardProposal(proposal: Record<string, unknown>, products: Map<string, Product>): Record<string, unknown> {
  const brand = {
    domain: typeof proposal.__brand_domain === 'string' ? proposal.__brand_domain : 'advertiser.example',
    ...(typeof proposal.__brand_id === 'string' && { brand_id: proposal.__brand_id }),
    ...(Array.isArray(proposal.__brand_countries) && { countries: proposal.__brand_countries }),
  };
  const terms = isRecord(proposal.__canonical_commercial_terms)
    ? structuredClone(proposal.__canonical_commercial_terms)
    : buildCanonicalCommercialTerms(proposal as unknown as Proposal, products, brand);
  const status = proposalLifecycle(proposal as unknown as Proposal).proposal_status ?? 'draft';
  return {
    proposal_id: proposal.proposal_id,
    proposal_kind: typeof proposal.__proposal_kind === 'string' ? proposal.__proposal_kind : 'new_media_buy',
    ...(typeof proposal.__parent_proposal_id === 'string' && { parent_proposal_id: proposal.__parent_proposal_id }),
    ...(typeof proposal.__media_buy_id === 'string' && { media_buy_id: proposal.__media_buy_id }),
    ...(typeof proposal.__base_media_buy_revision === 'number' && { base_media_buy_revision: proposal.__base_media_buy_revision }),
    ...(typeof proposal.__opportunity_id === 'string' && { opportunity_id: proposal.__opportunity_id }),
    proposal_status: status,
    ...(status === 'accepted' && typeof proposal.__accepted_at === 'string' && { accepted_at: proposal.__accepted_at }),
    ...(typeof proposal.expires_at === 'string' && { expires_at: proposal.expires_at }),
    name: proposal.name,
    ...(typeof proposal.description === 'string' && { description: proposal.description }),
    ...(typeof proposal.brief_alignment === 'string' && { brief_alignment: proposal.brief_alignment }),
    commercial_terms: terms,
    terms_digest: typeof proposal.__canonical_terms_digest === 'string'
      ? proposal.__canonical_terms_digest
      : proposalTermsDigest(terms),
    ...(isRecord(proposal.insertion_order) && { insertion_order: proposal.insertion_order }),
  };
}

/** Project the broad 3.x handler result into the compact split-tool domain
 * response. The idempotency store keeps the canonical result; projection is
 * applied after replay lookup so each tool retains its own wire contract. */
export function projectProductDiscoveryResult(
  toolName: string,
  result: Record<string, unknown>,
  originalArgs: Record<string, unknown>,
): Record<string, unknown> {
  if (!isProductDiscoveryTool(toolName) || toolName === 'get_products') return result;
  if (Array.isArray(result.errors) && result.errors.length > 0 && !Array.isArray(result.products)) return result;
  if (toolName === 'refine_proposals' && Array.isArray(result.results)) return result;
  if (toolName === 'request_proposals' && result.status === 'rejected') {
    return {
      outcome: 'rejected',
      ...(typeof result.reason === 'string' && { reason: result.reason }),
      ...(Array.isArray(result.suggestions) && { suggestions: result.suggestions }),
    };
  }

  let products = Array.isArray(result.products)
    ? result.products.filter(isRecord)
    : [];
  const proposalProducts = new Map(products
    .filter((product): product is Record<string, unknown> & { product_id: string } => typeof product.product_id === 'string')
    .map(product => [product.product_id, product as unknown as Product]));
  let proposals = Array.isArray(result.proposals)
    ? result.proposals.filter(isRecord)
    : [];
  const criteria = isRecord(originalArgs.criteria) ? originalArgs.criteria : undefined;
  const requestedProductIds = criteria && Array.isArray(criteria.product_ids)
    ? new Set(criteria.product_ids.filter((id): id is string => typeof id === 'string'))
    : undefined;
  if (requestedProductIds) {
    products = products.filter(product => (
      typeof product.product_id === 'string' && requestedProductIds.has(product.product_id)
    ));
    if (toolName === 'request_proposals') {
      proposals = proposals.filter(proposal => (
        Array.isArray(proposal.allocations)
        && proposal.allocations.every(allocation => (
          isRecord(allocation)
          && typeof allocation.product_id === 'string'
          && requestedProductIds.has(allocation.product_id)
        ))
      ));
    }
  }

  if (toolName === 'list_products') {
    if (result.unchanged === true) {
      return {
        outcome: 'unchanged',
        ...(typeof result.wholesale_feed_version === 'string' && { feed_version: result.wholesale_feed_version }),
        ...(typeof result.pricing_version === 'string' && { pricing_version: result.pricing_version }),
        ...(typeof result.cache_scope === 'string' && { cache_scope: result.cache_scope }),
      };
    }
    const pagination = isRecord(result.pagination) ? result.pagination : undefined;
    return {
      outcome: 'listed',
      products,
      ...(pagination && typeof pagination.cursor === 'string' && { next_cursor: pagination.cursor }),
      ...(typeof result.wholesale_feed_version === 'string' && { feed_version: result.wholesale_feed_version }),
      ...(typeof result.pricing_version === 'string' && { pricing_version: result.pricing_version }),
      ...(typeof result.cache_scope === 'string' && { cache_scope: result.cache_scope }),
      ...(Array.isArray(result.incomplete) && { incomplete: result.incomplete }),
    };
  }

  if (toolName === 'request_proposals') {
    const outwardProposals = proposals.map(proposal => outwardProposal(proposal, proposalProducts));
    const supportingProducts = supportingProductsForProposals(outwardProposals, products).map(compactCanonicalProduct);
    return {
      outcome: 'proposed',
      proposals: outwardProposals,
      products: supportingProducts,
      ...(isRecord(result.targeting_resolution) && { targeting_resolution: result.targeting_resolution }),
    };
  }

  if (toolName === 'refine_proposals') {
    const requestedRefinements = Array.isArray(originalArgs.refinements)
      ? originalArgs.refinements.filter(isRecord)
      : [];
    const sourceIds = requestedRefinements
      .map(entry => entry.proposal_id)
      .filter((id): id is string => typeof id === 'string');
    const requestBySource = new Map(requestedRefinements
      .filter((entry): entry is Record<string, unknown> & { proposal_id: string } => typeof entry.proposal_id === 'string')
      .map(entry => [entry.proposal_id, entry] as const));
    const proposalsBySource = new Map(proposals.map(proposal => [
      proposal.__source_proposal_id,
      proposal,
    ]));
    const outwardProposals = Array.from(proposalsBySource.values())
      .map(proposal => outwardProposal(proposal, proposalProducts));
    return {
      results: sourceIds.map(sourceProposalId => {
        const request = requestBySource.get(sourceProposalId);
        const internalProposal = proposalsBySource.get(sourceProposalId);
        const proposal = internalProposal && outwardProposal(internalProposal, proposalProducts);
        const isFinalize = request?.action === 'finalize';
        const constraints = isRecord(request?.constraints) ? request.constraints : undefined;
        const hasTypedRevision = constraints !== undefined
          || isRecord(request?.product_changes)
          || isRecord(request?.alternatives);
        const hasNonAlternativeTypedRevision = constraints !== undefined
          || isRecord(request?.product_changes);
        const requestedAlternativeCount = isRecord(request?.alternatives)
          && typeof request.alternatives.count === 'number'
          ? request.alternatives.count
          : undefined;
        const outcome = isFinalize
          ? 'finalized'
          : internalProposal?.__refinement_outcome === 'partial' || hasTypedRevision ? 'partial' : 'revised';
        if (!proposal) {
          return {
            source_proposal_id: sourceProposalId,
            outcome: 'unable',
            reason_code: 'source_unavailable',
            reason: 'The source proposal was not found or could not be revised under the requested terms.',
          };
        }
        if (outcome === 'finalized') {
          return {
            source_proposal_id: sourceProposalId,
            outcome,
            proposal,
          };
        }
        if (outcome === 'partial') {
          const reasonCode = hasNonAlternativeTypedRevision
            ? 'unsupported_dimension'
            : requestedAlternativeCount !== undefined && requestedAlternativeCount > 1
              ? 'alternatives_unavailable'
              : hasTypedRevision ? 'unsupported_dimension' : 'uninterpreted';
          return {
            source_proposal_id: sourceProposalId,
            outcome,
            proposals: [proposal],
            reason_code: reasonCode,
            reason: reasonCode === 'alternatives_unavailable'
              ? `The training agent produced 1 of ${requestedAlternativeCount} requested alternatives.`
              : typeof internalProposal?.__refinement_notes === 'string'
                ? internalProposal.__refinement_notes
                : reasonCode === 'unsupported_dimension'
                  ? 'The training agent does not implement the requested typed refinement dimension.'
                  : 'The training agent could not fully interpret the free-text ask.',
          };
        }
        return {
          source_proposal_id: sourceProposalId,
          outcome,
          proposals: [proposal],
        };
      }),
      products: supportingProductsForProposals(outwardProposals, products).map(compactCanonicalProduct),
    };
  }
  if (toolName === 'decline_proposals') {
    const requestedDeclines = Array.isArray(originalArgs.declines)
      ? originalArgs.declines.filter(isRecord)
      : [];
    const proposalsById = new Map(proposals.map(proposal => [proposal.proposal_id, proposal]));
    return {
      results: requestedDeclines.map(decline => {
        const proposalId = typeof decline.proposal_id === 'string' ? decline.proposal_id : '';
        const proposal = proposalsById.get(proposalId);
        return proposal?.__declined === true
          ? { proposal_id: proposalId, outcome: 'declined' }
          : {
              proposal_id: proposalId,
              outcome: 'unable',
              reason: 'The proposal was not found or could not be declined by this authenticated principal.',
            };
      }),
    };
  }
  return result;
}

/** Compact proposal operations address proposals by opaque ID under the
 * authenticated principal. They deliberately do not repeat account or brand
 * on every lifecycle call. The legacy facade retains its account-derived
 * session partition for 3.x compatibility. */
function productDiscoverySessionKey(args: ToolArgs, ctx: TrainingContext): string {
  const compactLifecycle = (args as unknown as Record<string, unknown>).__compact_proposal_lifecycle === true;
  if (compactLifecycle) {
    return sessionKeyFromArgs({}, ctx.mode, ctx.userId, ctx.moduleId, ctx.principal ?? 'anonymous');
  }
  return getProductsSessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId);
}

function idempotencyPayloadForServedVersion(
  toolName: string,
  args: Record<string, unknown>,
  servedAdcpVersion: string,
): Record<string, unknown> {
  if (
    isProductDiscoveryTool(toolName)
    && args.adcp_version === undefined
    && args.adcp_major_version === undefined
  ) {
    // The legacy facade defaults to 3.0 while split names default to 3.2.
    // Bind an omitted caller pin to the effective release so those distinct
    // wire contracts conflict instead of replaying a response across versions.
    return {
      ...args,
      adcp_version: servedAdcpVersion,
      ...(toolName !== 'get_products' && { __adcp_operation: toolName }),
    };
  }
  return toolName === 'get_products' ? args : { ...args, __adcp_operation: toolName };
}

export function validateProductDiscoveryAliasInput(
  toolName: string,
  args: Record<string, unknown>,
): { message: string; field?: string; code?: 'UNSUPPORTED_FEATURE' } | undefined {
  if (args.account !== undefined && !isRecord(args.account)) {
    return { message: 'account must be an object', field: 'account' };
  }
  const account = isRecord(args.account) ? args.account : undefined;
  const hasNaturalAccountBrand = isRecord(account?.brand)
    && typeof account.operator === 'string'
    && account.operator.length > 0;
  const allowedFields: Record<string, ReadonlySet<string>> = {
    list_products: new Set([
      'adcp_version', 'adcp_major_version', 'idempotency_key', 'context_id',
      'context', 'governance_context', 'push_notification_config', 'account', 'brand', 'criteria',
      'fields', 'cursor', 'max_results', 'if_feed_version', 'if_pricing_version',
    ]),
    request_proposals: new Set([
      'adcp_version', 'adcp_major_version', 'idempotency_key', 'account',
      'context_id', 'context', 'governance_context', 'push_notification_config',
      'brand', 'brief', 'criteria', 'opportunity',
    ]),
    refine_proposals: new Set([
      'adcp_version', 'adcp_major_version', 'idempotency_key', 'refinements',
      'context_id', 'context', 'governance_context', 'push_notification_config',
    ]),
    decline_proposals: new Set([
      'adcp_version', 'adcp_major_version', 'idempotency_key', 'declines', 'opportunity',
      'context_id', 'context', 'governance_context', 'push_notification_config',
    ]),
  };
  const allowed = allowedFields[toolName];
  if (allowed) {
    const unknown = Object.keys(args).find(field => !allowed.has(field));
    if (unknown) return { message: `${unknown} is not supported by ${toolName}`, field: unknown };
  }
  if (
    (
      toolName === 'request_proposals'
      || toolName === 'refine_proposals'
      || toolName === 'decline_proposals'
    )
    && args.idempotency_key == null
  ) {
    return { message: `idempotency_key is required for ${toolName}`, field: 'idempotency_key' };
  }
  if (toolName === 'list_products') {
    if (args.if_pricing_version !== undefined && args.if_feed_version === undefined) {
      return { message: 'if_pricing_version requires if_feed_version', field: 'if_feed_version' };
    }
    const criteria = isRecord(args.criteria) ? args.criteria : undefined;
    if (criteria?.targeting_overlay !== undefined || criteria?.required_overlay_support !== undefined) {
      return {
        code: 'UNSUPPORTED_FEATURE',
        message: 'The training agent does not execute split-task targeting criteria until the 3.2 SDK rollout; use schema fixtures for preview validation.',
        field: criteria.targeting_overlay !== undefined
          ? 'criteria.targeting_overlay'
          : 'criteria.required_overlay_support',
      };
    }
    if (isRecord(criteria?.catalog) && args.brand === undefined && !hasNaturalAccountBrand) {
      return { message: 'brand is required when catalog criteria are present', field: 'brand' };
    }
    if (isRecord(criteria?.catalog) && typeof criteria.catalog.catalog_id !== 'string') {
      return { message: 'criteria.catalog.catalog_id is required', field: 'criteria.catalog.catalog_id' };
    }
  }
  if (toolName === 'request_proposals') {
    if (typeof args.brief !== 'string' || args.brief.length === 0) {
      return { message: 'brief is required for request_proposals', field: 'brief' };
    }
    if (args.brand === undefined && !hasNaturalAccountBrand) {
      return { message: 'brand is required for request_proposals', field: 'brand' };
    }
    const criteria = isRecord(args.criteria) ? args.criteria : undefined;
    if (criteria?.targeting_overlay !== undefined || criteria?.required_overlay_support !== undefined) {
      return {
        code: 'UNSUPPORTED_FEATURE',
        message: 'The training agent does not execute split-task targeting criteria until the 3.2 SDK rollout; use schema fixtures for preview validation.',
        field: criteria.targeting_overlay !== undefined
          ? 'criteria.targeting_overlay'
          : 'criteria.required_overlay_support',
      };
    }
    if (isRecord(criteria?.catalog) && args.brand === undefined && !hasNaturalAccountBrand) {
      return { message: 'brand is required when catalog criteria are present', field: 'brand' };
    }
    if (isRecord(criteria?.catalog) && typeof criteria.catalog.catalog_id !== 'string') {
      return { message: 'criteria.catalog.catalog_id is required', field: 'criteria.catalog.catalog_id' };
    }
  }
  if (toolName === 'refine_proposals') {
    if (!Array.isArray(args.refinements) || args.refinements.length === 0) {
      return { message: 'refinements must contain at least one proposal change', field: 'refinements' };
    }
    const proposalIds = new Set<string>();
    for (let index = 0; index < args.refinements.length; index += 1) {
      const entry = args.refinements[index];
      if (!isRecord(entry)) {
        return { message: 'refinement entries must be objects', field: `refinements[${index}]` };
      }
      if (typeof entry.proposal_id !== 'string' || entry.proposal_id.length === 0) {
        return { message: 'proposal_id is required for every refinement', field: `refinements[${index}].proposal_id` };
      }
      if (proposalIds.has(entry.proposal_id)) {
        return { message: 'proposal_id values in refinements must be unique', field: `refinements[${index}].proposal_id` };
      }
      proposalIds.add(entry.proposal_id);
      if (entry.action !== 'revise' && entry.action !== 'finalize') {
        return {
          message: 'action is required and must be revise or finalize',
          field: `refinements[${index}].action`,
        };
      }
      const hasTypedRevision = isRecord(entry.constraints)
        || isRecord(entry.product_changes)
        || isRecord(entry.alternatives)
        || isRecord(entry.criteria);
      const hasAsk = typeof entry.ask === 'string' && entry.ask.length > 0;
      const isCancellation = entry.change_kind === 'cancellation';
      if (entry.action === 'revise' && !hasTypedRevision && !hasAsk && !isCancellation) {
        return {
          message: 'each revision requires constraints, product_changes, alternatives, criteria, ask, or change_kind cancellation',
          field: `refinements[${index}]`,
        };
      }
      if (entry.action === 'finalize' && (
        entry.ask !== undefined
        || entry.change_kind !== undefined
        || entry.constraints !== undefined
        || entry.product_changes !== undefined
        || entry.alternatives !== undefined
        || entry.criteria !== undefined
      )) {
        return {
          message: 'finalize cannot be combined with revision fields',
          field: `refinements[${index}].action`,
        };
      }
      if (
        entry.change_kind !== undefined
        && entry.change_kind !== 'amendment'
        && entry.change_kind !== 'cancellation'
      ) {
        return {
          message: 'change_kind must be amendment or cancellation',
          field: `refinements[${index}].change_kind`,
        };
      }
      if (isRecord(entry.constraints) && isRecord(entry.constraints.total_budget)) {
        const { min, max } = entry.constraints.total_budget;
        if (typeof min === 'number' && typeof max === 'number' && min > max) {
          return {
            message: 'constraints.total_budget.min must be less than or equal to max',
            field: `refinements[${index}].constraints.total_budget`,
          };
        }
      }
      const unknown = Object.keys(entry).find(
        field => ![
          'proposal_id', 'action', 'change_kind', 'constraints', 'product_changes', 'alternatives', 'criteria', 'ask',
        ].includes(field),
      );
      if (unknown) {
        return { message: `${unknown} is not supported on proposal refinements`, field: `refinements[${index}].${unknown}` };
      }
    }
    const hasFinalize = args.refinements.some(entry => isRecord(entry) && entry.action === 'finalize');
    if (hasFinalize && args.refinements.some(entry => !isRecord(entry) || entry.action !== 'finalize')) {
      return {
        message: 'finalize entries cannot be mixed with proposal revisions',
        field: 'refinements',
      };
    }
  }
  if (toolName === 'decline_proposals') {
    if (!Array.isArray(args.declines) || args.declines.length === 0) {
      return { message: 'declines must contain at least one proposal decline', field: 'declines' };
    }
    if (args.declines.length > 25) {
      return { message: 'declines exceeds the maximum batch size (25)', field: 'declines' };
    }
    const proposalIds = new Set<string>();
    const reasons = new Set([
      'price', 'inventory_fit', 'audience_fit', 'creative_unsupported', 'measurement_unsupported',
      'policy', 'timing', 'budget_changed', 'selected_alternative', 'other',
    ]);
    for (let index = 0; index < args.declines.length; index += 1) {
      const entry = args.declines[index];
      if (!isRecord(entry)) {
        return { message: 'decline entries must be objects', field: `declines[${index}]` };
      }
      if (typeof entry.proposal_id !== 'string' || entry.proposal_id.length === 0) {
        return { message: 'proposal_id is required for every decline', field: `declines[${index}].proposal_id` };
      }
      if (proposalIds.has(entry.proposal_id)) {
        return { message: 'proposal_id values in declines must be unique', field: `declines[${index}].proposal_id` };
      }
      proposalIds.add(entry.proposal_id);
      if (typeof entry.reason !== 'string' || !reasons.has(entry.reason)) {
        return { message: 'a supported reason is required for every decline', field: `declines[${index}].reason` };
      }
      if (entry.reason === 'other' && !(typeof entry.detail === 'string' && entry.detail.length > 0)) {
        return { message: 'detail is required when decline reason is other', field: `declines[${index}].detail` };
      }
      const unknown = Object.keys(entry).find(field => !['proposal_id', 'reason', 'detail'].includes(field));
      if (unknown) {
        return { message: `${unknown} is not supported on proposal declines`, field: `declines[${index}].${unknown}` };
      }
    }
  }
  return undefined;
}

const LIST_PRODUCTS_INPUT_SCHEMA = loadProductDiscoveryInputSchema('list-products-request');
const REQUEST_PROPOSALS_INPUT_SCHEMA = loadProductDiscoveryInputSchema('request-proposals-request');
const REFINE_PROPOSALS_INPUT_SCHEMA = loadProductDiscoveryInputSchema('refine-proposals-request');
const DECLINE_PROPOSALS_INPUT_SCHEMA = loadProductDiscoveryInputSchema('decline-proposals-request');
const CREATE_MEDIA_BUY_OPPORTUNITY_INPUT_SCHEMA = {
  type: 'object',
  description: 'Planning-cycle closure for proposal execution. Omit status to infer accepted closure, or send closed with accepted_with_seller.',
  properties: {
    opportunity_id: { type: 'string', minLength: 1, maxLength: 255, pattern: '^[A-Za-z0-9_.:-]{1,255}$' },
    phase: { type: 'string', enum: ['exploratory', 'planning', 'active_sourcing'] },
    intent: { type: 'string', enum: ['test', 'speculative', 'planning', 'live_rfp'] },
    planning_horizon: {
      type: 'object',
      properties: {
        start: { type: 'string', format: 'date' },
        end: { type: 'string', format: 'date' },
      },
      required: ['start', 'end'],
      additionalProperties: true,
    },
    response_deadline: { type: 'string', format: 'date-time' },
    status: { type: 'string', const: 'closed' },
    close_reason: { type: 'string', const: 'accepted_with_seller' },
    close_detail: { type: 'string', minLength: 1, maxLength: 500 },
  },
  required: ['opportunity_id'],
  allOf: [{
    if: { required: ['status'] },
    then: { required: ['close_reason'] },
    else: { not: { anyOf: [{ required: ['close_reason'] }, { required: ['close_detail'] }] } },
  }],
  additionalProperties: false,
};

const TOOLS = [
  {
    name: 'get_products',
    description: 'DEPRECATED in AdCP 3.2. Compatibility facade for brief, wholesale, refine, and finalize product flows. New callers use the dedicated product-discovery lifecycle tools.',
    // Polymorphic: brief/wholesale can be reads, but Submitted responses
    // allocate a task and refine+finalize commits an inventory hold.
    annotations: { readOnlyHint: false, idempotentHint: true },
    execution: { taskSupport: 'optional' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        idempotency_key: {
          type: 'string',
          minLength: 16,
          maxLength: 255,
          pattern: '^[A-Za-z0-9_.:-]{16,255}$',
        },
        buying_mode: { type: 'string', enum: ['brief', 'wholesale', 'refine'] },
        brief: { type: 'string' },
        refine: { type: 'array' },
        account: ACCOUNT_REF_SCHEMA,
        brand: { type: 'object' },
        filters: { type: 'object' },
        fields: { type: 'array', items: { type: 'string' } },
        if_wholesale_feed_version: { type: 'string' },
        if_pricing_version: { type: 'string' },
        pagination: {
          type: 'object',
          properties: {
            max_results: { type: 'integer', minimum: 1, maximum: 100 },
            cursor: { type: 'string' },
          },
        },
      },
      required: ['buying_mode'],
    },
  },
  {
    name: 'list_products',
    description: 'List product offers with structured commercial criteria. Returns products only; use request_proposals for seller-authored plans.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    execution: { taskSupport: 'forbidden' as const },
    inputSchema: LIST_PRODUCTS_INPUT_SCHEMA,
  },
  {
    name: 'request_proposals',
    description: 'Request immutable draft media-plan proposals from a brief and optional listed product IDs. Drafts can be revised, finalized into inventory holds, or declined.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    execution: { taskSupport: 'optional' as const },
    inputSchema: REQUEST_PROPOSALS_INPUT_SCHEMA,
  },
  {
    name: 'refine_proposals',
    description: 'Create draft revisions or finalize drafts into committed inventory holds. Every result receives a new proposal_id; source snapshots remain immutable.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    execution: { taskSupport: 'optional' as const },
    inputSchema: REFINE_PROPOSALS_INPUT_SCHEMA,
  },
  {
    name: 'decline_proposals',
    description: 'Terminally decline one or more immutable proposals. Repeated declines are semantically idempotent and declined proposals cannot be purchased.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    execution: { taskSupport: 'optional' as const },
    inputSchema: DECLINE_PROPOSALS_INPUT_SCHEMA,
  },
  {
    name: 'list_creative_formats',
    description: 'DEPRECATED in AdCP 3.2. Legacy named-format compatibility projection only. Sales deliverability comes from get_products format_options[]; creative-agent operations come from get_adcp_capabilities creative.supported_formats[].',
    annotations: { readOnlyHint: true, idempotentHint: true },
    execution: { taskSupport: 'forbidden' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        format_ids: { type: 'array' },
        channels: { type: 'array', items: { type: 'string' } },
        // Declared so the SDK's request validator (legacy dispatch) doesn't
        // strip `pagination` before it reaches the handler — without this,
        // pagination_integrity_creative_formats sees max_results dropped, the
        // handler defaults to 50, and `has_more` is incorrectly false.
        pagination: {
          type: 'object',
          properties: {
            max_results: { type: 'integer', minimum: 1, maximum: 100 },
            cursor: { type: 'string' },
          },
        },
      },
    },
  },
  {
    name: 'validate_input',
    description: 'Preflight a creative manifest against canonical formats, seeded products, or third-party format references. Returns per-target validated_pass, validated_fail, or unvalidatable_nondeterministic without registering a creative. For seller trafficking acceptance of the actual sync_creatives request, use sync_creatives with dry_run: true.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    execution: { taskSupport: 'forbidden' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        account: ACCOUNT_REF_SCHEMA,
        brand: { type: 'object', properties: { domain: { type: 'string' }, name: { type: 'string' } } },
        manifest: { type: 'object' },
        targets: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_VALIDATE_INPUT_TARGETS,
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['canonical', 'product', 'third_party_format', 'capability'] },
              id: { type: 'string' },
            },
            required: ['kind', 'id'],
          },
        },
      },
      required: ['manifest'],
    },
  },
  {
    name: 'create_media_buy',
    description: 'Create a media buy either from explicit product packages or by executing one committed proposal_id with total_budget. Package mode uses product_id and pricing_option_id from product discovery. Use update_media_buy for an existing buy.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    execution: { taskSupport: 'optional' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        idempotency_key: { type: 'string' },
        account: ACCOUNT_REF_SCHEMA,
        brand: { type: 'object', properties: { domain: { type: 'string' }, name: { type: 'string' } } },
        packages: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              product_id: { type: 'string' },
              pricing_option_id: { type: 'string' },
              budget: { type: 'number' },
              bid_price: { type: 'number' },
              impressions: { type: 'number' },
              paused: { type: 'boolean' },
              start_time: { type: 'string' },
              end_time: { type: 'string' },
              format_ids: { type: 'array' },
              format_option_refs: { type: 'array' },
              format_kind: { type: 'string' },
              params: { type: 'object' },
            },
            required: ['product_id', 'pricing_option_id', 'budget'],
          },
        },
        proposal_id: { type: 'string' },
        opportunity: CREATE_MEDIA_BUY_OPPORTUNITY_INPUT_SCHEMA,
        total_budget: { type: 'object', properties: { amount: { type: 'number' }, currency: { type: 'string' } } },
        start_time: { type: 'string', description: 'ISO 8601 date-time or "asap"' },
        end_time: { type: 'string' },
        paused: { type: 'boolean', description: 'Create the media buy with delivery held once activation prerequisites are satisfied.' },
        channel: { type: 'string', description: 'Primary channel for governance compliance (display, video, native, audio)' },
        channels: { type: 'array', items: { type: 'string' }, description: 'Channels for governance compliance' },
        countries: { type: 'array', items: { type: 'string' }, description: 'Target countries (ISO 3166-1 alpha-2) for governance compliance' },
        governance_context: { type: 'string', maxLength: 4096, description: 'Opaque governance context from a prior check_governance response. Persisted and returned on get_media_buys.' },
        push_notification_config: {
          type: 'object',
          description: 'Webhook destination for async completion notification. RFC 9421 signed by default; HMAC-SHA256 fallback when authentication is populated.',
          properties: {
            url: { type: 'string', format: 'uri' },
            authentication: {
              type: 'object',
              properties: {
                schemes: { type: 'array', items: { type: 'string' } },
                credentials: { type: 'string' },
              },
            },
          },
        },
      },
      required: ['account', 'brand', 'start_time', 'end_time'],
      dependencies: { opportunity: ['proposal_id'] },
    },
  },
  {
    name: 'get_media_buys',
    description: 'List media buys for the current session/account. Returns buy configuration and status only — not delivery metrics (use get_media_buy_delivery for that). Only returns buys created in the current session; buys from other sessions are not visible.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    execution: { taskSupport: 'forbidden' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        account: ACCOUNT_REF_SCHEMA,
        media_buy_ids: { type: 'array', items: { type: 'string' } },
        status_filter: { type: 'array', items: { type: 'string', enum: ['pending_creatives', 'pending_start', 'active', 'paused', 'completed', 'canceled', 'rejected'] }, description: 'Filter by lifecycle status. Defaults to ["active"] when no media_buy_ids provided.' },
        include_history: { type: 'integer', minimum: 0, maximum: 1000, description: 'Include the last N revision history entries per media buy. 0 or omit to exclude. Recommended: 5-10 for monitoring, 50+ for audit.' },
        include_snapshot: { type: 'boolean', description: 'Include full media buy snapshot in response' },
      },
    },
  },
  {
    name: 'get_media_buy_delivery',
    description: 'Get delivery metrics for a media buy including impressions, spend, and clicks by package. Requires a media_buy_id from create_media_buy. Returns simulated metrics proportional to elapsed flight time. Not for creating or updating buys.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    execution: { taskSupport: 'forbidden' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        account: ACCOUNT_REF_SCHEMA,
        media_buy_id: { type: 'string' },
        media_buy_ids: { type: 'array', items: { type: 'string' }, description: 'Plural form (SDK)' },
      },
      required: ['media_buy_id'] as const,
    },
  },
  {
    name: 'sync_creatives',
    description: 'Upload or update creative assets and optionally assign them to packages. Use dry_run: true to rehearse the actual seller upload/update without mutating the library. Not for manifest-only preflight against canonical/product targets (use validate_input) or listing existing creatives (use list_creatives).',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    execution: { taskSupport: 'optional' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        account: ACCOUNT_REF_SCHEMA,
        creatives: { type: 'array' },
        assignments: { type: 'array' },
        dry_run: { type: 'boolean' },
      },
      required: ['account', 'creatives'],
    },
  },
  {
    name: 'list_creatives',
    description: 'List creative assets for the current session. Filter by creative_ids, format_ids, asset_types, status, or media_buy_id to narrow results. When include_pricing is true and account is provided, returns per-creative pricing from the account rate card. Not for uploading or updating creatives (use sync_creatives).',
    annotations: { readOnlyHint: true, idempotentHint: true },
    execution: { taskSupport: 'forbidden' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        account: ACCOUNT_REF_SCHEMA,
        // Declared so legacy-dispatch session keying matches the seeded
        // creatives. `controller_seeding: true` storyboards seed via
        // comply_test_controller (which accepts `brand`) and then list with
        // `brand: {domain: ...}` from the runner's test-kit; without `brand`
        // declared here, the SDK strips it on list_creatives, sessionKeyFromArgs
        // falls back to `default`, and the seeded creatives are invisible.
        brand: { type: 'object', properties: { domain: { type: 'string' }, name: { type: 'string' } } },
        creative_ids: { type: 'array', items: { type: 'string' } },
        media_buy_id: { type: 'string' },
        include_pricing: { type: 'boolean', description: 'Include pricing from the account rate card on each creative (default: false). Requires account.' },
        include_snapshot: { type: 'boolean', description: 'Include delivery snapshot per creative' },
        include_purged: { type: 'boolean', description: 'Include soft-purged creative tombstones' },
        include_webhook_activity: { type: 'boolean', description: 'Include recent lifecycle webhook activity per creative' },
        webhook_activity_limit: { type: 'integer', minimum: 1, maximum: 200 },
        fields: {
          type: 'array',
          description: 'Optional sparse field selection. Response-required identity and lifecycle fields are always retained.',
          items: {
            type: 'string',
            enum: ['creative_id', 'name', 'format_id', 'assets', 'status', 'created_date', 'updated_date', 'tags', 'assignments', 'snapshot', 'items', 'variables', 'concept', 'pricing_options'],
          },
          minItems: 1,
        },
        filters: {
          type: 'object',
          properties: {
            creative_ids: { type: 'array', items: { type: 'string' } },
            statuses: { type: 'array', items: { type: 'string' } },
            format_ids: { type: 'array', items: FORMAT_ID_INPUT_SCHEMA, minItems: 1 },
            asset_types: {
              type: 'array',
              description: 'Filter creatives by exact asset_type values on direct object values in the top-level assets map (OR within this field; no array or nested traversal).',
              items: {
                type: 'string',
                enum: ['image', 'video', 'audio', 'text', 'markdown', 'html', 'css', 'javascript', 'zip', 'vast', 'daast', 'url', 'webhook', 'brief', 'catalog', 'published_post'],
              },
              minItems: 1,
              uniqueItems: true,
            },
          },
        },
        // See list_creative_formats above — declared so legacy dispatch keeps
        // `pagination` on the wire.
        pagination: {
          type: 'object',
          properties: {
            max_results: { type: 'integer', minimum: 1, maximum: 100 },
            cursor: { type: 'string' },
          },
        },
      },
    },
  },
  {
    name: 'get_creative_delivery',
    description: 'Get variant-level creative delivery data including what was generated, manifests, and per-variant metrics. Call this to see what creatives were actually served and how each variant performed. Requires at least one of media_buy_ids or creative_ids.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    execution: { taskSupport: 'forbidden' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        account: ACCOUNT_REF_SCHEMA,
        media_buy_ids: { type: 'array', items: { type: 'string' } },
        creative_ids: { type: 'array', items: { type: 'string' } },
        max_variants: { type: 'number' },
      },
    },
  },
  {
    name: 'build_creative',
    description: 'Build a creative through a canonical capability advertised by get_adcp_capabilities creative.supported_formats. Pass target_capability_id (or target_capability_ids) with a creative_manifest, brief, or library creative_id. Returns canonical creative manifests.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    execution: { taskSupport: 'optional' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        account: ACCOUNT_REF_SCHEMA,
        creative_id: { type: 'string', description: 'Reference to a synced creative (ad server mode)' },
        creative_manifest: { type: 'object', description: 'Inline manifest with assets (transformation mode)' },
        target_capability_id: { type: 'string', pattern: '^[a-zA-Z0-9_-]+$', description: 'Canonical output capability ID from creative.supported_formats' },
        target_capability_ids: { type: 'array', minItems: 1, maxItems: 50, uniqueItems: true, items: { type: 'string', pattern: '^[a-zA-Z0-9_-]+$' }, description: 'Multiple canonical output capability IDs' },
        target_format_id: { type: 'object', properties: { agent_url: { type: 'string' }, id: { type: 'string' } }, description: 'Deprecated 3.x named-format selector' },
        target_format_ids: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'object', properties: { agent_url: { type: 'string' }, id: { type: 'string' } } }, description: 'Deprecated 3.x named-format selectors' },
        brand: { type: 'object', properties: { domain: { type: 'string' } }, description: 'Brand reference for identity resolution' },
        media_buy_id: { type: 'string', description: 'Media buy context for placement-level tags' },
        package_id: { type: 'string', description: 'Package context for placement-level tags' },
        quality: { type: 'string', enum: ['draft', 'production'] },
        message: { type: 'string', description: 'Natural language instructions for generative builds' },
        include_preview: { type: 'boolean', description: 'Include a preview URL or inline HTML in the build response' },
        governance_context: { type: 'string', maxLength: 4096, description: 'Opaque governance context from check_governance. Echoed on the response.' },
      },
    },
  },
  {
    name: 'preview_creative',
    description: 'Preview a creative to see how it will render. Accepts a creative manifest (inline assets) or creative_id (from library). Returns a preview URL or inline HTML. Supports single and batch modes.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    execution: { taskSupport: 'optional' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        account: ACCOUNT_REF_SCHEMA,
        request_type: { type: 'string', enum: ['single', 'batch', 'variant'], description: 'Preview mode: single, batch, or variant' },
        creative_manifest: { type: 'object', description: 'Creative manifest with assets to preview. In single mode, provide this or creative_id.' },
        target_capability_id: { type: 'string', pattern: '^[a-zA-Z0-9_-]+$', description: 'Preview capability ID from creative.supported_formats' },
        format_id: { ...FORMAT_ID_INPUT_SCHEMA, deprecated: true, description: 'Deprecated 3.x named-format preview route.' },
        creative_id: { type: 'string', description: 'Creative-library identifier used instead of creative_manifest in single mode.' },
        requests: {
          type: 'array', description: 'Array of preview requests for batch mode (1-50 items)', minItems: 1, maxItems: 50,
          items: {
            type: 'object',
            properties: {
              target_capability_id: { type: 'string', pattern: '^[a-zA-Z0-9_-]+$' },
              format_id: { ...FORMAT_ID_INPUT_SCHEMA, deprecated: true },
              creative_manifest: { type: 'object' },
              creative_id: { type: 'string' },
              output_format: { type: 'string', enum: ['url', 'html', 'both'] },
              quality: { type: 'string', enum: ['draft', 'production'] },
              template_id: { type: 'string' },
              item_limit: { type: 'integer', minimum: 1 },
            },
            oneOf: [{ required: ['creative_manifest'] }, { required: ['creative_id'] }],
          },
        },
        variant_id: { type: 'string', description: 'Variant ID from get_creative_delivery (required for variant mode)' },
        output_format: { type: 'string', enum: ['url', 'html', 'both'], description: 'Preview output format' },
        quality: { type: 'string', enum: ['draft', 'production'] },
        template_id: { type: 'string', description: 'Specific template ID for custom format rendering' },
        item_limit: { type: 'integer', minimum: 1, description: 'Max catalog items to render per preview' },
      },
      allOf: [{
        if: { properties: { request_type: { const: 'single' } } },
        then: { oneOf: [{ required: ['creative_manifest'] }, { required: ['creative_id'] }] },
      }],
      required: ['request_type'] as const,
    },
  },
  {
    name: 'update_media_buy',
    description: 'Update an existing media buy. Supports changing package budget, paused state, end_time, cancellation, and adding new packages. Requires revision for optimistic concurrency. Not for creating new buys (use create_media_buy).',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    execution: { taskSupport: 'optional' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        account: ACCOUNT_REF_SCHEMA,
        media_buy_id: { type: 'string' },
        revision: { type: 'number', description: 'Current revision for optimistic concurrency control' },
        paused: { type: 'boolean', description: 'Pause (true) or resume (false) the media buy' },
        canceled: { type: 'boolean', const: true, description: 'Cancel the media buy (one-way, cannot be undone)' },
        cancellation_reason: { type: 'string', description: 'Reason for cancellation' },
        packages: { type: 'array' },
        new_packages: { type: 'array', items: { type: 'object', properties: { product_id: { type: 'string' }, pricing_option_id: { type: 'string' }, budget: { type: 'number' }, bid_price: { type: 'number' }, impressions: { type: 'number' }, paused: { type: 'boolean' }, start_time: { type: 'string' }, end_time: { type: 'string' }, format_option_refs: { type: 'array' }, format_kind: { type: 'string' }, params: { type: 'object' }, format_ids: { type: 'array' } }, required: ['product_id', 'pricing_option_id', 'budget'] }, description: 'Add new packages to the media buy' },
        end_time: { type: 'string' },
        action: { type: 'string', description: 'Action to perform (pause, resume, cancel, extend)' },
        governance_context: { type: 'string', maxLength: 4096, description: 'Opaque intent authorization for a governed update. The seller computes the actual positive delta from its current revision and enforces the signed ceiling.' },
      },
      required: ['account', 'media_buy_id'] as const,
    },
  },
  {
    name: 'get_signals',
    description: 'Discover signals matching campaign criteria. Supports natural language discovery via signal_spec or exact lookup via signal_ids. Returns signals with deployment status, pricing, and activation keys. Use this to find targetable audiences, contextual categories, geographic regions, and other data attributes.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    execution: { taskSupport: 'optional' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        signal_spec: { type: 'string', description: 'Natural language description of desired signals' },
        brief: { type: 'string', description: 'Alias for signal_spec (SDK compatibility)' },
        signal_ids: { type: 'array', items: { type: 'object' }, description: 'Specific signals to look up by ID' },
        signal_refs: { type: 'array', items: { type: 'object' }, description: 'Specific signal references to look up' },
        account: ACCOUNT_REF_SCHEMA,
        destinations: { type: 'array', items: { type: 'object' }, description: 'Filter to specific deployment targets' },
        countries: { type: 'array', items: { type: 'string' } },
        discovery_mode: { type: 'string', enum: ['brief', 'wholesale'] },
        filters: { type: 'object' },
        if_wholesale_feed_version: { type: 'string' },
        if_pricing_version: { type: 'string' },
        max_results: { type: 'integer' },
        // See list_creative_formats above — declared so legacy dispatch keeps
        // `pagination` on the wire.
        pagination: {
          type: 'object',
          properties: {
            max_results: { type: 'integer', minimum: 1, maximum: 100 },
            cursor: { type: 'string' },
          },
        },
      },
    },
  },
  {
    name: 'activate_signal',
    description: 'Activate a signal for use on a specific platform or agent. Requires signal_agent_segment_id from get_signals and at least one destination. Returns deployment status with activation keys.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    execution: { taskSupport: 'optional' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        signal_agent_segment_id: { type: 'string' },
        idempotency_key: { type: 'string', description: 'UUID v4 for retry safety' },
        action: { type: 'string', enum: ['activate', 'deactivate'] },
        destinations: { type: 'array', items: { type: 'object' } },
        pricing_option_id: { type: 'string' },
        governance_context: { type: 'string', maxLength: 4096, description: 'Opaque governance context from check_governance. Persisted on the activation.' },
        account: ACCOUNT_REF_SCHEMA,
      },
      required: ['signal_agent_segment_id', 'destinations', 'idempotency_key'] as const,
    },
  },
  ...ACCOUNT_TOOLS,
  ...CATALOG_EVENT_TOOLS,
  ...AUDIENCE_TOOLS,
  ...GOVERNANCE_TOOLS,
  ...PROPERTY_TOOLS,
  ...COLLECTION_LIST_TOOLS,
  ...CONTENT_STANDARDS_TOOLS,
  ...BRAND_TOOLS,
  COMPLY_TEST_CONTROLLER_TOOL,
  {
    name: 'report_usage',
    description: 'Report consumption data for billing verification. Send creative_id and pricing_option_id for creative agents, signal_agent_segment_id for signals agents. The vendor verifies the reported cost against its rate card.',
    annotations: { readOnlyHint: false, idempotentHint: true },
    execution: { taskSupport: 'forbidden' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        account: ACCOUNT_REF_SCHEMA,
        idempotency_key: { type: 'string', description: 'UUID for retry safety' },
        reporting_period: { type: 'object', properties: { start: { type: 'string' }, end: { type: 'string' } }, required: ['start', 'end'] },
        usage: {
          type: 'array', items: {
            type: 'object', properties: {
              account: ACCOUNT_REF_SCHEMA,
              creative_id: { type: 'string', description: 'Creative identifier (creative agents)' },
              signal_agent_segment_id: { type: 'string', description: 'Signal identifier (signals agents)' },
              pricing_option_id: { type: 'string', description: 'Pricing option from discovery or build response' },
              impressions: { type: 'number' },
              media_spend: { type: 'number' },
              vendor_cost: { type: 'number' },
              currency: { type: 'string' },
              final: { type: 'boolean' },
              finalized_at: { type: 'string' },
              measurement_window: { type: 'string' },
            },
            required: ['account', 'vendor_cost', 'currency'],
          },
        },
      },
      required: ['reporting_period', 'usage'] as const,
    },
  },
  {
    name: 'get_adcp_capabilities',
    description: 'Discover the capabilities of this AdCP agent — supported tasks, features, and protocol version. Call once per session; capabilities are static.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    execution: { taskSupport: 'forbidden' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
];

/**
 * Return the exact split product-discovery definitions used by the native
 * training server. Tenant discovery projects these same objects so the two
 * MCP entry points cannot advertise different request contracts.
 */
export function productDiscoveryAliasToolDefinitions(): Array<(typeof TOOLS)[number]> {
  return structuredClone(TOOLS.filter(tool => (
    tool.name === 'list_products'
    || tool.name === 'request_proposals'
    || tool.name === 'refine_proposals'
    || tool.name === 'decline_proposals'
  )));
}

function visibleToolsForContext(ctx: TrainingContext): typeof TOOLS {
  const threeZero = isThreeZeroStoryboardCompat(ctx);
  return TOOLS
    .filter(tool => !threeZero || (
      tool.name !== 'validate_input'
      && (tool.name === 'get_products' || !isProductDiscoveryTool(tool.name))
    ))
    .map(tool => {
      if (!threeZero || tool.name !== 'get_products') return tool;
      const inputSchema = tool.inputSchema as {
        properties?: Record<string, unknown>;
        required?: unknown[];
        [key: string]: unknown;
      };
      const properties = { ...(inputSchema.properties ?? {}) };
      delete properties.idempotency_key;
      return {
        ...tool,
        annotations: { ...tool.annotations, readOnlyHint: true, idempotentHint: true },
        inputSchema: {
          ...inputSchema,
          properties,
          required: inputSchema.required?.filter(field => field !== 'idempotency_key'),
        },
      };
    }) as typeof TOOLS;
}

export function visibleTrainingToolNamesForContext(ctx: TrainingContext): string[] {
  return visibleToolsForContext(ctx).map(tool => tool.name);
}

function toolAvailableForServedAdcpVersion(toolName: string, servedAdcpVersion: string): boolean {
  if (toolName === 'validate_input') return !servedAdcpVersion.startsWith('3.0');
  if (isProductDiscoveryTool(toolName) && toolName !== 'get_products') {
    return supportsGetProductsRejected(servedAdcpVersion);
  }
  return true;
}

// ── Task handler implementations ──────────────────────────────────

export async function handleGetProducts(args: ToolArgs, ctx: TrainingContext): Promise<GetProductsResponse | GetProductsRejectedResponse | { errors: TaskError[] }> {
  const req = args as unknown as GetProductsRequest & ToolArgs;
  const paginationOffset = req.pagination
    ? decodeOffsetCursor('products', req.pagination.cursor)
    : undefined;
  if (paginationOffset === null) {
    return {
      errors: [{ code: 'INVALID_REQUEST', message: 'pagination.cursor is malformed' }] as TaskError[],
    };
  }

  const buyingMode = req.buying_mode ?? 'brief';
  const proposalLifecycleWrite = buyingMode === 'refine'
    || (req as unknown as Record<string, unknown>).__require_proposals === true;
  const compactLifecycleWrite = proposalLifecycleWrite
    && (req as unknown as Record<string, unknown>).__compact_proposal_lifecycle === true;
  const sessionScope = productDiscoverySessionKey(args, ctx);
  const sessionHash = createHash('sha256').update(sessionScope).digest('hex');
  const principal = 'get-products-session-mutex';
  const key = `get-products-session:${sessionHash}`;
  const store = getIdempotencyStore();
  let claim = await store.check({ principal, key, payload: { session: sessionHash } });

  // Read discovery and the idempotent split lifecycle queue briefly behind an
  // active writer. Legacy get_products refine retains its non-blocking CONFLICT
  // behavior for 3.x compatibility.
  const readLockDeadline = Date.now() + 1_000;
  let readLockBackoffMs = 5;
  while ((!proposalLifecycleWrite || compactLifecycleWrite) && claim.kind !== 'miss') {
    const remainingMs = readLockDeadline - Date.now();
    if (remainingMs <= 0) break;
    const jitterMs = Math.floor(Math.random() * Math.max(1, readLockBackoffMs / 2));
    await new Promise(resolve => setTimeout(
      resolve,
      Math.min(readLockBackoffMs + jitterMs, remainingMs),
    ));
    claim = await store.check({ principal, key, payload: { session: sessionHash } });
    readLockBackoffMs = Math.min(readLockBackoffMs * 2, 100);
  }
  if (claim.kind !== 'miss') {
    return {
      errors: [{
        code: 'CONFLICT',
        message: 'Another get_products request is already updating this session. Retry after a short delay.',
        recovery: 'transient',
      }],
    };
  }

  if (!proposalLifecycleWrite) {
    let directives: GetProductsReadDirectives = {};
    try {
      const session = await getSession(
        sessionScope,
        controllerFixtureSessionKey(req, ctx),
      );
      const directivePrincipal = ctx.principal ?? 'anonymous';
      const rejection = buyingMode === 'brief' && supportsGetProductsRejected(ctx.servedAdcpVersion)
        ? session.complyExtensions.forcedGetProductsRejections.get(directivePrincipal)
        : undefined;
      const staleDirective = session.complyExtensions.forcedUpstreamUnavailable?.tool === 'get_products'
        ? session.complyExtensions.forcedUpstreamUnavailable
        : undefined;
      if (rejection) {
        session.complyExtensions.forcedGetProductsRejections.delete(directivePrincipal);
      }
      if (staleDirective) {
        session.complyExtensions.forcedUpstreamUnavailable = undefined;
      }
      directives = { rejection, staleDirective };
      if (rejection || staleDirective) await flushDirtySessions();
    } finally {
      await store.release({ principal, key, claimToken: claim.claimToken });
    }
    return handleGetProductsUnlocked(args, ctx, paginationOffset, directives);
  }

  try {
    if (compactLifecycleWrite) evictSessionFromRequestCache(sessionScope);
    const result = await handleGetProductsUnlocked(args, ctx, paginationOffset);
    // Keep the mutex until every refine mutation is durable, not just proposal
    // holds, so a following refine request observes the committed context.
    await flushDirtySessions();
    return result;
  } finally {
    await store.release({ principal, key, claimToken: claim.claimToken });
  }
}

async function handleGetProductsUnlocked(
  args: ToolArgs,
  ctx: TrainingContext,
  paginationOffset?: number,
  readDirectives?: GetProductsReadDirectives,
): Promise<GetProductsResponse | GetProductsRejectedResponse | { errors: TaskError[] }> {
  const req = args as unknown as GetProductsRequest & ToolArgs;
  const buyingMode = req.buying_mode || 'brief';
  const brief = (req as Record<string, unknown>).brief;
  if (brief !== undefined && typeof brief !== 'string') {
    return {
      errors: [{
        code: 'INVALID_REQUEST',
        message: 'brief must be a string.',
        field: 'brief',
        recovery: 'correctable',
      }] as TaskError[],
    };
  }
  if (buyingMode !== 'wholesale' && (req as WholesaleFeedRequest).if_wholesale_feed_version !== undefined) {
    return {
      errors: [{
        code: 'INVALID_REQUEST',
        message: 'if_wholesale_feed_version is only valid with buying_mode "wholesale".',
        field: 'if_wholesale_feed_version',
        recovery: 'correctable',
      }] as TaskError[],
    };
  }
  if ((req as WholesaleFeedRequest).if_pricing_version !== undefined) {
    if (buyingMode !== 'wholesale') {
      return {
        errors: [{
          code: 'INVALID_REQUEST',
          message: 'if_pricing_version is only valid with buying_mode "wholesale".',
          field: 'if_pricing_version',
          recovery: 'correctable',
        }] as TaskError[],
      };
    }
    if ((req as WholesaleFeedRequest).if_wholesale_feed_version === undefined) {
      return {
        errors: [{
          code: 'INVALID_REQUEST',
          message: 'if_pricing_version requires if_wholesale_feed_version.',
          field: 'if_pricing_version',
          recovery: 'correctable',
        }] as TaskError[],
      };
    }
  }
  const session = await getSession(
    productDiscoverySessionKey(req, ctx),
    controllerFixtureSessionKey(req, ctx),
  );
  const committedProposals = new Map(
    (session.lastGetProductsContext?.proposals ?? [])
      .filter(proposal => proposalLifecycle(proposal).proposal_status === 'committed')
      .map(proposal => [proposal.proposal_id, proposal]),
  );
  const wholesaleMeta = buyingMode === 'wholesale'
    ? productWholesaleFeedMeta(req as WholesaleFeedRequest, session)
    : undefined;
  const contextEcho = req.context ? { context: req.context } : {};

  const directivePrincipal = ctx.principal ?? 'anonymous';
  const rejection = readDirectives
    ? readDirectives.rejection
    : buyingMode === 'brief' || buyingMode === 'refine'
      ? session.complyExtensions.forcedGetProductsRejections.get(directivePrincipal)
      : undefined;
  if (rejection && supportsGetProductsRejected(ctx.servedAdcpVersion)) {
    if (!readDirectives) {
      session.complyExtensions.forcedGetProductsRejections.delete(directivePrincipal);
    }
    return {
      status: 'rejected',
      adcp_version: ctx.servedAdcpVersion!,
      reason: rejection.reason,
      ...(rejection.suggestions && { suggestions: [...rejection.suggestions] }),
      ...contextEcho,
    };
  }

  if (wholesaleMeta && wholesaleFeedUnchanged(req as WholesaleFeedRequest, wholesaleMeta)) {
    return {
      status: 'completed' as const,
      unchanged: true,
      ...wholesaleMeta,
      ...contextEcho,
    } as GetProductsResponse;
  }

  let products: Product[] = getCatalog().map(cp => ({ ...cp.product }));

  // Overlay seeded products from comply_test_controller fixtures so
  // storyboard-seeded fields (e.g. creative_policy.provenance_requirements,
  // accepted_verifiers) round-trip through get_products. The overlay
  // also backfills required Product fields on seeded products so they
  // serialize as schema-valid responses without forcing every fixture
  // to repeat boilerplate. Catalog products are not touched.
  const productMap = new Map(products.map(p => [p.product_id, p]));
  overlaySeededProducts(session, productMap);
  if (buyingMode !== 'wholesale') overlayNegotiatedPricingOptions(session, productMap);
  products = Array.from(productMap.values());
  const registryProducts = products;

  const requestedProductIds = Array.isArray((req as unknown as Record<string, unknown>).product_ids)
    ? new Set(((req as unknown as Record<string, unknown>).product_ids as unknown[])
        .filter((id): id is string => typeof id === 'string'))
    : undefined;
  if (requestedProductIds) {
    products = products.filter(product => requestedProductIds.has(product.product_id));
  }

  // Apply filters
  if (req.filters) {
    const pricingCurrencies = (req.filters as { pricing_currencies?: string[] }).pricing_currencies;
    if (pricingCurrencies?.length) {
      const seededIds = seededProductIds(session);
      if (seededIds.size > 0) {
        products = products.filter(p => seededIds.has(p.product_id));
      }
      products = applyPricingCurrenciesFilterToProducts(products, pricingCurrencies);
    }
    const formatIdsFilter = req.filters.format_ids;
    if (formatIdsFilter?.length) {
      products = applyFormatIdsFilterToProducts(products, formatIdsFilter);
    }
    const canonicalFormatFilters = req.filters as unknown as {
      format_kinds?: string[];
      format_option_refs?: Array<{ scope?: string; publisher_domain?: string; format_option_id?: string }>;
    };
    if (canonicalFormatFilters.format_kinds?.length || canonicalFormatFilters.format_option_refs?.length) {
      products = applyCanonicalFormatFiltersToProducts(
        products,
        canonicalFormatFilters.format_kinds ?? [],
        canonicalFormatFilters.format_option_refs ?? [],
      );
    }
    const channelFilter = req.filters.channels;
    if (channelFilter?.length) {
      products = products.filter(p =>
        p.channels?.some(c => (channelFilter as string[]).includes(c)),
      );
    }
    const deliveryTypeFilter = req.filters.delivery_type;
    if (deliveryTypeFilter) {
      products = products.filter(p => p.delivery_type === deliveryTypeFilter);
    }
    const fixedPriceFilter = req.filters.is_fixed_price;
    if (typeof fixedPriceFilter === 'boolean') {
      products = applyFixedPriceFilterToProducts(products, fixedPriceFilter);
    }
    const pricingStructures = (req.filters as { pricing_structures?: PricingStructure[] }).pricing_structures;
    if (pricingStructures?.length) {
      products = applyPricingStructuresFilterToProducts(products, pricingStructures);
    }
    const requiredVendorMetrics = (req.filters as { required_vendor_metrics?: Array<{ vendor?: { domain?: string }; metric_id?: string }> }).required_vendor_metrics;
    if (requiredVendorMetrics?.length) {
      products = products.filter(p => {
        const declared = (p.reporting_capabilities as { vendor_metrics?: Array<{ vendor?: { domain?: string }; metric_id?: string }> } | undefined)?.vendor_metrics;
        if (!declared?.length) return false;
        return requiredVendorMetrics.every(req =>
          declared.some(d =>
            (!req.vendor?.domain || d.vendor?.domain === req.vendor.domain)
            && (!req.metric_id || d.metric_id === req.metric_id),
          ),
        );
      });
    }
  }
  const filteredProducts = products;

  // Brief mode: channel-aware keyword matching
  if (buyingMode === 'brief' && brief) {
    const briefLower = brief.toLowerCase();
    const terms = briefLower.split(/\s+/);

    // Extract channel names mentioned in the brief — these get heavy weight
    const briefChannels = new Set<string>();
    for (const [alias, channel] of Object.entries(BRIEF_CHANNEL_ALIASES)) {
      if (briefLower.includes(alias)) briefChannels.add(channel);
    }

    const scored = products
      .map(p => {
        const text = `${p.name} ${p.description} ${p.channels?.join(' ')}`.toLowerCase();
        const keywordScore = terms.filter(t => text.includes(t)).length;
        // Channel match: +10 per matching channel (dominates keyword scoring)
        const channelScore = briefChannels.size > 0
          ? (p.channels?.filter(c => briefChannels.has(c)).length ?? 0) * 10
          : 0;
        const vendorMetricScore = vendorMetricBriefScore(p, briefLower);
        const totalScore = channelScore + keywordScore + vendorMetricScore;
        return totalScore > 0 ? { product: p, totalScore, channelScore, keywordScore, vendorMetricScore } : null;
      })
      .filter((s): s is NonNullable<typeof s> => s !== null)
      .sort((a, b) => b.totalScore - a.totalScore);

    // Cap at top 5 most relevant products so learners see brief mode as curated discovery
    const MAX_BRIEF_RESULTS = 5;
    products = scored.slice(0, MAX_BRIEF_RESULTS).map(s => {
      const matchParts = [
        ...(s.channelScore > 0 ? [`${s.channelScore / 10} channel(s)`] : []),
        ...(s.keywordScore > 0 ? ['keywords'] : []),
        ...(s.vendorMetricScore > 0 ? ['vendor-metric optimization'] : []),
      ];
      return {
        ...s.product,
        brief_relevance: `Matches ${matchParts.join(' and ')}. ${s.product.description}`,
      };
    });

    // If no keyword matches, return top products as suggestions
    if (products.length === 0) {
      products = filteredProducts.slice(0, MAX_BRIEF_RESULTS).map(p => ({
        ...p,
        brief_relevance: 'Suggested product — no direct keyword match with your brief.',
      }));
    }
  }

  // Refine mode: apply include/omit/more_like_this/finalize. The dedicated
  // decline_proposals task uses the same internal transaction machinery but
  // is intentionally not part of the deprecated get_products wire schema.
  type RefineEntry =
    | { scope: 'request'; ask?: string }
    | { scope: 'product'; product_id: string; action?: 'include' | 'omit' | 'more_like_this'; ask?: string }
    | {
        scope: 'proposal';
        proposal_id: string;
        action?: 'include' | 'omit' | 'finalize' | 'decline';
        ask?: string;
        change_kind?: 'amendment' | 'cancellation';
        constraints?: { total_budget?: { min?: number; max?: number; currency?: string } };
        product_changes?: Record<string, 'include' | 'omit'>;
        alternatives?: { count?: number };
        reason?: string;
        detail?: string;
      };

  type RefinementAppliedEntry =
    | { scope: 'request'; status: 'applied' | 'partial' | 'unable'; notes?: string }
    | { scope: 'product'; product_id: string; status: 'applied' | 'partial' | 'unable'; notes?: string }
    | { scope: 'proposal'; proposal_id: string; status: 'applied' | 'partial' | 'unable'; notes?: string };

  const immutableRefine = buyingMode === 'refine'
    && (req as unknown as Record<string, unknown>).__immutable_refine === true;
  const compactLifecycle = buyingMode === 'refine'
    && (req as unknown as Record<string, unknown>).__compact_proposal_lifecycle === true;
  const declineProposals = buyingMode === 'refine'
    && (req as unknown as Record<string, unknown>).__decline_proposals === true;
  const compactFinalizeSourceIds = new Set(
    immutableRefine && Array.isArray(req.refine)
      ? (req.refine as unknown as RefineEntry[])
          .filter(entry => entry.scope === 'proposal' && entry.action === 'finalize')
          .map(entry => (entry as Extract<RefineEntry, { scope: 'proposal' }>).proposal_id)
      : [],
  );
  const refinementApplied: RefinementAppliedEntry[] = [];
  const proposalOmitIds = new Set<string>();
  const refinedProposalOverrides = new Map<string, Proposal>();
  const explicitlySelectedProposals = new Map<string, Proposal>();
  const stagedProposalCommits = new Map<string, Proposal>();
  const stagedProposalDeclines = new Map<string, Proposal>();
  let guaranteedOnlyRequested = false;
  if (buyingMode === 'refine' && req.refine) {
    const refineOps = req.refine as unknown as RefineEntry[];
    const previousProposals = session.lastGetProductsContext?.proposals
      ?? (compactLifecycle ? [] : getProposals());
    const registryProposals = getProposals();
    const resolveProposal = (proposalId: string): Proposal | undefined => {
      const proposal = previousProposals.find(candidate => candidate.proposal_id === proposalId)
        ?? (compactLifecycle
          ? undefined
          : registryProposals.find(candidate => candidate.proposal_id === proposalId));
      if (proposal) return proposal;
      if (isThreeZeroStoryboardCompat(ctx) && proposalId === THREE_ZERO_LEGACY_PROPOSAL_ID) {
        return resolveThreeZeroProposalAlias([...previousProposals, ...registryProposals]);
      }
      return undefined;
    };
    const omitIds = new Set<string>();
    const includeIds = new Set<string>();
    const knownProductIds = new Set(
      registryProducts
        .filter(product => !product.expires_at || new Date(product.expires_at) >= new Date())
        .map(product => product.product_id),
    );

    const askAckNotes = (ask?: string) =>
      ask ? { notes: `Ask acknowledged but not applied by training agent: ${ask}` } : {};
    const declineOpportunity = declineProposals
      && isRecord((req as unknown as Record<string, unknown>).opportunity)
      ? (req as unknown as Record<string, unknown>).opportunity as Record<string, unknown>
      : undefined;
    let everyDeclineApplicable = true;

    // Validate entity references before applying any refinements. This keeps
    // failed multi-entry refine calls from partially finalizing earlier entries.
    for (let opIndex = 0; opIndex < refineOps.length; opIndex++) {
      const op = refineOps[opIndex];
      if (op.scope === 'product') {
        if (!knownProductIds.has(op.product_id)) {
          return {
            errors: [{
              code: 'PRODUCT_NOT_FOUND',
              message: `Product not found: ${op.product_id}`,
              field: `refine[${opIndex}].product_id`,
              recovery: 'correctable',
            }] as TaskError[],
          };
        }
        continue;
      }
      if (op.scope !== 'proposal') continue;
      const proposal = resolveProposal(op.proposal_id);
      if (!proposal) {
        if (declineProposals) everyDeclineApplicable = false;
        if (immutableRefine && op.action === 'finalize') {
          return {
            errors: [{
              code: 'PROPOSAL_NOT_FOUND',
              message: `Proposal not found: ${op.proposal_id}`,
              field: `refine[${opIndex}].proposal_id`,
              recovery: 'correctable',
            }] as TaskError[],
          };
        }
        if (immutableRefine || declineProposals) continue;
        return {
          errors: [{
            code: 'PROPOSAL_NOT_FOUND',
            message: `Proposal not found: ${op.proposal_id}`,
            field: `refine[${opIndex}].proposal_id`,
            recovery: 'correctable',
          }] as TaskError[],
        };
      }
      if (op.action === 'decline') {
        const internal = proposal as unknown as Record<string, unknown>;
        if (internal.__executed === true) everyDeclineApplicable = false;
        if (
          typeof declineOpportunity?.opportunity_id === 'string'
          && internal.__opportunity_id !== declineOpportunity.opportunity_id
        ) {
          return {
            errors: [{
              code: 'INVALID_REQUEST',
              message: 'Every proposal in decline_proposals must belong to the supplied opportunity_id.',
              field: 'opportunity.opportunity_id',
              recovery: 'correctable',
            }] as TaskError[],
          };
        }
      }
      if (op.action === 'finalize') {
        const internal = proposal as unknown as Record<string, unknown>;
        const lifecycleLink = session.proposalLifecycleLinks.get(op.proposal_id);
        if (lifecycleLink) {
          if (
            lifecycleLink.operation === 'finalize'
            && lifecycleLink.idempotencyKey === req.idempotency_key
            && previousProposals.some(candidate => candidate.proposal_id === lifecycleLink.successorProposalId)
          ) {
            continue;
          }
          return {
            errors: [{
              code: 'INVALID_STATE',
              message: `Proposal was already finalized: ${op.proposal_id}`,
              field: `refine[${opIndex}].proposal_id`,
              recovery: 'correctable',
            }] as TaskError[],
          };
        }
        if (
          internal.__declined === true
          || internal.__executed === true
        ) {
          return {
            errors: [{
              code: 'INVALID_STATE',
              message: `Proposal is terminal and cannot be finalized: ${op.proposal_id}`,
              field: `refine[${opIndex}].proposal_id`,
              recovery: 'correctable',
            }] as TaskError[],
          };
        }
        if (immutableRefine && proposalLifecycle(proposal).proposal_status !== 'draft') {
          return {
            errors: [{
              code: 'INVALID_STATE',
              message: `Only a draft proposal can be finalized: ${op.proposal_id}`,
              field: `refine[${opIndex}].proposal_id`,
              recovery: 'correctable',
            }] as TaskError[],
          };
        }
        if (proposal.expires_at && new Date(proposal.expires_at) < new Date()) {
          return {
            errors: [{
              code: 'PROPOSAL_EXPIRED',
              message: `Proposal expired at ${proposal.expires_at}: ${op.proposal_id}`,
              field: `refine[${opIndex}].proposal_id`,
              recovery: 'correctable',
            }] as TaskError[],
          };
        }
        const unavailableAllocation = proposal.allocations.find(
          allocation => !knownProductIds.has(allocation.product_id),
        );
        if (unavailableAllocation) {
          return {
            errors: [{
              code: 'PRODUCT_UNAVAILABLE',
              message: `Proposal ${op.proposal_id} references unavailable product ${unavailableAllocation.product_id}`,
              field: `refine[${opIndex}].proposal_id`,
              recovery: 'correctable',
            }] as TaskError[],
          };
        }
      }
    }

    for (let opIndex = 0; opIndex < refineOps.length; opIndex++) {
      const op = refineOps[opIndex];
      if (op.scope === 'product') {
        const action = op.action ?? 'include';
        const passesFilters = filteredProducts.some(product => product.product_id === op.product_id);
        if (action === 'omit') {
          omitIds.add(op.product_id);
          refinementApplied.push({ scope: 'product', product_id: op.product_id, status: 'applied' });
        } else if (action === 'include') {
          includeIds.add(op.product_id);
          if (!passesFilters) {
            refinementApplied.push({
              scope: 'product',
              product_id: op.product_id,
              status: 'partial',
              notes: 'Product is excluded by the request filters',
            });
          } else {
            const concreteCpmAsk = parseConcreteCpmAsk(op.ask);
            if (concreteCpmAsk) {
              const product = products.find(candidate => candidate.product_id === op.product_id);
              const concretePricing = product && concreteCpmPricing(product, concreteCpmAsk.currency);
              if (concretePricing) {
                products = products.map(candidate =>
                  candidate.product_id === op.product_id ? concretePricing.product : candidate,
                );
                session.negotiatedPricingOptions.set(`${op.product_id}:${concretePricing.pricingOptionId}`, {
                  productId: op.product_id,
                  option: concretePricing.pricingOption,
                });
                refinementApplied.push({
                  scope: 'product',
                  product_id: op.product_id,
                  status: 'applied',
                  notes: `Concrete fixed CPM pricing applied (${concretePricing.currency} ${concretePricing.fixedPrice} CPM).`,
                });
              } else {
                refinementApplied.push({
                  scope: 'product',
                  product_id: op.product_id,
                  status: 'unable',
                  notes: concreteCpmAsk.currency
                    ? `No CPM pricing option is available in ${concreteCpmAsk.currency}.`
                    : 'No CPM pricing option can be converted to concrete fixed pricing.',
                });
              }
            } else {
              refinementApplied.push({
                scope: 'product',
                product_id: op.product_id,
                status: op.ask ? 'partial' : 'applied',
                ...askAckNotes(op.ask),
              });
            }
          }
        } else if (action === 'more_like_this') {
          includeIds.add(op.product_id);
          const source = registryProducts.find(p => p.product_id === op.product_id);
          if (source) {
            const sourceChannels = source.channels;
            for (const p of filteredProducts) {
              if (p.channels?.some(c => sourceChannels?.includes(c))) {
                includeIds.add(p.product_id);
              }
            }
          }
          refinementApplied.push(passesFilters
            ? { scope: 'product', product_id: op.product_id, status: 'applied' }
            : { scope: 'product', product_id: op.product_id, status: 'partial', notes: 'Source product is excluded by the request filters' });
        }
      } else if (op.scope === 'proposal') {
        const action = op.action ?? 'include';
        let proposal = refinedProposalOverrides.get(op.proposal_id)
          ?? resolveProposal(op.proposal_id);
        if (!proposal) continue;
        if (action === 'omit') {
          proposalOmitIds.add(proposal.proposal_id);
          refinementApplied.push({ scope: 'proposal', proposal_id: op.proposal_id, status: 'applied' });
        } else if (action === 'include') {
          if (immutableRefine && (proposal as unknown as Record<string, unknown>).__declined === true) {
            refinementApplied.push({
              scope: 'proposal',
              proposal_id: op.proposal_id,
              status: 'unable',
              notes: 'Proposal was declined terminally and cannot be refined',
            });
            continue;
          }
          // An executed compact proposal is the accepted immutable snapshot.
          // Refining it forks an amendment/cancellation draft; the accepted
          // source remains the historical terms attached to the MediaBuy.
          explicitlySelectedProposals.set(proposal.proposal_id, proposal);
          for (const allocation of proposal.allocations) includeIds.add(allocation.product_id);
          if (!immutableRefine && proposalLifecycle(proposal).proposal_status === 'committed' && op.ask) {
            refinementApplied.push({
              scope: 'proposal',
              proposal_id: op.proposal_id,
              status: 'unable',
              notes: 'Proposal is already committed and cannot be refined. Discover or select a draft proposal instead.',
            });
            continue;
          }
          const concreteCpmAsk = parseConcreteCpmAsk(op.ask);
          const hasTypedRevision = op.constraints !== undefined
            || op.product_changes !== undefined
            || op.alternatives !== undefined;
          if (concreteCpmAsk) {
            const stagedProducts = new Map<string, ReturnType<typeof concreteCpmPricing>>();
            let allAllocationsPriced = true;
            for (const allocation of proposal.allocations) {
              const product = products.find(p => p.product_id === allocation.product_id);
              const concretePricing = product && concreteCpmPricing(product, concreteCpmAsk.currency);
              if (!concretePricing) {
                allAllocationsPriced = false;
                break;
              }
              stagedProducts.set(allocation.product_id, concretePricing);
            }

            if (allAllocationsPriced) {
              products = products.map(product => stagedProducts.get(product.product_id)?.product ?? product);
              const budget = concreteCpmAsk.budget;
              let refinedProposal = {
                ...proposal,
                allocations: proposal.allocations.map(allocation => ({
                  ...allocation,
                  pricing_option_id: stagedProducts.get(allocation.product_id)!.pricingOptionId,
                })),
              } as Proposal;
              if (budget) refinedProposal = withProposalBudgetGuidance(refinedProposal, budget);
              refinedProposalOverrides.set(proposal.proposal_id, refinedProposal);
              explicitlySelectedProposals.set(proposal.proposal_id, refinedProposal);
              for (const [productId, pricing] of stagedProducts) {
                session.negotiatedPricingOptions.set(`${productId}:${pricing!.pricingOptionId}`, {
                  productId,
                  option: pricing!.pricingOption,
                });
              }
              const rates = proposal.allocations.map(allocation => {
                const pricing = stagedProducts.get(allocation.product_id)!;
                return `${allocation.product_id}: ${pricing.currency} ${pricing.fixedPrice} CPM`;
              }).join('; ');
              const budgetNote = budget ? ` Recommended total set to ${budget.currency} ${budget.amount}.` : '';
              refinementApplied.push(hasTypedRevision
                ? {
                    scope: 'proposal',
                    proposal_id: op.proposal_id,
                    status: 'partial',
                    notes: `Concrete fixed CPM pricing applied (${rates}).${budgetNote} Typed refinement dimensions are not implemented by the training agent.`,
                  }
                : {
                    scope: 'proposal',
                    proposal_id: op.proposal_id,
                    status: 'applied',
                    notes: `Concrete fixed CPM pricing applied (${rates}).${budgetNote}`,
                  });
            } else {
              refinementApplied.push({ scope: 'proposal', proposal_id: op.proposal_id, status: 'partial', ...askAckNotes(op.ask) });
            }
          } else {
            refinementApplied.push({
              scope: 'proposal',
              proposal_id: op.proposal_id,
              status: op.ask || hasTypedRevision ? 'partial' : 'applied',
              ...(hasTypedRevision
                ? { notes: 'Typed refinement dimensions are not implemented by the training agent' }
                : askAckNotes(op.ask)),
            });
          }
        } else if (action === 'finalize') {
          const status = proposalLifecycle(proposal).proposal_status;
          if (immutableRefine) {
            explicitlySelectedProposals.set(proposal.proposal_id, proposal);
            for (const allocation of proposal.allocations) includeIds.add(allocation.product_id);
            refinementApplied.push({
              scope: 'proposal',
              proposal_id: op.proposal_id,
              status: 'applied',
              notes: 'Proposal finalized — pricing committed and inventory held for 24 hours',
            });
          } else if (status === 'committed') {
            refinementApplied.push({ scope: 'proposal', proposal_id: op.proposal_id, status: 'applied', notes: 'Proposal already committed' });
          } else {
            const accountBrand = (req as unknown as Record<string, unknown>).account as Record<string, unknown> | undefined;
            const boundBrandDomain = (proposal as unknown as Record<string, unknown>).__brand_domain;
            const brandDomain = ((accountBrand?.brand as Record<string, unknown>)?.domain as string)
              || (typeof boundBrandDomain === 'string' ? boundBrandDomain : undefined);
            const updatedProposal = executableProposalSnapshot(proposal, brandDomain);
            stagedProposalCommits.set(op.proposal_id, updatedProposal);

            refinementApplied.push({ scope: 'proposal', proposal_id: op.proposal_id, status: 'applied', notes: 'Proposal finalized — pricing committed, inventory held for 24 hours' });
          }
        } else if (action === 'decline') {
          const internal = proposal as unknown as Record<string, unknown>;
          if (internal.__executed === true) {
            refinementApplied.push({
              scope: 'proposal',
              proposal_id: op.proposal_id,
              status: 'unable',
              notes: 'Proposal was already executed and cannot be declined',
            });
            continue;
          }
          const opportunityUpdate = everyDeclineApplicable && declineOpportunity
            ? {
                ...(isRecord(internal.__opportunity_update)
                  ? structuredClone(internal.__opportunity_update)
                  : {}),
                ...structuredClone(declineOpportunity),
              }
            : undefined;
          if (opportunityUpdate?.status === 'open') {
            delete opportunityUpdate.close_reason;
            delete opportunityUpdate.close_detail;
          }
          const declined = {
            ...proposal,
            ...(
              internal.__declined === true
                ? {}
                : {
                    __declined: true,
                    ...(typeof op.reason === 'string' && { __decline_reason: op.reason }),
                    ...(typeof op.detail === 'string' && { __decline_detail: op.detail }),
                  }
            ),
            ...(opportunityUpdate && { __opportunity_update: opportunityUpdate }),
          } as unknown as Proposal;
          stagedProposalDeclines.set(op.proposal_id, declined);
          refinedProposalOverrides.set(op.proposal_id, declined);
          explicitlySelectedProposals.set(op.proposal_id, declined);
          refinementApplied.push({
            scope: 'proposal',
            proposal_id: op.proposal_id,
            status: 'applied',
            notes: (proposal as unknown as Record<string, unknown>).__declined === true
              ? 'Proposal was already declined'
              : 'Proposal declined terminally',
          });
        }
      } else if (op.scope === 'request') {
        if (requestsGuaranteedOnlyProducts(op.ask)) {
          const guaranteedProducts = products.filter(product => product.delivery_type === 'guaranteed');
          if (guaranteedProducts.length === 0) {
            refinementApplied.push({
              scope: 'request',
              status: 'unable',
              notes: 'No guaranteed products are available in the current selection.',
            });
          } else {
            guaranteedOnlyRequested = true;
            refinementApplied.push({
              scope: 'request',
              status: 'applied',
              notes: 'Selection limited to guaranteed products.',
            });
          }
        } else {
          refinementApplied.push({ scope: 'request', status: 'partial', notes: 'Request-level refinement acknowledged but not applied by training agent' });
        }
      }
    }

    // Apply includes first (expand), then omits (filter) for products
    if (includeIds.size > 0) {
      const currentProductsById = new Map(products.map(product => [product.product_id, product]));
      products = filteredProducts
        .filter(p => includeIds.has(p.product_id))
        .map(p => currentProductsById.get(p.product_id) ?? { ...p });
    }
    if (omitIds.size > 0) {
      products = products.filter(p => !omitIds.has(p.product_id));
    }
    if (guaranteedOnlyRequested) {
      products = products.filter(product => product.delivery_type === 'guaranteed');
    }
    if (stagedProposalCommits.size > 0 || stagedProposalDeclines.size > 0) {
      // Publish the complete batch with one assignment only after every
      // proposal has been resolved and every lifecycle update constructed.
      const prior = session.lastGetProductsContext?.proposals ?? [];
      const stagedUpdates = new Map([...stagedProposalCommits, ...stagedProposalDeclines]);
      const next = prior.map(proposal => stagedUpdates.get(proposal.proposal_id) ?? proposal);
      for (const [proposalId, proposal] of stagedUpdates) {
        if (!prior.some(existing => existing.proposal_id === proposalId)) next.push(proposal);
      }
      session.lastGetProductsContext = {
        products: session.lastGetProductsContext?.products ?? [...products],
        proposals: next,
      };
    }
  }

  // Brief mode only: complete proposals by pulling in missing allocated products.
  // This prevents keyword capping from accidentally breaking proposals.
  const productIds = new Set(products.map(p => p.product_id));
  if (buyingMode === 'brief') {
    const catalogById = new Map(filteredProducts.map(p => [p.product_id, p]));
    for (const proposal of getProposals()) {
      const missing = proposal.allocations.filter(a => !productIds.has(a.product_id));
      const present = proposal.allocations.filter(a => productIds.has(a.product_id));
      if (present.length > 0 && missing.length > 0) {
        for (const alloc of missing) {
          const product = catalogById.get(alloc.product_id);
          if (product) {
            products.push({ ...product });
            productIds.add(alloc.product_id);
          }
        }
      }
    }
  }

  // In refine mode, use session proposals (which may include finalized
  // versions). In other discovery modes, replace registry drafts with the
  // exact committed object already held by this session.
  const contextualProposals = (buyingMode === 'refine' && session.lastGetProductsContext?.proposals)
    ? session.lastGetProductsContext.proposals
    : getProposals().map(proposal => committedProposals.get(proposal.proposal_id) ?? proposal);
  const sourceProposals = [
    ...contextualProposals,
    ...Array.from(explicitlySelectedProposals.values()).filter(selected =>
      !contextualProposals.some(contextual => contextual.proposal_id === selected.proposal_id),
    ),
  ];

  const productsById = new Map(products.map(p => [p.product_id, p]));
  let proposals = sourceProposals
    .map(proposal => refinedProposalOverrides.get(proposal.proposal_id) ?? proposal)
    .filter(proposal =>
      proposal.allocations.every(a => productIds.has(a.product_id)) &&
      !proposalOmitIds.has(proposal.proposal_id),
    )
    .map(proposal => {
      // A committed proposal is a receipt for a specific inventory hold.
      // Later catalog/pricing discovery must not rewrite any part of it.
      if (
        proposalLifecycle(proposal).proposal_status === 'committed'
        || compactFinalizeSourceIds.has(proposal.proposal_id)
      ) return proposal;
      return {
        ...proposal,
        allocations: proposal.allocations.map(alloc => {
          const pricingOptions = productsById.get(alloc.product_id)?.pricing_options;
          const selectedPricing = pricingOptions?.find(
            option => option.pricing_option_id === alloc.pricing_option_id,
          ) ?? pricingOptions?.[0];
          return selectedPricing
            ? { ...alloc, pricing_option_id: selectedPricing.pricing_option_id }
            : alloc;
        }),
      };
    });
  const requireProposals = buyingMode === 'brief'
    && (req as unknown as Record<string, unknown>).__require_proposals === true;
  if (requireProposals) {
    const exactProductIds = Array.isArray((req as unknown as Record<string, unknown>).product_ids)
      ? new Set(((req as unknown as Record<string, unknown>).product_ids as unknown[])
          .filter((id): id is string => typeof id === 'string'))
      : undefined;
    if (exactProductIds) {
      proposals = proposals.filter(proposal => proposal.allocations.every(allocation => (
        exactProductIds.has(allocation.product_id)
      )));
    }
    const key = typeof (req as unknown as Record<string, unknown>).idempotency_key === 'string'
      ? (req as unknown as Record<string, unknown>).idempotency_key as string
      : 'unkeyed';
    const existingById = new Map(
      (session.lastGetProductsContext?.proposals ?? []).map(proposal => [proposal.proposal_id, proposal]),
    );
    const requestRecord = req as unknown as Record<string, unknown>;
    const requestAccount = isRecord(requestRecord.account) ? requestRecord.account : undefined;
    const accountBrand = isRecord(requestAccount?.brand) ? requestAccount.brand : undefined;
    const requestBrand = isRecord(requestRecord.brand) ? requestRecord.brand : accountBrand;
    const requestOpportunity = isRecord(requestRecord.opportunity) ? requestRecord.opportunity : undefined;
    const proposalAccountScope = requestAccount
      ? accountScopeFromRef(requestAccount)
      : compactBrandScope(requestBrand);
    const proposalOwner = JSON.stringify({
      ...(typeof requestAccount?.account_id === 'string' && { account_id: requestAccount.account_id }),
      brand: {
        domain: typeof requestBrand?.domain === 'string' ? requestBrand.domain.toLowerCase() : '',
        ...(typeof requestBrand?.brand_id === 'string' && { brand_id: requestBrand.brand_id }),
        ...(Array.isArray(requestBrand?.countries)
          && { countries: [...requestBrand.countries].filter(country => typeof country === 'string').sort() }),
      },
      ...(typeof requestAccount?.operator === 'string' && { operator: requestAccount.operator.toLowerCase() }),
      ...(isRecord(requestAccount?.operator_unit)
        && typeof requestAccount.operator_unit.id === 'string'
        && { operator_unit_id: requestAccount.operator_unit.id }),
      ...(typeof requestAccount?.currency === 'string' && { currency: requestAccount.currency }),
      ...(typeof requestAccount?.sandbox === 'boolean' && { sandbox: requestAccount.sandbox }),
    });
    proposals = proposals.map((proposal, index) => {
      const digest = createHash('sha256')
        .update(`${proposalOwner}:${key}:${proposal.proposal_id}:${index}`)
        .digest('hex')
        .slice(0, 24);
      const proposalId = `proposal_request_${digest}`;
      const snapshot = {
        ...proposal,
        proposal_id: proposalId,
        ...(typeof requestBrand?.domain === 'string' && { __brand_domain: requestBrand.domain.toLowerCase() }),
        ...(typeof requestBrand?.brand_id === 'string' && { __brand_id: requestBrand.brand_id }),
        ...(Array.isArray(requestBrand?.countries)
          && { __brand_countries: [...requestBrand.countries].filter(country => typeof country === 'string').sort() }),
        ...(typeof requestAccount?.account_id === 'string' && { __account_id: requestAccount.account_id }),
        ...(proposalAccountScope && { __account_scope: proposalAccountScope }),
        ...(typeof requestOpportunity?.opportunity_id === 'string'
          && { __opportunity_id: requestOpportunity.opportunity_id }),
      } as unknown as Proposal;
      return existingById.get(proposalId)
        ?? withCanonicalProposalEnvelope(
          draftProposalSnapshot(snapshot),
          productsById,
          {
            domain: typeof requestBrand?.domain === 'string'
              ? requestBrand.domain.toLowerCase()
              : 'advertiser.example',
            ...(typeof requestBrand?.brand_id === 'string' && { brand_id: requestBrand.brand_id }),
            ...(Array.isArray(requestBrand?.countries)
              && { countries: [...requestBrand.countries].filter(country => typeof country === 'string').sort() }),
          },
        );
    });
    if (proposals.length === 0) {
      return {
        status: 'rejected',
        reason: 'The seller could not construct a proposal satisfying the supplied product and campaign criteria.',
        suggestions: ['Broaden the product selection or campaign constraints and retry with a new idempotency key.'],
      } as GetProductsRejectedResponse;
    }
  }
  const sourceProposalOrder = immutableRefine && Array.isArray(req.refine)
    ? (req.refine as unknown as RefineEntry[])
        .filter((entry): entry is Extract<RefineEntry, { scope: 'proposal' }> => entry.scope === 'proposal')
        .map(entry => entry.proposal_id)
    : [];
  if (immutableRefine) {
    const key = typeof (req as unknown as Record<string, unknown>).idempotency_key === 'string'
      ? (req as unknown as Record<string, unknown>).idempotency_key as string
      : 'unkeyed';
    const proposalsById = new Map(proposals.map(proposal => [proposal.proposal_id, proposal]));
    const outcomesBySource = new Map(
      refinementApplied
        .filter((entry): entry is Extract<RefinementAppliedEntry, { scope: 'proposal' }> => entry.scope === 'proposal')
        .map(entry => [entry.proposal_id, entry]),
    );
    const actionBySource = new Map(
      (req.refine as unknown as RefineEntry[])
        .filter((entry): entry is Extract<RefineEntry, { scope: 'proposal' }> => entry.scope === 'proposal')
        .map(entry => [entry.proposal_id, {
          action: entry.action === 'finalize' ? 'finalize' as const : 'revise' as const,
          changeKind: entry.change_kind,
          ask: entry.ask,
        }]),
    );
    proposals = sourceProposalOrder.flatMap((sourceId, index) => {
      const proposal = proposalsById.get(sourceId);
      const outcome = outcomesBySource.get(sourceId);
      if (!proposal || outcome?.status === 'unable') return [];
      const digest = createHash('sha256').update(`${key}:${sourceId}:${index}`).digest('hex').slice(0, 24);
      const sourceInternal = proposal as unknown as Record<string, unknown>;
      const refinement = actionBySource.get(sourceId);
      const isAcceptedSource = sourceInternal.__executed === true;
      const revision = {
        ...proposal,
        proposal_id: `proposal_revision_${digest}`,
        __source_proposal_id: sourceId,
        __parent_proposal_id: sourceId,
        __refinement_outcome: outcome?.status === 'partial' ? 'partial' : 'revised',
        ...(outcome?.notes && { __refinement_notes: outcome.notes }),
        ...(isAcceptedSource && {
          __proposal_kind: refinement?.changeKind === 'cancellation'
            ? 'media_buy_cancellation'
            : 'media_buy_update',
          __media_buy_id: sourceInternal.__media_buy_id,
          __base_media_buy_revision: sourceInternal.__media_buy_revision,
        }),
      } as unknown as Proposal;
      if (isAcceptedSource) {
        const revisionInternal = revision as unknown as Record<string, unknown>;
        delete revisionInternal.__executed;
        delete revisionInternal.__accepted_at;
        delete revisionInternal.__opportunity_update;
      }
      const existingSuccessor = session.lastGetProductsContext?.proposals?.find(
        candidate => candidate.proposal_id === revision.proposal_id,
      );
      if (existingSuccessor) return [existingSuccessor];
      const brandDomain = (proposal as unknown as Record<string, unknown>).__brand_domain;
      const brandId = (proposal as unknown as Record<string, unknown>).__brand_id;
      const brandCountries = (proposal as unknown as Record<string, unknown>).__brand_countries;
      let successor = refinement?.action === 'finalize'
        ? executableProposalSnapshot(
          revision,
          typeof brandDomain === 'string' ? brandDomain : undefined,
        )
        : withCanonicalProposalEnvelope(
          draftProposalSnapshot(revision),
          productsById,
          {
            domain: typeof brandDomain === 'string' ? brandDomain : 'advertiser.example',
            ...(typeof brandId === 'string' && { brand_id: brandId }),
            ...(Array.isArray(brandCountries) && { countries: brandCountries }),
          },
          { rebuild: true },
        );
      if (refinement?.changeKind === 'cancellation') {
        const successorInternal = successor as unknown as Record<string, unknown>;
        const commercialTerms = structuredClone(successorInternal.__canonical_commercial_terms) as Record<string, unknown>;
        commercialTerms.cancellation_terms = {
          effective_at: new Date().toISOString(),
          ...(typeof refinement.ask === 'string' && { reason: refinement.ask.slice(0, 500) }),
        };
        successorInternal.__canonical_commercial_terms = commercialTerms;
        successorInternal.__canonical_terms_digest = proposalTermsDigest(commercialTerms);
        successor = successorInternal as unknown as Proposal;
      }
      return [successor];
    });
  }
  const canonicalFormatAdvisories = collectCanonicalFormatAdvisories(products);
  const staleDirective = readDirectives
    ? readDirectives.staleDirective
    : session.complyExtensions.forcedUpstreamUnavailable?.tool === 'get_products'
      ? session.complyExtensions.forcedUpstreamUnavailable
      : undefined;
  if (staleDirective && !readDirectives) {
    session.complyExtensions.forcedUpstreamUnavailable = undefined;
  }

  // Store context for refine
  const responseProducts = isThreeZeroStoryboardCompat(ctx)
    ? products.map(productForThreeZeroStoryboardCompat)
    : products;
  const retainedCommittedProposals = new Map(
    (session.lastGetProductsContext?.proposals ?? [])
      .filter(proposal => proposalLifecycle(proposal).proposal_status === 'committed')
      .map(proposal => [proposal.proposal_id, proposal]),
  );
  const finalizedBySource = new Map(
    proposals
      .map(proposal => proposal as unknown as Record<string, unknown>)
      .filter(proposal => (
        typeof proposal.__source_proposal_id === 'string'
        && proposal.proposal_status === 'committed'
        && typeof proposal.proposal_id === 'string'
      ))
      .map(proposal => [proposal.__source_proposal_id as string, proposal.proposal_id as string]),
  );
  const priorProposals = session.lastGetProductsContext?.proposals ?? [];
  const refinementIdempotencyKey = typeof (req as unknown as Record<string, unknown>).idempotency_key === 'string'
    ? (req as unknown as Record<string, unknown>).idempotency_key as string
    : undefined;
  if (refinementIdempotencyKey) {
    for (const [sourceProposalId, successorProposalId] of finalizedBySource) {
      session.proposalLifecycleLinks.set(sourceProposalId, {
        operation: 'finalize',
        idempotencyKey: refinementIdempotencyKey,
        successorProposalId,
      });
    }
  }
  const persistedProposals = buyingMode === 'wholesale'
    ? []
    : immutableRefine
      ? [...new Map([...priorProposals, ...proposals].map(proposal => [proposal.proposal_id, proposal])).values()]
      : requireProposals
        ? [
            ...priorProposals.filter(prior => !proposals.some(proposal => proposal.proposal_id === prior.proposal_id)),
            ...proposals,
          ]
        : [...proposals];
  const persistedProposalIds = new Set(persistedProposals.map(proposal => proposal.proposal_id));
  for (const proposal of retainedCommittedProposals.values()) {
    if (!persistedProposalIds.has(proposal.proposal_id)) persistedProposals.push(proposal);
  }
  if (usesTypedProposalNegotiation(ctx)) {
    const canonicalProducts = new Map(
      registryProducts.map(product => [product.product_id, product]),
    );
    for (const proposal of persistedProposals) {
      if (session.proposalRefinementRecords.has(proposal.proposal_id)) continue;
      session.proposalRefinementRecords.set(proposal.proposal_id, {
        proposal: outwardProposal(
          proposal as unknown as Record<string, unknown>,
          canonicalProducts,
        ) as unknown as CanonicalProposal,
        version: 1,
      });
    }
  }
  // Only refine requests establish durable context for later refinements.
  // Brief/wholesale discovery must remain read-only so concurrent reads cannot
  // overwrite a proposal committed by a serialized refine request.
  if (buyingMode === 'refine' || requireProposals) {
    session.lastGetProductsContext = {
      products: responseProducts,
      proposals: persistedProposals,
    };
  }
  let pageProducts = responseProducts;
  let pagination: { has_more: boolean; total_count: number; cursor?: string } | undefined;
  if (req.pagination) {
    // The exported handler validates this before acquiring the mutex or
    // loading session state.
    const offset = paginationOffset ?? 0;
    const maxResults = Math.min(
      typeof req.pagination.max_results === 'number' && req.pagination.max_results >= 1
        ? req.pagination.max_results
        : 50,
      100,
    );
    const pageEnd = Math.min(offset + maxResults, responseProducts.length);
    pageProducts = responseProducts.slice(offset, pageEnd);
    const hasMore = pageEnd < responseProducts.length;
    pagination = {
      has_more: hasMore,
      total_count: responseProducts.length,
      ...(hasMore && { cursor: encodeOffsetCursor('products', pageEnd) }),
    };
  }

  const response = {
    status: 'completed' as const,
    products: pageProducts,
    cache_scope: wholesaleMeta?.cache_scope ?? cacheScopeForWholesaleRequest(req as WholesaleFeedRequest),
    ...(wholesaleMeta && {
      wholesale_feed_version: wholesaleMeta.wholesale_feed_version,
      pricing_version: wholesaleMeta.pricing_version,
    }),
    ...(pagination && { pagination }),
    ...(buyingMode !== 'wholesale' && proposals.length > 0 && { proposals }),
    ...(refinementApplied.length > 0 && { refinement_applied: refinementApplied }),
    ...contextEcho,
    ...((canonicalFormatAdvisories.length > 0 || staleDirective) && {
      errors: [
        ...(staleDirective ? [{
          code: 'STALE_RESPONSE',
          message: 'Served cached product discovery because an upstream dependency is temporarily unavailable.',
          recovery: 'transient',
          details: {
            served_from_cache: true,
            cache_age_seconds: 60,
            freshness_target_seconds: 30,
            ...(staleDirective.upstreamName && { upstream: { name: staleDirective.upstreamName } }),
          },
        }] : []),
        ...canonicalFormatAdvisories,
      ] as unknown as GetProductsResponse['errors'],
    }),
  };
  return response;
}

export async function handleListCreativeFormats(args: ToolArgs, ctx: TrainingContext): Promise<object> {
  const req = args as unknown as ListCreativeFormatsRequest & { channels?: string[] };

  // When comply_test_controller.seed_creative_format has pre-populated formats,
  // use the seeded catalog so pagination-integrity storyboards can pin
  // has_more / cursor / total_count against a known set size. The seed pool is
  // process-global (not session-scoped) because list_creative_formats has no
  // tenant identity in its request schema — every call is a global catalog
  // read. Other seed_* scenarios (seed_creative, seed_media_buy) target
  // entities the listing call carries identity for and stay session-scoped.
  // Falls back to the static catalog when the seed pool is empty so normal
  // (non-compliance) callers are unaffected.
  let formats: ReturnType<typeof getFormats>;
  const seeded = getSeededCreativeFormats();
  if (seeded.size > 0) {
    // Seeded entries are stored as Record<string, unknown> with the format_id
    // stamped at seed time. Storyboards seed complete TrainingFormat-shaped
    // fixtures (name/description/renders/assets); the cast through unknown
    // matches that contract without re-validating at read time.
    formats = Array.from(seeded.values()) as unknown as ReturnType<typeof getFormats>;
  } else {
    formats = getFormats();

    // Filter by channels (informal field; stripped by SDK in compliance runs,
    // so this path is only reachable in non-SDK direct calls).
    if (req.channels?.length) {
      const validIds = new Set<string>();
      for (const [fmtId, fmtChannels] of Object.entries(FORMAT_CHANNEL_MAP)) {
        if (fmtChannels.some(c => req.channels!.includes(c))) {
          validIds.add(fmtId);
        }
      }
      formats = formats.filter(f => validIds.has(f.format_id.id));
    }
  }

  // Filter by format_ids (applies in both seeded and static paths)
  if (req.format_ids?.length) {
    const requestedIds = new Set(req.format_ids.map(f => f.id));
    formats = formats.filter(f => requestedIds.has(f.format_id.id));
  }

  // The 3.0 FormatIDParameter enum predates pixel-density negotiation. Keep
  // the template available to compatibility runners, but do not advertise an
  // enum member their pinned response schema cannot represent.
  if (ctx.storyboardCompat?.version === '3.0') {
    formats = formats.map(format => format.accepts_parameters?.includes('pixel_ratio')
      ? {
          ...format,
          accepts_parameters: format.accepts_parameters.filter(parameter => parameter !== 'pixel_ratio'),
          description: format.format_id.id === 'display_image'
            ? 'Static image display ad. Provide logical width and height in format_id.'
            : format.description,
        }
      : format);
  }

  const totalMatching = formats.length;
  const requestedMax = req.pagination?.max_results;
  const maxResults = Math.min(typeof requestedMax === 'number' ? requestedMax : 50, 100);
  const offset = decodeCreativeCursor(req.pagination?.cursor);
  if (offset === null) {
    return { errors: [{ code: 'INVALID_REQUEST', message: 'pagination.cursor is malformed' }] };
  }
  const pageEnd = Math.min(offset + maxResults, totalMatching);
  const pageFormats = formats.slice(offset, pageEnd);
  const hasMore = pageEnd < totalMatching;

  return {
    formats: pageFormats,
    pagination: {
      has_more: hasMore,
      total_count: totalMatching,
      ...(hasMore && { cursor: encodeCreativeCursor(pageEnd) }),
    },
  };
}

// ── Transformers (list_transformers + build_creative transformer path) ──────
//
// A transformer is the creative analog of a media-buy product: an
// agent-offered, account-scoped, selectable unit of build capability
// (a voice, a model, a style) with a typed config surface. The reference
// agent exposes one static transformer; real agents resolve account-scoped
// option values (e.g. cloned voices) per credential. Enumerable option VALUES
// are returned only when the param's field is named in expand_params.

interface TransformerParamOption {
  value: unknown;
  label?: string;
  metadata?: Record<string, unknown>;
}

interface TransformerParam {
  field: string;
  type: 'string' | 'number' | 'integer' | 'boolean';
  value_source: 'inline' | 'range' | 'enumerable' | 'free_text';
  allowed_values?: unknown[];
  minimum?: number;
  maximum?: number;
  max_length?: number;
  default?: unknown;
  required?: boolean;
  description?: string;
}

interface TrainingTransformer {
  transformer_id: string;
  name: string;
  description?: string;
  metadata?: Record<string, unknown>;
  input_format_ids?: FormatID[];
  input_formats?: Array<{ format_kind: string; params: Record<string, unknown> }>;
  output_format_ids: FormatID[];
  output_capability_ids: string[];
  params: TransformerParam[];
  pricing_options?: Array<Record<string, unknown>>;
  multiplicity?: Record<string, unknown>;
  // Full account-scoped option pool for enumerable params, surfaced on
  // params[].options[] only when expand_params names the field.
  enumerableOptions?: Record<string, TransformerParamOption[]>;
}

// The agent advertises this as multiplicity.max_variants_limit and enforces it
// on build_creative — a variant request above it is clamped (not rejected),
// signalling the shortfall via leaves_returned < leaves_total.
const TRANSFORMER_MAX_VARIANTS_LIMIT = 10;

function getTransformers(): TrainingTransformer[] {
  const agentUrl = getAgentUrl();
  return [
    {
      transformer_id: 'audiostack_voiceover',
      name: 'Voiceover',
      description: 'Script-to-audio voiceover with account-configured voices.',
      metadata: { provider: 'audiostack', modality: 'audio' },
      input_format_ids: [{ agent_url: agentUrl, id: 'script' }],
      output_format_ids: [{ agent_url: agentUrl, id: 'audio_vo' }],
      output_capability_ids: ['audio_vo'],
      params: [
        { field: 'voice', type: 'string', value_source: 'enumerable', default: 'sara', description: 'Narration voice, incl. account-specific custom/cloned voices.' },
        { field: 'mastering_preset', type: 'string', value_source: 'inline', allowed_values: ['broadcast', 'podcast', 'music'], default: 'broadcast', description: 'Audio mastering profile applied to the final mix.' },
        { field: 'speaking_rate', type: 'number', value_source: 'range', minimum: 0.5, maximum: 2.0, default: 1.0, description: 'Narration speed multiplier.' },
        { field: 'pronunciation_note', type: 'string', value_source: 'free_text', max_length: 280, description: 'Optional free-text pronunciation/style guidance.' },
      ],
      pricing_options: [
        { pricing_option_id: 'vo_per_second_standard', model: 'per_unit', unit: 'second', unit_price: 0.05, currency: 'USD' },
      ],
      multiplicity: { supports_catalog_fanout: false, supports_variants: true, max_variants_limit: TRANSFORMER_MAX_VARIANTS_LIMIT, variant_dimensions: ['voice', 'best_of_n', 'transformer_config'] },
      enumerableOptions: {
        voice: [
          { value: 'sara', label: 'Sara', metadata: { language: 'en-US', gender: 'female', provider: 'audiostack' } },
          { value: 'isaac', label: 'Isaac', metadata: { language: 'en-US', gender: 'male', provider: 'audiostack' } },
          { value: 'mateo', label: 'Mateo', metadata: { language: 'es-ES', gender: 'male', provider: 'audiostack' } },
          { value: 'ceo_clone_2026', label: 'CEO (custom)', metadata: { language: 'en-US', custom: true } },
        ],
      },
    },
  ];
}

interface ListTransformersArgs {
  transformer_ids?: string[];
  input_format_ids?: FormatID[];
  output_format_ids?: FormatID[];
  input_format_kinds?: string[];
  output_capability_ids?: string[];
  name_search?: string;
  brief?: string;
  expand_params?: string[];
  expand_pagination?: Array<{ transformer_id?: string; field?: string; options_cursor?: string }>;
  include_pricing?: boolean;
  account?: unknown;
  pagination?: { max_results?: number; cursor?: string };
}

export async function handleListTransformers(args: ToolArgs, _ctx: TrainingContext): Promise<object> {
  const req = args as unknown as ListTransformersArgs;

  // Pricing is account-scoped — the request schema makes account conditionally
  // required when include_pricing is true.
  if (req.include_pricing) {
    const account = req.account as { account_id?: string; brand?: { domain?: string } } | undefined;
    const hasAccount = !!(account && (account.account_id || account.brand?.domain));
    if (!hasAccount) {
      return { errors: [{ code: 'INVALID_REQUEST', message: 'account is required when include_pricing is true.', field: 'account', recovery: 'correctable' }] };
    }
  }

  let transformers = getTransformers();
  if (req.transformer_ids?.length) {
    const want = new Set(req.transformer_ids);
    transformers = transformers.filter(t => want.has(t.transformer_id));
  }
  if (req.output_format_ids?.length) {
    const want = new Set(req.output_format_ids.map(f => f.id));
    transformers = transformers.filter(t => t.output_format_ids.some(f => want.has(f.id)));
  }
  if (req.output_capability_ids?.length) {
    const want = new Set(req.output_capability_ids);
    transformers = transformers.filter(t => t.output_capability_ids.some(id => want.has(id)));
  }
  if (req.input_format_ids?.length) {
    const want = new Set(req.input_format_ids.map(f => f.id));
    transformers = transformers.filter(t => (t.input_format_ids ?? []).some(f => want.has(f.id)));
  }
  if (req.input_format_kinds?.length) {
    const want = new Set(req.input_format_kinds);
    transformers = transformers.filter(t => (t.input_formats ?? []).some(format => want.has(format.format_kind)));
  }
  if (req.name_search) {
    const needle = req.name_search.toLowerCase();
    transformers = transformers.filter(t => t.name.toLowerCase().includes(needle));
  }

  // expand_params surfaces the FIRST page of a field's option values;
  // expand_pagination fetches the NEXT page of a specific (transformer, field)
  // via its options_cursor (from a prior response).
  const OPTION_PAGE_SIZE = 25;
  const expand = new Set(req.expand_params ?? []);
  const optionCursorByKey = new Map<string, string>();
  for (const ep of req.expand_pagination ?? []) {
    if (!ep.field) continue;
    expand.add(ep.field);
    if (ep.options_cursor !== undefined) {
      // Reject a malformed/foreign option cursor rather than silently restart at page 1.
      if (decodeTransformerOptionCursor(ep.options_cursor) === null) {
        return { errors: [{ code: 'INVALID_REQUEST', message: 'expand_pagination.options_cursor is malformed', field: 'expand_pagination', recovery: 'correctable' }] };
      }
      optionCursorByKey.set(`${ep.transformer_id ?? ''}::${ep.field}`, ep.options_cursor);
    }
  }
  const briefNeedle = req.brief?.toLowerCase();

  const shaped = transformers.map(t => {
    const params = t.params.map(p => {
      if (p.value_source === 'enumerable' && expand.has(p.field)) {
        let options = t.enumerableOptions?.[p.field] ?? [];
        // Brief-filter enumerable values (e.g. "spanish" narrows a voice catalog).
        if (briefNeedle) {
          const filtered = options.filter(o => JSON.stringify(o).toLowerCase().includes(briefNeedle));
          options = filtered;
        }
        // Page the (filtered) option set per (transformer, field).
        const cursor = optionCursorByKey.get(`${t.transformer_id}::${p.field}`) ?? optionCursorByKey.get(`::${p.field}`);
        const optOffset = cursor ? (decodeTransformerOptionCursor(cursor) ?? 0) : 0;
        const optEnd = Math.min(optOffset + OPTION_PAGE_SIZE, options.length);
        const moreOptions = optEnd < options.length;
        return {
          ...p,
          options: options.slice(optOffset, optEnd),
          ...(moreOptions && { options_cursor: encodeTransformerOptionCursor(optEnd) }),
        };
      }
      return p;
    });
    return {
      transformer_id: t.transformer_id,
      name: t.name,
      ...(t.description && { description: t.description }),
      ...(t.metadata && { metadata: t.metadata }),
      ...(t.input_formats && { input_formats: t.input_formats }),
      output_capability_ids: t.output_capability_ids,
      params,
      ...(t.multiplicity && { multiplicity: t.multiplicity }),
      ...(req.include_pricing && t.pricing_options && { pricing_options: t.pricing_options }),
    };
  });

  const requestedMax = req.pagination?.max_results;
  const maxResults = Math.min(typeof requestedMax === 'number' ? requestedMax : 50, 100);
  const offset = decodeTransformerCursor(req.pagination?.cursor);
  if (offset === null) {
    return { errors: [{ code: 'INVALID_REQUEST', message: 'pagination.cursor is malformed', field: 'pagination.cursor', recovery: 'correctable' }] };
  }
  const pageEnd = Math.min(offset + maxResults, shaped.length);
  const page = shaped.slice(offset, pageEnd);
  const hasMore = pageEnd < shaped.length;

  return {
    transformers: page,
    pagination: {
      has_more: hasMore,
      total_count: shaped.length,
      ...(hasMore && { cursor: encodeTransformerCursor(pageEnd) }),
    },
  };
}

/**
 * Strict-validate a build_creative `config` against the selected transformer's
 * params. The request schema leaves config open (legal keys are dynamic per
 * transformer), so rejecting unknown keys / out-of-range values is a normative
 * AGENT obligation, not schema validation. Returns the first violation, or null.
 */
function validateTransformerConfig(
  transformer: TrainingTransformer,
  config: Record<string, unknown> | undefined,
): { code: string; message: string; field: string; recovery: 'correctable' } | null {
  if (!config || typeof config !== 'object') return null;
  const byField = new Map(transformer.params.map(p => [p.field, p] as const));
  for (const [key, value] of Object.entries(config)) {
    const param = byField.get(key);
    if (!param) {
      return { code: 'INVALID_REQUEST', message: `Unknown config key "${key}" for transformer "${transformer.transformer_id}". Vendor-specific knobs belong in ext.`, field: `config.${key}`, recovery: 'correctable' };
    }
    if (param.value_source === 'inline') {
      if (!Array.isArray(param.allowed_values) || !param.allowed_values.includes(value)) {
        return { code: 'INVALID_REQUEST', message: `config.${key} must be one of: ${(param.allowed_values ?? []).join(', ')}.`, field: `config.${key}`, recovery: 'correctable' };
      }
    } else if (param.value_source === 'range') {
      const n = typeof value === 'number' ? value : Number.NaN;
      if (Number.isNaN(n) || (typeof param.minimum === 'number' && n < param.minimum) || (typeof param.maximum === 'number' && n > param.maximum)) {
        return { code: 'INVALID_REQUEST', message: `config.${key} must be a number in [${param.minimum}, ${param.maximum}].`, field: `config.${key}`, recovery: 'correctable' };
      }
    } else if (param.value_source === 'enumerable') {
      const opts = transformer.enumerableOptions?.[key] ?? [];
      if (opts.length > 0 && !opts.some(o => o.value === value)) {
        return { code: 'INVALID_REQUEST', message: `config.${key} "${String(value)}" is not an available value for this account.`, field: `config.${key}`, recovery: 'correctable' };
      }
    } else if (param.value_source === 'free_text') {
      // No closed/enumerable set, but max_length (when declared) is enforced.
      if (typeof param.max_length === 'number' && typeof value === 'string' && value.length > param.max_length) {
        return { code: 'INVALID_REQUEST', message: `config.${key} exceeds the maximum length of ${param.max_length} characters.`, field: `config.${key}`, recovery: 'correctable' };
      }
    }
  }
  // Required params the buyer omitted (no default chosen by the caller).
  for (const param of transformer.params) {
    if (param.required && !(param.field in config)) {
      return { code: 'INVALID_REQUEST', message: `config.${param.field} is required for transformer "${transformer.transformer_id}".`, field: `config.${param.field}`, recovery: 'correctable' };
    }
  }
  return null;
}

function transformerManifest(target: FormatID, label: string, canonical: boolean): AdcpCreativeManifest {
  if (canonical) {
    const capability = supportedCanonicalBuildCapability(target.id);
    if (capability) {
      if (capability.formatKind === 'audio_hosted') {
        return {
          format_kind: capability.formatKind,
          assets: buildCanonicalAudioAssets(),
        } as AdcpCreativeManifest;
      }
      return {
        format_kind: capability.formatKind,
        assets: buildHtmlAssets(label),
      } as AdcpCreativeManifest;
    }
  }
  return {
    format_id: { agent_url: target.agent_url ?? getAgentUrl(), id: target.id },
    assets: buildHtmlAssets(label),
  } as AdcpCreativeManifest;
}

function defaultTargetsForManifest(manifest: ValidateInputArgs['manifest']): ValidateInputTarget[] {
  if (typeof manifest?.format_kind === 'string') {
    return [{ kind: 'canonical', id: manifest.format_kind }];
  }
  return [];
}

function schemaIssueField(path: Array<string | number>): string {
  if (path.length === 0) return 'manifest';
  return `manifest.${path.map(part => typeof part === 'number' ? `[${part}]` : part).join('.')}`.replace(/\.\[/g, '[');
}

function validateManifestSchema(manifest: NonNullable<ValidateInputArgs['manifest']>): ValidateInputViolation[] {
  const parsed = CreativeManifestSchema.safeParse(manifest);
  if (parsed.success) return [];
  return parsed.error.issues.map(issue => ({
    rule: 'schema',
    field: schemaIssueField(issue.path.filter((part): part is string | number => typeof part === 'string' || typeof part === 'number')),
    expected: issue.message,
    predicted: issue.code,
  }));
}

function validateExternalUrlValue(field: string, raw: unknown): ValidateInputViolation | null {
  if (typeof raw !== 'string') return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { rule: 'url', field, expected: 'valid http/https URL', predicted: raw };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { rule: 'url_scheme', field, expected: 'http or https', predicted: parsed.protocol };
  }
  const hostname = normalizeExternalHostname(parsed.hostname);
  if (!hostname || isPrivateHostname(hostname)) {
    return { rule: 'url_host_public', field, expected: 'public hostname', predicted: parsed.hostname };
  }
  return null;
}

function collectAssetUrlViolations(
  value: unknown,
  path: string,
  violations: ValidateInputViolation[],
  seen: WeakSet<object>,
): void {
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectAssetUrlViolations(entry, `${path}[${index}]`, violations, seen));
    return;
  }

  const object = value as Record<string, unknown>;
  for (const [key, entry] of Object.entries(object)) {
    const childPath = `${path}.${key}`;
    if (key === 'url' || key.endsWith('_url')) {
      const violation = validateExternalUrlValue(childPath, entry);
      if (violation) violations.push(violation);
    }
    collectAssetUrlViolations(entry, childPath, violations, seen);
  }
}

function validateAssetUrls(manifest: NonNullable<ValidateInputArgs['manifest']>): ValidateInputViolation[] {
  const violations: ValidateInputViolation[] = [];
  const assets = manifest.assets ?? {};
  const seen = new WeakSet<object>();
  for (const [slotId, slotValue] of Object.entries(assets)) {
    collectAssetUrlViolations(slotValue, `assets.${slotId}`, violations, seen);
  }
  return violations;
}

function assetTypeOf(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const assetType = (value as { asset_type?: unknown }).asset_type;
  return typeof assetType === 'string' ? assetType : undefined;
}

function slotValues(assets: Record<string, unknown> | undefined, slotId: string): unknown[] {
  const value = assets?.[slotId];
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function slotCount(assets: Record<string, unknown> | undefined, slotId: string): number {
  return slotValues(assets, slotId).length;
}

function validateManifestSlots(
  manifest: NonNullable<ValidateInputArgs['manifest']>,
  slots: CanonicalSlot[],
): ValidateInputViolation[] {
  const violations: ValidateInputViolation[] = [];
  const assets = manifest.assets ?? {};

  for (const slot of slots) {
    const count = slotCount(assets, slot.asset_group_id);
    if (slot.required && count === 0) {
      violations.push({
        rule: 'required_slot',
        field: `assets.${slot.asset_group_id}`,
        expected: { asset_type: slot.asset_type },
      });
      continue;
    }
    if (count === 0) continue;
    if (slot.min !== undefined && count < slot.min) {
      violations.push({
        rule: 'slot_min_items',
        field: `assets.${slot.asset_group_id}`,
        expected: slot.min,
        predicted: count,
      });
    }
    if (slot.max !== undefined && count > slot.max) {
      violations.push({
        rule: 'slot_max_items',
        field: `assets.${slot.asset_group_id}`,
        expected: slot.max,
        predicted: count,
      });
    }
    for (const [index, value] of slotValues(assets, slot.asset_group_id).entries()) {
      const predicted = assetTypeOf(value);
      if (predicted !== slot.asset_type) {
        violations.push({
          rule: 'asset_type',
          field: Array.isArray(assets[slot.asset_group_id])
            ? `assets.${slot.asset_group_id}[${index}].asset_type`
            : `assets.${slot.asset_group_id}.asset_type`,
          expected: slot.asset_type,
          predicted,
        });
      }
    }
  }

  return violations;
}

function normalizeCanonicalSlots(value: unknown): CanonicalSlot[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const slots: CanonicalSlot[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const slot = entry as Record<string, unknown>;
    if (typeof slot.asset_group_id !== 'string' || typeof slot.asset_type !== 'string') continue;
    slots.push({
      asset_group_id: slot.asset_group_id,
      asset_type: slot.asset_type,
      ...(typeof slot.required === 'boolean' && { required: slot.required }),
      ...(typeof slot.min === 'number' && { min: slot.min }),
      ...(typeof slot.max === 'number' && { max: slot.max }),
    });
  }
  return slots.length > 0 ? slots : undefined;
}

function selectedFormatDeclaration(
  product: Product,
  manifest: ValidateInputArgs['manifest'],
): Record<string, unknown> | undefined {
  const declarations = (product as unknown as { format_options?: unknown[] }).format_options;
  if (!Array.isArray(declarations)) return undefined;
  const formatOptionRef = manifest?.format_option_ref && typeof manifest.format_option_ref === 'object'
    ? manifest.format_option_ref
    : undefined;
  const formatOptionId = typeof formatOptionRef?.format_option_id === 'string'
    ? formatOptionRef.format_option_id
    : undefined;
  const publisherDomain = typeof formatOptionRef?.publisher_domain === 'string'
    ? formatOptionRef.publisher_domain
    : undefined;
  const scope = typeof formatOptionRef?.scope === 'string'
    ? formatOptionRef.scope
    : undefined;
  const formatKindMatches = declarations.filter((entry): entry is Record<string, unknown> => {
    if (!entry || typeof entry !== 'object') return false;
    const declaration = entry as Record<string, unknown>;
    if (manifest?.format_kind && declaration.format_kind !== manifest.format_kind) return false;
    return true;
  });
  if (formatOptionId) {
    return formatKindMatches.find(declaration => {
      if (declaration.format_option_id !== formatOptionId) return false;
      const declarationPublisherDomain = typeof declaration.publisher_domain === 'string'
        ? declaration.publisher_domain
        : undefined;
      if (scope === 'publisher') {
        return Boolean(publisherDomain) && declarationPublisherDomain === publisherDomain;
      }
      if (scope === 'product') {
        return declarationPublisherDomain === undefined;
      }
      return declarationPublisherDomain === publisherDomain;
    });
  }
  return formatKindMatches.length === 1 ? formatKindMatches[0] : undefined;
}

function nondeterministicSourceViolation(formatParams: Record<string, unknown>): ValidateInputViolation | null {
  const source = typeof formatParams.asset_source === 'string'
    ? formatParams.asset_source
    : (typeof formatParams.item_production_model === 'string' ? formatParams.item_production_model : undefined);
  if (!source || !NONDETERMINISTIC_INCOMPATIBLE_SOURCES.has(source)) return null;
  return {
    rule: 'synthesis_nondeterministic_source_compatibility',
    field: formatParams.asset_source !== undefined ? 'params.asset_source' : 'params.item_production_model',
    expected: 'seller_pre_rendered_from_brief, seller_human_designed, or agent_synthesized',
    predicted: source,
  };
}

function thirdPartyResolutionViolation(target: ValidateInputTarget, expected: string, predicted?: unknown): ValidateInputResult {
  return {
    target,
    result_kind: 'validated_fail',
    violations: [{
      rule: 'third_party_format_resolution',
      field: 'targets[].id',
      expected,
      predicted: predicted ?? target.id,
    }],
  };
}

function parseThirdPartyFormatTarget(target: ValidateInputTarget): { url: string; digest: string } | ValidateInputResult {
  const marker = '@sha256:';
  const markerIndex = target.id.lastIndexOf(marker);
  if (markerIndex <= 0) {
    return thirdPartyResolutionViolation(target, 'https URI followed by @sha256:<64 lowercase hex digest>');
  }
  const url = target.id.slice(0, markerIndex);
  const digest = target.id.slice(markerIndex + marker.length);
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    return thirdPartyResolutionViolation(target, '64 lowercase hex SHA-256 digest', digest);
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      return thirdPartyResolutionViolation(target, 'https URI', parsed.protocol);
    }
    const hostname = normalizeExternalHostname(parsed.hostname);
    if (!hostname || isPrivateHostname(hostname)) {
      return thirdPartyResolutionViolation(target, 'public hostname', parsed.hostname);
    }
  } catch {
    return thirdPartyResolutionViolation(target, 'valid https URI', url);
  }
  return { url, digest };
}

async function validateThirdPartyTarget(
  target: ValidateInputTarget,
  manifest: NonNullable<ValidateInputArgs['manifest']>,
): Promise<ValidateInputResult> {
  const parsedTarget = parseThirdPartyFormatTarget(target);
  if ('result_kind' in parsedTarget) return parsedTarget;

  let response: { status: number; data: Buffer };
  try {
    response = await safeFetchAxiosLike(parsedTarget.url, {
      method: 'GET',
      timeoutMs: 5000,
      maxResponseBytes: 1024 * 1024,
      maxRedirects: 0,
    });
  } catch (error) {
    return thirdPartyResolutionViolation(target, 'fetchable digest-pinned third-party format schema', error instanceof Error ? error.message : String(error));
  }
  if (response.status < 200 || response.status >= 300) {
    return thirdPartyResolutionViolation(target, 'HTTP 2xx response', response.status);
  }

  const body = response.data;
  const digest = createHash('sha256').update(body).digest('hex');
  if (digest !== parsedTarget.digest) {
    return thirdPartyResolutionViolation(target, `sha256:${parsedTarget.digest}`, `sha256:${digest}`);
  }

  let definition: unknown;
  try {
    definition = JSON.parse(body.toString('utf8'));
  } catch {
    return thirdPartyResolutionViolation(target, 'JSON format definition');
  }
  const def = definition && typeof definition === 'object'
    ? definition as Record<string, unknown>
    : {};
  const params = def.params && typeof def.params === 'object'
    ? def.params as Record<string, unknown>
    : {};
  const slots = normalizeCanonicalSlots(def.slots) ?? normalizeCanonicalSlots(params.slots);
  if (!slots) {
    return thirdPartyResolutionViolation(target, 'format definition with slots[] or params.slots[]');
  }
  const violations = validateManifestSlots(manifest, slots);
  return violations.length > 0
    ? { target, result_kind: 'validated_fail', violations }
    : { target, result_kind: 'validated_pass' };
}

function validateCanonicalTarget(
  target: ValidateInputTarget,
  manifest: NonNullable<ValidateInputArgs['manifest']>,
): ValidateInputResult {
  if (!VALID_CANONICAL_FORMAT_KINDS.has(target.id) || target.id === 'custom') {
    return {
      target,
      result_kind: 'validated_fail',
      violations: [{
        rule: 'canonical_target_supported',
        field: 'targets[].id',
        expected: [...VALID_CANONICAL_FORMAT_KINDS].filter(id => id !== 'custom'),
        predicted: target.id,
      }],
    };
  }
  if (manifest.format_kind !== target.id) {
    return {
      target,
      result_kind: 'validated_fail',
      violations: [{
        rule: 'format_kind',
        field: 'manifest.format_kind',
        expected: target.id,
        predicted: manifest.format_kind,
      }],
    };
  }
  const violations = validateManifestSlots(manifest, CANONICAL_FORMAT_SLOTS[target.id] ?? []);
  return violations.length > 0
    ? { target, result_kind: 'validated_fail', violations }
    : { target, result_kind: 'validated_pass' };
}

function validateCapabilityTarget(
  target: ValidateInputTarget,
  manifest: NonNullable<ValidateInputArgs['manifest']>,
): ValidateInputResult {
  const capability = supportedCanonicalBuildCapability(target.id);
  if (!capability) {
    return {
      target,
      result_kind: 'validated_fail',
      violations: [{
        rule: 'capability_target_supported',
        field: 'targets[].id',
        expected: SUPPORTED_CANONICAL_BUILD_CAPABILITIES.map(item => item.capabilityId),
        predicted: target.id,
      }],
    };
  }
  if (manifest.format_kind !== capability.formatKind) {
    return {
      target,
      result_kind: 'validated_fail',
      violations: [{
        rule: 'format_kind',
        field: 'manifest.format_kind',
        expected: capability.formatKind,
        predicted: manifest.format_kind,
      }],
    };
  }
  const violations = validateManifestSlots(manifest, capability.slots);
  return violations.length > 0
    ? { target, result_kind: 'validated_fail', violations }
    : { target, result_kind: 'validated_pass' };
}

function validateProductTarget(
  target: ValidateInputTarget,
  manifest: NonNullable<ValidateInputArgs['manifest']>,
  product: Product | undefined,
): ValidateInputResult {
  if (!product) {
    return {
      target,
      result_kind: 'validated_fail',
      violations: [{
        rule: 'product_target_found',
        field: 'targets[].id',
        expected: 'known product_id',
        predicted: target.id,
      }],
    };
  }
  if (typeof manifest.format_kind !== 'string') {
    return {
      target,
      result_kind: 'validated_fail',
      violations: [{
        rule: 'format_kind',
        field: 'manifest.format_kind',
        expected: 'canonical format_kind for product validation',
        predicted: manifest.format_kind,
      }],
    };
  }
  const declaration = selectedFormatDeclaration(product, manifest);
  if (!declaration) {
    return {
      target,
      result_kind: 'validated_fail',
      violations: [{
        rule: 'product_format_option_supported',
        field: 'manifest.format_kind',
        expected: (product as unknown as { format_options?: Array<{ format_kind?: string }> }).format_options?.map(o => o.format_kind) ?? [],
        predicted: manifest.format_kind,
      }],
    };
  }
  const formatKind = typeof declaration.format_kind === 'string' ? declaration.format_kind : undefined;
  if (!formatKind || !VALID_CANONICAL_FORMAT_KINDS.has(formatKind) || formatKind === 'custom') {
    return {
      target,
      result_kind: 'validated_fail',
      violations: [{
        rule: 'product_format_kind_supported',
        field: 'products[].format_options[].format_kind',
        expected: [...VALID_CANONICAL_FORMAT_KINDS].filter(id => id !== 'custom'),
        predicted: formatKind,
      }],
    };
  }
  const params = declaration.params && typeof declaration.params === 'object'
    ? declaration.params as Record<string, unknown>
    : {};
  const slots = normalizeCanonicalSlots(params.slots) ?? CANONICAL_FORMAT_SLOTS[formatKind] ?? [];
  const violations = validateManifestSlots(manifest, slots);
  if (params.synthesis_nondeterministic === true) {
    const sourceViolation = nondeterministicSourceViolation(params);
    if (sourceViolation) {
      return { target, result_kind: 'validated_fail', violations: [...violations, sourceViolation] };
    }
    if (violations.length > 0) {
      return { target, result_kind: 'validated_fail', violations };
    }
    return { target, result_kind: 'unvalidatable_nondeterministic' };
  }
  return violations.length > 0
    ? { target, result_kind: 'validated_fail', violations }
    : { target, result_kind: 'validated_pass' };
}

export async function handleValidateInput(args: ToolArgs, ctx: TrainingContext): Promise<object> {
  const req = args as unknown as ValidateInputArgs;
  if (!req.manifest) {
    return {
      status: 'completed',
      results: [{
        target: { kind: 'canonical', id: 'unknown' },
        result_kind: 'validated_fail',
        violations: [{ rule: 'manifest_required', field: 'manifest', expected: 'creative manifest' }],
      }],
    };
  }
  const targets = req.targets?.length ? req.targets : defaultTargetsForManifest(req.manifest);
  if (targets.length === 0) {
    return {
      status: 'completed',
      results: [{
        target: { kind: 'canonical', id: 'unknown' },
        result_kind: 'validated_fail',
        violations: [{ rule: 'target_required', field: 'targets', expected: 'at least one validation target' }],
      }],
    };
  }
  if (targets.length > MAX_VALIDATE_INPUT_TARGETS) {
    return {
      status: 'completed',
      results: [{
        target: { kind: 'canonical', id: 'unknown' },
        result_kind: 'validated_fail',
        violations: [{
          rule: 'too_many_targets',
          field: 'targets',
          expected: `at most ${MAX_VALIDATE_INPUT_TARGETS} validation targets`,
          predicted: targets.length,
        }],
      }],
    };
  }

  const unknownCapabilityIndex = targets.findIndex(target =>
    target.kind === 'capability' && !supportedCanonicalBuildCapability(target.id)
  );
  if (unknownCapabilityIndex >= 0) {
    const target = targets[unknownCapabilityIndex];
    return {
      errors: [{
        code: 'FORMAT_NOT_SUPPORTED',
        message: `Validation capability "${target.id}" is not advertised by this creative agent.`,
        field: `targets[${unknownCapabilityIndex}].id`,
        recovery: 'correctable',
        details: {
          capability_id: target.id,
          supported_capability_ids: SUPPORTED_CANONICAL_BUILD_CAPABILITIES.map(item => item.capabilityId),
        },
      }],
    };
  }

  const schemaViolations = [
    ...validateManifestSchema(req.manifest),
    ...validateAssetUrls(req.manifest),
  ];
  if (schemaViolations.length > 0) {
    return {
      status: 'completed',
      results: targets.map(target => ({
        target,
        result_kind: 'validated_fail',
        violations: schemaViolations,
      })),
    };
  }

  const productTargets = targets.filter(target => target.kind === 'product');
  const productsById = new Map<string, Product>();
  if (productTargets.length > 0) {
    const session = await getSession(
      sessionKeyFromArgs(req, ctx.mode, ctx.userId, ctx.moduleId),
      controllerFixtureSessionKey(req as unknown as ToolArgs, ctx),
    );
    for (const catalogProduct of getCatalog()) {
      productsById.set(catalogProduct.product.product_id, { ...catalogProduct.product });
    }
    overlaySeededProducts(session, productsById);
  }

  const results: ValidateInputResult[] = await Promise.all(targets.map(target => {
    if (target.kind === 'canonical') {
      return validateCanonicalTarget(target, req.manifest!);
    }
    if (target.kind === 'product') {
      return validateProductTarget(target, req.manifest!, productsById.get(target.id));
    }
    if (target.kind === 'capability') {
      return validateCapabilityTarget(target, req.manifest!);
    }
    return validateThirdPartyTarget(target, req.manifest!);
  }));

  return { status: 'completed', results };
}

export async function handleCreateMediaBuy(args: ToolArgs, ctx: TrainingContext) {
  const proposalId = (args as unknown as Record<string, unknown>).proposal_id;
  if (typeof proposalId !== 'string') return handleCreateMediaBuyUnlocked(args, ctx);

  // Proposal execution, legacy get_products finalization, and decline all
  // transition the same principal-owned snapshot. Serialize them on the
  // compact lifecycle session and persist before releasing so different
  // idempotency keys cannot both execute one proposal.
  const sessionScope = sessionKeyFromArgs(
    {},
    ctx.mode,
    ctx.userId,
    ctx.moduleId,
    ctx.principal ?? 'anonymous',
  );
  const sessionHash = createHash('sha256').update(sessionScope).digest('hex');
  const principal = 'get-products-session-mutex';
  const key = `get-products-session:${sessionHash}`;
  const store = getIdempotencyStore();
  let claim = await store.check({ principal, key, payload: { session: sessionHash } });
  const deadline = Date.now() + 2_000;
  let backoffMs = 5;
  while (claim.kind !== 'miss' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, backoffMs));
    claim = await store.check({ principal, key, payload: { session: sessionHash } });
    backoffMs = Math.min(backoffMs * 2, 100);
  }
  if (claim.kind !== 'miss') {
    return {
      errors: [{
        code: 'CONFLICT',
        message: 'Another proposal lifecycle request is already updating this session. Retry after a short delay.',
        recovery: 'transient',
      }] as TaskError[],
    };
  }

  try {
    evictSessionFromRequestCache(sessionScope);
    const result = await handleCreateMediaBuyUnlocked(args, ctx);
    await flushDirtySessions();
    return result;
  } finally {
    await store.release({ principal, key, claimToken: claim.claimToken });
  }
}

async function handleCreateMediaBuyUnlocked(args: ToolArgs, ctx: TrainingContext) {
  const req = args as unknown as CreateMediaBuyRequest & ToolArgs & { paused?: boolean };
  const sessionKey = sessionKeyFromArgs(req, ctx.mode, ctx.userId, ctx.moduleId);
  const session = await getSession(
    sessionKey,
    controllerFixtureSessionKey(req, ctx),
  );
  const accountCurrency = resolveAccountCurrencyForRef(
    sessionKey,
    ctx.principal,
    ctx.resolvedAccount ?? req.account,
  );
  if (
    accountCurrency
    && req.total_budget?.currency
    && req.total_budget.currency !== accountCurrency
  ) {
    return {
      errors: [{
        code: 'INVALID_REQUEST',
        message: `total_budget.currency must match the account currency (${accountCurrency}).`,
        field: 'total_budget.currency',
        recovery: 'correctable',
      }] as TaskError[],
    };
  }
  const mediaBuyCurrency = accountCurrency ?? req.total_budget?.currency ?? 'USD';
  let executedCompactProposal: Proposal | undefined;
  let executedCompactProposalSession: SessionState | undefined;

  // Consume any single-shot directive registered by
  // comply_test_controller.force_create_media_buy_arm. Runs before all other
  // gates so the storyboard's wire-shape probe is not confounded by governance
  // or account-status checks; the directive is sandbox-only and the runner
  // explicitly opted into this response shape. Cleared after read — a second
  // create_media_buy from the same session resumes default behavior.
  // Idempotency_key replay is unaffected: the SDK's request-idempotency cache
  // wraps this handler, so a replayed request returns the cached submitted
  // response without re-evaluating the (now-empty) directive slot.
  const directive = session.complyExtensions.forcedCreateMediaBuyArm;
  if (
    directive
    && directive.arm === 'submitted'
    && typeof directive.taskId === 'string'
    && directive.taskId.length > 0
    && directive.taskId.length <= 128
  ) {
    session.complyExtensions.forcedCreateMediaBuyArm = undefined;
    const responseMessage =
      typeof directive.message === 'string' && directive.message.length <= 2000
        ? directive.message
        : undefined;
    return {
      status: 'submitted',
      task_id: directive.taskId,
      ...(responseMessage && { message: responseMessage }),
    };
  }

  // Enforce account status gates set by comply_test_controller
  const accountId = (req as unknown as Record<string, unknown>).account as { account_id?: string } | undefined;
  if (accountId?.account_id) {
    const acctStatus = getAccountStatus(session, accountId.account_id);
    if (acctStatus && acctStatus !== 'active') {
      const BLOCKED_STATUSES: Record<string, string> = {
        suspended: 'Account is suspended — contact the seller to resolve.',
        payment_required: 'Account requires payment before new media buys can be created.',
        closed: 'Account is closed and cannot create new media buys.',
        rejected: 'Account was rejected and cannot create media buys.',
      };
      return {
        errors: [{ code: 'ACCOUNT_STATUS_BLOCKED', message: BLOCKED_STATUSES[acctStatus] || `Account status "${acctStatus}" does not permit new media buys.` }] as TaskError[],
      };
    }
  }

  // Enforce governance: if governance plans exist, validate the buy budget.
  // Deny-on-any-plan: without a governance_context there is no way to know
  // which plan the buy targets, so a conservative deny teaches buyers to call
  // check_governance first.
  const rawGovCtx = (req as unknown as Record<string, unknown>).governance_context;
  const govCtx = typeof rawGovCtx === 'string' && rawGovCtx ? rawGovCtx : undefined;
  const governanceAgents = resolveGovernanceAgentsForAccount(
    sessionKeyFromArgs(req, ctx.mode, ctx.userId, ctx.moduleId),
    ctx.principal,
    req.account,
  );
  if (govCtx) {
    const buyBudget = req.total_budget?.amount
      ?? req.packages?.reduce((sum, pkg) => sum + ((pkg as unknown as { budget: number }).budget || 0), 0);
    const commitmentError = await governedCommitmentError(
      govCtx,
      ctx.authenticatedAgentUrl,
      'create_media_buy',
      `${getCanonicalBase()}/sales`,
      governedRequestPayload(ctx, req as unknown as Record<string, unknown>),
      buyBudget ?? 0,
      mediaBuyCurrency,
    );
    if (commitmentError) return { errors: [commitmentError] };
  } else if (session.governancePlans.size > 0 || governanceAgents.length > 0) {
    return {
      errors: [{
        code: governanceAgents.length > 0 ? 'PERMISSION_DENIED' : 'GOVERNANCE_DENIED',
        message: 'Media-buy creation requires governance approval. Call check_governance first.',
      }] as TaskError[],
    };
  }

  // Validate event-kind optimization_goals reference a previously-registered
  // event_source_id. Silent acceptance of phantom ids is a façade — the
  // seller cannot optimize against a source it doesn't know about. The
  // performance_buy_flow storyboard asserts this rejection with an error
  // .field set to the offending JSONPath-lite path.
  const sessionKeyForEventSources = sessionKeyFromArgs(req, ctx.mode, ctx.userId, ctx.moduleId);
  if (Array.isArray(req.packages)) {
    for (let i = 0; i < req.packages.length; i++) {
      const pkg = req.packages[i] as { optimization_goals?: unknown };
      const goals = pkg?.optimization_goals;
      if (!Array.isArray(goals)) continue;
      for (let j = 0; j < goals.length; j++) {
        const goal = goals[j] as { kind?: string; event_sources?: unknown };
        if (goal?.kind !== 'event') continue;
        const eventSources = goal.event_sources;
        if (!Array.isArray(eventSources)) continue;
        for (let k = 0; k < eventSources.length; k++) {
          const entry = eventSources[k] as { event_source_id?: string };
          const id = entry?.event_source_id;
          if (typeof id !== 'string' || id.length === 0) continue;
          if (!findEventSourceInSession(sessionKeyForEventSources, id)) {
            return {
              errors: [{
                code: 'INVALID_REQUEST',
                message: `event_source_id "${id}" was not registered via sync_event_sources`,
                field: `packages[${i}].optimization_goals[${j}].event_sources[${k}].event_source_id`,
              }] as TaskError[],
            };
          }
        }
      }
    }
  }

  // Validate targeting_overlay.audience_include / audience_exclude entries
  // reference an audience_id previously registered via sync_audiences. Silent
  // acceptance of phantom ids is a façade — the seller cannot target an
  // audience it doesn't know about. Sibling contract to the event_source_id
  // check above. error.field is a literal JSONPath-lite per core/error.json
  // so audience_buy_flow can assert equality, not regex.
  const sessionKeyForAudiences = sessionKeyFromArgs(req, ctx.mode, ctx.userId, ctx.moduleId);
  if (Array.isArray(req.packages)) {
    for (let i = 0; i < req.packages.length; i++) {
      const pkg = req.packages[i] as { targeting_overlay?: unknown; targeting?: unknown };
      const overlay = (pkg?.targeting_overlay ?? pkg?.targeting) as
        | { audience_include?: unknown; audience_exclude?: unknown }
        | undefined;
      if (!overlay || typeof overlay !== 'object') continue;
      for (const field of ['audience_include', 'audience_exclude'] as const) {
        const list = overlay[field];
        if (!Array.isArray(list)) continue;
        for (let k = 0; k < list.length; k++) {
          const id = list[k];
          if (typeof id !== 'string' || id.length === 0) continue;
          if (!findAudienceInSession(sessionKeyForAudiences, id)) {
            return {
              errors: [{
                code: 'INVALID_REQUEST',
                message: `audience_id "${id}" was not registered via sync_audiences`,
                field: `packages[${i}].targeting_overlay.${field}[${k}]`,
              }] as TaskError[],
            };
          }
        }
      }
    }
  }

  const catalog = getCatalog();
  const productMap = new Map(catalog.map(cp => [cp.product.product_id, cp.product]));
  overlaySeededProducts(session, productMap);
  overlayNegotiatedPricingOptions(session, productMap);

  // Validate metric-kind optimization_goals against the package's product
  // metric_optimization declarations. reach goals must declare a reach_unit
  // present in supported_reach_units; completed_views goals must declare a
  // view_duration_seconds present in supported_view_durations. Silent
  // acceptance is a façade (the seller would either coerce the unit or run
  // without one) — the reach_buy_flow / completed_views_buy_flow storyboards
  // assert this rejection with error.field set to the offending JSONPath-lite
  // path. Mirrors the event_source / audience_id checks above.
  if (Array.isArray(req.packages)) {
    for (let i = 0; i < req.packages.length; i++) {
      const pkg = req.packages[i] as { product_id?: string; optimization_goals?: unknown };
      const goals = pkg?.optimization_goals;
      if (!Array.isArray(goals)) continue;
      const product = pkg.product_id ? productMap.get(pkg.product_id) : undefined;
      for (let j = 0; j < goals.length; j++) {
        const goal = goals[j] as {
          kind?: string;
          metric?: string;
          reach_unit?: string;
          view_duration_seconds?: number;
        };
        if (goal?.kind !== 'metric') continue;
        if (goal.metric === 'reach' && typeof goal.reach_unit === 'string' && goal.reach_unit.length > 0) {
          const supported = product?.metric_optimization?.supported_reach_units;
          // Reach is honest-bounded by reach-unit.json enum; reject when the
          // product declares a narrower set OR when no declaration exists and
          // the value isn't a spec-defined reach unit.
          const allowed: readonly string[] = supported ?? ['individuals', 'households', 'devices', 'accounts', 'cookies', 'custom'];
          if (!allowed.includes(goal.reach_unit)) {
            return {
              errors: [{
                code: 'INVALID_REQUEST',
                message: `reach_unit "${goal.reach_unit}" not in product's supported_reach_units`,
                field: `packages[${i}].optimization_goals[${j}].reach_unit`,
              }] as TaskError[],
            };
          }
        }
        if (goal.metric === 'completed_views' && typeof goal.view_duration_seconds === 'number') {
          const supported = product?.metric_optimization?.supported_view_durations;
          // No spec-bound enum on view_duration; fall back to industry-default
          // durations when the product omits the declaration (matches the
          // product-factory default 2/6/15/30).
          const allowed: readonly number[] = supported ?? [2, 6, 15, 30];
          if (!allowed.includes(goal.view_duration_seconds)) {
            return {
              errors: [{
                code: 'INVALID_REQUEST',
                message: `view_duration_seconds ${goal.view_duration_seconds} not in product's supported_view_durations`,
                field: `packages[${i}].optimization_goals[${j}].view_duration_seconds`,
              }] as TaskError[],
            };
          }
        }
      }
    }
  }

  // Validate vendor_metric optimization_goals against the product's
  // vendor_metric_optimization declarations and the package's reporting
  // contract. This goal kind is only meaningful when the seller can both
  // optimize toward the vendor metric and commit to reporting the same
  // (vendor, metric_id) key back to the buyer.
  if (Array.isArray(req.packages)) {
    for (let i = 0; i < req.packages.length; i++) {
      const pkg = req.packages[i] as {
        product_id?: string;
        optimization_goals?: unknown;
        committed_metrics?: unknown;
      };
      const goals = pkg?.optimization_goals;
      if (!Array.isArray(goals)) continue;
      const product = pkg.product_id
        ? productMap.get(pkg.product_id) as (Product & { vendor_metric_optimization?: VendorMetricOptimizationView }) | undefined
        : undefined;
      if (!product) continue;
      const supportedMetrics = product?.vendor_metric_optimization?.supported_metrics;
      const reportableMetrics = (product?.reporting_capabilities as ReportingCapabilitiesView | undefined)?.vendor_metrics;
      const committedMetrics = Array.isArray(pkg.committed_metrics)
        ? (pkg.committed_metrics as VendorMetricRefView[])
        : [];
      for (let j = 0; j < goals.length; j++) {
        const goal = goals[j] as VendorMetricRefView & { kind?: unknown; target?: { kind?: unknown; value?: unknown } };
        if (goal?.kind !== 'vendor_metric') continue;
        const key = vendorMetricKey(goal);
        if (!key) {
          const field = typeof goal?.vendor?.domain !== 'string' || goal.vendor.domain.length === 0
            ? `packages[${i}].optimization_goals[${j}].vendor.domain`
            : `packages[${i}].optimization_goals[${j}].metric_id`;
          return {
            errors: [{
              code: 'INVALID_REQUEST',
              message: 'vendor_metric goal requires non-empty vendor.domain and metric_id',
              field,
            }] as TaskError[],
          };
        }

        const supported = Array.isArray(supportedMetrics)
          ? supportedMetrics.find(entry => vendorMetricKey(entry) === key)
          : undefined;
        if (!supported) {
          return {
            errors: [{
              // Vendor-metric optimization is negotiated against vendor
              // measurement/reporting terms. The normative docs route
              // capability and reporting-coherence misses through
              // TERMS_REJECTED, even though legacy seller-native metric
              // shape checks above still use INVALID_REQUEST.
              code: 'TERMS_REJECTED',
              message: `vendor_metric goal "${goal.metric_id}" is not in product's vendor_metric_optimization.supported_metrics`,
              field: `packages[${i}].optimization_goals[${j}].metric_id`,
            }] as TaskError[],
          };
        }

        const target = goal.target;
        if (target !== undefined && (target === null || typeof target !== 'object' || typeof (target as { kind?: unknown }).kind !== 'string')) {
          return {
            errors: [{
              code: 'INVALID_REQUEST',
              message: 'vendor_metric target.kind is required when target is present',
              field: `packages[${i}].optimization_goals[${j}].target.kind`,
            }] as TaskError[],
          };
        }

        const targetKind = (target as { kind?: string; value?: unknown } | undefined)?.kind;
        const targetValue = (target as { value?: unknown } | undefined)?.value;
        if (target !== undefined && (typeof targetValue !== 'number' || !Number.isFinite(targetValue) || targetValue <= 0)) {
          return {
            errors: [{
              code: 'INVALID_REQUEST',
              message: 'vendor_metric target.value must be a positive number when target is present',
              field: `packages[${i}].optimization_goals[${j}].target.value`,
            }] as TaskError[],
          };
        }

        if (targetKind) {
          const supportedTargets = Array.isArray(supported.supported_targets)
            ? supported.supported_targets
            : [];
          if (!supportedTargets.includes(targetKind as (typeof supportedTargets)[number])) {
            return {
              errors: [{
                code: 'TERMS_REJECTED',
                message: `vendor_metric target.kind "${targetKind}" is not in product's vendor_metric_optimization.supported_metrics[].supported_targets`,
                field: `packages[${i}].optimization_goals[${j}].target.kind`,
              }] as TaskError[],
            };
          }
        }

        const hasCommittedMetric = committedMetrics.some(entry =>
          entry?.scope === 'vendor' && vendorMetricKey(entry) === key,
        );
        if (!hasCommittedMetric) {
          return {
            errors: [{
              code: 'TERMS_REJECTED',
              message: `vendor_metric goal "${goal.metric_id}" requires a matching vendor-scope committed_metrics entry`,
              field: `packages[${i}].committed_metrics`,
            }] as TaskError[],
          };
        }

        const hasReportableMetric = Array.isArray(reportableMetrics)
          ? reportableMetrics.some(entry => vendorMetricKey(entry) === key)
          : false;
        if (!hasReportableMetric) {
          return {
            errors: [{
              code: 'TERMS_REJECTED',
              message: `committed_metrics entry for vendor_metric goal "${goal.metric_id}" is not in product's reporting_capabilities.vendor_metrics`,
              field: `packages[${i}].committed_metrics`,
            }] as TaskError[],
          };
        }

        const catalogKey = vendorCatalogKey(goal);
        const seededCatalog = catalogKey ? session.complyExtensions.seededMeasurementCatalogs.get(catalogKey) : undefined;
        const productCatalog = productMeasurementCatalogForGoal(product, goal);
        const catalogMetrics = seededCatalog?.metrics ?? productCatalog?.metrics;
        if (
          Array.isArray(catalogMetrics)
          && !catalogMetrics.some(entry => entry?.metric_id === goal.metric_id)
        ) {
          return {
            errors: [{
              code: 'TERMS_REJECTED',
              message: `vendor_metric goal "${goal.metric_id}" is not in ${goal.vendor?.domain}'s measurement.metrics catalog`,
              field: `packages[${i}].optimization_goals[${j}].metric_id`,
            }] as TaskError[],
          };
        }
      }
    }
  }

  // Proposal-based creation: expand proposal allocations into packages
  if (req.proposal_id && !req.packages?.length) {
    // Check session proposals first (may have finalized versions), then global catalog
    let proposal = session.lastGetProductsContext?.proposals?.find(p => p.proposal_id === req.proposal_id)
      || getProposals().find(p => p.proposal_id === req.proposal_id);
    if (!proposal) {
      // Compact proposal lifecycle calls intentionally address opaque IDs
      // under the authenticated principal instead of repeating account data.
      // Resolve that principal-owned proposal here, then verify its internal
      // account/brand binding against the billed account without exposing
      // whether a cross-account proposal exists.
      const proposalSession = await getSession(
        sessionKeyFromArgs({}, ctx.mode, ctx.userId, ctx.moduleId, ctx.principal ?? 'anonymous'),
      );
      const candidate = proposalSession.lastGetProductsContext?.proposals?.find(
        p => p.proposal_id === req.proposal_id,
      );
      if (candidate) {
        proposal = candidate;
        executedCompactProposalSession = proposalSession;
      }
    }
    if (proposal) {
      const internal = proposal as unknown as Record<string, unknown>;
      const accountRef = req.account as unknown as { account_id?: string };
      const requestBrand = req.brand as unknown as { domain?: string; brand_id?: string; countries?: string[] };
      const boundAccountId = internal.__account_id;
      const boundBrandDomain = internal.__brand_domain;
      const boundBrandId = internal.__brand_id;
      const boundBrandCountries = internal.__brand_countries;
      const hasCompactOwnerBinding = typeof boundAccountId === 'string'
        || typeof boundBrandDomain === 'string'
        || typeof boundBrandId === 'string';
      const accountMatches = typeof boundAccountId !== 'string'
        || accountRef?.account_id === boundAccountId;
      const brandMatches = typeof boundBrandDomain !== 'string'
        || (
          requestBrand?.domain?.toLowerCase() === boundBrandDomain
          && (typeof requestBrand.brand_id === 'string' ? requestBrand.brand_id : undefined)
            === (typeof boundBrandId === 'string' ? boundBrandId : undefined)
          && JSON.stringify([...(requestBrand.countries ?? [])].sort())
            === JSON.stringify(Array.isArray(boundBrandCountries) ? [...boundBrandCountries].sort() : [])
        );
      if (hasCompactOwnerBinding && (!accountMatches || !brandMatches)) proposal = undefined;
    }
    if (!proposal && isThreeZeroStoryboardCompat(ctx) && req.proposal_id === THREE_ZERO_LEGACY_PROPOSAL_ID) {
      proposal = resolveThreeZeroProposalAlias([...(session.lastGetProductsContext?.proposals ?? []), ...getProposals()]);
    }
    if (!proposal) {
      return {
        errors: [{
          code: 'PROPOSAL_NOT_FOUND',
          message: `Proposal not found: ${req.proposal_id}`,
          field: 'proposal_id',
          recovery: 'correctable',
        }] as TaskError[],
      };
    }

    const internalProposal = proposal as unknown as Record<string, unknown>;
    const compactProposal = typeof internalProposal.__brand_domain === 'string'
      || typeof internalProposal.__brand_id === 'string'
      || Array.isArray(internalProposal.__brand_countries)
      || typeof internalProposal.__account_id === 'string';
    if (internalProposal.__declined === true) {
      return {
        errors: [{
          code: 'INVALID_STATE',
          message: `Proposal "${req.proposal_id}" has been declined and cannot be executed. Request a new proposal before retrying.`,
          field: 'proposal_id',
          recovery: 'correctable',
        }] as TaskError[],
      };
    }
    if (compactProposal && internalProposal.__executed === true) {
      return {
        errors: [{
          code: 'INVALID_STATE',
          message: `Proposal "${req.proposal_id}" was already executed. Exact retries must reuse the original idempotency key.`,
          field: 'proposal_id',
          recovery: 'correctable',
        }] as TaskError[],
      };
    }
    const createOpportunity = isRecord((req as unknown as Record<string, unknown>).opportunity)
      ? (req as unknown as Record<string, unknown>).opportunity as Record<string, unknown>
      : undefined;
    if (
      typeof internalProposal.__opportunity_id === 'string'
      && typeof createOpportunity?.opportunity_id === 'string'
      && createOpportunity.opportunity_id !== internalProposal.__opportunity_id
    ) {
      return {
        errors: [{
          code: 'INVALID_REQUEST',
          message: 'opportunity.opportunity_id does not match the opportunity associated with this proposal.',
          field: 'opportunity.opportunity_id',
          recovery: 'correctable',
        }] as TaskError[],
      };
    }

    // Enforce proposal lifecycle: draft proposals cannot be purchased directly
    const proposalStatus = proposalLifecycle(proposal).proposal_status;
    if (proposalStatus === 'draft' && !(isThreeZeroStoryboardCompat(ctx) && req.proposal_id === THREE_ZERO_LEGACY_PROPOSAL_ID)) {
      return {
        errors: [{ code: 'PROPOSAL_NOT_COMMITTED', message: `Proposal "${req.proposal_id}" is a draft — finalize it through refine_proposals before retrying.` }] as TaskError[],
      };
    }

    // Enforce proposal expiry
    if (proposal.expires_at && new Date(proposal.expires_at) < new Date()) {
      return {
        errors: [{ code: 'PROPOSAL_EXPIRED', message: `Proposal "${req.proposal_id}" expired at ${proposal.expires_at}. Request and finalize a fresh proposal before retrying.` }] as TaskError[],
      };
    }

    // Enforce IO acceptance when required
    const insertionOrder = proposalLifecycle(proposal).insertion_order;
    const ioAcceptance = (req as unknown as Record<string, unknown>).io_acceptance as { io_id: string; accepted_at: string; signatory: string } | undefined;
    if (
      insertionOrder?.requires_signature
      && !ioAcceptance
      && !(isThreeZeroStoryboardCompat(ctx) && req.proposal_id === THREE_ZERO_LEGACY_PROPOSAL_ID)
    ) {
      return {
        errors: [{ code: 'IO_REQUIRED', message: `Proposal "${req.proposal_id}" requires a signed insertion order. Include io_acceptance with io_id "${insertionOrder.io_id}" on create_media_buy.` }] as TaskError[],
      };
    }
    if (ioAcceptance && insertionOrder && ioAcceptance.io_id !== insertionOrder.io_id) {
      return {
        errors: [{ code: 'INVALID_REQUEST', message: `io_acceptance.io_id "${ioAcceptance.io_id}" does not match proposal insertion order io_id "${insertionOrder.io_id}".` }] as TaskError[],
      };
    }

    const totalBudget = req.total_budget?.amount;
    if (!totalBudget) {
      return {
        errors: [{ code: 'INVALID_REQUEST', message: 'total_budget.amount is required when using proposal_id' }] as TaskError[],
      };
    }
    // Expand proposal allocations into packages
    (req as { packages?: unknown[] }).packages = proposal.allocations.map((alloc, i) => {
      const product = productMap.get(alloc.product_id);
      const pricingOptionId = alloc.pricing_option_id || product?.pricing_options[0]?.pricing_option_id || '';
      const pricing = product?.pricing_options.find(po => po.pricing_option_id === pricingOptionId);

      // Auction pricing needs a bid_price — use price_guidance p50 or floor_price
      let bidPrice: number | undefined;
      if (pricing && pricingStructureForOption(pricing) === 'auction') {
        const po = pricing as unknown as PricingOptionView;
        bidPrice = po.price_guidance?.p50 ?? po.floor_price;
      }

      return {
        product_id: alloc.product_id,
        pricing_option_id: pricingOptionId,
        budget: Math.round(totalBudget * alloc.allocation_percentage / 100),
        ...(bidPrice !== undefined && { bid_price: bidPrice }),
      };
    });
    if (compactProposal) {
      executedCompactProposal = proposal;
      if (!executedCompactProposalSession && session.proposalRefinementRecords.has(proposal.proposal_id)) {
        executedCompactProposalSession = session;
      }
    }
  }

  if (!req.packages?.length) {
    return {
      errors: [{ code: 'INVALID_REQUEST', message: 'packages array is required and must have at least one item' }] as TaskError[],
    };
  }

  if (req.packages.length > MAX_PACKAGES_PER_BUY) {
    return {
      errors: [{ code: 'LIMIT_EXCEEDED', message: `Too many packages: ${req.packages.length} (max ${MAX_PACKAGES_PER_BUY}).` }] as TaskError[],
    };
  }

  if (session.mediaBuys.size >= MAX_MEDIA_BUYS_PER_SESSION) {
    return {
      errors: [{ code: 'LIMIT_EXCEEDED', message: `Session limit reached (max ${MAX_MEDIA_BUYS_PER_SESSION} media buys). Start a new session.` }] as TaskError[],
    };
  }

  // Validate dates
  const buyStart = req.start_time;
  const buyEnd = req.end_time;
  if (buyStart !== 'asap' && isNaN(new Date(buyStart).getTime())) {
    return { errors: [{ code: 'INVALID_REQUEST', message: `Invalid start_time: "${buyStart}". Use ISO 8601 format or "asap".` }] as TaskError[] };
  }
  if (isNaN(new Date(buyEnd).getTime())) {
    return { errors: [{ code: 'INVALID_REQUEST', message: `Invalid end_time: "${buyEnd}". Use ISO 8601 format.` }] as TaskError[] };
  }
  if (buyStart !== 'asap' && new Date(buyStart) >= new Date(buyEnd)) {
    return { errors: [{ code: 'INVALID_REQUEST', message: 'start_time must be before end_time' }] as TaskError[] };
  }
  if (buyStart !== 'asap' && new Date(buyStart) < new Date()) {
    return { errors: [{ code: 'INVALID_REQUEST', message: 'start_time must not be in the past' }] as TaskError[] };
  }

  // Validate all packages and collect errors before returning
  const confirmedAt = new Date().toISOString();
  const errors: TaskError[] = [];
  const createdPackages: PackageState[] = [];
  const inlineCreativesToPersist: ValidatedInlineCreative[] = [];
  const productFormatOptionIndexes: ProductFormatOptionIndexCache = new WeakMap();
  for (let i = 0; i < req.packages.length; i++) {
    const pkg = req.packages[i] as unknown as PackageInput;
    const pkgLabel = `Package ${i}`;

    // Check negative budget before product lookup (budget is always validatable)
    if (pkg.budget < 0) {
      errors.push({ code: 'BUDGET_TOO_LOW', message: `${pkgLabel}: Budget must be non-negative, got ${pkg.budget}` });
      continue;
    }

    const product = productMap.get(pkg.product_id);
    if (!product) {
      errors.push({ code: 'PRODUCT_NOT_FOUND', message: `${pkgLabel}: Product not found: ${pkg.product_id}` });
      continue;
    }

    const committedMetricError = validateCommittedMetricProposals(
      pkg.committed_metrics,
      product,
      `packages[${i}].committed_metrics`,
    );
    if (committedMetricError) {
      errors.push(committedMetricError);
      continue;
    }

    // Enforce product expiry
    if (product.expires_at && new Date(product.expires_at) < new Date()) {
      errors.push({ code: 'PRODUCT_EXPIRED', message: `${pkgLabel}: Product "${pkg.product_id}" expired at ${product.expires_at}. Re-discover with list_products.` });
      continue;
    }

    const pricingOptions = product.pricing_options;
    const pricing = pricingOptions?.find(po => po.pricing_option_id === pkg.pricing_option_id);
    if (!pricing) {
      errors.push({
        code: 'INVALID_REQUEST',
        message: `${pkgLabel}: Pricing option not found: ${pkg.pricing_option_id}. Available: ${pricingOptions?.map(po => po.pricing_option_id).join(', ')}`,
      });
      continue;
    }

    const selectorCompatibilityError = validatePackageSelectorCompatibility(
      pkg,
      product,
      i,
      productFormatOptionIndexes,
    );
    if (selectorCompatibilityError) {
      errors.push(selectorCompatibilityError);
      continue;
    }
    const formatSnapshot = snapshotPackageFormats(pkg, product, i, productFormatOptionIndexes);
    if (formatSnapshot.error) {
      errors.push(formatSnapshot.error);
      continue;
    }

    // Reject unworkable measurement_terms (TERMS_REJECTED). Checked BEFORE
    // bid_price / other field validation so buyers see the terms-level
    // rejection first — correcting a one-sided measurement proposal is
    // typically an earlier-round concern than a missing bid_price.
    // Matches the `measurement_terms_rejected` storyboard's aggressive
    // baseline probe (max_variance_percent: 0, measurement_window: "c30").
    const terms = (pkg as unknown as { measurement_terms?: { billing_measurement?: { max_variance_percent?: number; measurement_window?: string } } }).measurement_terms;
    const bm = terms?.billing_measurement;
    if (bm) {
      if (typeof bm.max_variance_percent === 'number' && bm.max_variance_percent < 0.5) {
        errors.push({
          code: 'TERMS_REJECTED',
          message: `${pkgLabel}: measurement_terms.billing_measurement.max_variance_percent ${bm.max_variance_percent} is below our minimum of 0.5%. Third-party measurement variance can't be guaranteed tighter than 0.5%.`,
          field: `packages[${i}].measurement_terms.billing_measurement.max_variance_percent`,
          recovery: 'correctable',
        });
        continue;
      }
      if (bm.measurement_window === 'c30') {
        errors.push({
          code: 'TERMS_REJECTED',
          message: `${pkgLabel}: measurement_window "c30" is not supported. Use "c3" or "c7" for guaranteed windows.`,
          field: `packages[${i}].measurement_terms.billing_measurement.measurement_window`,
          recovery: 'correctable',
        });
        continue;
      }
    }

    const pricingView = pricing as unknown as PricingOptionView;
    const pricingStructure = pricingStructureForOption(pricing);
    if (pricingView.currency !== mediaBuyCurrency) {
      errors.push({
        code: 'INVALID_REQUEST',
        message: `${pkgLabel}: pricing option ${pkg.pricing_option_id} is denominated in ${pricingView.currency}, but the media buy uses ${mediaBuyCurrency}.`,
        field: `packages[${i}].pricing_option_id`,
        recovery: 'correctable',
      } as TaskError);
      continue;
    }
    const floorPrice = pricingStructure === 'auction' ? pricingView.floor_price : undefined;
    const isAuction = pricingStructure === 'auction';
    const seededPricingKey = `${pkg.product_id}:${pkg.pricing_option_id}`;
    const allowSeededMetricFloorCoercion = Boolean(
      floorPrice !== undefined
      && pkg.bid_price !== undefined
      && pkg.bid_price < floorPrice
      && session.complyExtensions.seededPricingOptions.has(seededPricingKey)
      && packageHasMetricGoal(pkg, ['reach', 'completed_views']),
    );
    const storedBidPrice = allowSeededMetricFloorCoercion ? floorPrice : pkg.bid_price;

    if (isAuction && pkg.bid_price === undefined) {
      errors.push({
        code: 'INVALID_REQUEST',
        message: `${pkgLabel}: bid_price is required for auction pricing (pricing option ${pkg.pricing_option_id})`,
        field: `packages[${i}].bid_price`,
      } as TaskError);
    }

    if (pricingStructure === 'contingent' && pkg.bid_price !== undefined) {
      errors.push({
        code: 'INVALID_REQUEST',
        message: `${pkgLabel}: bid_price is not valid for contingent pricing (pricing option ${pkg.pricing_option_id})`,
        field: `packages[${i}].bid_price`,
      } as TaskError);
    }

    if (
      pricingView.pricing_model === 'revenue_share'
      && pricingView.event_source_id
      && !findEventSourceInSession(sessionKeyForEventSources, pricingView.event_source_id)
    ) {
      errors.push({
        code: 'INVALID_REQUEST',
        message: `event_source_id "${pricingView.event_source_id}" from revenue-share pricing option "${pkg.pricing_option_id}" was not registered via sync_event_sources`,
        field: `packages[${i}].pricing_option_id`,
      } as TaskError);
    }

    if (floorPrice !== undefined && pkg.bid_price !== undefined && pkg.bid_price < floorPrice && !allowSeededMetricFloorCoercion) {
      errors.push({
        code: 'INVALID_REQUEST',
        message: `${pkgLabel}: Bid price $${pkg.bid_price} is below floor price of $${floorPrice} for pricing option ${pkg.pricing_option_id}`,
      });
    }

    // Check min spend
    const minSpend = pricingView.min_spend_per_package;
    if (minSpend && pkg.budget < minSpend) {
      errors.push({
        code: 'INVALID_REQUEST',
        message: `${pkgLabel}: Budget $${pkg.budget} is below minimum spend of $${minSpend} for pricing option ${pkg.pricing_option_id}`,
      });
    }

    const startTime = pkg.start_time || buyStart;
    const endTime = pkg.end_time || buyEnd;

    // Validate package-level dates if overridden
    if (pkg.start_time && startTime !== 'asap' && isNaN(new Date(startTime).getTime())) {
      errors.push({ code: 'INVALID_REQUEST', message: `${pkgLabel}: Invalid start_time: "${startTime}". Use ISO 8601 format or "asap".` });
    }
    if (pkg.end_time && isNaN(new Date(endTime).getTime())) {
      errors.push({ code: 'INVALID_REQUEST', message: `${pkgLabel}: Invalid end_time: "${endTime}". Use ISO 8601 format.` });
    }


    // Don't build package state if there are any validation errors (atomic create).
    // Spec field is `targeting_overlay`; `targeting` is an alias we accept for
    // backward compat with storyboards authored before the rename.
    const incomingTargeting = (pkg as unknown as { targeting_overlay?: unknown; targeting?: unknown }).targeting_overlay
      ?? pkg.targeting;
    const targetingResult = validateTargeting(incomingTargeting, `packages[${i}].targeting_overlay`);
    if (targetingResult.errors.length) {
      errors.push(...targetingResult.errors);
    }

    if (errors.length > 0) continue;

    const resolvedStart = startTime === 'asap' ? new Date().toISOString() : startTime;

    const rawGoals = (pkg as unknown as { optimization_goals?: unknown }).optimization_goals;
    const optimizationGoals = Array.isArray(rawGoals)
      ? (rawGoals as unknown[]).filter((g): g is Record<string, unknown> => typeof g === 'object' && g !== null)
      : undefined;
    const committedMetrics = Array.isArray(pkg.committed_metrics)
      ? pkg.committed_metrics.map(metric => ({
        ...metric,
        committed_at: confirmedAt,
      }))
      : undefined;
    const rawCreativeAssignments = Array.isArray(pkg.creative_assignments) ? pkg.creative_assignments : [];
    const creativeAssignments: string[] = [];
    for (let j = 0; j < rawCreativeAssignments.length; j++) {
      const creativeId = rawCreativeAssignments[j]?.creative_id;
      if (!creativeId) {
        errors.push({
          code: 'VALIDATION_ERROR',
          message: `${pkgLabel}: creative_assignments[${j}].creative_id is required`,
          field: `packages[${i}].creative_assignments[${j}].creative_id`,
        });
        continue;
      }
      creativeAssignments.push(creativeId);
    }
    const inlineCreatives = collectInlineCreativeIds(pkg.creatives, `packages[${i}].creatives`);
    errors.push(...inlineCreatives.errors);
    creativeAssignments.push(...inlineCreatives.creativeIds);
    if (errors.length > 0) continue;
    if (Array.isArray(pkg.creatives)) {
      inlineCreativesToPersist.push(...inlineCreatives.validatedCreatives);
    }
    const formatSelector = packageFormatSelectorForState(
      pkg,
      formatSnapshot.formats,
      formatSnapshot.legacyFormatIds,
      formatSnapshot.selectedLegacyFormatIds,
    );

    createdPackages.push({
      packageId: `pkg-${i}`,
      productId: pkg.product_id,
      budget: pkg.budget,
      pricingOptionId: pkg.pricing_option_id,
      bidPrice: storedBidPrice,
      impressions: pkg.impressions,
      paused: pkg.paused || false,
      startTime: resolvedStart,
      endTime,
      ...formatSelector,
      params: pkg.params,
      ...(!isThreeZeroStoryboardCompat(ctx) && formatSnapshot.formats?.length && {
        formatsToProvide: formatSnapshot.formats,
      }),
      creativeAssignments,
      targeting: targetingResult.targeting,
      ...(isRecord(pkg.context) && { context: pkg.context }),
      ...(optimizationGoals && optimizationGoals.length > 0 && { optimizationGoals }),
      ...(committedMetrics && committedMetrics.length > 0 && { committedMetrics }),
    });
  }

  if (errors.length > 0) {
    return { errors };
  }

  // Accept a buyer-supplied `media_buy_id` when present. Conformance
  // storyboards (sales_non_guaranteed, governance_delivery_monitor) hard-code
  // an id in the request and then query it on later steps; without this
  // the seller's auto-generated id wouldn't match the query.
  const requestedMediaBuyId = (req as unknown as { media_buy_id?: unknown }).media_buy_id;
  const mediaBuyId = typeof requestedMediaBuyId === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(requestedMediaBuyId)
    ? requestedMediaBuyId
    : `mb_${randomUUID().slice(0, 8)}`;
  const now = confirmedAt;
  const resolvedStart = buyStart === 'asap' ? now : buyStart;
  const persistedAccountRef = ctx.resolvedAccount ?? req.account;
  persistInlineCreatives(
    session,
    inlineCreativesToPersist,
    persistedAccountRef as AccountRef | undefined,
    resolveAccountIdForRef(sessionKeyFromArgs(req, ctx.mode, ctx.userId, ctx.moduleId), ctx.principal, req.account),
    now,
  );

  // Persist governance_context if provided (spec: sellers MUST persist and return on get_media_buys)
  const governanceContext = govCtx && govCtx.length <= 4096 ? govCtx : undefined;
  const productAllowedActions = deriveProductAllowedActionsForPackages(createdPackages, productMap);

  const mediaBuy: MediaBuyState = {
    mediaBuyId,
    accountRef: persistedAccountRef,
    brandRef: req.brand,
    status: req.paused === true ? 'paused' : 'active',
    currency: mediaBuyCurrency,
    totalBudget: req.total_budget?.amount
      ?? createdPackages.reduce((sum, pkg) => sum + (pkg.budget || 0), 0),
    ...((req as unknown as { budget_allocation?: Record<string, unknown> }).budget_allocation
      ? { budgetAllocation: structuredClone((req as unknown as { budget_allocation: Record<string, unknown> }).budget_allocation) }
      : {}),
    ...((req as unknown as { pacing?: string }).pacing
      ? { aggregatePacing: (req as unknown as { pacing: string }).pacing }
      : {}),
    ...((req as unknown as { bidding?: Record<string, unknown> }).bidding
      ? { aggregateBidding: structuredClone((req as unknown as { bidding: Record<string, unknown> }).bidding) }
      : {}),
    packages: createdPackages,
    ...(productAllowedActions && { productAllowedActions }),
    startTime: resolvedStart,
    endTime: buyEnd,
    revision: 1,
    confirmedAt: now,
    ...(governanceContext && { governanceContext }),
    ...(isRecord(req.context) && { context: req.context }),
    createdAt: now,
    updatedAt: now,
    history: [{
      revision: 1,
      timestamp: now,
      actor: 'buyer',
      action: 'created',
      summary: req.paused === true
        ? `Media buy created paused with ${createdPackages.length} package(s)`
        : `Media buy created with ${createdPackages.length} package(s)`,
    }],
  };

  if (executedCompactProposal) {
    const internal = executedCompactProposal as unknown as Record<string, unknown>;
    internal.__executed = true;
    internal.__accepted_at = now;
    internal.__media_buy_id = mediaBuyId;
    internal.__media_buy_revision = mediaBuy.revision;
    const suppliedOpportunity = isRecord((req as unknown as Record<string, unknown>).opportunity)
      ? (req as unknown as Record<string, unknown>).opportunity as Record<string, unknown>
      : undefined;
    const opportunityId = typeof suppliedOpportunity?.opportunity_id === 'string'
      ? suppliedOpportunity.opportunity_id
      : typeof internal.__opportunity_id === 'string'
        ? internal.__opportunity_id
        : undefined;
    if (opportunityId) {
      internal.__opportunity_update = {
        ...structuredClone(suppliedOpportunity ?? {}),
        opportunity_id: opportunityId,
        status: 'closed',
        close_reason: 'accepted_with_seller',
      };
    }
    const proposalSession = executedCompactProposalSession ?? session;
    const record = proposalSession.proposalRefinementRecords.get(executedCompactProposal.proposal_id);
    if (record) {
      proposalSession.proposalRefinementRecords.set(executedCompactProposal.proposal_id, {
        ...record,
        version: record.version + 1,
        accepted: {
          accepted_at: now,
          media_buy_id: mediaBuyId,
          media_buy_revision: mediaBuy.revision,
        },
      });
      for (const [proposalId, source] of proposalSession.proposalRefinementRecords) {
        if (source.activeHold?.proposal_id !== executedCompactProposal.proposal_id) continue;
        proposalSession.proposalRefinementRecords.set(proposalId, {
          ...source,
          version: source.version + 1,
          activeHold: undefined,
        });
      }
    }
  }
  session.mediaBuys.set(mediaBuyId, mediaBuy);

  const status = deriveStatus(mediaBuy, session);
  const productAvailableActions = deriveAvailableActionsFromProductAllowedActions(productAllowedActions, status);
  if (productAvailableActions !== undefined) mediaBuy.availableActions = productAvailableActions;
  // Emit `media_buy_status` (canonical 3.1 field per #4895). Body-level
  // `status` carrying MediaBuyStatus is deprecated and removed in 3.2
  // (#4906) — emitting it here would collide with envelope `status`
  // (TaskStatus), which the envelope-fold (#4878) now requires to validate
  // against the per-task response schema.
  return {
    media_buy_id: mediaBuyId,
    ...(req.proposal_id && { proposal_id: req.proposal_id }),
    ...(req.idempotency_key && { idempotency_key: req.idempotency_key }),
    media_buy_status: status,
    revision: mediaBuy.revision,
    confirmed_at: mediaBuy.confirmedAt,
    currency: mediaBuy.currency,
    total_budget: mediaBuy.totalBudget,
    ...(mediaBuy.budgetAllocation && { budget_allocation: mediaBuy.budgetAllocation }),
    ...(mediaBuy.aggregatePacing && { pacing: mediaBuy.aggregatePacing }),
    ...(mediaBuy.aggregateBidding && { bidding: mediaBuy.aggregateBidding }),
    valid_actions: validActionsForMediaBuy(mediaBuy, status),
    available_actions: availableActionsForMediaBuy(mediaBuy, status),
    packages: createdPackages.map(pkg => ({
      package_id: pkg.packageId,
      product_id: pkg.productId,
      budget: pkg.budget,
      pricing_option_id: pkg.pricingOptionId,
      ...(pkg.bidPrice !== undefined && { bid_price: pkg.bidPrice }),
      ...(pkg.impressions !== undefined && { impressions: pkg.impressions }),
      paused: pkg.paused,
      start_time: pkg.startTime,
      end_time: pkg.endTime,
      ...packageFormatSelectorForWire(pkg, ctx),
      ...packageReadinessFields(pkg, session),
      ...(pkg.targeting && { targeting_overlay: targetingForWire(pkg.targeting) }),
      ...(pkg.context && { context: pkg.context }),
      ...(pkg.committedMetrics && { committed_metrics: pkg.committedMetrics }),
      creative_assignments: pkg.creativeAssignments.map(creativeId => ({ creative_id: creativeId })),
    })),
    ...(isRecord(req.context) && { context: req.context }),
  };
}

export async function handleGetMediaBuys(args: ToolArgs, ctx: TrainingContext): Promise<Record<string, unknown>> {
  const req = args as unknown as GetMediaBuysArgs;
  const session = await getSession(sessionKeyFromArgs(req, ctx.mode, ctx.userId, ctx.moduleId));
  const filterIds = req.media_buy_ids;

  let buys = Array.from(session.mediaBuys.values());
  if (!filterIds?.length && buys.length === 0) {
    // Broad list on an empty session: provide compliance fixtures so demo.example.com
    // sessions show realistic media buy data without the learner first creating a buy.
    // ID-lookup paths skip this — loading all fixtures to filter down is wasteful when
    // the caller already knows the IDs it wants (and unknown IDs should return empty,
    // not a fixture). Sessions that have created their own buys return only those.
    buys = getComplianceMediaBuys();
  }
  if (filterIds?.length) {
    buys = buys.filter(b => filterIds.includes(b.mediaBuyId));
    // Media buy lookup is scoped to the caller's session (brand/account-derived).
    // Unknown IDs simply fall out of the filter — the response omits them.
  }

  // Apply status_filter (default to ['active'] when no IDs provided)
  const statusFilter = req.status_filter;
  if (!filterIds?.length) {
    const effectiveFilter = statusFilter || ['active'];
    buys = buys.filter(mb => effectiveFilter.includes(deriveStatus(mb, session)));
  } else if (statusFilter?.length) {
    buys = buys.filter(mb => statusFilter.includes(deriveStatus(mb, session)));
  }

  const includeSnapshot = req.include_snapshot === true;
  const includeHistory = Number(req.include_history) || 0;

  // Always emit a pagination block — per the cursor↔has_more invariant
  // (universal/get-media-buys-pagination-integrity, schema/core/pagination-response.json).
  // The SDK's storyboard request-builder injects `media_buy_ids: ["unknown"]`
  // whenever context.media_buy_id is empty, so a "broad list query" reaches
  // the agent as an ID-lookup. We honor the slice on broad queries (no
  // filterIds) and emit a terminal pagination block on ID lookups (where
  // pagination is semantically a no-op but a missing block is dishonest).
  // Cursor/max_results are ignored on ID-lookup paths — direct lookup wins.
  let pageBuys = buys;
  let paginationBlock: Record<string, unknown>;

  if (!filterIds?.length) {
    const requestedMax = req.pagination?.max_results;
    const maxResults = Math.min(typeof requestedMax === 'number' ? requestedMax : 50, 100);
    const offset = decodeOffsetCursor('media_buys', req.pagination?.cursor);
    if (offset === null) {
      return {
        errors: [{ code: 'INVALID_REQUEST', message: 'pagination.cursor is malformed' }] as TaskError[],
      };
    }
    const pageEnd = Math.min(offset + maxResults, buys.length);
    pageBuys = buys.slice(offset, pageEnd);
    const hasMore = pageEnd < buys.length;
    paginationBlock = {
      has_more: hasMore,
      total_count: buys.length,
      ...(hasMore && { cursor: encodeOffsetCursor('media_buys', pageEnd) }),
    };
  } else {
    // ID lookup: direct match, no pagination. Emit terminal block so the
    // wire shape is honest (`has_more: false`, no cursor).
    paginationBlock = { has_more: false, total_count: buys.length };
  }

  return {
    media_buys: pageBuys.map(mb => {
      const status = deriveStatus(mb, session);
      const totalBudget = mb.totalBudget
        ?? mb.packages.reduce((sum, pkg) => sum + (pkg.budget || 0), 0);
      const openImpairments = mb.impairments ?? [];
      const buy = {
        media_buy_id: mb.mediaBuyId,
        status,
        revision: mb.revision,
        confirmed_at: mb.confirmedAt,
        created_at: mb.createdAt,
        updated_at: mb.updatedAt,
        valid_actions: validActionsForMediaBuy(mb, status),
        available_actions: availableActionsForMediaBuy(mb, status),
        currency: mb.currency,
        total_budget: totalBudget,
        ...(mb.budgetAllocation && { budget_allocation: mb.budgetAllocation }),
        ...(mb.aggregatePacing && { pacing: mb.aggregatePacing }),
        ...(mb.aggregateBidding && { bidding: mb.aggregateBidding }),
        start_time: mb.startTime,
        end_time: mb.endTime,
        health: (openImpairments.length > 0 ? 'impaired' : 'ok') as 'ok' | 'impaired',
        impairments: openImpairments.map(i => ({
          impairment_id: i.impairmentId,
          resource_type: i.resourceType,
          resource_id: i.resourceId,
          package_ids: i.packageIds,
          transition: i.transition,
          reason_code: i.reasonCode,
          observed_at: i.observedAt,
          ...(i.reason !== undefined && { reason: i.reason }),
          ...(i.remediation !== undefined && { remediation: i.remediation }),
        })),
        ...(mb.creativeDeadline && { creative_deadline: mb.creativeDeadline }),
        ...(mb.governanceContext && { governance_context: mb.governanceContext }),
        ...(mb.canceledAt && {
          cancellation: {
            canceled_at: mb.canceledAt,
            canceled_by: mb.canceledBy,
            reason: mb.cancellationReason,
          },
        }),
        packages: mb.packages.map(pkg => {
          const pkgData = {
            package_id: pkg.packageId,
            ...(pkg.legacyOmitProductId ? {} : { product_id: pkg.productId }),
            budget: pkg.budget,
            pricing_option_id: pkg.pricingOptionId,
            ...(pkg.bidPrice !== undefined && { bid_price: pkg.bidPrice }),
            ...(pkg.impressions !== undefined && { impressions: pkg.impressions }),
            paused: pkg.paused,
            start_time: pkg.startTime,
            end_time: pkg.endTime,
            ...packageFormatSelectorForWire(pkg, ctx),
            ...packageReadinessFields(pkg, session),
            creative_approvals: pkg.creativeAssignments.map(cid => ({
              creative_id: cid,
              approval_status: 'approved' as const,
            })),
            ...(pkg.targeting && { targeting_overlay: targetingForWire(pkg.targeting) }),
            ...(pkg.context && { context: pkg.context }),
            ...(pkg.committedMetrics && { committed_metrics: pkg.committedMetrics }),
            ...(pkg.canceledAt && {
              cancellation: {
                canceled_at: pkg.canceledAt,
                canceled_by: pkg.canceledBy,
                reason: pkg.cancellationReason,
              },
            }),
            ...(includeSnapshot && { snapshot_unavailable_reason: 'SNAPSHOT_UNSUPPORTED' as const }),
          };
          return pkgData;
        }),
        ...(mb.context && { context: mb.context }),
        ...(includeHistory > 0 && mb.history?.length && {
          history: mb.history.slice(-includeHistory).reverse().map(h => ({
          revision: h.revision,
          timestamp: h.timestamp,
          actor: h.actor,
          action: h.action,
          summary: h.summary,
          ...(h.packageId && { package_id: h.packageId }),
        })),
        }),
      };
      return buy;
    }),
    pagination: paginationBlock,
    ...(req.context !== undefined && { context: req.context }),
  };
}

export async function handleGetMediaBuyDelivery(args: ToolArgs, ctx: TrainingContext) {
  const req = args as unknown as GetMediaBuyDeliveryRequest & ToolArgs & { media_buy_id?: string };
  const session = await getSession(
    sessionKeyFromArgs(req, ctx.mode, ctx.userId, ctx.moduleId),
    controllerFixtureSessionKey(req, ctx),
  );
  const catalog = getCatalog();
  const productMap = new Map(catalog.map(cp => [cp.product.product_id, { ...cp.product }]));
  overlaySeededProducts(session, productMap);
  overlayNegotiatedPricingOptions(session, productMap);
  const mediaBuyId = req.media_buy_id || req.media_buy_ids?.[0] || '';
  const mb = session.mediaBuys.get(mediaBuyId) ?? getComplianceMediaBuy(mediaBuyId);

  if (!mb) {
    return {
      errors: [{ code: 'MEDIA_BUY_NOT_FOUND', message: `Media buy not found: ${mediaBuyId}` }],
    };
  }

  const now = new Date();
  const start = new Date(mb.startTime);
  const end = new Date(mb.endTime);
  const reportingStart = req.start_date ? new Date(`${req.start_date}T00:00:00.000Z`) : start;
  const reportingEnd = req.end_date ? new Date(`${req.end_date}T00:00:00.000Z`) : now;
  if (req.start_date && req.end_date && reportingStart.getTime() >= reportingEnd.getTime()) {
    return {
      errors: [{ code: 'VALIDATION_ERROR', message: 'start_date must be before end_date', field: 'start_date' }],
    };
  }
  const durationMs = end.getTime() - start.getTime();
  const elapsed = durationMs > 0
    ? Math.max(0, Math.min(1, (reportingEnd.getTime() - start.getTime()) / durationMs))
    : 0;

  // Read simulated delivery upfront so vendor_metric_values can be spread into
  // per-package entries inside the map below.
  const simDeliveryEarly = req.start_date || req.end_date
    ? getDeliverySimulationForPeriod(session, mb.mediaBuyId, reportingStart, reportingEnd)
    : getDeliverySimulation(session, mb.mediaBuyId);

  // Build per-package metrics
  let totalImpressions = 0;
  let totalSpend = 0;
  let totalClicks = 0;
  let totalCompletedViews = 0;
  let totalViews = 0;
  let totalReach = 0;
  let totalReachUnit: string | undefined;

  const mediaBuyPaused = mb.status === 'paused';
  const simDelivery = mediaBuyPaused ? undefined : simDeliveryEarly;

  const byPackage = mb.packages.map(pkg => {
    const packagePaused = pkg.paused === true;
    const deliverySuppressed = mediaBuyPaused || packagePaused || pkg.canceled;
    if (deliverySuppressed) {
      const { model, rate } = derivePricing(pkg, productMap);
      return {
        package_id: pkg.packageId,
        spend: 0,
        impressions: 0,
        clicks: 0,
        pricing_model: model,
        model, // #1525: alias for @adcp/sdk < 4.11.0
        rate,
        currency: mb.currency,
        paused: packagePaused,
        delivery_status: 'delivering' as const,
      };
    }

    const { model: pricingModel, rate } = derivePricing(pkg, productMap);
    const isRevenueShare = pricingModel === 'revenue_share';
    const useScopedSimulation = simDelivery !== undefined
      && Boolean(req.start_date || req.end_date);
    const budget = pkg.budget;
    const spend = isRevenueShare || useScopedSimulation
      ? (simDelivery?.reportedSpend.amount ?? 0)
      : Math.round(budget * elapsed * 100) / 100;

    // Channel-appropriate CTR
    const product = productMap.get(pkg.productId);
    const channels = product?.channels;
    let ctr: number;
    if (channels?.some(c => ['social', 'influencer'].includes(c))) ctr = 0.012;
    else if (channels?.some(c => ['search'].includes(c))) ctr = 0.035;
    else if (channels?.some(c => ['retail_media'].includes(c))) ctr = 0.008;
    else if (channels?.some(c => ['ctv', 'linear_tv'].includes(c))) ctr = 0;
    else if (channels?.some(c => ['streaming_audio', 'podcast', 'radio'].includes(c))) ctr = 0.003;
    else if (channels?.some(c => ['print'].includes(c))) ctr = 0;
    else ctr = 0.001;

    const impressions = isRevenueShare || useScopedSimulation
      ? (simDelivery?.impressions ?? 0)
      : rate > 0 ? Math.round((spend / rate) * 1000) : 0;
    const clicks = isRevenueShare || useScopedSimulation
      ? (simDelivery?.clicks ?? 0)
      : Math.round(impressions * ctr);

    if (!isRevenueShare && !useScopedSimulation) {
      totalImpressions += impressions;
      totalSpend += spend;
      totalClicks += clicks;
    }

    // Audio/video metrics — completion rates vary by channel
    // Accumulators for totals rollup are updated after audioMetrics is built
    const isAudioVideo = channels?.some(c =>
      ['streaming_audio', 'podcast', 'radio', 'ctv', 'linear_tv', 'olv'].includes(c),
    );
    let completionRate = 0.65;
    if (channels?.some(c => ['podcast'].includes(c))) completionRate = 0.87;
    else if (channels?.some(c => ['streaming_audio', 'radio'].includes(c))) completionRate = 0.72;
    else if (channels?.some(c => ['ctv', 'linear_tv'].includes(c))) completionRate = 0.82;

    const reachUnit = channels?.some(c => ['streaming_audio', 'podcast'].includes(c)) ? 'accounts' as const : 'devices' as const;
    const audioMetrics = isAudioVideo && impressions > 0
      ? {
        views: Math.round(impressions * 0.9),
        completed_views: Math.round(impressions * completionRate),
        completion_rate: completionRate,
        reach: Math.round(impressions * 0.72),
        reach_unit: reachUnit,
        frequency: +(impressions / Math.round(impressions * 0.72)).toFixed(1),
        ...(channels?.some(c => ['streaming_audio', 'podcast'].includes(c))
          ? {
            follows: Math.round(impressions * 0.002),
            conversions: Math.round(impressions * 0.006),
          }
          : {}),
      }
      : {};
    const byCreative = simDelivery?.conversions && pkg.creativeAssignments.length > 0
      ? {
        by_creative: pkg.creativeAssignments.map((creativeId, index) => {
          const base = Math.floor(simDelivery.conversions / pkg.creativeAssignments.length);
          const remainder = simDelivery.conversions % pkg.creativeAssignments.length;
          const impressionBase = Math.floor(impressions / pkg.creativeAssignments.length);
          const impressionRemainder = impressions % pkg.creativeAssignments.length;
          const spendBase = Math.floor((spend / pkg.creativeAssignments.length) * 100) / 100;
          const spendRemainderCents = Math.round((spend - (spendBase * pkg.creativeAssignments.length)) * 100);
          return {
            creative_id: creativeId,
            impressions: impressionBase + (index < impressionRemainder ? 1 : 0),
            spend: Math.round((spendBase + (index < spendRemainderCents ? 0.01 : 0)) * 100) / 100,
            conversions: base + (index < remainder ? 1 : 0),
          };
        }),
      }
      : {};

    const reporting = product?.reporting_capabilities as ReportingCapabilitiesView | undefined;
    const fallbackMetrics: CommittedMetricProposalView[] = [
      ...(reporting?.available_metrics ?? []).map(metricId => ({ scope: 'standard' as const, metric_id: metricId })),
      ...(reporting?.vendor_metrics ?? []).flatMap(metric => {
        const domain = metric.vendor?.domain;
        const metricId = metric.metric_id;
        if (typeof domain !== 'string' || typeof metricId !== 'string') return [];
        return [{
          scope: 'vendor' as const,
          vendor: {
            domain,
            ...(typeof metric.vendor?.brand_id === 'string' && { brand_id: metric.vendor.brand_id }),
          },
          metric_id: metricId,
        }];
      }),
    ];
    // An explicit package snapshot is authoritative even when it contains no
    // vendor rows. Only packages without a snapshot fall back to the product's
    // current reporting capabilities.
    const auditMetrics: CommittedMetricProposalView[] = pkg.committedMetrics !== undefined
      ? pkg.committedMetrics
      : fallbackMetrics;
    const eligibleAuditMetrics = auditMetrics.filter(metric => (
      metric.committed_at === undefined
      || new Date(metric.committed_at).getTime() < reportingEnd.getTime()
    ));
    const auditVendorKeys = new Set(
      auditMetrics
        .filter(metric => metric.scope === 'vendor')
        .map(metric => vendorMetricKey(metric))
        .filter((key): key is string => key !== null),
    );
    const rawDeferredVendorMetrics = simDelivery?.deferredVendorMetricsByPackage?.[pkg.packageId]
      ?? (mb.packages.length === 1 ? simDelivery?.deferredVendorMetrics : undefined)
      ?? [];
    const deferredVendorKeys = new Set(
      rawDeferredVendorMetrics
        .map(metric => vendorMetricKey(metric))
        .filter((key): key is string => key !== null),
    );
    const rawVendorMetricValues = simDelivery?.vendorMetricValuesByPackage?.[pkg.packageId]
      ?? (mb.packages.length === 1 ? simDelivery?.vendorMetricValues : undefined)
      ?? [];
    const vendorMetricValues = rawVendorMetricValues
      .filter((value): value is Record<string, unknown> => isRecord(value))
      .filter(value => {
        const key = vendorMetricKey(value as VendorMetricRefView);
        return key !== null && auditVendorKeys.has(key);
      });
    const deliveredVendorKeys = new Set(
      vendorMetricValues
        .map(value => vendorMetricKey(value as VendorMetricRefView))
        .filter((key): key is string => key !== null),
    );
    const packageDeliveryMetrics: Record<string, unknown> = {
      spend,
      impressions,
      clicks,
      ...(mb.packages.length === 1 && simDelivery?.plays !== undefined ? { plays: simDelivery.plays } : {}),
      ...(mb.packages.length === 1 && simDelivery?.doohMetrics ? { dooh_metrics: simDelivery.doohMetrics } : {}),
      ...audioMetrics,
      ...byCreative,
      ...(vendorMetricValues.length > 0 && { vendor_metric_values: vendorMetricValues }),
    };
    const missingMetrics = eligibleAuditMetrics.reduce<Array<Record<string, unknown>>>((missing, metric) => {
      if (metric.scope === 'standard') {
        if (!standardMetricIsDelivered(metric, packageDeliveryMetrics)) {
          missing.push({
            scope: 'standard' as const,
            metric_id: metric.metric_id!,
            ...(metric.qualifier && { qualifier: metric.qualifier }),
          });
        }
        return missing;
      }
      const key = vendorMetricKey(metric);
      if (key !== null && !deliveredVendorKeys.has(key) && !deferredVendorKeys.has(key)) {
        missing.push({
          scope: 'vendor' as const,
          vendor: metric.vendor!,
          metric_id: metric.metric_id!,
        });
      }
      return missing;
    }, []);

    if (isAudioVideo && impressions > 0) {
      totalCompletedViews += Math.round(impressions * completionRate);
      totalViews += Math.round(impressions * 0.9);
      totalReach += Math.round(impressions * 0.72);
      if (!totalReachUnit) totalReachUnit = reachUnit;
      else if (totalReachUnit !== reachUnit) totalReachUnit = 'mixed';
    }

    return {
      package_id: pkg.packageId,
      ...packageDeliveryMetrics,
      ...(isRevenueShare && simDelivery ? {
        conversions: simDelivery.conversions,
        ...(simDelivery.conversionValue !== undefined ? { conversion_value: simDelivery.conversionValue } : {}),
        ...(simDelivery.commissionableValue !== undefined ? { commissionable_value: simDelivery.commissionableValue } : {}),
      } : {}),
      pricing_model: pricingModel,
      model: pricingModel, // #1525: alias for @adcp/sdk < 4.11.0
      rate,
      currency: mb.currency,
      ...(includeThreeOneFields(ctx) && simDelivery?.isFinal !== undefined ? { is_final: simDelivery.isFinal } : {}),
      ...(includeThreeOneFields(ctx) && simDelivery?.isFinal === true && simDelivery.finalizedAt ? { finalized_at: simDelivery.finalizedAt } : {}),
      ...(includeThreeOneFields(ctx) && simDelivery?.measurementWindow ? { measurement_window: simDelivery.measurementWindow } : {}),
      paused: false,
      delivery_status: elapsed >= 1 ? 'completed' as const : 'delivering' as const,
      ...(auditMetrics.length > 0 ? { missing_metrics: missingMetrics } : {}),
    };
  });

  // Add simulated delivery data from comply_test_controller
  if (simDelivery) {
    totalImpressions += simDelivery.impressions;
    totalClicks += simDelivery.clicks;
    totalSpend += simDelivery.reportedSpend.amount;
  }

  // Conversion-attributed totals. Only surface when simulate_delivery
  // injected conversion data — sellers that don't optimize toward events
  // (pure brand/audience sellers) omit these fields entirely.
  const totalConversions = simDelivery?.conversions ?? 0;
  const roundedSpend = Math.round(totalSpend * 100) / 100;
  const conversionTotals = totalConversions > 0 && roundedSpend > 0
    ? {
      conversions: totalConversions,
      cost_per_acquisition: Math.round((roundedSpend / totalConversions) * 100) / 100,
    }
    : totalConversions > 0
      ? { conversions: totalConversions }
      : {};
  const conversionValueTotals = simDelivery
    ? {
      ...(simDelivery.conversionValue !== undefined ? { conversion_value: simDelivery.conversionValue } : {}),
      ...(simDelivery.commissionableValue !== undefined ? { commissionable_value: simDelivery.commissionableValue } : {}),
    }
    : {};

  // Click-attributed total. cost_per_click is defined as spend / clicks in
  // delivery-metrics.json. Always surface when both are positive — this
  // doesn't need a goal-kind gate because every buy emits clicks (the
  // default totals.clicks already does) and the derived metric is the
  // discriminating field for click-optimized buys (clicks_buy_flow).
  const clickTotals = totalClicks > 0 && roundedSpend > 0
    ? { cost_per_click: Math.round((roundedSpend / totalClicks) * 100) / 100 }
    : {};

  // Metric-goal-gated emission. Reach + frequency are surfaced when at
  // least one package was created with a reach goal; completed_views +
  // completion_rate when at least one package was created with a
  // completed_views goal. Without the gate the seller would blanket-emit
  // these fields on every buy (a brand-only seller would emit completion
  // metrics on a click-only buy — confuses buyers and runs against the
  // discriminating-field contract in the storyboards).
  //
  // Placeholder ratios: reach = floor(impressions / 3) with frequency = 3
  // (industry-typical for mixed-channel campaigns); completed_views =
  // floor(impressions * 0.7) (70% completion rate is a common video
  // platform default). Documented as placeholders because the
  // get_media_buy_delivery contract requires field_present, not specific
  // numeric values, on the gating scenarios.
  const hasReachGoal = mb.packages.some(pkg =>
    pkg.optimizationGoals?.some(g => g?.kind === 'metric' && g?.metric === 'reach'),
  );
  const hasCompletedViewsGoal = mb.packages.some(pkg =>
    pkg.optimizationGoals?.some(g => g?.kind === 'metric' && g?.metric === 'completed_views'),
  );
  // Resolve reach_unit from the first reach goal that declared one — buyers
  // bind reach measurement to the unit (households vs cookies are not
  // comparable). When goals omitted the unit, fall back to the existing
  // channel-derived unit (totalReachUnit) computed above.
  let derivedReachUnit: string | undefined = totalReachUnit !== 'mixed' ? totalReachUnit : undefined;
  if (!derivedReachUnit && hasReachGoal) {
    for (const pkg of mb.packages) {
      const goal = pkg.optimizationGoals?.find(g => g?.kind === 'metric' && g?.metric === 'reach' && typeof g?.reach_unit === 'string');
      if (goal && typeof goal.reach_unit === 'string') {
        derivedReachUnit = goal.reach_unit;
        break;
      }
    }
  }

  const goalDerivedReach = hasReachGoal && totalImpressions > 0 && totalReach === 0
    ? {
      reach: Math.max(1, Math.floor(totalImpressions / 3)),
      ...(derivedReachUnit && { reach_unit: derivedReachUnit }),
      frequency: +(totalImpressions / Math.max(1, Math.floor(totalImpressions / 3))).toFixed(1),
    }
    : {};
  const defaultReachWindow = hasReachGoal && simDelivery?.reach !== undefined && !simDelivery.reachWindow
    ? { kind: 'period' as const, period: { interval: 1, unit: 'days' } }
    : undefined;
  const goalDerivedCompletedViews = hasCompletedViewsGoal && totalImpressions > 0 && totalCompletedViews === 0
    ? (() => {
      const completed = Math.floor(totalImpressions * 0.7);
      return {
        completed_views: completed,
        completion_rate: +(completed / totalImpressions).toFixed(3),
      };
    })()
    : {};
  const simulatedReachMetrics = simDelivery && (
    simDelivery.reach !== undefined
    || simDelivery.frequency !== undefined
    || simDelivery.reachWindow
  )
    ? {
      ...(simDelivery.reach !== undefined ? { reach: simDelivery.reach } : {}),
      ...(simDelivery.reach !== undefined && derivedReachUnit ? { reach_unit: derivedReachUnit } : {}),
      ...(simDelivery.frequency !== undefined ? { frequency: simDelivery.frequency } : {}),
      ...(simDelivery.reachWindow ? { reach_window: simDelivery.reachWindow } : {}),
      ...(defaultReachWindow ? { reach_window: defaultReachWindow } : {}),
    }
    : {};
  const simulatedViewability = simDelivery?.viewability
    ? { viewability: simDelivery.viewability }
    : {};
  const simulatedDoohMetrics = simDelivery
    ? {
      ...(simDelivery.plays !== undefined ? { plays: simDelivery.plays } : {}),
      ...(simDelivery.doohMetrics ? { dooh_metrics: simDelivery.doohMetrics } : {}),
    }
    : {};

  return {
    reporting_period: {
      start: reportingStart.toISOString(),
      end: reportingEnd.toISOString(),
    },
    currency: mb.currency,
    media_buy_deliveries: [{
      media_buy_id: mb.mediaBuyId,
      status: deriveStatus(mb, session),
      ...(includeThreeOneFields(ctx) && simDelivery?.isFinal !== undefined ? { is_final: simDelivery.isFinal } : {}),
      ...(includeThreeOneFields(ctx) && simDelivery?.isFinal === true && simDelivery.finalizedAt ? { finalized_at: simDelivery.finalizedAt } : {}),
      totals: {
        impressions: totalImpressions,
        spend: roundedSpend,
        clicks: totalClicks,
        ...clickTotals,
        ...(totalCompletedViews > 0 ? {
          views: totalViews,
          completed_views: totalCompletedViews,
          completion_rate: +(totalCompletedViews / totalImpressions).toFixed(3),
        } : {}),
        ...goalDerivedCompletedViews,
        ...(totalReach > 0 && totalReachUnit && totalReachUnit !== 'mixed' ? {
          reach: totalReach,
          reach_unit: totalReachUnit,
          frequency: +(totalImpressions / totalReach).toFixed(1),
        } : {}),
        ...goalDerivedReach,
        ...simulatedReachMetrics,
        ...conversionTotals,
        ...conversionValueTotals,
        ...simulatedViewability,
        ...simulatedDoohMetrics,
      },
      by_package: byPackage,
    }],
  };
}

function derivePricing(pkg: PackageState, productMap: Map<string, import('@adcp/sdk').LegacyProduct>): { model: string; rate: number } {
  const product = productMap.get(pkg.productId);
  const pricing = product?.pricing_options.find(po => po.pricing_option_id === pkg.pricingOptionId);
  const view = pricing as unknown as PricingOptionView | undefined;
  return {
    model: view?.pricing_model || 'cpm',
    rate: view?.commission_rate
      ?? view?.fixed_price
      ?? (pricingStructureForOption(view) === 'auction' ? view?.floor_price : undefined)
      ?? 10,
  };
}

function creativeSessionKey(args: ToolArgs, ctx: TrainingContext): string {
  const legacyDomain = ctx.storyboardCompat?.version === '3.0'
    ? ctx.legacySessionBrandDomain
      ?? args.account?.brand?.domain
      ?? args.brand?.domain
    : undefined;
  return sessionKeyFromArgs(
    legacyDomain ? { brand: { domain: legacyDomain } } : args,
    ctx.mode,
    ctx.userId,
    ctx.moduleId,
  );
}

export async function handleSyncCreatives(args: ToolArgs, ctx: TrainingContext) {
  const req = args as unknown as SyncCreativesRequest & ToolArgs & { dry_run?: boolean };
  const sessionKey = creativeSessionKey(req, ctx);
  const session = await getSession(sessionKey);
  const isDryRun = req.dry_run === true;
  const accountId = resolveAccountIdForRef(sessionKey, ctx.principal, req.account);

  if (!req.creatives?.length) {
    return {
      errors: [{ code: 'INVALID_REQUEST', message: 'creatives array is required' }] as TaskError[],
    };
  }

  if (!isDryRun && session.creatives.size + req.creatives.length > MAX_CREATIVES_PER_SESSION) {
    return {
      errors: [{ code: 'LIMIT_EXCEEDED', message: `Session limit reached (max ${MAX_CREATIVES_PER_SESSION} creatives). Start a new session.` }] as TaskError[],
    };
  }

  // Build a set of valid format IDs for validation
  const validFormatIds = new Set(getFormats().map(f => f.format_id.id));
  const ownAgentUrlCanonical = canonicalizeAgentUrl(getAgentUrl());
  // Compute the session's effective creative_policy from seeded products.
  // Returns null when no fixture seeds policy fields — pre-existing
  // storyboards that don't exercise provenance enforcement keep working.
  const effectivePolicy = aggregateCreativePolicy(session);

  const results: SyncCreativeResult[] = [];
  for (const creative of req.creatives) {
    if (!creative.creative_id) {
      return {
        errors: [{
          code: 'INVALID_REQUEST',
          message: 'creative_id is required on each creative. The buyer assigns creative IDs.',
        }],
      };
    }
    const creativeId = creative.creative_id;
    const creativeShape = creative as unknown as {
      format_id?: FormatID;
      format_kind?: string;
      format_option_ref?: Record<string, unknown>;
      assets?: Record<string, unknown>;
      manifest?: CreativeManifest;
    };
    const identityResult = validatedCreativeIdentity(creativeShape);
    if (!identityResult.ok) {
      return {
        errors: [{ code: 'INVALID_REQUEST', message: `Each creative ${identityResult.message}.` }] as TaskError[],
      };
    }
    const identity = identityResult.identity;
    const formatId = identity.kind === 'legacy' ? identity.formatId : undefined;

    // Enforce creative_policy.provenance_required / provenance_requirements /
    // accepted_verifiers BEFORE persisting the creative. Per-creative failure
    // is surfaced as action: 'failed' + errors[]; the surrounding session and
    // any other creatives in the batch are unaffected (best-effort processing).
    const policyResult = await enforceProvenancePolicy(creative as unknown as CreativeForEnforcement, effectivePolicy);
    if (policyResult.error) {
      results.push({
        creative_id: creativeId,
        action: 'failed',
        errors: [policyResult.error],
      });
      continue;
    }

    // Validate format_id only when the format is claimed against this agent.
    // Cross-agent format references (e.g. creative.adcontextprotocol.org) are
    // resolved by the referenced creative agent at render time — the seller
    // just stores the pointer. Compare canonical forms so a trailing slash
    // or case variant of the local URL still counts as local.
    const isLocalFormat = !formatId?.agent_url
      || canonicalizeAgentUrl(formatId.agent_url) === ownAgentUrlCanonical;
    if (creativeShape.format_id && formatId?.id && isLocalFormat && !validFormatIds.has(formatId.id)) {
      return {
        errors: [{
          code: 'INVALID_REQUEST',
          message: `Unknown format_id "${formatId.id}" on the deprecated named-format path. Use canonical format_kind from the target product.`,
        }] as TaskError[],
      };
    }

    const nativeError = nativeInFeedValidationError(creative as { format_id?: FormatID; assets?: Record<string, unknown> });
    if (nativeError) return { errors: [nativeError] as TaskError[] };

    const existing = session.creatives.has(creativeId);
    const existingCreative = session.creatives.get(creativeId);

    if (!isDryRun) {
      const manifest = normalizedCreativeManifest(creativeShape, existingCreative, identity);
      session.creatives.set(creativeId, {
        creativeId,
        accountId: accountId ?? existingCreative?.accountId,
        accountRef: ctx.resolvedAccount ?? req.account ?? existingCreative?.accountRef,
        ...(identity.kind === 'legacy'
          ? {
            formatId: identity.formatId,
            ...(identity.formatOptionRef && { formatOptionRef: identity.formatOptionRef }),
          }
          : {
            formatKind: identity.formatKind,
            ...(identity.formatOptionRef && { formatOptionRef: identity.formatOptionRef }),
          }),
        ...(manifest && { assets: manifest.assets }),
        name: creative.name,
        status: existingCreative?.status ?? 'approved',
        syncedAt: new Date().toISOString(),
        // manifest is a training-agent extension, not in SDK CreativeAsset type.
        // Normalize its identity from the validated top-level union so a
        // canonical update cannot retain a nested legacy format_id.
        manifest,
        pricingOptionId: existingCreative?.pricingOptionId,
        purge: existingCreative?.purge,
        webhookActivity: existingCreative?.webhookActivity,
      });
      if (policyResult.auditObservations.length) {
        session.complyExtensions.provenanceAuditObservations.set(creativeId, policyResult.auditObservations);
      } else {
        session.complyExtensions.provenanceAuditObservations.delete(creativeId);
      }
    }

    results.push({
      creative_id: creativeId,
      action: existing ? 'updated' : 'created',
    });
  }

  // Process creative assignments. Dry runs validate the same assignment
  // references but skip the package mutation.
  const assignmentResults: AssignmentResult[] = [];
  if (req.assignments?.length) {
    const availableCreativeIds = new Set(session.creatives.keys());
    for (const result of results) {
      if (result.action !== 'failed') availableCreativeIds.add(result.creative_id);
    }
    for (const assignment of req.assignments) {
      const mediaBuyId = (assignment as unknown as CreativeAssignmentInput).media_buy_id;
      const packageId = assignment.package_id;
      const creativeId = assignment.creative_id;

      const mb = session.mediaBuys.get(mediaBuyId);
      if (!mb) {
        assignmentResults.push({ creative_id: creativeId, package_id: packageId, status: 'error', message: `Media buy not found: ${mediaBuyId}` });
        continue;
      }
      const pkg = mb.packages.find(p => p.packageId === packageId);
      if (!pkg) {
        assignmentResults.push({ creative_id: creativeId, package_id: packageId, status: 'error', message: `Package not found: ${packageId}` });
        continue;
      }
      if (!availableCreativeIds.has(creativeId)) {
        assignmentResults.push({ creative_id: creativeId, package_id: packageId, status: 'error', message: `Creative not found: ${creativeId}` });
        continue;
      }
      if (!isDryRun && !pkg.creativeAssignments.includes(creativeId)) {
        pkg.creativeAssignments.push(creativeId);
      }
      assignmentResults.push({ creative_id: creativeId, package_id: packageId, status: 'assigned' });
    }
  }

  return {
    ...(isDryRun && { dry_run: true }),
    creatives: results,
    ...(assignmentResults.length > 0 && { assignments: assignmentResults }),
  };
}

function accountRefsOverlap(stored: AccountRef | undefined, requested: AccountRef): boolean {
  if (!stored) return false;
  if (requested.account_id || stored.account_id) {
    return Boolean(requested.account_id && stored.account_id && requested.account_id === stored.account_id);
  }
  if (requested.brand?.domain && stored.brand?.domain && requested.brand.domain !== stored.brand.domain) return false;
  if (requested.operator || stored.operator) {
    return Boolean(requested.operator && stored.operator && requested.operator === stored.operator);
  }
  return Boolean(requested.brand?.domain && stored.brand?.domain && requested.brand.domain === stored.brand.domain);
}

type CreativeListFilters = {
  creative_ids?: string[];
  statuses?: string[];
  media_buy_ids?: string[];
  format_ids?: FormatID[];
  asset_types?: string[];
};

function storedCreativeFormatRecord(creative: CreativeState): Record<string, unknown> {
  if (creative.formatKind) {
    return {
      format_kind: creative.formatKind,
      ...(creative.formatOptionRef && { format_option_ref: creative.formatOptionRef }),
    };
  }
  return creative.formatId
    ? {
      format_id: {
        ...creative.formatId,
        agent_url: creative.formatId.agent_url ?? getAgentUrl(),
      },
      ...(creative.formatOptionRef && { format_option_ref: creative.formatOptionRef }),
    }
    : {};
}

function creativeMatchesAnyFormatId(
  creative: CreativeState,
  requested: FormatID[],
  adapters: CreativeProjectionAdapters,
): boolean {
  let projected: Record<string, unknown>;
  try {
    projected = projectCreativeRecordForWire(storedCreativeFormatRecord(creative), 'legacy', adapters);
  } catch {
    return false;
  }
  const actual = isRecord(projected.format_id) ? projected.format_id as unknown as FormatID : undefined;
  if (!actual?.id) return false;
  const actualAgentUrl = actual.agent_url ?? getAgentUrl();
  return requested.some(wanted => {
    if (!wanted?.id || wanted.id !== actual.id) return false;
    if (!wanted.agent_url
      || canonicalizeAgentUrl(wanted.agent_url) !== canonicalizeAgentUrl(actualAgentUrl)) return false;
    for (const parameter of ['width', 'height', 'duration_ms'] as const) {
      if (wanted[parameter] !== actual[parameter]) return false;
    }
    return true;
  });
}

function creativeMatchesAnyFormatKind(
  creative: CreativeState,
  requested: Set<string>,
  adapters: CreativeProjectionAdapters,
): boolean {
  let projected: Record<string, unknown>;
  try {
    projected = projectCreativeRecordForWire(storedCreativeFormatRecord(creative), 'canonical', adapters);
  } catch {
    return false;
  }
  return typeof projected.format_kind === 'string' && requested.has(projected.format_kind);
}

function creativeHasAnyTopLevelAssetType(creative: CreativeState, requested: Set<string>): boolean {
  const assets = creative.manifest?.assets as Record<string, unknown> | undefined;
  if (!assets) return false;
  for (const slotValue of Object.values(assets)) {
    if (!slotValue || typeof slotValue !== 'object' || Array.isArray(slotValue)) continue;
    const assetType = (slotValue as { asset_type?: unknown }).asset_type;
    if (typeof assetType === 'string' && requested.has(assetType)) return true;
  }
  return false;
}

export async function handleListCreatives(args: ToolArgs, ctx: TrainingContext) {
  const req = args as unknown as ListCreativesRequest & ToolArgs & {
    creative_ids?: string[];
    include_pricing?: boolean;
    include_snapshot?: boolean;
    include_purged?: boolean;
    include_webhook_activity?: boolean;
    webhook_activity_limit?: number;
    fields?: string[];
  };
  const filters = (req.filters ?? {}) as CreativeListFilters;
  const sessionKey = creativeSessionKey(req, ctx);
  const session = await getSession(sessionKey);
  const filterIds = req.creative_ids || filters.creative_ids;
  const requestedAccountId = resolveAccountIdForRef(sessionKey, ctx.principal, req.account);

  let creatives = Array.from(session.creatives.values());
  if (creatives.length === 0 && !req.include_webhook_activity) {
    // Controller-seeded creative storyboards can write under the test-kit
    // brand session while the list request keys by account_id. Prefer that
    // freshly seeded library over falling back to static compliance fixtures.
    const seededSession = await findSessionMatching(s => s.creatives.size > 0);
    if (seededSession) creatives = Array.from(seededSession.creatives.values());
  }
  if (filterIds?.length) {
    creatives = creatives.filter(c => filterIds.includes(c.creativeId));
  } else if (creatives.length === 0) {
    // Empty session falls back to compliance fixtures so storyboards that
    // reference stable IDs (e.g., campaign_hero_video in creative_ad_server)
    // resolve without the SDK's controller_seeding auto-fire. Sessions that
    // have synced their own creatives return only those — no mixing.
    creatives = getComplianceCreatives();
  }
  if (req.include_webhook_activity) {
    creatives = req.account && requestedAccountId
      ? creatives.filter(c => Boolean(c.accountId) && c.accountId === requestedAccountId)
      : [];
  } else if (req.account) {
    creatives = creatives.filter(c => {
      if (requestedAccountId && c.accountId) return c.accountId === requestedAccountId;
      if (c.accountRef) return accountRefsOverlap(c.accountRef, req.account!);
      return !req.include_webhook_activity;
    });
  }
  if (!req.include_purged) {
    creatives = creatives.filter(c => !c.purge);
  }
  if (filters.statuses?.length) {
    const statuses = new Set(filters.statuses);
    creatives = creatives.filter(c => statuses.has(c.status));
  }
  if (filters.media_buy_ids?.length) {
    const requestedMediaBuyIds = new Set(filters.media_buy_ids);
    const assignedCreativeIds = new Set<string>();
    for (const mediaBuy of session.mediaBuys.values()) {
      if (!requestedMediaBuyIds.has(mediaBuy.mediaBuyId)) continue;
      for (const pkg of mediaBuy.packages) {
        for (const creativeId of pkg.creativeAssignments) assignedCreativeIds.add(creativeId);
      }
    }
    creatives = creatives.filter(c => assignedCreativeIds.has(c.creativeId));
  }
  const formatKinds = (req.filters as unknown as { format_kinds?: string[] } | undefined)?.format_kinds;
  const filterProjectionAdapters = formatKinds?.length || filters.format_ids?.length
    ? creativeProjectionAdapters()
    : undefined;
  if (formatKinds?.length) {
    const wantedKinds = new Set(formatKinds);
    creatives = creatives.filter(c => creativeMatchesAnyFormatKind(c, wantedKinds, filterProjectionAdapters!));
  }
  if (filters.format_ids?.length) {
    creatives = creatives.filter(c => creativeMatchesAnyFormatId(c, filters.format_ids!, filterProjectionAdapters!));
  }
  if (filters.asset_types?.length) {
    const assetTypes = new Set(filters.asset_types);
    creatives = creatives.filter(c => creativeHasAnyTopLevelAssetType(c, assetTypes));
  }

  const totalMatching = creatives.length;
  // Schema declares max_results min=1, max=100, default=50. Honor the cap;
  // do not silently lift sub-1 values — those should surface as schema
  // violations through the SDK's request validator, not be quietly corrected.
  const requestedMax = req.pagination?.max_results;
  const maxResults = Math.min(typeof requestedMax === 'number' ? requestedMax : 50, 100);
  const offset = decodeCreativeCursor(req.pagination?.cursor);
  if (offset === null) {
    return {
      errors: [{ code: 'INVALID_REQUEST', message: 'pagination.cursor is malformed' }] as TaskError[],
    };
  }
  const pageEnd = Math.min(offset + maxResults, totalMatching);
  const pageCreatives = creatives.slice(offset, pageEnd);
  const hasMore = pageEnd < totalMatching;

  // Ad-server-capable sellers (creative.has_creative_library) quote per-
  // creative pricing whenever an account is present, independent of the
  // buyer setting include_pricing. Explicit `include_pricing: false` still
  // suppresses — matches the spec wording while letting callers that omit
  // the flag (e.g., SDK request builders that drop it) still receive pricing.
  // Spec today says "When false or omitted, pricing is not computed"; the
  // emission-on-omit behaviour here is deliberate per the has_creative_library
  // gate in #2847 and tracks the spec-side clarification referenced there.
  const emitPricing = creativeBillsThroughAdcp(ctx) && Boolean(req.account) && req.include_pricing !== false;
  const selectedFields = req.fields?.length ? new Set(req.fields) : undefined;

  return {
    query_summary: {
      total_matching: totalMatching,
      returned: pageCreatives.length,
    },
    pagination: {
      has_more: hasMore,
      total_count: totalMatching,
      // Cursor MUST be present iff has_more is true — see
      // static/schemas/source/core/pagination-response.json. Carrying a stale
      // cursor on a terminal page invites callers to follow it past the end
      // (caught by universal/pagination-integrity.yaml).
      ...(hasMore && { cursor: encodeCreativeCursor(pageEnd) }),
    },
    creatives: pageCreatives.map(c => {
      const base: Record<string, unknown> = {
        creative_id: c.creativeId,
        ...storedCreativeFormatRecord(c),
        name: c.name ?? c.creativeId,
        status: c.status,
        created_date: c.syncedAt,
        updated_date: c.syncedAt,
        ...(c.manifest?.assets && (!selectedFields || selectedFields.has('assets')) && { assets: c.manifest.assets }),
      };
      if (emitPricing && (c.formatKind || c.formatId?.id) && (!selectedFields || selectedFields.has('pricing_options'))) {
        base.pricing_options = [getCreativePricing(req.account!, c)];
      }
      if (req.include_snapshot) {
        base.snapshot_unavailable_reason = 'SNAPSHOT_UNSUPPORTED';
      }
      if (c.purge) {
        base.purge = {
          kind: c.purge.kind,
          at: c.purge.at,
          reason_code: c.purge.reasonCode,
        };
      }
      if (req.include_webhook_activity) {
        const limit = Math.min(Math.max(req.webhook_activity_limit ?? 50, 1), 200);
        base.webhook_activity = (c.webhookActivity ?? []).slice(0, limit);
      }
      return base;
    }),
  };
}

function encodeCreativeCursor(offset: number): string {
  return encodeOffsetCursor('creatives', offset);
}

function decodeCreativeCursor(cursor: string | undefined): number | null {
  return decodeOffsetCursor('creatives', cursor);
}

// Transformer list + per-param option cursors get their own kinds so a cursor
// minted by one endpoint can't be replayed onto another (the kind prefix is
// the cross-endpoint guard — see pagination.ts).
function encodeTransformerCursor(offset: number): string {
  return encodeOffsetCursor('transformers', offset);
}
function decodeTransformerCursor(cursor: string | undefined): number | null {
  return decodeOffsetCursor('transformers', cursor);
}
function encodeTransformerOptionCursor(offset: number): string {
  return encodeOffsetCursor('transformer_options', offset);
}
function decodeTransformerOptionCursor(cursor: string | undefined): number | null {
  return decodeOffsetCursor('transformer_options', cursor);
}

/** Sandbox rate card: returns CPM pricing based on account and creative format. */
function getCreativePricing(account: { account_id?: string }, creative: import('./types.js').CreativeState) {
  // Two sandbox rate cards: "premium" accounts get lower CPM
  const isPremium = account.account_id?.includes('premium');
  const pricingIdentity = creative.formatKind ?? creative.formatId?.id ?? 'creative';
  const isVideo = pricingIdentity.includes('video') || pricingIdentity.includes('vast');
  const cpm = isPremium
    ? (isVideo ? 0.25 : 0.10)
    : (isVideo ? 0.50 : 0.20);
  const pricingOptionId = `po_${pricingIdentity}_cpm`;
  return {
    pricing_option_id: pricingOptionId,
    model: 'cpm',
    cpm,
    currency: 'USD',
  };
}

export async function handleUpdateMediaBuy(args: ToolArgs, ctx: TrainingContext): Promise<Record<string, unknown>> {
  const req = args as unknown as UpdateMediaBuyArgs;
  const session = await getSession(
    sessionKeyFromArgs(req, ctx.mode, ctx.userId, ctx.moduleId),
    controllerFixtureSessionKey(req as unknown as ToolArgs, ctx),
  );
  const mediaBuyId = req.media_buy_id || '';
  const mb = session.mediaBuys.get(mediaBuyId);

  if (!mb) {
    return { errors: [{ code: 'MEDIA_BUY_NOT_FOUND', message: `Media buy not found: ${mediaBuyId}` }] };
  }

  // Terminal state check. Double-cancel returns NOT_CANCELLABLE —
  // media_buy_seller/invalid_transitions pins this error code explicitly.
  const currentStatus = deriveStatus(mb, session);
  if (['canceled', 'rejected', 'completed'].includes(currentStatus)) {
    const isRecancel = req.canceled === true && currentStatus === 'canceled';
    const code = isRecancel ? 'NOT_CANCELLABLE' : 'INVALID_STATE';
    const message = isRecancel
      ? `Media buy is already canceled and cannot be canceled again`
      : `Media buy is ${currentStatus} and cannot be updated`;
    return { errors: [{ code, message }] };
  }

  const productMap = new Map(getCatalog().map(cp => [cp.product.product_id, cp.product]));
  overlaySeededProducts(session, productMap);

  const actionRejection = rejectUnavailableAction(mb, req, currentStatus, productMap);
  if (actionRejection) return actionRejection;

  const pausedValue = req.paused;
  if (pausedValue === true && !NON_TERMINAL_MEDIA_BUY_STATUSES.has(currentStatus)) {
    return {
      errors: [{ code: 'INVALID_STATE', message: `Cannot pause media buy in ${currentStatus} state` }] as TaskError[],
      ...(req.context !== undefined && { context: req.context }),
    };
  }
  if (pausedValue === false && mb.status !== 'paused') {
    return {
      errors: [{ code: 'INVALID_STATE', message: `Cannot resume media buy in ${currentStatus} state` }] as TaskError[],
      ...(req.context !== undefined && { context: req.context }),
    };
  }

  // Revision check for optimistic concurrency
  const reqRevision = req.revision;
  if (reqRevision !== undefined && reqRevision !== mb.revision) {
    return { errors: [{ code: 'CONFLICT', message: `Revision mismatch: expected ${mb.revision}, got ${reqRevision}` }] };
  }

  // Compute the monetary delta from the seller's authoritative pre-update
  // revision, then enforce the buyer intent's signed ceiling before mutating
  // any state. The buyer's post-update totals are never trusted as the delta.
  const submittedBudgets = [
    ...(req.packages ?? []).flatMap(update => update.budget === undefined ? [] : [update.budget]),
    ...(req.new_packages ?? []).map(pkg => pkg.budget),
  ];
  if (submittedBudgets.some(budget => !Number.isFinite(budget) || budget < 0)) {
    return { errors: [{ code: 'VALIDATION_ERROR', message: 'Package budgets must be finite, non-negative numbers.' }] };
  }
  const aggregateUpdate = aggregateMediaBuyUpdate(req);
  if (aggregateUpdate.total_budget && (
    !Number.isFinite(aggregateUpdate.total_budget.amount)
    || aggregateUpdate.total_budget.amount < 0
    || aggregateUpdate.total_budget.currency !== mb.currency
  )) {
    return {
      errors: [{
        code: 'VALIDATION_ERROR',
        message: `total_budget must be finite, non-negative, and denominated in ${mb.currency}.`,
      }],
    };
  }
  const resultingAllocation = aggregateUpdate.budget_allocation ?? mb.budgetAllocation;
  const sellerOptimized = resultingAllocation?.mode === 'seller_optimized';
  const fixedRedistribution = aggregateUpdate.total_budget && !sellerOptimized && req.packages === undefined && req.new_packages === undefined
    ? proportionalFixedPackageBudgets(mb, aggregateUpdate.total_budget.amount)
    : undefined;
  if (fixedRedistribution?.error) {
    return { errors: [fixedRedistribution.error] };
  }
  if (
    aggregateUpdate.total_budget
    && !sellerOptimized
    && (req.packages !== undefined || req.new_packages !== undefined)
    && aggregateUpdate.total_budget.amount !== projectedPackageBudgetTotal(mb, req)
  ) {
    return {
      errors: [{
        code: 'VALIDATION_ERROR',
        message: 'In fixed allocation mode, total_budget.amount must equal the resulting package budget sum.',
      }],
    };
  }
  const updateDelta = positiveMediaBuyUpdateDelta(mb, req);
  if (!Number.isFinite(updateDelta)) {
    return { errors: [{ code: 'VALIDATION_ERROR', message: 'Package budgets must be finite numbers.' }] };
  }
  const rawGovernanceContext = (req as unknown as Record<string, unknown>).governance_context;
  const updateGovernanceContext = typeof rawGovernanceContext === 'string' && rawGovernanceContext
    ? rawGovernanceContext
    : undefined;
  const requiresGovernance = mediaBuyUpdateRequiresGovernance(mb, req, updateDelta);
  const updateGovernanceAgents = resolveGovernanceAgentsForAccount(
    sessionKeyFromArgs(req, ctx.mode, ctx.userId, ctx.moduleId),
    ctx.principal,
    mb.accountRef,
  );
  if (updateGovernanceContext) {
    const commitmentError = await governedCommitmentError(
      updateGovernanceContext,
      ctx.authenticatedAgentUrl,
      'update_media_buy',
      `${getCanonicalBase()}/sales`,
      governedRequestPayload(ctx, req as unknown as Record<string, unknown>),
      updateDelta,
      mb.currency,
    );
    if (commitmentError) return { errors: [commitmentError] };
  } else if (requiresGovernance && (session.governancePlans.size > 0 || updateGovernanceAgents.length > 0)) {
    return {
      errors: [{
        code: 'GOVERNANCE_DENIED',
        message: 'This media-buy update increases or widens the governed obligation. Call check_governance and provide governance_context.',
      }] as TaskError[],
    };
  }

  const now = new Date().toISOString();
  const affectedPackageIds = new Set<string>();

  // Increment revision once before mutations
  mb.revision += 1;

  // Media buy cancellation
  const isCanceled = req.canceled === true;
  if (isCanceled) {
    const reason = req.cancellation_reason;
    mb.canceledAt = now;
    mb.canceledBy = 'buyer';
    mb.cancellationReason = reason;
    mb.history.push({ revision: mb.revision, timestamp: now, actor: 'buyer', action: 'canceled', summary: reason || 'Media buy canceled by buyer' });
    mb.updatedAt = now;

    const status = deriveStatus(mb, session);
    // `media_buy_status` is the canonical 3.1 body field (#4895); legacy
    // body `status: MediaBuyStatus` removed in 3.2 (#4906).
    return {
      media_buy_id: mb.mediaBuyId,
      ...(req.idempotency_key && { idempotency_key: req.idempotency_key }),
      status,
      media_buy_status: status,
      revision: mb.revision,
      valid_actions: validActionsForMediaBuy(mb, status),
      available_actions: availableActionsForMediaBuy(mb, status),
      cancellation: { canceled_at: mb.canceledAt, canceled_by: mb.canceledBy, reason: mb.cancellationReason },
      ...(req.context !== undefined && { context: req.context }),
    };
  }

  // Pause/resume at media buy level
  if (pausedValue === true) {
    mb.status = 'paused';
    mb.history.push({ revision: mb.revision, timestamp: now, actor: 'buyer', action: 'paused', summary: 'Media buy paused' });
  } else if (pausedValue === false && mb.status === 'paused') {
    mb.status = 'active';
    mb.history.push({ revision: mb.revision, timestamp: now, actor: 'buyer', action: 'resumed', summary: 'Media buy resumed' });
  }

  // Update end_time with validation
  if (req.end_time) {
    if (isNaN(new Date(req.end_time).getTime())) {
      return { errors: [{ code: 'VALIDATION_ERROR', message: `Invalid end_time: "${req.end_time}". Use ISO 8601 format.` }] };
    }
    const oldEnd = mb.endTime;
    mb.endTime = req.end_time;
    mb.history.push({ revision: mb.revision, timestamp: now, actor: 'buyer', action: 'end_time_updated', summary: `End time changed from ${oldEnd} to ${req.end_time}` });
  }

  // Update packages
  const warnings: string[] = [];
  if (req.packages?.length) {
    const knownPkgIds = new Set(mb.packages.map(p => p.packageId));

    // Pre-validate all creative_assignments across every package before
    // mutating anything, so a bad creative_id in pkg[N] doesn't leave
    // pkg[0..N-1] with partially-applied assignments.
    for (const update of req.packages as PackageUpdateExt[]) {
      const assignments = (update as PackageUpdate & { creative_assignments?: Array<{ creative_id: string }> }).creative_assignments;
      const inlineCreatives = collectInlineCreativeIds(update.creatives, `packages[${update.package_id || '?'}].creatives`);
      if (inlineCreatives.errors.length) {
        return { errors: inlineCreatives.errors };
      }
      if (assignments === undefined) continue;
      const pkgId = update.package_id || '';
      if (assignments.length === 0) {
        const currentStatus = deriveStatus(mb, session);
        if (['active', 'paused', 'pending_start'].includes(currentStatus)) {
          return {
            errors: [{ code: 'VALIDATION_ERROR', message: `creative_assignments cannot be cleared on a buy in "${currentStatus}" status`, field: `packages[${pkgId}].creative_assignments` }] as TaskError[],
          };
        }
      }
      for (const assignment of assignments) {
        const cid = assignment.creative_id;
        if (!cid) {
          return { errors: [{ code: 'VALIDATION_ERROR', message: `creative_assignments[].creative_id is required for package ${pkgId}`, field: `packages[${pkgId}].creative_assignments` }] };
        }
        if (!session.creatives.has(cid)) {
          return { errors: [{ code: 'CREATIVE_NOT_FOUND', message: `Creative not found: ${cid}. Sync the creative via sync_creatives before assigning.`, field: `packages[${pkgId}].creative_assignments` }] };
        }
      }
    }

    for (const update of req.packages as PackageUpdateExt[]) {
      const pkgId = update.package_id || '';
      const pkg = mb.packages.find(p => p.packageId === pkgId);
      if (!pkg) {
        return { errors: [{ code: 'PACKAGE_NOT_FOUND', message: `Package not found: ${pkgId}. Known packages: ${[...knownPkgIds].join(', ')}` }] };
      }

      // Package cancellation
      if ((update as PackageUpdateExt).canceled === true) {
        pkg.canceled = true;
        pkg.canceledAt = now;
        pkg.canceledBy = 'buyer';
        pkg.cancellationReason = (update as PackageUpdateExt).cancellation_reason;
        affectedPackageIds.add(pkgId);
        mb.history.push({ revision: mb.revision, timestamp: now, actor: 'buyer', action: 'package_canceled', summary: `Package ${pkgId} canceled`, packageId: pkgId });
        continue;
      }

      // Package pause/resume
      if (update.paused !== undefined && update.paused !== pkg.paused) {
        pkg.paused = update.paused;
        affectedPackageIds.add(pkgId);
        const action = update.paused ? 'package_paused' : 'package_resumed';
        mb.history.push({ revision: mb.revision, timestamp: now, actor: 'buyer', action, summary: `Package ${pkgId} ${update.paused ? 'paused' : 'resumed'}`, packageId: pkgId });
      }

      if (update.budget !== undefined) {
        if (update.budget < 0) {
          return { errors: [{ code: 'VALIDATION_ERROR', message: `Negative budget rejected for package ${pkgId}. Budget must be non-negative.` }] };
        }
        const oldBudget = pkg.budget;
        pkg.budget = update.budget;
        affectedPackageIds.add(pkgId);
        mb.history.push({ revision: mb.revision, timestamp: now, actor: 'buyer', action: 'budget_updated', summary: `Package ${pkgId} budget changed from ${oldBudget} to ${update.budget}`, packageId: pkgId });
      }

      if (update.end_time) {
        if (isNaN(new Date(update.end_time).getTime())) {
          warnings.push(`Invalid end_time for package ${pkgId}: "${update.end_time}". Skipped.`);
        } else {
          pkg.endTime = update.end_time;
          affectedPackageIds.add(pkgId);
        }
      }

      const updateTargeting = update.targeting_overlay ?? update.targeting;
      if (updateTargeting !== undefined) {
        const targetingResult = validateTargeting(updateTargeting, `packages[${pkgId}].targeting_overlay`);
        if (targetingResult.errors.length) {
          return { errors: targetingResult.errors };
        }
        const before = pkg.targeting;
        pkg.targeting = targetingResult.targeting;
        const changed = JSON.stringify(before ?? null) !== JSON.stringify(pkg.targeting ?? null);
        if (changed) {
          affectedPackageIds.add(pkgId);
          const action = pkg.targeting ? 'targeting_updated' : 'targeting_cleared';
          const summary = pkg.targeting ? `Package ${pkgId} targeting updated` : `Package ${pkgId} targeting cleared`;
          mb.history.push({ revision: mb.revision, timestamp: now, actor: 'buyer', action, summary, packageId: pkgId });
        }
      }

      // Replacement semantics: the provided array replaces pkg.creativeAssignments
      // entirely. Empty arrays are rejected in the pre-pass for active/paused/pending_start buys;
      // validity of creative_ids was also checked in the pre-pass.
      const creativeAssignments = (update as PackageUpdate & { creative_assignments?: Array<{ creative_id: string }> }).creative_assignments;
      if (creativeAssignments !== undefined) {
        const creativeIds = creativeAssignments.map(a => a.creative_id);
        pkg.creativeAssignments = creativeIds;
        affectedPackageIds.add(pkgId);
        mb.history.push({ revision: mb.revision, timestamp: now, actor: 'buyer', action: 'creative_assignments_updated', summary: `Package ${pkgId} creative assignments replaced (${creativeIds.length} creatives)`, packageId: pkgId });
      }
      if (update.creatives !== undefined) {
        const inlineCreatives = collectInlineCreativeIds(update.creatives, `packages[${pkgId}].creatives`);
        const creativeIds = inlineCreatives.creativeIds;
        persistInlineCreatives(
          session,
          inlineCreatives.validatedCreatives,
          req.account as AccountRef | undefined,
          resolveAccountIdForRef(sessionKeyFromArgs(req, ctx.mode, ctx.userId, ctx.moduleId), ctx.principal, req.account),
          now,
        );
        pkg.creativeAssignments = creativeIds;
        affectedPackageIds.add(pkgId);
        mb.history.push({ revision: mb.revision, timestamp: now, actor: 'buyer', action: 'inline_creatives_updated', summary: `Package ${pkgId} inline creatives replaced (${creativeIds.length} creatives)`, packageId: pkgId });
      }
    }

    // Recompute open impairments when package dependencies change. Creative
    // bindings use creativeAssignments; audience bindings use the targeting
    // overlay include/exclude arrays.
    if (mb.impairments?.length) {
      const stillReferenced = new Set<string>();
      const stillReferencedAudiences = new Set<string>();
      for (const pkg of mb.packages) {
        for (const cid of pkg.creativeAssignments) stillReferenced.add(cid);
        for (const audienceId of pkg.targeting?.audience_include ?? []) stillReferencedAudiences.add(audienceId);
        for (const audienceId of pkg.targeting?.audience_exclude ?? []) stillReferencedAudiences.add(audienceId);
      }
      const before = mb.impairments.length;
      mb.impairments = mb.impairments.filter(
        i => (i.resourceType !== 'creative' || stillReferenced.has(i.resourceId))
          && (i.resourceType !== 'audience' || stillReferencedAudiences.has(i.resourceId)),
      );
      if (mb.impairments.length !== before) {
        mb.updatedAt = now;
      }
    }
  }

  // Add new packages
  const newPackages = req.new_packages;
  if (newPackages?.length) {
    const productFormatOptionIndexes: ProductFormatOptionIndexCache = new WeakMap();
    if (mb.packages.length + newPackages.length > MAX_PACKAGES_PER_BUY) {
      return {
        errors: [{ code: 'LIMIT_EXCEEDED', message: `Adding ${newPackages.length} packages would exceed the per-buy limit of ${MAX_PACKAGES_PER_BUY}.` }] as TaskError[],
      };
    }
    for (let i = 0; i < newPackages.length; i++) {
      const npkg = newPackages[i];
      const productId = npkg.product_id;
      const product = productMap.get(productId);
      if (!product) {
        return { errors: [{ code: 'PACKAGE_NOT_FOUND', message: `Product not found for new package: ${productId}` }] };
      }
      const selectorCompatibilityError = validatePackageSelectorCompatibility(
        npkg,
        product,
        i,
        productFormatOptionIndexes,
      );
      if (selectorCompatibilityError) return { errors: [selectorCompatibilityError] };
      const formatSnapshot = snapshotPackageFormats(npkg, product, i, productFormatOptionIndexes);
      if (formatSnapshot.error) return { errors: [formatSnapshot.error] };
      const formatSelector = packageFormatSelectorForState(
        npkg,
        formatSnapshot.formats,
        formatSnapshot.legacyFormatIds,
        formatSnapshot.selectedLegacyFormatIds,
      );

      const pkgId = `pkg-${mb.packages.length + i}`;
      const newTargeting = npkg.targeting_overlay ?? npkg.targeting;
      const targetingResult = validateTargeting(newTargeting, `new_packages[${i}].targeting_overlay`);
      if (targetingResult.errors.length) {
        return { errors: targetingResult.errors };
      }
      const newPkg: PackageState = {
        packageId: pkgId,
        productId,
        budget: npkg.budget,
        pricingOptionId: npkg.pricing_option_id,
        bidPrice: npkg.bid_price,
        impressions: npkg.impressions,
        paused: npkg.paused || false,
        startTime: npkg.start_time || mb.startTime,
        endTime: npkg.end_time || mb.endTime,
        ...formatSelector,
        params: npkg.params,
        ...(!isThreeZeroStoryboardCompat(ctx) && formatSnapshot.formats?.length && {
          formatsToProvide: formatSnapshot.formats,
        }),
        creativeAssignments: [],
        targeting: targetingResult.targeting,
      };
      mb.packages.push(newPkg);
      affectedPackageIds.add(pkgId);
      mb.history.push({ revision: mb.revision, timestamp: now, actor: 'buyer', action: 'package_added', summary: `New package ${pkgId} added (product: ${productId})`, packageId: pkgId });
    }
    const updatedAllowedActions = deriveProductAllowedActionsForPackages(mb.packages, productMap);
    if (updatedAllowedActions) {
      mb.productAllowedActions = updatedAllowedActions;
    } else {
      delete mb.productAllowedActions;
    }
  }

  const packageBudgetChanged = Boolean(
    req.packages?.some(update => update.budget !== undefined || (update as PackageUpdateExt).canceled === true)
    || req.new_packages?.length,
  );
  if (aggregateUpdate.total_budget) {
    if (fixedRedistribution?.budgets) {
      for (const pkg of mb.packages) {
        const nextBudget = fixedRedistribution.budgets.get(pkg.packageId);
        if (nextBudget === undefined) continue;
        const oldBudget = pkg.budget;
        pkg.budget = nextBudget;
        affectedPackageIds.add(pkg.packageId);
        mb.history.push({
          revision: mb.revision,
          timestamp: now,
          actor: 'buyer',
          action: 'budget_updated',
          summary: `Package ${pkg.packageId} budget proportionally changed from ${oldBudget} to ${nextBudget}`,
          packageId: pkg.packageId,
        });
      }
    }
    mb.totalBudget = aggregateUpdate.total_budget.amount;
  } else if (
    !sellerOptimized
    && (packageBudgetChanged || aggregateUpdate.budget_allocation !== undefined)
  ) {
    mb.totalBudget = mb.packages.reduce(
      (sum, pkg) => sum + (pkg.canceled ? 0 : pkg.budget || 0),
      0,
    );
  }
  if (aggregateUpdate.budget_allocation !== undefined) {
    mb.budgetAllocation = structuredClone(aggregateUpdate.budget_allocation);
  }
  if (aggregateUpdate.pacing !== undefined) mb.aggregatePacing = aggregateUpdate.pacing;
  if (aggregateUpdate.bidding === null) delete mb.aggregateBidding;
  else if (aggregateUpdate.bidding !== undefined) {
    mb.aggregateBidding = structuredClone(aggregateUpdate.bidding);
  }

  mb.updatedAt = now;

  const status = deriveStatus(mb, session);
  const updatedPackages = mb.packages.map(pkg => ({
    package_id: pkg.packageId,
    product_id: pkg.productId,
    budget: pkg.budget,
    pricing_option_id: pkg.pricingOptionId,
    paused: pkg.paused,
    start_time: pkg.startTime,
    end_time: pkg.endTime,
    ...packageFormatSelectorForWire(pkg, ctx),
    ...packageReadinessFields(pkg, session),
    ...(pkg.targeting && { targeting_overlay: targetingForWire(pkg.targeting) }),
    ...(pkg.context && { context: pkg.context }),
    ...(pkg.committedMetrics && { committed_metrics: pkg.committedMetrics }),
    creative_assignments: pkg.creativeAssignments.map(creativeId => ({ creative_id: creativeId })),
    ...(pkg.canceledAt && {
      cancellation: { canceled_at: pkg.canceledAt, canceled_by: pkg.canceledBy, reason: pkg.cancellationReason },
    }),
  }));
  const affectedPackages = updatedPackages.filter(pkg => affectedPackageIds.has(pkg.package_id));
  // `media_buy_status` is the canonical 3.1 body field (#4895); legacy
  // body `status: MediaBuyStatus` removed in 3.2 (#4906).
  const result = {
    media_buy_id: mb.mediaBuyId,
    ...(req.idempotency_key && { idempotency_key: req.idempotency_key }),
    status,
    media_buy_status: status,
    revision: mb.revision,
    valid_actions: validActionsForMediaBuy(mb, status),
    available_actions: availableActionsForMediaBuy(mb, status),
    ...((aggregateUpdate.total_budget !== undefined || packageBudgetChanged) && {
      currency: mb.currency,
      total_budget: mb.totalBudget,
    }),
    ...(aggregateUpdate.budget_allocation !== undefined && mb.budgetAllocation
      ? { budget_allocation: mb.budgetAllocation }
      : {}),
    ...(aggregateUpdate.pacing !== undefined && mb.aggregatePacing
      ? { pacing: mb.aggregatePacing }
      : {}),
    ...(aggregateUpdate.bidding !== undefined && mb.aggregateBidding
      ? { bidding: mb.aggregateBidding }
      : {}),
    ...(mb.canceledAt && {
      cancellation: { canceled_at: mb.canceledAt, canceled_by: mb.canceledBy, reason: mb.cancellationReason },
    }),
    affected_packages: affectedPackages,
    packages: updatedPackages,
    ...(warnings.length > 0 && { warnings }),
    ...(req.context !== undefined && { context: req.context }),
  };
  return result;
}

export async function handleGetAdcpCapabilities(args: ToolArgs, ctx: TrainingContext): Promise<Record<string, unknown>> {
  const versionResolution = resolveServedAdcpVersion(args as unknown as Record<string, unknown>);
  const servedAdcpVersion = versionResolution.ok ? versionResolution.servedVersion : DEFAULT_ADCP_VERSION;
  const tasks = visibleToolsForContext(ctx)
    .filter(tool => toolAvailableForServedAdcpVersion(tool.name, servedAdcpVersion))
    .map(t => t.name)
    .filter(name => name !== 'get_adcp_capabilities');
  const channels = [...new Set(PUBLISHERS.flatMap(p => p.channels))].sort();
  const publisherDomains = PUBLISHERS.map(p => p.domain);
  const signingCap = selectSigningCapability(ctx);
  // Wire shape splits the SDK's flat `required_for` / `supported_for` lists
  // back into the two namespaces defined in the spec (adcp#4318):
  //   - `required_for` / `supported_for`: AdCP tool names (no `/`)
  //   - `protocol_methods_*`: JSON-RPC method names (e.g. `tasks/cancel`)
  // The internal verifier capability merges both for by-string matching;
  // the wire response separates them so verifiers and storyboard runners
  // don't conflate the two namespaces.
  //
  // The `/` test is the structural inverse of the schema's
  // `pattern: "^[a-z][a-z0-9_]*/[a-z][a-z0-9_]*$"` constraint on
  // `protocol_methods_*` items in `static/schemas/source/protocol/get-adcp-capabilities-response.json`.
  // AdCP tool names are snake_case and have never contained `/`; this filter
  // is correct as long as that invariant holds.
  const isProtocolMethod = (op: string): boolean => op.includes('/');
  const requiredFor = signingCap.required_for.filter(op => !isProtocolMethod(op));
  const supportedFor = signingCap.supported_for?.filter(op => !isProtocolMethod(op));
  const protocolMethodsRequiredFor = signingCap.required_for.filter(isProtocolMethod);
  const protocolMethodsSupportedFor = signingCap.supported_for?.filter(isProtocolMethod) ?? [];
  const wholesaleProfile = wholesaleCapabilityProfile(ctx);
  const complianceScenarios = [
    'force_creative_status',
    'force_audience_status',
    'force_account_status',
    'force_media_buy_status',
    'force_create_media_buy_arm',
    'force_task_completion',
    ...(!isThreeZeroStoryboardCompat(ctx) ? ['force_creative_purge'] : []),
    'force_session_status',
    'simulate_delivery',
    'simulate_budget_spend',
    'seed_account',
    'seed_product',
    'seed_pricing_option',
    'seed_creative',
    'seed_plan',
    'seed_media_buy',
    'seed_creative_format',
    'seed_measurement_catalog',
    ...(!isThreeZeroStoryboardCompat(ctx) ? ['query_provenance_audit_observations'] : []),
  ];
  const governanceEnforcementTasks = ctx.tenantId === 'sales'
    ? [{ task: 'create_media_buy', modes: ['signed_context'] }]
    : ctx.tenantId === 'signals'
      ? [{ task: 'activate_signal', modes: ['signed_context'] }]
      : ctx.tenantId === 'brand'
        ? [{ task: 'acquire_rights', modes: ['signed_context'] }]
        : ctx.tenantId === 'creative' || ctx.tenantId === 'creative-builder'
          ? [{ task: 'build_creative', modes: ['signed_context'] }]
          : [];
  const experimentalFeatures = [
    ...((governanceEnforcementTasks.length > 0 || ctx.tenantId === 'governance')
      ? ['governance.campaign']
      : []),
    ...((ctx.tenantId === 'sales' || ctx.tenantId == null) ? ['measurement.core'] : []),
  ];
  return {
    adcp_version: DEFAULT_ADCP_VERSION,
    adcp: {
      major_versions: [...SUPPORTED_MAJOR_VERSIONS],
      supported_versions: [...SUPPORTED_RELEASE_VERSIONS],
      idempotency: { supported: true, replay_ttl_seconds: 86400 },
      ...(governanceEnforcementTasks.length > 0 && {
        governance_enforcement: { tasks: governanceEnforcementTasks },
      }),
    },
    supported_protocols: ['media_buy', 'creative', 'governance', 'signals', 'brand'],
    ...(experimentalFeatures.length > 0 && { experimental_features: experimentalFeatures }),
    specialisms: [],
    request_signing: {
      supported: signingCap.supported,
      covers_content_digest: signingCap.covers_content_digest,
      required_for: requiredFor,
      ...(supportedFor && { supported_for: supportedFor }),
      ...(protocolMethodsRequiredFor.length > 0 && { protocol_methods_required_for: protocolMethodsRequiredFor }),
      ...(protocolMethodsSupportedFor.length > 0 && { protocol_methods_supported_for: protocolMethodsSupportedFor }),
    },
    protocol_version: '3.0',
    tasks,
    ...((wholesaleProfile.productWholesale || wholesaleProfile.signalWholesale) && {
      wholesale_feed_versioning: {
        supported: true,
        pricing_version_separate: true,
        cache_scope_account: true,
      },
      wholesale_feed_webhooks: {
        supported: true,
        event_types: wholesaleProfile.eventTypes,
      },
      webhook_signing: {
        supported: true,
        profile: 'adcp/webhook-signing/v1',
        algorithms: ['ed25519'],
        legacy_hmac_fallback: true,
      },
      identity: {
        brand_json_url: `${getAgentUrl()}/.well-known/brand.json`,
      },
    }),
    media_buy: {
      buying_modes: wholesaleProfile.productWholesale ? ['brief', 'wholesale', 'refine'] : ['brief', 'refine'],
      ...(supportsGetProductsRejected(servedAdcpVersion) && {
        lifecycle_tools: [...PRODUCT_DISCOVERY_TOOLS],
        proposal_refinement: proposalCapabilitiesForProfile(ctx.proposalNegotiationProfile),
      }),
      supports_proposals: true,
      performance_feedback: {
        reports_application_status: true,
      },
      features: {
        inline_creative_management: true,
        catalog_management: true,
      },
      portfolio: {
        publisher_domains: publisherDomains,
        primary_channels: channels,
      },
      content_standards: {
        supports_local_evaluation: true,
        supported_channels: channels,
        supports_webhook_delivery: false,
      },
      audience_targeting: {
        supported_identifier_types: ['hashed_email'],
        minimum_audience_size: 100,
      },
      conversion_tracking: {
        supported_event_types: ['purchase', 'add_to_cart', 'lead', 'page_view'],
        supported_hashed_identifiers: ['hashed_email'],
        supported_action_sources: ['website', 'app'],
      },
      vendor_metric_optimization: {
        supported_targets: ['threshold_rate'],
      },
      // Seller-level rollup of metric-optimization capabilities. Honest
      // union across catalog products (product-factory.ts assigns these
      // by channel mix). Gate scenarios — clicks_buy_flow / reach_buy_flow
      // / completed_views_buy_flow — read this field and grade
      // not_applicable when missing. adcp-client#1818 will auto-derive
      // from product-level metric_optimization.supported_metrics once
      // the SDK ships the seller-level field; until then this is a
      // manual declaration.
      supported_optimization_metrics: ['clicks', 'views', 'completed_views', 'engagements', 'reach'],
      execution: {
        targeting: {
          geo_countries: true,
          geo_regions: true,
          geo_metros: { nielsen_dma: true },
          geo_postal_areas: { us_zip: true },
          language: true,
          keyword_targets: { supported_match_types: ['broad', 'phrase', 'exact'] },
          negative_keywords: { supported_match_types: ['broad', 'phrase', 'exact'] },
        },
      },
    },
    creative: {
      supports_generation: true,
      supports_transformation: true,
      supports_compliance: false,
      has_creative_library: true,
      ...(includeThreeOneFields(ctx) ? {
        bills_through_adcp: creativeBillsThroughAdcp(ctx),
        supported_formats: supportedCanonicalFormatsCapability(),
        preview: {
          routes: SUPPORTED_CANONICAL_BUILD_CAPABILITIES.map(capability => ({
            capability_id: capability.capabilityId,
            rendering_origin: 'agent_approximation',
          })),
        },
        canonical_catalog_version: '3.2',
        supports_transformers: true,
        supports_refinement: true,
        refinable_retention_seconds: 3600,
        multiplicity: {
          supports_catalog_fanout: false,
          supports_variants: true,
          max_variants_limit: TRANSFORMER_MAX_VARIANTS_LIMIT,
          variant_dimensions: ['voice', 'theme', 'best_of_n', 'transformer_config', 'custom'],
        },
      } : {}),
    },
    account: {
      require_operator_auth: false,
      required_for_products: false,
      // Single source of truth — the gate at account-handlers.ts
      // imports the same constant. Spread so the typed `as const` tuple
      // becomes a regular string array that the JSON-Schema
      // validator on the capabilities response accepts.
      supported_billing: [...SUPPORTED_BILLINGS],
      supported_account_currency_modes: ['fixed', 'per_media_buy'],
      sandbox: true,
    },
    ...(wholesaleProfile.signalWholesale && {
      signals: {
        discovery_modes: ['brief', 'wholesale'],
        features: {
          catalog_signals: true,
        },
      },
    }),
    compliance_testing: {
      scenarios: complianceScenarios,
    },
    agent: {
      name: 'AdCP Training Agent',
      description: 'Training agent for AdCP protocol testing and certification',
    },
  };
}

// ── Signal task handlers ──────────────────────────────────────────

const MAX_SIGNAL_RESULTS = 10;

export async function handleGetSignals(args: ToolArgs, ctx: TrainingContext) {
  const req = args as unknown as GetSignalsRequest & ToolArgs & {
    brief?: string;
    discovery_mode?: 'brief' | 'wholesale';
    if_wholesale_feed_version?: string;
    if_pricing_version?: string;
    pagination?: { max_results?: number; cursor?: string };
  };
  // Accept both signal_spec (protocol) and brief (SDK test tool)
  const rawSpec = req.signal_spec || req.brief;
  const hasWholesaleRunnerFallbackSpec =
    req.discovery_mode === 'wholesale'
    && req.signal_spec === SDK_STORYBOARD_FALLBACK_SIGNAL_SPEC
    && req.brief === undefined;
  const signalSpec = req.discovery_mode === 'wholesale'
    ? undefined
    : typeof rawSpec === 'string'
      ? rawSpec
      : undefined;
  const signalRefs = (req as GetSignalsRequest & { signal_refs?: Array<Record<string, unknown>> }).signal_refs;
  if (req.discovery_mode !== 'wholesale' && req.if_wholesale_feed_version !== undefined) {
    return {
      errors: [{
        code: 'INVALID_REQUEST',
        message: 'if_wholesale_feed_version is only valid with discovery_mode "wholesale".',
        field: 'if_wholesale_feed_version',
        recovery: 'correctable',
      }] as TaskError[],
    };
  }
  if (req.if_pricing_version !== undefined) {
    if (req.discovery_mode !== 'wholesale') {
      return {
        errors: [{
          code: 'INVALID_REQUEST',
          message: 'if_pricing_version is only valid with discovery_mode "wholesale".',
          field: 'if_pricing_version',
          recovery: 'correctable',
        }] as TaskError[],
      };
    }
    if (req.if_wholesale_feed_version === undefined) {
      return {
        errors: [{
          code: 'INVALID_REQUEST',
          message: 'if_pricing_version requires if_wholesale_feed_version.',
          field: 'if_pricing_version',
          recovery: 'correctable',
        }] as TaskError[],
      };
    }
  }
  if (
    req.discovery_mode === 'wholesale'
    && (
	      (req.signal_spec !== undefined && !hasWholesaleRunnerFallbackSpec)
	      || req.brief !== undefined
	      || (Array.isArray(req.signal_ids) && req.signal_ids.length > 0)
      || (Array.isArray(signalRefs) && signalRefs.length > 0)
    )
  ) {
    const field = req.signal_spec !== undefined && !hasWholesaleRunnerFallbackSpec
      ? 'signal_spec'
      : req.brief !== undefined
        ? 'brief'
        : Array.isArray(signalRefs) && signalRefs.length > 0
          ? 'signal_refs'
          : 'signal_ids';
    return {
      errors: [{
        code: 'INVALID_REQUEST',
        message: 'signal_spec, brief, signal_refs, and signal_ids must not be provided when discovery_mode is "wholesale".',
        field,
        recovery: 'correctable',
      }] as TaskError[],
    };
  }
  // Pagination shape (pagination.max_results, schema cap 100) takes precedence
  // over the legacy top-level `max_results` (no schema cap; this handler
  // historically capped at 50 to keep semantic-search results focused). The two
  // forms have different caps because they have different contracts —
  // pagination.max_results is the standard envelope and matches the schema's
  // documented 100 cap; top-level max_results is the predecessor and we
  // preserve its tighter behavioral cap to avoid silently widening any caller
  // currently relying on the 50 ceiling. Spec ambiguity on which form wins
  // when both are present is tracked at adcontextprotocol/adcp#3113.
  let maxResults: number;
  const paginationMax = req.pagination?.max_results;
  if (typeof paginationMax === 'number' && paginationMax >= 1) {
    maxResults = Math.min(paginationMax, 100);
  } else if (typeof req.max_results === 'number' && req.max_results >= 1) {
    maxResults = Math.min(req.max_results, 50);
  } else {
    maxResults = MAX_SIGNAL_RESULTS;
  }
  const offset = decodeOffsetCursor('signals', req.pagination?.cursor);
  if (offset === null) {
    return {
      errors: [{ code: 'INVALID_REQUEST', message: 'pagination.cursor is malformed' }] as TaskError[],
    };
  }
  const session = await getSession(sessionKeyFromArgs(req, ctx.mode, ctx.userId, ctx.moduleId));
  const wholesaleMeta = req.discovery_mode === 'wholesale'
    ? signalWholesaleFeedMeta(req as WholesaleFeedRequest)
    : undefined;

  if (wholesaleMeta && wholesaleFeedUnchanged(req as WholesaleFeedRequest, wholesaleMeta)) {
    return {
      unchanged: true,
      ...wholesaleMeta,
    };
  }

  const allSignals = getAllSignals();
  let results = allSignals;
  const agentUrl = getAgentUrl();

  // Exact lookup by signal_refs or legacy signal_ids.
  if (req.signal_ids?.length || signalRefs?.length) {
    const idSet = new Set(req.signal_ids?.map(sid => sid.id) ?? []);
    results = results.filter(s =>
      idSet.has(s.signalAgentSegmentId)
      || signalRefs?.some(ref => signalMatchesRef(s, ref, agentUrl)),
    );
  }

  // Natural language search via signal_spec
  const rawTerms = signalSpec ? signalSpec.toLowerCase().split(/\s+/) : [];
  if (signalSpec) {
    const expanded = new Set<string>();
    for (const t of rawTerms) {
      expanded.add(t);
      const synonyms = SYNONYM_MAP[t];
      if (synonyms) {
        for (const s of synonyms) expanded.add(s);
      }
    }
    const terms = [...expanded];
    const scored = results
      .map(s => {
        const text = `${s.name} ${s.description} ${s.tags.join(' ')} ${s.providerName}`.toLowerCase();
        const matchCount = terms.filter(t => text.includes(t)).length;
        return { signal: s, matchCount };
      })
      .filter(s => s.matchCount > 0 || req.signal_ids?.length) // keep exact matches even without keyword hit
      .sort((a, b) => b.matchCount - a.matchCount);
    results = scored.map(s => s.signal);
  }

  // Apply filters
  if (req.filters) {
    const maxCpm = (req.filters as SignalFilters & { max_cpm?: number }).max_cpm;
    if (maxCpm !== undefined) {
      results = results.filter(s =>
        s.pricingOptions.some(po => po.model === 'cpm' && po.cpm !== undefined && po.cpm <= maxCpm),
      );
    }
    if (req.filters.data_providers?.length) {
      const providerSet = new Set(req.filters.data_providers.map(d => d.toLowerCase()));
      results = results.filter(s => providerSet.has(s.providerName.toLowerCase()));
    }
    if (req.filters.catalog_types?.length) {
      const catalogTypes = req.filters.catalog_types as string[];
      results = results.filter(s => catalogTypes.includes(s.signalType));
    }
  }

  // Slice to the requested page after filters/sorts have settled. Iteration
  // order is stable across calls within a session because getAllSignals()
  // returns the static catalog and SYNONYM_MAP scoring is deterministic.
  const totalMatching = results.length;
  const pageEnd = Math.min(offset + maxResults, totalMatching);
  results = results.slice(offset, pageEnd);
  const hasMore = pageEnd < totalMatching;

  // Build response signals with deployments
  const signals: SignalResponse[] = results.map(s => {
    // Check if this signal has been activated in this session
    const activationKey = `${s.signalAgentSegmentId}:${agentUrl}`;
    const activation = session.signalActivations.get(activationKey);
    const isLive = activation?.isLive ?? false;

    const deployment = {
      type: 'agent' as const,
      agent_url: agentUrl,
      is_live: isLive,
      ...(isLive ? {
        activation_key: {
          type: 'key_value' as const,
          key: 'audience_segment',
          value: s.signalAgentSegmentId,
        },
        deployed_at: activation?.activatedAt,
      } : {
        estimated_activation_duration_minutes: 0, // sandbox: instant
      }),
    };

    const signal = {
      signal_agent_segment_id: s.signalAgentSegmentId,
      signal_id: {
        source: 'catalog' as const,
        data_provider_domain: s.providerDomain,
        id: s.signalAgentSegmentId,
      },
      name: s.name,
      description: s.description,
      value_type: s.valueType,
      signal_type: s.signalType,
      data_provider: s.providerName,
      coverage_percentage: s.coveragePercentage,
      deployments: [deployment],
      pricing_options: s.pricingOptions.map(po => ({
        pricing_option_id: po.pricingOptionId,
        model: po.model,
        currency: po.currency,
        ...(po.model === 'cpm' && { cpm: po.cpm }),
        ...(po.model === 'percent_of_media' && {
          percent: po.percent,
          ...(po.maxCpm !== undefined && { max_cpm: po.maxCpm }),
        }),
        ...(po.model === 'flat_fee' && { amount: po.amount, period: po.period }),
      })),
      ...(s.valueType === 'categorical' && s.categories ? { categories: s.categories } : {}),
      ...(s.valueType === 'numeric' && s.range ? { range: s.range } : {}),
    };

    return signal;
  });

  // Scope boundary note for identity resolution queries
  const identityTerms = ['identity', 'resolution', 'matching', 'graph', 'credit'];
  const hasIdentityTerm = rawTerms.some(t => identityTerms.includes(t));
  const response: {
    signals: SignalResponse[];
    pagination: { has_more: boolean; total_count: number; cursor?: string };
    note?: string;
    unchanged?: boolean;
    wholesale_feed_version?: string;
    pricing_version?: string;
    cache_scope?: 'public' | 'account';
  } = {
    signals,
    pagination: {
      has_more: hasMore,
      total_count: totalMatching,
      // Cursor MUST be present iff has_more is true — see
      // static/schemas/source/core/pagination-response.json. universal/
      // pagination-integrity catches stale tokens on terminal pages.
      ...(hasMore && { cursor: encodeOffsetCursor('signals', pageEnd) }),
    },
    ...(wholesaleMeta && {
      wholesale_feed_version: wholesaleMeta.wholesale_feed_version,
      pricing_version: wholesaleMeta.pricing_version,
      cache_scope: wholesaleMeta.cache_scope,
    }),
  };
  if (hasIdentityTerm) {
    const isCreditQuery = rawTerms.includes('credit');
    response.note = isCreditQuery
      ? 'AdCP signals support credit-derived audience segments (credit activity, income tiers) but not raw credit scores, FICO data, or credit risk models. Signals represent targeting segments, not underlying financial data. Credit-derived signals may carry additional regulatory obligations (FCRA).'
      : 'AdCP signals support identity-derived attributes (age, income, life stage) but not identity resolution itself. Identity graphs, match rates, and cross-publisher deduplication are outside the current protocol scope.';
  }
  return response;
}

export async function handleActivateSignal(args: ToolArgs, ctx: TrainingContext) {
  const req = args as unknown as ActivateSignalRequest & ToolArgs;
  const segmentId = req.signal_agent_segment_id || '';
  const action = req.action || 'activate';
  const destinations: Destination[] = req.destinations || [];
  const pricingOptionId = req.pricing_option_id;
  const rawGovCtx = (req as unknown as Record<string, unknown>).governance_context;
  const governanceContext = typeof rawGovCtx === 'string' && rawGovCtx.length <= 4096 ? rawGovCtx : undefined;
  const sessionKey = sessionKeyFromArgs(req, ctx.mode, ctx.userId, ctx.moduleId);
  const session = await getSession(sessionKey);
  const registeredGovernanceAgents = resolveGovernanceAgentsForAccount(sessionKey, ctx.principal, req.account);
  const hasRegisteredGovernanceAgent = registeredGovernanceAgents.length > 0;

  if (!segmentId) {
    return { errors: [{ code: 'INVALID_REQUEST', message: 'signal_agent_segment_id is required' }] };
  }
  if (!destinations?.length) {
    return { errors: [{ code: 'INVALID_REQUEST', message: 'destinations array is required' }] };
  }

  // Find the signal in our catalog
  const allSignals = getAllSignals();
  const signal = allSignals.find(s => s.signalAgentSegmentId === segmentId);
  if (!signal) {
    return {
      errors: [{
        code: 'SIGNAL_AGENT_SEGMENT_NOT_FOUND',
        message: `Signal not found: ${segmentId}. Use get_signals to discover available signals.`,
      }],
    };
  }
  const validPricing = pricingOptionId
    ? signal.pricingOptions.find(po => po.pricingOptionId === pricingOptionId)
    : undefined;
  if (pricingOptionId && !validPricing) {
    return {
      errors: [{
        code: 'INVALID_PRICING_MODEL',
        message: `Pricing option not found: ${pricingOptionId}. Available: ${signal.pricingOptions.map(po => po.pricingOptionId).join(', ')}`,
      }],
    };
  }
  const signalCommitment = action === 'deactivate'
    ? 0
    : validPricing?.model === 'flat_fee'
      ? validPricing.amount ?? 0
      : validPricing?.model === 'cpm'
        ? validPricing.cpm ?? 0
        : validPricing?.maxCpm ?? 0;
  const signalCurrency = validPricing?.currency ?? 'USD';

  // Enforce governance: if the account has a registered governance agent, the
  // activation requires a valid approval token from check_governance. Fall back
  // to session plans for legacy storyboard setup where the governance agent was
  // called in-process but sync_governance was omitted.
  if (governanceContext) {
    const commitmentError = await governedCommitmentError(
      governanceContext,
      ctx.authenticatedAgentUrl,
      'activate_signal',
      `${getCanonicalBase()}/signals`,
      governedRequestPayload(ctx, req as unknown as Record<string, unknown>),
      signalCommitment,
      signalCurrency,
    );
    if (commitmentError) return { errors: [commitmentError] };
  } else if (action !== 'deactivate' && (hasRegisteredGovernanceAgent || session.governancePlans.size > 0)) {
    const msg = hasRegisteredGovernanceAgent
      ? `Signal activation requires governance approval. Call check_governance first — a governance agent is registered for this account.`
      : `Signal activation requires governance approval. Call check_governance first — a governance plan is registered for this account.`;
    return {
      errors: [{
        code: hasRegisteredGovernanceAgent ? 'PERMISSION_DENIED' : 'GOVERNANCE_DENIED',
        message: msg,
        details: {
          findings: [{
            category_id: hasRegisteredGovernanceAgent ? 'governance_context' : 'budget_authority',
            severity: 'critical',
            explanation: msg,
          }],
          ...(session.governancePlans.size > 0 && { plan_id: [...session.governancePlans.values()][0].planId }),
        },
      }] as TaskError[],
    };
  }

  const agentUrl = getAgentUrl();
  const now = new Date().toISOString();

  const destId = (dest: Destination): string =>
    dest.type === 'agent' ? dest.agent_url : dest.platform || agentUrl;

  if (action === 'deactivate') {
    // Remove activations for this signal
    for (const dest of destinations) {
      const activationKey = `${segmentId}:${destId(dest)}`;
      session.signalActivations.delete(activationKey);
    }

    return {
      deployments: destinations.map(dest => ({
        type: dest.type,
        is_live: false,
        deployed_at: now,
        ...(dest.type === 'agent' ? { agent_url: dest.agent_url } : { platform: dest.platform }),
        ...(dest.account ? { account: dest.account } : {}),
      })),
      };
  }

  // Activate: store activation state and return deployment info
  const deployments = destinations.map(dest => {
    const id = destId(dest);
    const activationKey = `${segmentId}:${id}`;

    const activationState: SignalActivationState = {
      signalAgentSegmentId: segmentId,
      destinationType: dest.type,
      destinationId: id,
      account: dest.account,
      pricingOptionId,
      governanceContext,
      isLive: true,
      activatedAt: now,
    };
    session.signalActivations.set(activationKey, activationState);

    return {
      type: dest.type,
      is_live: true,
      activation_key: {
        type: 'key_value' as const,
        key: 'audience_segment',
        value: segmentId,
      },
      deployed_at: now,
      ...(dest.type === 'agent' ? { agent_url: dest.agent_url } : { platform: dest.platform }),
      ...(dest.account ? { account: dest.account } : {}),
    };
  });

  return {
    deployments,
    ...(governanceContext && { governance_context: governanceContext }),
  };
}

export async function handleGetCreativeDelivery(args: ToolArgs, ctx: TrainingContext) {
  const req = args as unknown as GetCreativeDeliveryRequest & ToolArgs;
  const session = await getSession(creativeSessionKey(req, ctx));
  const agentUrl = getAgentUrl();

  // Resolve media buy IDs from multiple input formats
  const mediaBuyIds = req.media_buy_ids;
  const creativeIds = req.creative_ids;
  const maxVariants = req.max_variants || 10;

  if (!mediaBuyIds?.length && !creativeIds?.length) {
    return {
      errors: [{ code: 'INVALID_REQUEST', message: 'At least one of media_buy_ids or creative_ids is required.' }],
    };
  }

  // Find matching media buys
  const matchingBuys: MediaBuyState[] = [];
  for (const mb of session.mediaBuys.values()) {
    if (mediaBuyIds?.includes(mb.mediaBuyId)) matchingBuys.push(mb);
  }

  // Collect assigned creatives from matching buys, tracking which buy each belongs to
  const relevantCreativeIds = new Set<string>();
  const creativeToBuy = new Map<string, string>();
  if (creativeIds?.length) {
    creativeIds.forEach(id => relevantCreativeIds.add(id));
  }
  for (const mb of matchingBuys) {
    for (const pkg of mb.packages) {
      pkg.creativeAssignments.forEach(id => {
        relevantCreativeIds.add(id);
        creativeToBuy.set(id, mb.mediaBuyId);
      });
    }
  }

  if (relevantCreativeIds.size === 0) {
    return {
      reporting_period: {
        start: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
        end: new Date().toISOString(),
        timezone: 'America/New_York',
      },
      currency: 'USD',
      creatives: [],
      };
  }

  const now = new Date();
  const creatives: CreativeDeliveryEntry[] = [];

  for (const cid of relevantCreativeIds) {
    const creative = session.creatives.get(cid);
    if (!creative) continue;

    // Generate deterministic variant-level delivery based on creative ID
    const variantCount = Math.min(maxVariants, 3);
    const idHash = Array.from(cid).reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0);
    const totalImpressions = 50000 + Math.abs(idHash % 100000);
    const totalSpend = Math.round(totalImpressions * 0.05 * 100) / 100;
    const totalClicks = Math.round(totalImpressions * 0.03);
    const variants: CreativeVariant[] = [];

    const topics = ['technology', 'lifestyle', 'finance', 'health', 'sports'];
    const devices = ['mobile', 'desktop', 'tablet'];

    for (let i = 0; i < variantCount; i++) {
      const share = i === 0 ? 0.5 : (0.5 / (variantCount - 1));
      const vImpressions = Math.round(totalImpressions * share);
      const vSpend = Math.round(totalSpend * share * 100) / 100;
      const vClicks = Math.round(totalClicks * share);

      variants.push({
        variant_id: `gen_${cid}_${i}`,
        generation_context: {
          context_type: 'web_page',
          topic: topics[i % topics.length],
          device_class: devices[i % devices.length],
        },
        manifest: {
          ...storedCreativeFormatRecord(creative),
          assets: {
            headline: { asset_type: 'text', content: `Generated variant ${i + 1} for ${creative.name || cid}` },
            hero_image: { asset_type: 'image', url: `https://cdn.example.com/generated/${cid}_v${i}.jpg`, width: 300, height: 250 },
          },
        },
        impressions: vImpressions,
        spend: vSpend,
        clicks: vClicks,
        ctr: vImpressions > 0 ? Math.round((vClicks / vImpressions) * 10000) / 10000 : 0,
      });
    }

    creatives.push({
      creative_id: cid,
      media_buy_id: creativeToBuy.get(cid) || matchingBuys[0]?.mediaBuyId,
      ...storedCreativeFormatRecord(creative),
      totals: {
        impressions: totalImpressions,
        spend: totalSpend,
        clicks: totalClicks,
        ctr: totalImpressions > 0 ? Math.round((totalClicks / totalImpressions) * 10000) / 10000 : 0,
      },
      variant_count: variantCount,
      variants,
    });
  }

  return {
    reporting_period: {
      start: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      end: now.toISOString(),
      timezone: 'America/New_York',
    },
    currency: 'USD',
    creatives,
  };
}

// ── Build creative handler ──────────────────────────────────────

interface BuildCreativeArgs {
  account?: unknown;
  mode?: 'execute' | 'estimate';
  creative_id?: string;
  creative_manifest?: {
    format_id?: FormatID;
    format_kind?: string;
    format_option_ref?: Record<string, unknown>;
    assets?: Record<string, unknown> | Array<Record<string, unknown>>;
  };
  target_format_id?: FormatID;
  target_format_ids?: FormatID[];
  target_capability_id?: string;
  target_capability_ids?: string[];
  brand?: { domain?: string };
  media_buy_id?: string;
  package_id?: string;
  quality?: 'draft' | 'production';
  message?: string;
  transformer_id?: string;
  config?: Record<string, unknown>;
  max_creatives?: number;
  max_variants?: number;
  variant_axis?: { dimension?: string; field?: string; values?: unknown[]; label?: string };
  keep_mode?: 'keep_all' | 'keep_one' | 'keep_some';
  refine_from_build_variant_id?: string;
  idempotency_key?: string;
}

type ResolvedBuildTarget = {
  requested: FormatID;
  format?: { renders: Array<Record<string, unknown>> };
  formatKind?: NonNullable<AdcpCreativeManifest['format_kind']>;
};

function getDimensions(format: { renders: Array<Record<string, unknown>> } | undefined): { w: number; h: number } {
  const dims = format?.renders?.[0]?.dimensions as { width?: number; height?: number } | undefined;
  return { w: dims?.width || 300, h: dims?.height || 250 };
}

function buildHtmlAssets(html: string): AdcpCreativeManifest['assets'] {
  // HTMLAsset in @adcp/sdk ≥5.10 has `asset_type: 'html'` as a required
  // discriminator. Without it the union resolves ambiguously to MarkdownAsset
  // and tsc fails build.
  return { serving_tag: { asset_type: 'html', content: html } };
}

function buildCreativeCompleted<T extends object>(payload: T): T & { status: 'completed' } {
  return { status: 'completed', ...payload };
}

function buildCanonicalImageAssets(formatId: string, dimensions: { w: number; h: number }): AdcpCreativeManifest['assets'] {
  return {
    image_main: {
      asset_type: 'image',
      url: 'https://test-assets.adcontextprotocol.org/acme-outdoor/banner_300x250.jpg',
      width: dimensions.w,
      height: dimensions.h,
      alt_text: `Generated image creative for ${formatId}`,
    },
    headline: {
      asset_type: 'text',
      content: 'Trail-ready gear for every summit',
    },
    landing_page_url: {
      asset_type: 'url',
      url: 'https://acmeoutdoor.example/trail-pro',
    },
  };
}

function buildCanonicalAudioAssets(): AdcpCreativeManifest['assets'] {
  return {
    audio_main: {
      asset_type: 'audio',
      url: 'https://test-assets.adcontextprotocol.org/acme-outdoor/generated-voiceover.mp3',
      duration_ms: 30000,
      container_format: 'mp3',
    },
  } as AdcpCreativeManifest['assets'];
}

export async function handleBuildCreative(args: ToolArgs, ctx: TrainingContext): Promise<BuildCreativeResponse & { pricing_option_id?: string; vendor_cost?: number; currency?: string; consumption?: Record<string, unknown>; governance_context?: string }> {
  const req = args as unknown as BuildCreativeArgs;
  const session = await getSession(creativeSessionKey(req as unknown as ToolArgs, ctx));
  const agentUrl = getAgentUrl();
  const formats = getFormats();
  const rawGovCtx = (req as unknown as Record<string, unknown>).governance_context;
  const governanceContext = typeof rawGovCtx === 'string' && rawGovCtx.length <= 4096 ? rawGovCtx : undefined;
  const parentGovernance = req.refine_from_build_variant_id
    ? session.buildVariantGovernance.get(req.refine_from_build_variant_id)
    : undefined;
  const effectiveTransformerId = req.transformer_id ?? parentGovernance?.transformerId;
  const selectedTransformer = effectiveTransformerId
    ? getTransformers().find(transformer => transformer.transformer_id === effectiveTransformerId)
    : undefined;
  const selectedPricing = parentGovernance
    ? { unit_price: parentGovernance.unitPrice, currency: parentGovernance.currency }
    : selectedTransformer?.pricing_options?.find(option => {
      const unitPrice = (option as { unit_price?: unknown }).unit_price;
      return typeof unitPrice === 'number' && unitPrice > 0;
    }) as { unit_price?: number; currency?: string } | undefined;
  const effectiveAccount = (parentGovernance?.account ?? req.account) as AccountRef | undefined;
  // The training voiceover transformer emits fixed 30-second audio. Match the
  // renderer's axis precedence and fan-out clamp so token verification uses
  // the same paid leaf count the handler will actually produce.
  const governedVariantCount = Math.min(
    Math.max(1, req.variant_axis?.values?.length ?? req.max_variants ?? 1),
    TRANSFORMER_MAX_VARIANTS_LIMIT,
  );
  const governedAmount = (selectedPricing?.unit_price ?? 0) * 30 * governedVariantCount;
  const isPaidExecution = req.mode !== 'estimate' && governedAmount > 0;
  if (isPaidExecution && !effectiveAccount) {
    return buildCreativeCompleted({
      errors: [{
        code: 'ACCOUNT_REQUIRED',
        message: 'account is required to determine whether governance applies to paid creative execution.',
      }],
    });
  }
  const registeredGovernanceAgents = resolveGovernanceAgentsForAccount(
    creativeSessionKey(req as unknown as ToolArgs, ctx),
    ctx.principal,
    effectiveAccount as AccountRef | undefined,
  );
  if (governanceContext) {
    const commitmentError = await governedCommitmentError(
      governanceContext,
      ctx.authenticatedAgentUrl,
      'build_creative',
      `${getCanonicalBase()}/${ctx.tenantId === 'creative-builder' ? 'creative-builder' : 'creative'}`,
      governedRequestPayload(ctx, req as unknown as Record<string, unknown>),
      governedAmount,
      selectedPricing?.currency ?? 'USD',
    );
    if (commitmentError) {
      return buildCreativeCompleted({
        errors: [{ code: commitmentError.code, message: commitmentError.message }],
      });
    }
  } else if (isPaidExecution && registeredGovernanceAgents.length > 0) {
    const message = 'Paid creative execution requires governance approval. Call check_governance first — a governance agent is registered for this account.';
    return buildCreativeCompleted({
      errors: [{
        code: 'PERMISSION_DENIED',
        message,
        details: {
          findings: [{
            category_id: 'governance_context',
            severity: 'critical',
            explanation: message,
          }],
        },
      }],
    });
  }
  const validFormatIds = new Map(formats.map(f => [f.format_id.id, f]));
  const canonicalBuildsEnabled = includeThreeOneFields(ctx);
  const acceptedTargetIds = new Set([
    ...validFormatIds.keys(),
    ...Object.keys(BUILD_CREATIVE_FORMAT_ALIASES),
    ...(canonicalBuildsEnabled ? SUPPORTED_CANONICAL_BUILD_CAPABILITIES.map(item => item.capabilityId) : []),
  ]);
  const usesCanonicalTargets = Boolean(req.target_capability_id || req.target_capability_ids?.length);
  const usesLegacyTargets = Boolean(req.target_format_id || req.target_format_ids?.length);
  if (usesCanonicalTargets && usesLegacyTargets) {
    return buildCreativeCompleted({
      errors: [{
        code: 'INVALID_REQUEST',
        message: 'Use canonical target_capability_id(s) or deprecated target_format_id(s), not both.',
        field: 'target_capability_id',
        recovery: 'correctable',
      }],
    });
  }

  const unsupportedFormatError = (formatId: FormatID, field: string) => ({
    code: 'FORMAT_NOT_SUPPORTED',
    message: `Format "${formatId.id}" is not supported by this creative agent.`,
    field,
    recovery: 'correctable' as const,
    details: {
      format_id: formatId.id,
      accepted_values: [...acceptedTargetIds].sort(),
    },
  });

  const resolveTarget = (formatId: FormatID, field: string): { target?: ResolvedBuildTarget; error?: ReturnType<typeof unsupportedFormatError> } => {
    if (usesCanonicalTargets && canonicalBuildsEnabled) {
      const capability = supportedCanonicalBuildCapability(formatId.id);
      if (capability) {
        return { target: { requested: formatId, formatKind: capability.formatKind as NonNullable<AdcpCreativeManifest['format_kind']> } };
      }
      return { error: unsupportedFormatError(formatId, field) };
    }

    const aliasId = BUILD_CREATIVE_FORMAT_ALIASES[formatId.id] ?? formatId.id;
    const format = validFormatIds.get(aliasId);
    if (format) {
      return { target: { requested: formatId, format } };
    }

    if (canonicalBuildsEnabled) {
      const capability = supportedCanonicalBuildCapability(formatId.id);
      if (capability) {
        return { target: { requested: formatId, formatKind: capability.formatKind as NonNullable<AdcpCreativeManifest['format_kind']> } };
      }
    }

    return { error: unsupportedFormatError(formatId, field) };
  };

  const buildManifest = (target: ResolvedBuildTarget, label: string): AdcpCreativeManifest => {
    const { w, h } = getDimensions(target.format);
    if (target.formatKind === 'image') {
      return {
        format_kind: target.formatKind,
        assets: buildCanonicalImageAssets(target.requested.id, { w, h }),
      } as AdcpCreativeManifest;
    }
    if (target.formatKind === 'audio_hosted') {
      return {
        format_kind: target.formatKind,
        assets: buildCanonicalAudioAssets(),
      } as AdcpCreativeManifest;
    }
    if (target.formatKind) {
      return {
        format_kind: target.formatKind,
        assets: buildHtmlAssets(label),
      } as AdcpCreativeManifest;
    }
    return {
      format_id: {
        ...target.requested,
        agent_url: target.requested.agent_url ?? agentUrl,
      },
      assets: buildHtmlAssets(label),
    } as AdcpCreativeManifest;
  };

  // Determine target formats (cap at 50 to prevent response amplification)
  const MAX_TARGET_FORMATS = 50;
  if ((req.target_capability_ids?.length ?? 0) > MAX_TARGET_FORMATS || (req.target_format_ids?.length ?? 0) > MAX_TARGET_FORMATS) {
    const field = (req.target_capability_ids?.length ?? 0) > MAX_TARGET_FORMATS
      ? 'target_capability_ids'
      : 'target_format_ids';
    return buildCreativeCompleted({ errors: [{
      code: 'INVALID_REQUEST',
      message: `${field} supports at most ${MAX_TARGET_FORMATS} entries.`,
      field,
      recovery: 'correctable',
    }] });
  }
  const targetCapabilityIds = req.target_capability_ids?.length
    ? req.target_capability_ids
    : req.target_capability_id
      ? [req.target_capability_id]
      : [];
  const targetIds: FormatID[] = targetCapabilityIds.length
    ? targetCapabilityIds.map(id => ({ agent_url: agentUrl, id }))
    : req.target_format_ids?.length
    ? req.target_format_ids
    : req.target_format_id
      ? [req.target_format_id]
      : [];
  const targetField = (index?: number): string => usesCanonicalTargets
    ? (req.target_capability_ids?.length ? `target_capability_ids[${index ?? 0}]` : 'target_capability_id')
    : (req.target_format_ids?.length ? `target_format_ids[${index ?? 0}]` : 'target_format_id');

  // Transformer / multiplicity / refinement path. Engaged whenever the request
  // selects a transformer or asks for the variant shape (max_variants > 1,
  // variant_axis, or refine_from_build_variant_id). Bypasses the format-catalog
  // gate: a canonical target is one of the transformer's advertised output
  // capability IDs. Legacy named targets remain accepted as a 3.x shim.
  const wantsVariantShape = (typeof req.max_variants === 'number' && req.max_variants > 1)
    || !!req.variant_axis
    || !!req.refine_from_build_variant_id;
  if (req.transformer_id || wantsVariantShape) {
    const idemSeed = (typeof req.idempotency_key === 'string' ? req.idempotency_key : 'build')
      .replace(/[^A-Za-z0-9]/g, '').slice(0, 12) || 'build';

    let transformer: TrainingTransformer | undefined;
    if (req.transformer_id) {
      transformer = getTransformers().find(t => t.transformer_id === req.transformer_id);
      if (!transformer) {
        return buildCreativeCompleted({ errors: [{ code: 'INVALID_REQUEST', message: `Unknown transformer_id "${req.transformer_id}". Discover transformers via list_transformers.`, field: 'transformer_id', recovery: 'correctable' }] });
      }
      const configError = validateTransformerConfig(transformer, req.config);
      if (configError) {
        return buildCreativeCompleted({ errors: [configError] });
      }
      // A build_creative target MUST be a subset of the transformer's outputs.
      const transformerOutputIds = usesCanonicalTargets
        ? transformer.output_capability_ids
        : transformer.output_format_ids.map(format => format.id);
      const invalidTargetIndex = targetIds.findIndex(targetId => !transformerOutputIds.includes(targetId.id));
      if (invalidTargetIndex >= 0) {
        const invalidTarget = targetIds[invalidTargetIndex];
        const field = targetField(invalidTargetIndex);
        return buildCreativeCompleted({ errors: [{ code: 'INVALID_REQUEST', message: `Target format "${invalidTarget.id}" is not an output format of transformer "${req.transformer_id}".`, field, recovery: 'correctable' }] });
      }
    }

    // Refinement requires the agent to advertise supports_refinement (3.1 surface).
    if (req.refine_from_build_variant_id && !canonicalBuildsEnabled) {
      return buildCreativeCompleted({ errors: [{ code: 'UNSUPPORTED_FEATURE', message: 'This agent does not retain prior builds for refinement. Drop refine_from_build_variant_id and resend, or use the transform path (creative_manifest + message).', field: 'refine_from_build_variant_id', recovery: 'correctable' }] });
    }

    // For refinements, inherit the parent leaf's target from session state.
    // The schema forbids a new selector on refinement — the only valid source
    // of truth is what was stored when the parent variant was produced.
    if (req.refine_from_build_variant_id && !session.buildVariantTargets.has(req.refine_from_build_variant_id)) {
      return buildCreativeCompleted({ errors: [{ code: 'REFERENCE_NOT_FOUND', message: `Build variant "${req.refine_from_build_variant_id}" is not retained by this agent. Only variants produced in the current session are refinable.`, field: 'refine_from_build_variant_id', recovery: 'correctable' }] });
    }

    const target: FormatID = (req.refine_from_build_variant_id
      ? session.buildVariantTargets.get(req.refine_from_build_variant_id)!
      : targetIds[0])
      ?? req.target_format_id
      ?? transformer?.output_format_ids?.[0]
      ?? { agent_url: agentUrl, id: 'audio_vo' };

    // Single-format, non-variant transformer build → BuildCreativeSuccess,
    // carrying a build_variant_id so the result is itself refinable.
    if (!wantsVariantShape && req.transformer_id) {
      const singleVariantId = `bv_${idemSeed}_0`;
      session.buildVariantTargets.set(singleVariantId, target);
      if (selectedPricing?.unit_price !== undefined && effectiveTransformerId) {
        session.buildVariantGovernance.set(singleVariantId, {
          transformerId: effectiveTransformerId,
          ...(effectiveAccount ? { account: effectiveAccount } : {}),
          unitPrice: selectedPricing.unit_price,
          currency: selectedPricing.currency ?? 'USD',
        });
      }
      return buildCreativeCompleted({
        creative_manifest: transformerManifest(target, `<!-- AdCP Training Agent transformer ${escapeHtmlAttr(req.transformer_id)} -->`, usesCanonicalTargets || !usesLegacyTargets),
        build_variant_id: singleVariantId,
        ...(governanceContext && { governance_context: governanceContext }),
      });
    }

    // Variant shape (max_variants / variant_axis / refinement) →
    // BuildCreativeVariantSuccess. variant_axis.values length is authoritative
    // over max_variants when present.
    const axisValues = req.variant_axis?.values;
    const requestedVariantCount = Array.isArray(axisValues) && axisValues.length > 0
      ? axisValues.length
      : (typeof req.max_variants === 'number' && req.max_variants > 1 ? req.max_variants : 1);
    // Clamp to the advertised ceiling (never allocate an unbounded fan-out from
    // caller input); the shortfall shows as leaves_returned < leaves_total.
    const variantCount = Math.min(Math.max(requestedVariantCount, 1), TRANSFORMER_MAX_VARIANTS_LIMIT);
    const isRefine = !!req.refine_from_build_variant_id;
    const keepMode = req.keep_mode;

    const variants = Array.from({ length: variantCount }, (_unused, i) => {
      const variantId = `bv_${idemSeed}_${i}`;
      session.buildVariantTargets.set(variantId, target);
      if (selectedPricing?.unit_price !== undefined && effectiveTransformerId) {
        session.buildVariantGovernance.set(variantId, {
          transformerId: effectiveTransformerId,
          ...(effectiveAccount ? { account: effectiveAccount } : {}),
          unitPrice: selectedPricing.unit_price,
          currency: selectedPricing.currency ?? 'USD',
        });
      }
      const leaf: Record<string, unknown> = {
        build_variant_id: variantId,
        creative_manifest: transformerManifest(target, `<!-- AdCP Training Agent variant ${i} -->`, usesCanonicalTargets || !usesLegacyTargets),
      };
      if (Array.isArray(axisValues) && axisValues[i] !== undefined) {
        leaf.variant_axis_value = axisValues[i];
      }
      if (isRefine) {
        leaf.parent_build_variant_id = req.refine_from_build_variant_id;
      }
      // keep_one/keep_some are advisory: flag the agent's pick(s) via
      // recommended/rank without changing what is produced or billed.
      if (keepMode === 'keep_one' || keepMode === 'keep_some') {
        leaf.rank = i + 1;
        if (i === 0) leaf.recommended = true;
      }
      return leaf;
    });

    const variantResponse = buildCreativeCompleted({
      creatives: [{ build_creative_id: `bc_${idemSeed}`, variants }],
      items_total: 1,
      items_returned: 1,
      leaves_total: requestedVariantCount,
      leaves_returned: variantCount,
      ...(keepMode && { keep_mode_applied: keepMode }),
      budget_status: 'complete',
      ...(governanceContext && { governance_context: governanceContext }),
    });
    // BuildCreativeVariantSuccess (creatives[].variants[]) is in the wire
    // schema (build-creative-response.json) ahead of the SDK's published
    // BuildCreativeResponse union type. Responses are not framework-validated
    // (registry.ts validation.responses:'off'), so emit the wire shape; the
    // storyboard response_schema check is the guard.
    return variantResponse as unknown as BuildCreativeResponse & {
      pricing_option_id?: string;
      vendor_cost?: number;
      currency?: string;
      consumption?: Record<string, unknown>;
      governance_context?: string;
    };
  }

  // Mode 1: Library retrieval (creative_id)
  if (req.creative_id) {
    const creative = session.creatives.get(req.creative_id) ?? getComplianceCreative(req.creative_id);
    if (!creative) {
      return buildCreativeCompleted({
        errors: [{ code: 'CREATIVE_NOT_FOUND', message: `Creative "${req.creative_id}" not found. Use sync_creatives to upload or list_creatives to browse.` }],
      });
    }

    const requestedTarget = targetIds[0];
    let resolved;
    if (requestedTarget) {
      resolved = resolveTarget(requestedTarget, targetField());
    } else if (creative.formatKind) {
      resolved = {
        target: {
          requested: { agent_url: agentUrl, id: creative.formatKind },
          formatKind: creative.formatKind as NonNullable<AdcpCreativeManifest['format_kind']>,
        },
      };
    } else if (creative.formatId) {
      resolved = resolveTarget(creative.formatId, targetField());
    } else {
      return buildCreativeCompleted({
        errors: [{ code: 'INVALID_REQUEST', message: `Creative "${req.creative_id}" has no format identity.` }],
      });
    }
    if (resolved.error) return buildCreativeCompleted({ errors: [resolved.error] });
    const { w, h } = getDimensions(resolved.target!.format);
    const targetLabel = requestedTarget?.id ?? creative.formatKind ?? creative.formatId?.id ?? 'unknown';

    const builtManifest = buildManifest(resolved.target!, `<!-- AdCP Training Agent tag for ${escapeHtmlAttr(req.creative_id!)} -->\n<div data-adcp-creative="${escapeHtmlAttr(req.creative_id!)}" data-format="${escapeHtmlAttr(targetLabel)}"${req.media_buy_id ? ` data-media-buy="${escapeHtmlAttr(req.media_buy_id)}"` : ''}${req.package_id ? ` data-package="${escapeHtmlAttr(req.package_id)}"` : ''} style="width:${w}px;height:${h}px;background:#f0f0f0;display:flex;align-items:center;justify-content:center;font-family:sans-serif;font-size:14px;color:#666;">Ad: ${escapeHtmlAttr(creative.name || req.creative_id!)}</div>`);
    const base = {
      creative_manifest: !requestedTarget && creative.formatKind && creative.formatOptionRef
        ? {
          ...builtManifest,
          format_option_ref: creative.formatOptionRef as unknown as NonNullable<AdcpCreativeManifest['format_option_ref']>,
        }
        : builtManifest,
    };

    // Return pricing when account is provided (paid creative agent mode)
    if (creativeBillsThroughAdcp(ctx) && req.account) {
      const pricing = getCreativePricing(req.account, creative);
      creative.pricingOptionId = pricing.pricing_option_id;
      return buildCreativeCompleted({
        ...base,
        pricing_option_id: pricing.pricing_option_id,
        vendor_cost: 0, // CPM-priced: cost accrues at serve time
        currency: pricing.currency,
        consumption: {},
        ...(governanceContext && { governance_context: governanceContext }),
      });
    }

    return buildCreativeCompleted({ ...base, ...(governanceContext && { governance_context: governanceContext }) });
  }

  // Mode 2: Stateless transformation (creative_manifest + canonical target)
  if (req.creative_manifest) {
    const rawAssets = req.creative_manifest.assets;
    const inputAssetCount = Array.isArray(rawAssets) ? rawAssets.length : Object.keys(rawAssets || {}).length;

    if (targetIds.length === 0) {
      // Use the manifest's own format_id if no target specified
      const fmtId = req.creative_manifest.format_id;
      if (fmtId) targetIds.push(fmtId);
    }

    // Generate output for each target format
    if (targetIds.length > 1) {
      const resolvedTargets = targetIds.map((fmtId, index) => resolveTarget(fmtId, targetField(index)));
      const errors = resolvedTargets.flatMap(result => result.error ? [result.error] : []);
      if (errors.length > 0) {
        return buildCreativeCompleted({ errors, ...(governanceContext && { governance_context: governanceContext }) });
      }
      // Multi-format response
      const creative_manifests = resolvedTargets.map(result => {
        const target = result.target!;
        const { w, h } = getDimensions(target.format);
        return buildManifest(target, `<!-- AdCP Training Agent tag -->\n<div data-adcp-format="${escapeHtmlAttr(target.requested.id)}" style="width:${w}px;height:${h}px;background:linear-gradient(135deg,#1B5E20,#FF6F00);display:flex;align-items:center;justify-content:center;font-family:sans-serif;font-size:12px;color:#fff;border-radius:4px;">Built: ${escapeHtmlAttr(target.requested.id)} (${w}x${h})</div>`);
      });

      return buildCreativeCompleted({ creative_manifests, ...(governanceContext && { governance_context: governanceContext }) });
    }

    // Single format response
    const fmtId = targetIds[0] || { agent_url: agentUrl, id: 'display_300x250' };
    const resolved = resolveTarget(fmtId, targetField());
    if (resolved.error) {
      return buildCreativeCompleted({ errors: [resolved.error], ...(governanceContext && { governance_context: governanceContext }) });
    }
    const { w, h } = getDimensions(resolved.target!.format);

    return buildCreativeCompleted({
      creative_manifest: buildManifest(resolved.target!, `<!-- AdCP Training Agent tag -->\n<div data-adcp-format="${escapeHtmlAttr(fmtId.id)}" data-input-assets="${inputAssetCount}" style="width:${w}px;height:${h}px;background:linear-gradient(135deg,#1B5E20,#FF6F00);display:flex;align-items:center;justify-content:center;font-family:sans-serif;font-size:12px;color:#fff;border-radius:4px;">Built: ${escapeHtmlAttr(fmtId.id)} (${w}x${h})</div>`),
      ...(governanceContext && { governance_context: governanceContext }),
    });
  }

  // Mode 3: Generative build (canonical target + message, no manifest or library creative)
  if (targetIds.length > 0) {
    if (targetIds.length > 1) {
      const resolvedTargets = targetIds.map((fmtId, index) => resolveTarget(fmtId, targetField(index)));
      const errors = resolvedTargets.flatMap(result => result.error ? [result.error] : []);
      if (errors.length > 0) {
        return buildCreativeCompleted({ errors, ...(governanceContext && { governance_context: governanceContext }) });
      }
      const creative_manifests = resolvedTargets.map(result => {
        const target = result.target!;
        const { w, h } = getDimensions(target.format);
        return buildManifest(target, `<!-- AdCP Training Agent generated -->\n<div data-adcp-format="${escapeHtmlAttr(target.requested.id)}" style="width:${w}px;height:${h}px;background:linear-gradient(135deg,#047857,#0d9488);display:flex;align-items:center;justify-content:center;font-family:sans-serif;font-size:12px;color:#fff;border-radius:4px;">Generated: ${escapeHtmlAttr(target.requested.id)} (${w}x${h})</div>`);
      });
      return buildCreativeCompleted({ creative_manifests, ...(governanceContext && { governance_context: governanceContext }) });
    }

    const fmtId = targetIds[0];
    const resolved = resolveTarget(fmtId, targetField());
    if (resolved.error) {
      return buildCreativeCompleted({ errors: [resolved.error], ...(governanceContext && { governance_context: governanceContext }) });
    }
    const { w, h } = getDimensions(resolved.target!.format);

    return buildCreativeCompleted({
      creative_manifest: buildManifest(resolved.target!, `<!-- AdCP Training Agent generated -->\n<div data-adcp-format="${escapeHtmlAttr(fmtId.id)}" style="width:${w}px;height:${h}px;background:linear-gradient(135deg,#047857,#0d9488);display:flex;align-items:center;justify-content:center;font-family:sans-serif;font-size:12px;color:#fff;border-radius:4px;">Generated: ${escapeHtmlAttr(fmtId.id)} (${w}x${h})</div>`),
      ...(governanceContext && { governance_context: governanceContext }),
    });
  }

  return buildCreativeCompleted({
    errors: [{ code: 'INVALID_REQUEST', message: 'Provide creative_id (library mode), creative_manifest (transformation mode), or target_capability_id (generative mode).' }],
  });
}

// ── Preview creative handler ────────────────────────────────────

interface PreviewCreativeArgs {
  account?: unknown;
  request_type: 'single' | 'batch' | 'variant';
  creative_manifest?: { format_id?: FormatID; format_kind?: string; format_option_ref?: Record<string, unknown>; creative_id?: string; assets?: Record<string, unknown> };
  target_capability_id?: string;
  format_id?: FormatID;
  creative_id?: string;
  requests?: Array<{
    target_capability_id?: string;
    format_id?: FormatID;
    creative_manifest?: { format_id?: FormatID; format_kind?: string; format_option_ref?: Record<string, unknown>; creative_id?: string; assets?: Record<string, unknown> };
    creative_id?: string;
    output_format?: 'url' | 'html' | 'both';
    quality?: 'draft' | 'production';
    template_id?: string;
    item_limit?: number;
  }>;
  variant_id?: string;
  output_format?: 'url' | 'html' | 'both';
  quality?: 'draft' | 'production';
  template_id?: string;
  item_limit?: number;
}

export async function handlePreviewCreative(args: ToolArgs, ctx: TrainingContext) {
  const req = args as unknown as PreviewCreativeArgs;
  const session = await getSession(creativeSessionKey(req as unknown as ToolArgs, ctx));
  const agentUrl = getAgentUrl();
  const formats = getFormats();
  const validFormatIds = new Map(formats.map(f => [f.format_id.id, f]));
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  function buildPreview(
    manifest: { format_id?: FormatID; format_kind?: string; format_option_ref?: Record<string, unknown>; creative_id?: string; assets?: Record<string, unknown> },
    targetCapabilityId?: string,
    requestedOutputFormat: 'url' | 'html' | 'both' = 'url',
    requestedQuality: 'draft' | 'production' = 'production',
    legacyFormatId?: FormatID,
  ) {
    // Resolve format
    let formatId = legacyFormatId ?? manifest.format_id;
    let formatKind = manifest.format_kind;
    let creativeName = 'Preview';

    // A top-level creative_id is normalized to a manifest containing only
    // that ID. An inline manifest may also carry creative_id as identity; its
    // supplied assets and format remain authoritative and must not trigger a
    // library lookup.
    const isLibraryReference = Boolean(
      manifest.creative_id
      && manifest.assets === undefined
      && manifest.format_id === undefined
      && manifest.format_kind === undefined,
    );
    if (isLibraryReference && manifest.creative_id) {
      const creative = session.creatives.get(manifest.creative_id);
      if (!creative) return null;
      formatId = creative.formatId;
      formatKind = creative.formatKind;
      creativeName = creative.name || manifest.creative_id;
    }

    // The frozen 3.0 surface stored named format IDs in the later
    // `format_kind` slot when the SDK projected a synced creative. Treat that
    // value as legacy routing only inside the storyboard compatibility shim.
    if (
      isThreeZeroStoryboardCompat(ctx)
      && formatKind
      && !VALID_CANONICAL_FORMAT_KINDS.has(formatKind)
      && formatId?.id
      && validFormatIds.has(formatId.id)
    ) {
      formatKind = undefined;
    }

    if (legacyFormatId) {
      if (!legacyFormatId.id || !validFormatIds.has(legacyFormatId.id)) return null;
    } else if (formatKind) {
      const matches = SUPPORTED_CANONICAL_BUILD_CAPABILITIES.filter(item => item.formatKind === formatKind);
      if (targetCapabilityId) {
        const selected = SUPPORTED_CANONICAL_BUILD_CAPABILITIES.find(item => item.capabilityId === targetCapabilityId);
        if (!selected || selected.formatKind !== formatKind) return null;
      } else if (matches.length !== 1 && !isThreeZeroStoryboardCompat(ctx)) {
        return null;
      }
    } else if (targetCapabilityId) {
      return null;
    }

    const fmtId = legacyFormatId?.id || formatKind || formatId?.id || 'image';
    const format = validFormatIds.get(fmtId);
    if (!formatKind && !format && formatId?.id && fmtId !== 'native_in_feed') {
      return null; // Signal invalid format to caller
    }
    if (formatKind && !VALID_CANONICAL_FORMAT_KINDS.has(formatKind)) return null;
    const { w, h } = getDimensions(format);

    const previewHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Preview: ${escapeHtmlAttr(fmtId)}</title><style>body{margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#fafafa;font-family:sans-serif;}</style></head><body><div data-quality="${requestedQuality}" style="width:${w}px;height:${h}px;background:linear-gradient(135deg,#1B5E20,#FF6F00);display:flex;flex-direction:column;align-items:center;justify-content:center;border-radius:8px;color:#fff;"><div style="font-size:16px;font-weight:600;">${escapeHtmlAttr(creativeName)}</div><div style="font-size:12px;opacity:0.8;margin-top:4px;">${escapeHtmlAttr(fmtId)} (${w}x${h})</div><div style="font-size:10px;opacity:0.6;margin-top:8px;">AdCP Training Agent Preview</div></div></body></html>`;

    const render: Record<string, unknown> = {
      render_id: `preview_${fmtId}`,
      output_format: requestedOutputFormat,
      role: 'primary',
      dimensions: { width: w, height: h },
    };

    if (requestedOutputFormat === 'url' || requestedOutputFormat === 'both') {
      render.preview_url = `data:text/html;base64,${Buffer.from(previewHtml).toString('base64')}`;
    }
    if (requestedOutputFormat === 'html' || requestedOutputFormat === 'both') {
      render.preview_html = previewHtml;
    }

    return {
      preview_id: `preview_${fmtId}`,
      renders: [render],
      input: { name: creativeName },
    };
  }

  // Variant mode
  if (req.request_type === 'variant') {
    if (!req.variant_id) {
      return { errors: [{ code: 'INVALID_REQUEST', message: 'variant_id is required for variant mode.' }] };
    }
    return { errors: [{ code: 'NOT_SUPPORTED', message: 'Variant replay is not supported by the training agent. Use single or batch mode.' }] };
  }

  // Batch mode
  if (req.request_type === 'batch' && req.requests?.length) {
    const usesCanonicalRouting = Boolean(req.target_capability_id)
      || req.requests.some(item => Boolean(item.target_capability_id));
    const usesLegacyRouting = Boolean(req.format_id)
      || req.requests.some(item => Boolean(item.format_id));
    if (usesCanonicalRouting && usesLegacyRouting) {
      return { errors: [{ code: 'INVALID_REQUEST', message: 'Use target_capability_id or deprecated format_id routing, not both.' }] };
    }
    const results = req.requests.map(item => {
      if (item.creative_manifest && item.creative_id) {
        return {
          success: false,
          creative_id: item.creative_id,
          errors: [{ code: 'INVALID_REQUEST', message: 'Provide creative_manifest or creative_id, not both.' }],
        };
      }
      const manifest = item.creative_manifest || (item.creative_id ? { creative_id: item.creative_id } : undefined);
      if (item.creative_id && !session.creatives.has(item.creative_id)) {
        return {
          success: false,
          creative_id: item.creative_id,
          errors: [{ code: 'CREATIVE_NOT_FOUND', message: `Creative "${item.creative_id}" was not found in this agent's creative library.` }],
        };
      }
      const targetCapabilityId = item.target_capability_id ?? req.target_capability_id;
      const legacyFormatId = targetCapabilityId ? undefined : item.format_id ?? req.format_id;
      const effectiveOutputFormat = item.output_format ?? req.output_format ?? 'url';
      const effectiveQuality = item.quality ?? req.quality ?? 'production';
      const preview = manifest
        ? buildPreview(manifest, targetCapabilityId, effectiveOutputFormat, effectiveQuality, legacyFormatId)
        : null;
      if (!preview) {
        return {
          success: false,
          creative_id: item.creative_id || 'unknown',
          errors: [{ code: 'FORMAT_NOT_SUPPORTED', message: 'No unique advertised preview capability matches this item.' }],
        };
      }
      return {
        success: true,
        creative_id: item.creative_id || 'unknown',
        quality_used: effectiveQuality,
        response: { previews: [preview], expires_at: expiresAt },
      };
    });
    return {
      response_type: 'batch',
      results,
    };
  }

  // Single mode
  if (req.creative_manifest && req.creative_id) {
    return { errors: [{ code: 'INVALID_REQUEST', message: 'Provide creative_manifest or creative_id, not both.' }] };
  }
  if (req.target_capability_id && req.format_id) {
    return { errors: [{ code: 'INVALID_REQUEST', message: 'Use target_capability_id or deprecated format_id routing, not both.' }] };
  }
  const manifest = req.creative_manifest || (req.creative_id ? { creative_id: req.creative_id } : null);
  if (!manifest) {
    return {
      errors: [{ code: 'INVALID_REQUEST', message: 'Provide creative_manifest (with inline assets) or creative_id (from library).' }],
    };
  }

  if (req.creative_id && !session.creatives.has(req.creative_id)) {
    return {
      errors: [{ code: 'CREATIVE_NOT_FOUND', message: `Creative "${req.creative_id}" was not found in this agent's creative library.` }],
    };
  }

  const preview = buildPreview(
    manifest,
    req.target_capability_id,
    req.output_format ?? 'url',
    req.quality ?? 'production',
    req.target_capability_id ? undefined : req.format_id,
  );
  if (!preview) {
    const fmtId = manifest.format_kind || manifest.format_id?.id || 'unknown';
    return {
      errors: [{ code: 'FORMAT_NOT_SUPPORTED', message: `Format "${fmtId}" has no unique matching advertised preview capability. Inspect get_adcp_capabilities creative.supported_formats to select target_capability_id.` }],
    };
  }

  return {
    response_type: 'single',
    previews: [preview],
    quality_used: req.quality ?? 'production',
    expires_at: expiresAt,
  };
}

// ── report_usage handler ──────────────────────────────────────────

interface ReportUsageArgs extends ToolArgs {
  idempotency_key?: string;
  account?: { account_id?: string; brand?: { domain: string }; operator?: string };
  reporting_period: { start: string; end: string };
  usage: Array<{
    account: { account_id?: string; brand?: { domain: string }; operator?: string };
    media_buy_id?: string;
    creative_id?: string;
    signal_agent_segment_id?: string;
    standards_id?: string;
    rights_id?: string;
    build_variant_id?: string;
    property_list_id?: string;
    pricing_option_id?: string;
    impressions?: number;
    media_spend?: number;
    conversions?: number;
    conversion_value?: number;
    commissionable_value?: number;
    vendor_cost: number;
    currency: string;
    final?: boolean;
    finalized_at?: string;
    measurement_window?: string;
  }>;
}

function roundCurrency(value: number, currency: string): number {
  let fractionDigits = 2;
  try {
    fractionDigits = new Intl.NumberFormat('en', { style: 'currency', currency })
      .resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    // The schema constrains shape but not membership in the ISO registry. The
    // handler's existing behavior accepts unknown three-letter codes, so keep
    // the conventional two-decimal fallback rather than adding a new rejection.
  }
  const factor = 10 ** fractionDigits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function effectiveProductMapForSession(session: SessionState): Map<string, Product> {
  const productMap = new Map(getCatalog().map(cp => [cp.product.product_id, { ...cp.product }]));
  overlaySeededProducts(session, productMap);
  overlayNegotiatedPricingOptions(session, productMap);
  return productMap;
}

type RevenueShareUsageContext = {
  rate: number;
  currency: string;
  budget: number;
  pricingOptionId: string;
};

function pricingContextsForUsage(
  session: SessionState,
  record: ReportUsageArgs['usage'][number],
): { packagePricingOptionIds: Set<string>; revenueShares: RevenueShareUsageContext[] } | undefined {
  if (!record.media_buy_id) return undefined;
  const mediaBuy = session.mediaBuys.get(record.media_buy_id);
  if (!mediaBuy) return undefined;
  const products = effectiveProductMapForSession(session);
  const revenueShares: RevenueShareUsageContext[] = [];
  for (const pkg of mediaBuy.packages) {
    const product = products.get(pkg.productId);
    const option = product?.pricing_options.find(candidate => candidate.pricing_option_id === pkg.pricingOptionId) as unknown as PricingOptionView | undefined;
    if (option?.pricing_model !== 'revenue_share' || option.commission_rate === undefined || !option.currency) continue;
    revenueShares.push({
      rate: option.commission_rate,
      currency: option.currency,
      budget: pkg.budget,
      pricingOptionId: pkg.pricingOptionId,
    });
  }
  return {
    packagePricingOptionIds: new Set(mediaBuy.packages.map(pkg => pkg.pricingOptionId)),
    revenueShares,
  };
}

// ── get_creative_features (truth-of-claim verifier; closes #3802) ──
//
// Governance-agent-shaped handler the training agent exposes so the
// seller-side sync_creatives enforcement path can verify buyer-claimed
// provenance. Returns deterministic AI-detection results derived from the
// creative manifest's asset URLs — encoded in the URL filename pattern so
// storyboards can drive both "claim confirmed" and "claim contradicted"
// outcomes from the fixture without per-test stateful bookkeeping.
//
// URL pattern detection (case-insensitive substring match on each asset URL):
//   - Contains "ai-generated-true" or "ai_gen_true"  -> ai_generated: true,  conf 0.95
//   - Contains "ai-generated-false" or "ai_gen_false" -> ai_generated: false, conf 0.95
//   - Otherwise: derive from buyer-claimed digital_source_type (verifier
//     "agrees" with the claim by default). digital_capture / digital_creation /
//     human_edits / composite_capture / data_driven_media -> ai_generated: false.
//     trained_algorithmic_media / composite_with_trained_algorithmic_media /
//     composite_synthetic / algorithmic_media -> ai_generated: true.
//   - When neither URL pattern matches and digital_source_type is absent,
//     return ai_generated: false with low confidence (0.3) — agnostic on
//     missing claim. The storyboard's structural-rejection contract catches
//     missing digital_source_type via PROVENANCE_DIGITAL_SOURCE_TYPE_MISSING
//     before we reach the truth-of-claim path.
//
// The handler is documented and stable for storyboard authors: pick the URL
// pattern that drives the test outcome, no fixture mutation needed.
interface GetCreativeFeaturesArgs {
  creative_manifest?: { provenance?: Record<string, unknown>; assets?: Record<string, { url?: unknown; provenance?: Record<string, unknown> }> };
  feature_ids?: string[];
}

interface CreativeFeatureResult {
  feature_id: string;
  value: boolean | number | string;
  confidence?: number;
}

interface CreativeAuditObservation {
  code: 'OVERSIGHT_DISCLOSURE_CARVEOUT_CLAIMED';
  severity: 'audit-worthy';
  recovery: 'informational';
  field: string;
  message: string;
  details: {
    agent_url: string;
    feature_id?: string;
    claimed_value: {
      human_oversight: 'edited' | 'directed';
      disclosure_required: false;
    };
    observed_value?: boolean | number | string | null;
    confidence?: number;
    substituted_for?: string;
  };
}

const AI_TRUE_DST = new Set([
  'trained_algorithmic_media',
  'composite_with_trained_algorithmic_media',
  'composite_synthetic',
  'algorithmic_media',
]);

function detectAiFromManifest(creative_manifest: GetCreativeFeaturesArgs['creative_manifest']): { value: boolean; confidence: number } {
  const assets = creative_manifest?.assets ?? {};
  for (const asset of Object.values(assets)) {
    const url = typeof asset?.url === 'string' ? asset.url.toLowerCase() : '';
    if (url.includes('ai-generated-true') || url.includes('ai_gen_true')) return { value: true, confidence: 0.95 };
    if (url.includes('ai-generated-false') || url.includes('ai_gen_false')) return { value: false, confidence: 0.95 };
  }
  const dst = creative_manifest?.provenance?.digital_source_type;
  if (typeof dst === 'string') {
    if (AI_TRUE_DST.has(dst)) return { value: true, confidence: 0.85 };
    return { value: false, confidence: 0.85 };
  }
  return { value: false, confidence: 0.3 };
}

function buildOversightDisclosureAuditObservations(
  creative_manifest: GetCreativeFeaturesArgs['creative_manifest'],
  opts: {
    agent_url: string;
    feature_id?: string;
    observed_value?: boolean | number | string | null;
    confidence?: number;
    substituted_for?: string;
  },
): CreativeAuditObservation[] {
  const provenance = creative_manifest?.provenance;
  const humanOversight = provenance?.human_oversight;
  const disclosure = provenance?.disclosure as { required?: unknown } | undefined;
  if ((humanOversight !== 'edited' && humanOversight !== 'directed') || disclosure?.required !== false) {
    return [];
  }

  return [{
    code: 'OVERSIGHT_DISCLOSURE_CARVEOUT_CLAIMED',
    severity: 'audit-worthy',
    recovery: 'informational',
    field: 'creative_manifest.provenance.disclosure.required',
    message: `Creative claims human-${humanOversight} AI output does not require disclosure; retain for audit review.`,
    details: {
      agent_url: opts.agent_url,
      ...(opts.feature_id ? { feature_id: opts.feature_id } : {}),
      claimed_value: {
        human_oversight: humanOversight,
        disclosure_required: false,
      },
      ...(opts.observed_value !== undefined ? { observed_value: opts.observed_value } : {}),
      ...(typeof opts.confidence === 'number' ? { confidence: opts.confidence } : {}),
      ...(opts.substituted_for ? { substituted_for: opts.substituted_for } : {}),
    },
  }];
}

export async function handleGetCreativeFeatures(args: ToolArgs, _ctx: TrainingContext) {
  const req = args as unknown as GetCreativeFeaturesArgs;
  const requested = req.feature_ids?.length ? new Set(req.feature_ids) : null;
  const ai = detectAiFromManifest(req.creative_manifest);

  const allFeatures: CreativeFeatureResult[] = [
    { feature_id: 'ai_generated', value: ai.value, confidence: ai.confidence },
    { feature_id: 'ai_modified', value: false, confidence: 0.6 },
    { feature_id: 'ai_confidence', value: ai.confidence },
  ];
  const results = requested ? allFeatures.filter(f => requested.has(f.feature_id)) : allFeatures;
  const aiResult = results.find(f => f.feature_id === 'ai_generated');
  const audit_observations = buildOversightDisclosureAuditObservations(req.creative_manifest, {
    agent_url: getAgentUrl(),
    ...(aiResult ? { feature_id: aiResult.feature_id, observed_value: aiResult.value, confidence: aiResult.confidence } : {}),
  });
  return {
    results,
    ...(audit_observations.length ? { audit_observations } : {}),
  };
}

/**
 * Run the seller-side truth-of-claim verifier on a creative manifest.
 * In a real seller, this would invoke `get_creative_features` over the
 * network against a governance agent on the seller's `accepted_verifiers`
 * allowlist. The training agent acts as both seller and verifier in one
 * process, so we call the handler directly. The wire contract is identical:
 * the seller obtains a feature result and reconciles it against the buyer's
 * provenance claim.
 *
 * Returns the verifier identity + result for `error.details` on
 * PROVENANCE_CLAIM_CONTRADICTED, or null when the claim is confirmed.
 */
async function runProvenanceVerifier(
  creative: CreativeForEnforcement,
  policy: CreativePolicyView,
): Promise<{
  contradiction: { agent_url: string; feature_id: string; claimed_value: string; observed_value: boolean; confidence: number; substituted_for?: string } | null;
  auditObservations: CreativeAuditObservation[];
}> {
  const provenance = resolveManifestProvenance(creative);
  const claimed = provenance?.digital_source_type;
  if (!policy.accepted_verifiers?.length) return { contradiction: null, auditObservations: [] };
  if (!provenance) return { contradiction: null, auditObservations: [] };

  // Pick the buyer's nominated verifier when on-list, else the first
  // on-list entry the seller would use. The seller is the verifier-of-
  // record per #3468 — buyer-asserted URLs are hints, not authoritative.
  const buyerNominated = pickBuyerNominatedVerifierUrl(provenance);
  const allowed = policy.accepted_verifiers;
  const buyerCanonical = buyerNominated ? canonicalizeAgentUrl(buyerNominated) : null;
  let chosen = allowed.find(v => buyerCanonical && canonicalizeAgentUrl(v.agent_url) === buyerCanonical);
  let substituted: string | undefined;
  if (!chosen) {
    chosen = allowed[0];
    substituted = buyerNominated ?? undefined;
  }
  const featureId = chosen.feature_id ?? 'ai_generated';

  // In-process call to the verifier handler. Real sellers do this over
  // the network; the contract result is the same. This runs before the
  // digital_source_type short-circuit because audit observations can be
  // claim-driven even when there is no DST value to refute. Synthesize a
  // manifest from whichever shape the creative carries: sync_creatives puts
  // assets at the top level, build_creative / preview_creative nest them
  // under creative_manifest. Either path resolves to the same input.
  const synthesized = creative.creative_manifest ?? creative.manifest ?? {
    provenance: creative.provenance,
    assets: creative.assets,
  };
  if (!synthesized.assets && creative.assets) {
    synthesized.assets = creative.assets;
  }
  const features = await handleGetCreativeFeatures(
    { creative_manifest: synthesized, feature_ids: [featureId] } as unknown as ToolArgs,
    {} as unknown as TrainingContext,
  ) as unknown as { results?: CreativeFeatureResult[]; audit_observations?: CreativeAuditObservation[] };
  const result = features.results?.find(r => r.feature_id === featureId);
  if (!result) return { contradiction: null, auditObservations: [] };

  const verifierSaysAi = result.value === true;
  const claimsAi = typeof claimed === 'string' && AI_TRUE_DST.has(claimed);
  const confidence = typeof result.confidence === 'number' ? result.confidence : 0;
  // Surface the seller-selected verifier identity in public audit details;
  // the in-process handler's local identity is an implementation detail.
  const auditObservations = (features.audit_observations ?? []).map(observation => ({
    ...observation,
    details: {
      ...observation.details,
      agent_url: chosen.agent_url,
      ...(substituted ? { substituted_for: substituted } : {}),
    },
  }));
  if (typeof claimed !== 'string') return { contradiction: null, auditObservations }; // no claim to refute; structural codes handle absence

  // Contradiction: buyer says non-AI but verifier sees AI with confidence
  // above the seller's threshold. The reverse direction (buyer claims AI
  // but verifier sees non-AI) is NOT a contradiction — buyers may
  // conservatively over-disclose. Threshold matches the storyboard
  // assertion: 0.9 confidence is the established line for high-signal
  // detector verdicts (see PROVENANCE_CLAIM_CONTRADICTED docstring).
  const CONFIDENCE_THRESHOLD = 0.9;
  if (verifierSaysAi && !claimsAi && confidence >= CONFIDENCE_THRESHOLD) {
    return {
      contradiction: {
        agent_url: chosen.agent_url,
        feature_id: featureId,
        claimed_value: claimed,
        observed_value: verifierSaysAi,
        confidence,
        ...(substituted ? { substituted_for: substituted } : {}),
      },
      auditObservations,
    };
  }
  return { contradiction: null, auditObservations };
}

function pickBuyerNominatedVerifierUrl(provenance: Record<string, unknown> | undefined): string | null {
  type Layer = { verify_agent?: { agent_url?: unknown } };
  const layers: Layer[] = [];
  const e = provenance?.embedded_provenance;
  if (Array.isArray(e)) layers.push(...(e as Layer[]));
  const w = provenance?.watermarks;
  if (Array.isArray(w)) layers.push(...(w as Layer[]));
  for (const layer of layers) {
    const url = layer.verify_agent?.agent_url;
    if (typeof url === 'string' && url.length > 0) return url;
  }
  return null;
}

export async function handleReportUsage(args: ToolArgs, ctx: TrainingContext) {
  const req = args as unknown as ReportUsageArgs;

  if (!req.reporting_period) {
    return { errors: [{ code: 'INVALID_REQUEST', message: 'reporting_period is required.', field: 'reporting_period' }] };
  }

  if (!req.usage?.length) {
    return { errors: [{ code: 'INVALID_REQUEST', message: 'At least one usage record is required.', field: 'usage' }] };
  }

  // Each record is self-contained and a report may span accounts. Resolve
  // state (including the exact principal-bound controller fixture projection)
  // from the record's own account instead of letting usage[0] lend its media
  // buys, creatives, signals, or seeded pricing to the rest of the batch.
  const sessionPromises = new Map<string, Promise<import('./types.js').SessionState>>();
  const usageSessions = await Promise.all(req.usage.map(record => {
    const sessionArgs = { account: record.account } as unknown as ToolArgs;
    const sessionKey = sessionKeyFromArgs(sessionArgs, ctx.mode, ctx.userId, ctx.moduleId);
    let sessionPromise = sessionPromises.get(sessionKey);
    if (!sessionPromise) {
      sessionPromise = getSession(
        sessionKey,
        controllerFixtureSessionKey(sessionArgs, ctx),
      );
      sessionPromises.set(sessionKey, sessionPromise);
    }
    return sessionPromise;
  }));
  const incomingBySession = new Map<import('./types.js').SessionState, number>();
  for (const session of usageSessions) {
    incomingBySession.set(session, (incomingBySession.get(session) ?? 0) + 1);
  }
  if ([...incomingBySession].some(([session, incoming]) => (
    session.usageRecords.length + incoming > MAX_USAGE_RECORDS_PER_SESSION
  ))) {
    return { errors: [{ code: 'LIMIT_EXCEEDED', message: `Usage record limit (${MAX_USAGE_RECORDS_PER_SESSION}) would be exceeded for at least one account.` }] };
  }

  let accepted = 0;
  const errors: Array<{ code: string; message: string; field?: string; recovery?: string }> = [];

  for (let i = 0; i < req.usage.length; i++) {
    const record = req.usage[i];
    const session = usageSessions[i];

    // Validate required fields
    if (record.vendor_cost === undefined || record.vendor_cost === null) {
      errors.push({ code: 'INVALID_USAGE_DATA', message: 'vendor_cost is required.', field: `usage[${i}].vendor_cost` });
      continue;
    }
    if (record.vendor_cost < 0) {
      errors.push({ code: 'INVALID_USAGE_DATA', message: 'vendor_cost must be non-negative.', field: `usage[${i}].vendor_cost` });
      continue;
    }
    if (!record.currency) {
      errors.push({ code: 'INVALID_USAGE_DATA', message: 'currency is required.', field: `usage[${i}].currency` });
      continue;
    }
    if (!record.account) {
      errors.push({ code: 'INVALID_USAGE_DATA', message: 'account is required.', field: `usage[${i}].account` });
      continue;
    }
    if (record.impressions !== undefined && record.impressions < 0) {
      errors.push({ code: 'INVALID_USAGE_DATA', message: 'impressions must be non-negative.', field: `usage[${i}].impressions` });
      continue;
    }
    if (record.conversions !== undefined && record.conversions < 0) {
      errors.push({ code: 'INVALID_USAGE_DATA', message: 'conversions must be non-negative.', field: `usage[${i}].conversions` });
      continue;
    }
    if (record.conversion_value !== undefined && record.conversion_value < 0) {
      errors.push({ code: 'INVALID_USAGE_DATA', message: 'conversion_value must be non-negative.', field: `usage[${i}].conversion_value` });
      continue;
    }
    if (record.commissionable_value !== undefined && record.commissionable_value < 0) {
      errors.push({ code: 'INVALID_USAGE_DATA', message: 'commissionable_value must be non-negative.', field: `usage[${i}].commissionable_value` });
      continue;
    }

    const usesVendorPricingNamespace = Boolean(
      record.creative_id
      || record.signal_agent_segment_id
      || record.standards_id
      || record.rights_id
      || record.build_variant_id
      || record.property_list_id,
    );
    const pricingContexts = usesVendorPricingNamespace ? undefined : pricingContextsForUsage(session, record);
    if (record.pricing_option_id && pricingContexts && !pricingContexts.packagePricingOptionIds.has(record.pricing_option_id)) {
      errors.push({
        code: 'INVALID_PRICING_OPTION',
        message: `pricing_option_id "${record.pricing_option_id}" is not part of media buy "${record.media_buy_id}".`,
        field: `usage[${i}].pricing_option_id`,
      });
      continue;
    }
    const revenueShare = record.pricing_option_id
      ? pricingContexts?.revenueShares.find(context => context.pricingOptionId === record.pricing_option_id)
      : pricingContexts?.revenueShares[0];
    if (revenueShare) {
      if (!record.pricing_option_id) {
        errors.push({
          code: 'INVALID_USAGE_DATA',
          message: `pricing_option_id is required for revenue-share reconciliation; expected ${revenueShare.pricingOptionId}.`,
          field: `usage[${i}].pricing_option_id`,
        });
        continue;
      }
      if (record.commissionable_value === undefined) {
        errors.push({
          code: 'INVALID_USAGE_DATA',
          message: 'commissionable_value is required for revenue-share reconciliation.',
          field: `usage[${i}].commissionable_value`,
        });
        continue;
      }
      if (record.currency !== revenueShare.currency) {
        errors.push({
          code: 'INVALID_USAGE_DATA',
          message: `currency must match the selected revenue-share pricing option (${revenueShare.currency}).`,
          field: `usage[${i}].currency`,
        });
        continue;
      }
      const expectedCost = roundCurrency(record.commissionable_value * revenueShare.rate, record.currency);
      if (Math.abs(roundCurrency(record.vendor_cost, record.currency) - expectedCost) > Number.EPSILON) {
        errors.push({
          code: 'INVALID_USAGE_DATA',
          message: `vendor_cost must equal round_currency(commissionable_value × commission_rate); expected ${expectedCost}.`,
          field: `usage[${i}].vendor_cost`,
        });
        continue;
      }
      const previouslyAcceptedCost = session.usageRecords
        .filter(existing => existing.mediaBuyId === record.media_buy_id && existing.pricingOptionId === revenueShare.pricingOptionId)
        .reduce((sum, existing) => sum + existing.vendorCost, 0);
      const cumulativeCost = roundCurrency(previouslyAcceptedCost + record.vendor_cost, record.currency);
      if (cumulativeCost > revenueShare.budget) {
        errors.push({
          code: 'INVALID_USAGE_DATA',
          message: `cumulative vendor_cost ${cumulativeCost} exceeds the package commission budget ${revenueShare.budget}.`,
          field: `usage[${i}].vendor_cost`,
        });
        continue;
      }
    }

    // Validate creative_id exists if provided
    if (record.creative_id) {
      if (!creativeBillsThroughAdcp(ctx)) {
        errors.push({
          code: 'BILLING_OUT_OF_BAND',
          message: 'Creative usage for this account bills out of band; do not retry report_usage for billing reconciliation.',
          field: `usage[${i}]`,
          recovery: 'terminal',
        });
        continue;
      }

      const creative = session.creatives.get(record.creative_id) ?? getComplianceCreative(record.creative_id);
      if (!creative) {
        errors.push({ code: 'CREATIVE_NOT_FOUND', message: `Creative "${record.creative_id}" not found in session.`, field: `usage[${i}].creative_id` });
        continue;
      }

      // Validate pricing_option_id matches if provided
      if (record.pricing_option_id && creative.pricingOptionId && record.pricing_option_id !== creative.pricingOptionId) {
        errors.push({
          code: 'INVALID_PRICING_OPTION',
          message: `pricing_option_id mismatch: expected ${creative.pricingOptionId}, received ${record.pricing_option_id}`,
          field: `usage[${i}].pricing_option_id`,
        });
        continue;
      }
    }

    // Validate signal_agent_segment_id exists if provided
    if (record.signal_agent_segment_id) {
      const activation = session.signalActivations.get(record.signal_agent_segment_id);
      if (!activation) {
        errors.push({ code: 'SIGNAL_NOT_FOUND', message: `Signal "${record.signal_agent_segment_id}" not found in session. Use activate_signal first.`, field: `usage[${i}].signal_agent_segment_id` });
        continue;
      }
    }

    // Store the usage record
    session.usageRecords.push({
      account: record.account as import('./types.js').AccountRef,
      mediaBuyId: record.media_buy_id,
      creativeId: record.creative_id,
      signalAgentSegmentId: record.signal_agent_segment_id,
      pricingOptionId: record.pricing_option_id,
      impressions: record.impressions,
      mediaSpend: record.media_spend,
      conversions: record.conversions,
      conversionValue: record.conversion_value,
      commissionableValue: record.commissionable_value,
      vendorCost: record.vendor_cost,
      currency: record.currency,
      final: record.final,
      finalizedAt: record.finalized_at,
      measurementWindow: record.measurement_window,
      reportedAt: new Date().toISOString(),
    });
    accepted++;
  }

  // Use 'rejected' instead of 'errors' for partial acceptance to avoid
  // the MCP server's error detection wrapping the response as an error.
  // When all records are rejected (accepted === 0), return as errors for
  // proper error signaling.
  if (accepted === 0 && errors.length) {
    return { status: 'completed', accepted: 0, errors };
  }
  const result: Record<string, unknown> = { status: 'completed', accepted };
  if (errors.length) result.rejected = errors;
  return result;
}

// ── Handler dispatch ──────────────────────────────────────────────

type ToolHandler = (args: ToolArgs, ctx: TrainingContext) => object | Promise<object>;

type TrainingProposalRecord = SessionState['proposalRefinementRecords'] extends Map<string, infer T>
  ? T
  : never;

function canonicalProposalFromRecord(record: TrainingProposalRecord): CanonicalProposal {
  if (!record.accepted) return structuredClone(record.proposal);
  return {
    ...structuredClone(record.proposal),
    proposal_status: 'accepted',
    accepted_at: record.accepted.accepted_at,
    media_buy_id: record.accepted.media_buy_id,
    base_media_buy_revision: record.accepted.media_buy_revision,
  };
}

function internalProposalFromCanonical(successor: CanonicalProposal, source: Proposal): Proposal {
  const totalBudget = successor.commercial_terms.total_budget;
  const purchaseBudgets = successor.commercial_terms.purchases.map(
    purchase => (purchase as ProposalPurchase & { budget?: number }).budget ?? 0,
  );
  const explicitBudgetTotal = purchaseBudgets.reduce((sum, amount) => sum + amount, 0);
  const allocations = successor.commercial_terms.purchases.map((purchase, index, purchases) => ({
    product_id: purchase.product_id,
    pricing_option_id: purchase.pricing_option_id,
    allocation_percentage: explicitBudgetTotal > 0
      ? purchaseBudgets[index]! / explicitBudgetTotal * 100
      : 100 / purchases.length,
  }));
  const internal = {
    ...structuredClone(source),
    proposal_id: successor.proposal_id,
    name: successor.name,
    ...(successor.description !== undefined && { description: successor.description }),
    ...(successor.brief_alignment !== undefined && { brief_alignment: successor.brief_alignment }),
    allocations,
    ...(totalBudget && {
      total_budget_guidance: {
        min: totalBudget.amount,
        max: totalBudget.amount,
        recommended: totalBudget.amount,
        currency: totalBudget.currency,
      },
    }),
    proposal_status: successor.proposal_status,
    ...(successor.expires_at !== undefined && { expires_at: successor.expires_at }),
    ...(successor.insertion_order !== undefined && { insertion_order: structuredClone(successor.insertion_order) }),
    __source_proposal_id: successor.parent_proposal_id,
    __parent_proposal_id: successor.parent_proposal_id,
    __proposal_kind: successor.proposal_kind,
    ...(successor.media_buy_id !== undefined && { __media_buy_id: successor.media_buy_id }),
    ...(successor.base_media_buy_revision !== undefined && {
      __base_media_buy_revision: successor.base_media_buy_revision,
    }),
    __canonical_commercial_terms: structuredClone(successor.commercial_terms),
    __canonical_terms_digest: successor.terms_digest,
  } as unknown as Record<string, unknown>;
  delete internal.__executed;
  delete internal.__accepted_at;
  delete internal.__media_buy_revision;
  delete internal.__opportunity_update;
  return internal as unknown as Proposal;
}

function purchaseForTrainingProduct(productId: string, source: CanonicalProposal): ProposalPurchase | undefined {
  const product = getCatalog().find(entry => entry.product.product_id === productId)?.product;
  if (!product) return undefined;
  const pricing = product.pricing_options?.[0];
  if (!pricing) return undefined;
  const pricingOptionId = pricing.pricing_option_id;
  return {
    product_id: productId,
    pricing_option_id: pricingOptionId,
    pricing: canonicalPricingSnapshot(pricing, pricingOptionId) as unknown as ProposalPurchase['pricing'],
    start_time: source.commercial_terms.start_time,
    end_time: source.commercial_terms.end_time,
  };
}

function proposalProductsForResults(results: readonly object[]): Array<{ product_id: string; name: string }> {
  const productIds = new Set<string>();
  for (const rawResult of results) {
    const result = rawResult as { outcome?: string; proposal?: CanonicalProposal; proposals?: CanonicalProposal[] };
    const proposals = result.outcome === 'finalized'
      ? result.proposal ? [result.proposal] : []
      : result.proposals ?? [];
    for (const proposal of proposals) {
      for (const purchase of proposal.commercial_terms.purchases) productIds.add(purchase.product_id);
    }
  }
  return getCatalog()
    .map(entry => entry.product)
    .filter(product => productIds.has(product.product_id))
    .map(product => ({ product_id: product.product_id, name: product.name }));
}

function proposalStoreForSession(
  session: SessionState,
  now: Date,
): ProposalRefinementStore<CanonicalProposal> {
  return {
    get(_scope: Readonly<ProposalRefinementScope>, proposalId: string) {
      const record = session.proposalRefinementRecords.get(proposalId);
      if (!record) return null;
      const activeHold = record.activeHold && Date.parse(record.activeHold.expires_at) > now.getTime()
        ? structuredClone(record.activeHold)
        : undefined;
      return {
        proposal: canonicalProposalFromRecord(record),
        version: String(record.version),
        ...(activeHold && { active_hold: activeHold }),
      };
    },
    begin(
      _scope: Readonly<ProposalRefinementScope>,
      expectedSources: readonly ProposalSourceExpectation[],
    ) {
      let staged: readonly CanonicalProposal[] = [];
      return {
        stage(proposals) {
          const ids = new Set<string>();
          for (const proposal of proposals) {
            if (ids.has(proposal.proposal_id) || session.proposalRefinementRecords.has(proposal.proposal_id)) {
              throw new Error(`Proposal successor already exists: ${proposal.proposal_id}`);
            }
            ids.add(proposal.proposal_id);
          }
          staged = structuredClone(proposals);
        },
        commit() {
          const nextRecords = new Map(session.proposalRefinementRecords);
          const currentInternal = session.lastGetProductsContext?.proposals ?? [];
          const nextInternal = [...currentInternal];
          const internalById = new Map(currentInternal.map(proposal => [proposal.proposal_id, proposal]));
          for (const expected of expectedSources) {
            const current = nextRecords.get(expected.proposal_id);
            const version = current ? String(current.version) : null;
            if (version !== expected.version) {
              throw new Error(`Proposal source version changed: ${expected.proposal_id}`);
            }
            if (
              expected.action === 'finalize'
              && current?.activeHold
              && Date.parse(current.activeHold.expires_at) > now.getTime()
            ) {
              throw new Error(`Proposal source already has an active hold: ${expected.proposal_id}`);
            }
          }
          for (const proposal of staged) {
            const sourceId = proposal.parent_proposal_id;
            const sourceInternal = sourceId ? internalById.get(sourceId) : undefined;
            if (!sourceInternal) throw new Error(`Internal source proposal is missing: ${sourceId ?? 'unknown'}`);
            const internal = internalProposalFromCanonical(proposal, sourceInternal);
            nextInternal.push(internal);
            internalById.set(proposal.proposal_id, internal);
            nextRecords.set(proposal.proposal_id, {
              proposal: structuredClone(proposal),
              version: 1,
            });
          }
          for (const expected of expectedSources) {
            const current = nextRecords.get(expected.proposal_id)!;
            const hold = expected.action === 'finalize'
              ? staged.find(proposal => proposal.parent_proposal_id === expected.proposal_id)
              : undefined;
            nextRecords.set(expected.proposal_id, {
              ...current,
              version: current.version + 1,
              ...(hold?.expires_at && {
                activeHold: { proposal_id: hold.proposal_id, expires_at: hold.expires_at },
              }),
            });
          }
          session.proposalRefinementRecords = nextRecords;
          session.lastGetProductsContext = {
            products: session.lastGetProductsContext?.products,
            proposals: nextInternal,
          };
        },
        rollback() {
          staged = [];
        },
      };
    },
  };
}

async function handleTypedProposalRefinement(args: ToolArgs, ctx: TrainingContext): Promise<object> {
  const profile = ctx.proposalNegotiationProfile;
  if (!profile || profile === 'ask-only') {
    return { errors: [{ code: 'UNSUPPORTED_FEATURE', message: 'Typed proposal negotiation is not enabled.' }] };
  }
  const sessionScope = sessionKeyFromArgs({}, ctx.mode, ctx.userId, ctx.moduleId, ctx.principal ?? 'anonymous');
  const sessionHash = createHash('sha256').update(sessionScope).digest('hex');
  const lockPrincipal = 'get-products-session-mutex';
  const lockKey = `get-products-session:${sessionHash}`;
  const lockStore = getIdempotencyStore();
  const claim = await lockStore.check({
    principal: lockPrincipal,
    key: lockKey,
    payload: { session: sessionHash },
  });
  if (claim.kind !== 'miss') {
    return {
      errors: [{
        code: 'CONFLICT',
        message: 'Another proposal lifecycle request is already updating this session. Retry shortly.',
        recovery: 'transient',
      }],
    };
  }
  try {
    evictSessionFromRequestCache(sessionScope);
    const session = await getSession(sessionScope);
    const now = new Date();
    const activeHoldCount = Array.from(session.proposalRefinementRecords.values())
      .filter(record => record.activeHold && Date.parse(record.activeHold.expires_at) > now.getTime())
      .length;
    const policyContext: TrainingProposalPolicyContext = {
      profile,
      now,
      activeHoldCount,
      purchaseForProduct: purchaseForTrainingProduct,
    };
    const handler = createProposalRefinementHandler<
      CanonicalProposal,
      { product_id: string; name: string },
      TrainingProposalPolicyContext
    >({
      capabilities: proposalCapabilitiesForProfile(profile),
      store: proposalStoreForSession(session, now),
      scope: (): ProposalRefinementScope => ({
        tenant_id: ctx.tenantId ?? 'sales',
        principal_id: ctx.principal ?? 'anonymous',
      }),
      evaluate: evaluation => evaluateTrainingProposal(evaluation),
      products: results => proposalProductsForResults(results),
      now: () => now,
    });
    const response = await handler({
      ...(args as unknown as RefineProposalsRequest),
      adcp_version: '3.2',
      adcp_major_version: 3,
    }, policyContext);
    await flushDirtySessions();
    return response;
  } catch (error) {
    const structured = error as Error & {
      code?: string;
      field?: string;
      recovery?: string;
      details?: Record<string, unknown>;
    };
    const classifiedDomainFailure =
      Boolean(structured.code) ||
      structured.message?.startsWith('Proposal source version changed:') ||
      structured.message?.startsWith('Proposal source already has an active hold:') ||
      structured.message?.startsWith('Proposal successor already exists:');
    if (!classifiedDomainFailure) {
      logger.error({ error, profile, sessionHash }, 'Unexpected proposal refinement failure');
    }
    return {
      errors: [{
        code: structured.code ?? 'INVALID_STATE',
        message: structured.message,
        ...(structured.field && { field: structured.field }),
        ...(structured.recovery && { recovery: structured.recovery }),
        ...(structured.details && { details: structured.details }),
      }],
    };
  } finally {
    await lockStore.release({
      principal: lockPrincipal,
      key: lockKey,
      claimToken: claim.claimToken,
    });
  }
}

const HANDLER_MAP: Record<string, ToolHandler> = {
  get_products: handleGetProducts,
  list_products: handleGetProducts,
  request_proposals: handleGetProducts,
  refine_proposals: handleGetProducts,
  decline_proposals: handleGetProducts,
  list_creative_formats: handleListCreativeFormats,
  validate_input: handleValidateInput,
  create_media_buy: handleCreateMediaBuy,
  get_media_buys: handleGetMediaBuys,
  get_media_buy_delivery: handleGetMediaBuyDelivery,
  get_creative_delivery: handleGetCreativeDelivery,
  sync_creatives: handleSyncCreatives,
  list_creatives: handleListCreatives,
  build_creative: handleBuildCreative,
  preview_creative: handlePreviewCreative,
  update_media_buy: handleUpdateMediaBuy,
  get_signals: handleGetSignals,
  activate_signal: handleActivateSignal,
  list_accounts: handleListAccounts,
  sync_accounts: handleSyncAccounts,
  sync_governance: handleSyncGovernance,
  sync_catalogs: handleSyncCatalogs,
  sync_event_sources: handleSyncEventSources,
  sync_audiences: handleSyncAudiences,
  log_event: handleLogEvent,
  provide_performance_feedback: handleProvidePerformanceFeedback,
  sync_plans: handleSyncPlans,
  check_governance: handleCheckGovernance,
  report_plan_outcome: handleReportPlanOutcome,
  report_plan_adjustment: handleReportPlanAdjustment,
  get_plan_audit_logs: handleGetPlanAuditLogs,
  search_brands: handleSearchBrands,
  get_brand_identity: handleGetBrandIdentity,
  get_rights: handleGetRights,
  acquire_rights: handleAcquireRights,
  update_rights: handleUpdateRights,
  creative_approval: handleCreativeApproval,
  create_property_list: handleCreatePropertyList,
  list_property_lists: handleListPropertyLists,
  get_property_list: handleGetPropertyList,
  update_property_list: handleUpdatePropertyList,
  delete_property_list: handleDeletePropertyList,
  validate_property_delivery: handleValidatePropertyDelivery,
  create_collection_list: handleCreateCollectionList,
  get_collection_list: handleGetCollectionList,
  update_collection_list: handleUpdateCollectionList,
  list_collection_lists: handleListCollectionLists,
  delete_collection_list: handleDeleteCollectionList,
  create_content_standards: handleCreateContentStandards,
  list_content_standards: handleListContentStandards,
  get_content_standards: handleGetContentStandards,
  update_content_standards: handleUpdateContentStandards,
  calibrate_content: handleCalibrateContent,
  validate_content_delivery: handleValidateContentDelivery,
  get_adcp_capabilities: handleGetAdcpCapabilities,
  report_usage: handleReportUsage,
  comply_test_controller: handleComplyTestController,
};

function validateIdempotencyProtectedInput(
  toolName: string,
  args: Record<string, unknown>,
): { message: string; field?: string } | undefined {
  if (toolName !== 'get_products') return undefined;
  if (args.brief !== undefined && typeof args.brief !== 'string') {
    return { message: 'brief must be a string when provided', field: 'brief' };
  }
  const hasDecline = Array.isArray(args.refine) && args.refine.some(entry => (
    isRecord(entry) && entry.scope === 'proposal' && entry.action === 'decline'
  ));
  const compactDecline = args.__decline_proposals === true;
  if (hasDecline) {
    if (!compactDecline) {
      return {
        message: 'Proposal decline is available through the dedicated decline_proposals task.',
        field: 'refine',
      };
    }
    const reasons = new Set([
      'price', 'inventory_fit', 'audience_fit', 'creative_unsupported', 'measurement_unsupported',
      'policy', 'timing', 'budget_changed', 'selected_alternative', 'other',
    ]);
    const invalidIndex = (args.refine as unknown[]).findIndex(entry => (
      isRecord(entry)
      && entry.scope === 'proposal'
      && entry.action === 'decline'
      && (
        typeof entry.proposal_id !== 'string'
        || typeof entry.reason !== 'string'
        || !reasons.has(entry.reason)
        || (entry.reason === 'other' && !(typeof entry.detail === 'string' && entry.detail.length > 0))
      )
    ));
    if (invalidIndex >= 0) {
      return {
        message: `Invalid get_products request at refine[${invalidIndex}]: decline requires proposal_id, a supported reason, and detail when reason is other.`,
        field: `refine[${invalidIndex}]`,
      };
    }
  }
  // A dedicated decline request was validated against its public source schema
  // before normalization. All public get_products shapes continue through the
  // SDK parser, whose schema intentionally does not expose the internal action.
  if (!compactDecline) {
    const parsed = GetProductsRequestSchema.safeParse(args);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = issue?.path.map(segment => String(segment)).join('.');
      return {
        message: `Invalid get_products request${field ? ` at ${field}` : ''}: ${issue?.message ?? 'schema validation failed'}`,
        ...(field && { field }),
      };
    }
    if (parsed.data.pagination && decodeOffsetCursor('products', parsed.data.pagination.cursor) === null) {
      return { message: 'pagination.cursor is malformed', field: 'pagination.cursor' };
    }
  }

  // Finalization is a commit boundary, not another refinement. Reject mixed
  // arrays before the idempotency store is consulted so an invalid request
  // cannot reserve a key or partially mutate an earlier proposal entry.
  if (Array.isArray(args.refine)) {
    const hasFinalize = args.refine.some(entry => (
      isRecord(entry)
      && entry.scope === 'proposal'
      && entry.action === 'finalize'
    ));
    if (hasFinalize) {
      const mixedIndex = args.refine.findIndex(entry => !(
        isRecord(entry)
        && entry.scope === 'proposal'
        && entry.action === 'finalize'
      ));
      if (mixedIndex >= 0) {
        return {
          message: `Invalid get_products request at refine[${mixedIndex}]: proposal finalization cannot be mixed with request, product, include, or omit refinements. Send finalization as a separate request.`,
          field: `refine[${mixedIndex}]`,
        };
      }
    }
  }
  return undefined;
}

function applyThreeZeroGetProductsIdempotencyCompatibility(
  toolName: string,
  args: Record<string, unknown>,
  scopedCallerPrincipal: string,
  compatibilityEnabled: boolean,
): Record<string, unknown> {
  if (
    toolName !== 'get_products'
    || !compatibilityEnabled
    || args.idempotency_key !== undefined
  ) {
    return args;
  }

  // Frozen 3.0 get_products examples predate the shared replay contract. Give only
  // that legacy wire shape a deterministic internal key so exact retries still
  // converge through the normal schema/cache/task/finalize path. Context and
  // version negotiation are envelope concerns, not logical request identity.
  const {
    context: _context,
    context_id: _contextId,
    adcp_version: _adcpVersion,
    adcp_major_version: _adcpMajorVersion,
    ...canonicalRequest
  } = args;
  const fingerprint = createHash('sha256')
    .update(scopedCallerPrincipal)
    .update('\0')
    .update(payloadHash(canonicalRequest))
    .digest('hex');
  return {
    ...canonicalRequest,
    idempotency_key: `compat30:${fingerprint}`,
  };
}

const REFINEMENT_CONSTRAINT_DIMENSIONS = ['total_budget', 'cpm', 'impressions', 'flight'] as const;

type UnsupportedTrainingRefinement = {
  field: string;
  dimension: (typeof REFINEMENT_CONSTRAINT_DIMENSIONS)[number] | 'product_changes' | 'alternatives' | 'criteria';
  index: number;
};

function usesTypedProposalNegotiation(ctx: TrainingContext): boolean {
  return ctx.proposalNegotiationProfile !== undefined
    && ctx.proposalNegotiationProfile !== 'ask-only';
}

function unsupportedTrainingProposalRefinement(
  toolName: string,
  args: Record<string, unknown>,
): UnsupportedTrainingRefinement | undefined {
  if (toolName !== 'refine_proposals' || !Array.isArray(args.refinements)) return undefined;
  for (const [index, refinement] of args.refinements.entries()) {
    if (!isRecord(refinement)) continue;
    if (isRecord(refinement.constraints)) {
      const dimension = REFINEMENT_CONSTRAINT_DIMENSIONS.find(
        key => (refinement.constraints as Record<string, unknown>)[key] !== undefined,
      );
      if (dimension) return { field: `constraints.${dimension}`, dimension, index };
    }
    if (refinement.product_changes !== undefined) return { field: 'product_changes', dimension: 'product_changes', index };
    if (refinement.alternatives !== undefined) return { field: 'alternatives', dimension: 'alternatives', index };
    if (refinement.criteria !== undefined) return { field: 'criteria', dimension: 'criteria', index };
  }
  return undefined;
}

/**
 * Execute a training agent tool in-process (no HTTP round-trip).
 * Used by Addie's adcp-tools during certification demos.
 */
export async function executeTrainingAgentTool(
  toolName: string,
  args: ToolArgs,
  ctx: TrainingContext,
): Promise<{ success: boolean; data?: object; error?: string }> {
  return runWithSessionContext(async () => {
    const result = await executeTrainingAgentToolInContext(toolName, args, ctx);
    if (result.success) await flushDirtySessions();
    return result;
  });
}

async function executeTrainingAgentToolInContext(
  toolName: string,
  args: ToolArgs,
  ctx: TrainingContext,
): Promise<{ success: boolean; data?: object; error?: string }> {
  // Context is an envelope field: it is excluded from request equivalence,
  // never passed into domain handlers, and echoed from the current attempt.
  // Keeping it out of the cached inner response prevents a replay from
  // returning the original caller's correlation data.
  const rawArgs = args as unknown as Record<string, unknown>;
  const { context: callerContext, ...initialHandlerArgs } = rawArgs;
  const versionResolution = resolveServedAdcpVersionForTool(toolName, initialHandlerArgs);
  if (!versionResolution.ok) {
    return { success: false, error: versionResolution.message };
  }
  if (
    !visibleTrainingToolNamesForContext(ctx).includes(toolName)
    || !toolAvailableForServedAdcpVersion(toolName, versionResolution.servedVersion)
  ) {
    return { success: false, error: `Unknown tool: ${toolName}` };
  }
  const handler = toolName === 'refine_proposals' && usesTypedProposalNegotiation(ctx)
    ? handleTypedProposalRefinement
    : HANDLER_MAP[toolName];
  if (!handler) {
    return { success: false, error: `Unknown tool: ${toolName}` };
  }
  if (isMutatingTool(toolName) && initialHandlerArgs.idempotency_key == null) {
    return { success: false, error: `idempotency_key is required for ${toolName}` };
  }
  const sourceSchemaName = productDiscoverySourceSchemaName(toolName);
  const strictSourceSchemaName = sourceSchemaName
    ?? (toolName === 'create_media_buy' && rawArgs.opportunity !== undefined
      ? 'create-media-buy-request'
      : undefined);
  const sourceValidationError = strictSourceSchemaName
    ? validateProductDiscoverySourceInput(strictSourceSchemaName, rawArgs)
    : undefined;
  if (sourceValidationError) {
    return { success: false, error: sourceValidationError.message };
  }
  const aliasValidationError = validateProductDiscoveryAliasInput(toolName, initialHandlerArgs);
  if (aliasValidationError) {
    return { success: false, error: aliasValidationError.message };
  }
  const unsupportedRefinement = usesTypedProposalNegotiation(ctx)
    ? undefined
    : unsupportedTrainingProposalRefinement(toolName, initialHandlerArgs);
  if (unsupportedRefinement) {
    return {
      success: false,
      error: `UNSUPPORTED_FEATURE at refinements.${unsupportedRefinement.index}.${unsupportedRefinement.field}: The training seller does not support the ${unsupportedRefinement.dimension} typed proposal-refinement dimension.`,
    };
  }
  const normalizedHandlerArgs = toolName === 'refine_proposals' && usesTypedProposalNegotiation(ctx)
    ? initialHandlerArgs
    : normalizeProductDiscoveryArgs(toolName, initialHandlerArgs);
  const authPrincipal = ctx.principal ?? ctx.userId ?? 'anonymous';
  let accountScope: string | undefined;
  try {
    accountScope = toolName === 'comply_test_controller'
      ? undefined
      : await deriveProductDiscoveryAccountScope(toolName, initialHandlerArgs, normalizedHandlerArgs, ctx);
  } catch (error) {
    if (!(error instanceof AccountRefValidationError)) throw error;
    return { success: false, error: `Invalid ${toolName} request at account: ${error.message}` };
  }
  const principal = scopedPrincipal(authPrincipal, accountScope);
  const handlerArgs = applyThreeZeroGetProductsIdempotencyCompatibility(
    toolName,
    normalizedHandlerArgs,
    principal,
    ctx.storyboardCompat?.version === '3.0' || initialHandlerArgs.adcp_version === '3.0',
  );
  const idempotencyKey = handlerArgs.idempotency_key;
  let claim: { payloadHash: string; claimToken: string } | undefined;

  // The read-only legacy/list surfaces permit keyless calls, but they still
  // share the canonical get_products request contract. Validate the logical
  // request before deciding whether this attempt participates in replay.
  const productValidationError = toolName === 'refine_proposals' && usesTypedProposalNegotiation(ctx)
    ? undefined
    : validateIdempotencyProtectedInput(canonicalProductDiscoveryTool(toolName), handlerArgs);
  if (productValidationError) {
    return { success: false, error: productValidationError.message };
  }

  if (isMutatingTool(toolName) || idempotencyKey !== undefined) {
    if (isMutatingTool(toolName) && (idempotencyKey === undefined || idempotencyKey === null)) {
      return { success: false, error: `idempotency_key is required for ${toolName}` };
    }
    if (!validateKeyFormat(idempotencyKey)) {
      return { success: false, error: 'idempotency_key has an invalid format' };
    }
    const outcome = await getIdempotencyStore().check({
      principal,
      key: idempotencyKey,
      payload: idempotencyPayloadForServedVersion(
        toolName,
        sourceSchemaName ? initialHandlerArgs : handlerArgs,
        versionResolution.servedVersion,
      ),
    });
    if (outcome.kind === 'replay') {
      const replayed = projectProductDiscoveryResult(
        toolName,
        outcome.response as Record<string, unknown>,
        initialHandlerArgs,
      );
      return {
        success: true,
        data: {
          ...replayed,
          adcp_version: versionResolution.servedVersion,
          replayed: true,
          ...(callerContext !== undefined && { context: callerContext }),
        },
      };
    }
    if (outcome.kind === 'expired') {
      return { success: false, error: 'IDEMPOTENCY_EXPIRED' };
    }
    if (outcome.kind === 'conflict') {
      return { success: false, error: 'IDEMPOTENCY_CONFLICT' };
    }
    if (outcome.kind === 'in-flight') {
      return {
        success: false,
        error: `IDEMPOTENCY_IN_FLIGHT: matching request is already in progress; retry_after=${outcome.retryAfterSeconds}`,
      };
    }
    claim = { payloadHash: outcome.payloadHash, claimToken: outcome.claimToken };
  }
  try {
    const result = await Promise.resolve(handler(
      handlerArgs as ToolArgs,
      { ...ctx, servedAdcpVersion: versionResolution.servedVersion },
    ));
    const cacheResponse = addServedAdcpVersion(result, versionResolution.servedVersion) as Record<string, unknown>;
    const projectedResponse = projectProductDiscoveryResult(
      toolName,
      result as Record<string, unknown>,
      initialHandlerArgs,
    );
    const response = addServedAdcpVersion(projectedResponse, versionResolution.servedVersion, callerContext) as Record<string, unknown>;
    if (claim && typeof idempotencyKey === 'string') {
      const hasErrors = Array.isArray(cacheResponse.errors) && cacheResponse.errors.length > 0;
      const hasAdvisorySuccessPayload = permitsAdvisoryErrors(toolName, cacheResponse);
      if (hasErrors && !hasAdvisorySuccessPayload) {
        await getIdempotencyStore().release({
          principal,
          key: idempotencyKey,
          claimToken: claim.claimToken,
        });
      } else {
        // get_products finalization state must be durable before its replay is
        // published. Other tools retain the historical save-then-flush order;
        // moving every synchronous mutation to flush-first creates a new
        // duplicate-execution window if cache publication fails.
        if (isProductDiscoveryTool(toolName)) await flushDirtySessions();
        await getIdempotencyStore().save({
          principal,
          key: idempotencyKey,
          payloadHash: claim.payloadHash,
          response: cacheResponse,
          claimToken: claim.claimToken,
        });
      }
    }
    return { success: true, data: response };
  } catch (error) {
    if (claim && typeof idempotencyKey === 'string') {
      await getIdempotencyStore().release({
        principal,
        key: idempotencyKey,
        claimToken: claim.claimToken,
      });
    }
    logger.error({ error, tool: toolName }, 'Training agent in-process tool error');
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

// ── MCP Server factory ────────────────────────────────────────────

/**
 * Create a per-request MCP Server with training agent tools.
 */
export function createTrainingAgentServer(ctx: TrainingContext): Server {
  const taskStore = getTrainingTaskStore();
  const server = new Server(
    { name: 'adcp-training-agent', version: '1.0.0' },
    {
      capabilities: {
        tools: {},
        tasks: {
          list: {},
          cancel: {},
          requests: { tools: { call: {} } },
        },
      },
      taskStore,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: visibleToolsForContext(ctx) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    // Wrap handler execution + task storage in a per-request session context so
    // getSession() calls cache within the request and real mutations are flushed
    // at the end (solves cross-Fly-machine persistence). Flush only on clean
    // return from the handler — if the handler threw, discard any in-progress
    // session state rather than persisting half-mutated data.
    return runWithSessionContext(async () => {
      const { result, flushable } = await dispatchCallTool(request, extra);
      if (flushable) await flushDirtySessions();
      return result;
    });
  });
  installTaskProtocolVersionNegotiation(server);

  async function dispatchCallTool(
    request: { params: { name: string; arguments?: unknown; task?: { ttl?: number } } },
    _extra: unknown,
  ): Promise<{ result: object; flushable: boolean }> {
    const { name, arguments: args } = request.params;

    // Extract and strip context before passing args to handlers (AdCP requirement:
    // echo caller's context object back unchanged in every response).
    const rawArgs = (args as Record<string, unknown> | undefined) ?? {};
    const { context: callerContext, ...initialHandlerArgs } = rawArgs;
    const versionResolution = resolveServedAdcpVersionForTool(name, initialHandlerArgs);

    const handler = name === 'refine_proposals' && usesTypedProposalNegotiation(ctx)
      ? handleTypedProposalRefinement
      : HANDLER_MAP[name];

    if (!versionResolution.ok) {
      return {
        result: adcpError('VERSION_UNSUPPORTED', {
          message: versionResolution.message,
          details: versionResolution.details,
          field: versionResolution.field,
        }, callerContext),
        flushable: true,
      };
    }
    const servedAdcpVersion = versionResolution.servedVersion;

    if (
      !handler
      || !visibleTrainingToolNamesForContext(ctx).includes(name)
      || !toolAvailableForServedAdcpVersion(name, servedAdcpVersion)
    ) {
      // Pre-handler validation failures don't touch session state, so flushing
      // is a no-op; leaving flushable=true keeps behaviour consistent for
      // requests whose handlers DO legitimately mutate before failing.
      return { result: adcpError('INVALID_REQUEST', { message: `Unknown tool: ${name}` }, callerContext, servedAdcpVersion), flushable: true };
    }

    if (isMutatingTool(name) && initialHandlerArgs.idempotency_key == null) {
      return {
        result: adcpError('INVALID_REQUEST', {
          message: `idempotency_key is required for ${name}. Generate a UUID v4 and reuse it unchanged for retries.`,
          field: 'idempotency_key',
          recovery: 'correctable',
        }, callerContext, servedAdcpVersion),
        flushable: true,
      };
    }

    const sourceSchemaName = productDiscoverySourceSchemaName(name);
    const strictSourceSchemaName = sourceSchemaName
      ?? (name === 'create_media_buy' && rawArgs.opportunity !== undefined
        ? 'create-media-buy-request'
        : undefined);
    const sourceValidationError = strictSourceSchemaName
      ? validateProductDiscoverySourceInput(strictSourceSchemaName, rawArgs)
      : undefined;
    if (sourceValidationError) {
      return {
        result: adcpError('INVALID_REQUEST', {
          message: sourceValidationError.message,
          ...(sourceValidationError.field && { field: sourceValidationError.field }),
          recovery: 'correctable',
        }, callerContext, servedAdcpVersion),
        flushable: true,
      };
    }

    const aliasValidationError = validateProductDiscoveryAliasInput(name, initialHandlerArgs);
    if (aliasValidationError) {
      return {
        result: adcpError(aliasValidationError.code ?? 'INVALID_REQUEST', {
          message: aliasValidationError.message,
          ...(aliasValidationError.field && { field: aliasValidationError.field }),
          recovery: 'correctable',
        }, callerContext, servedAdcpVersion),
        flushable: true,
      };
    }

    const unsupportedRefinement = usesTypedProposalNegotiation(ctx)
      ? undefined
      : unsupportedTrainingProposalRefinement(name, initialHandlerArgs);
    if (unsupportedRefinement) {
      return {
        result: adcpError('UNSUPPORTED_FEATURE', {
          message: `The training seller does not support the ${unsupportedRefinement.dimension} typed proposal-refinement dimension.`,
          field: `refinements.${unsupportedRefinement.index}.${unsupportedRefinement.field}`,
          details: {
            unsupported_dimension: unsupportedRefinement.dimension,
            supported_dimensions: [],
          },
          recovery: 'correctable',
        }, callerContext, servedAdcpVersion),
        flushable: true,
      };
    }
    const normalizedHandlerArgs = name === 'refine_proposals' && usesTypedProposalNegotiation(ctx)
      ? initialHandlerArgs
      : normalizeProductDiscoveryArgs(name, initialHandlerArgs);

    // Check for task-augmented request (explicit `task` field in params).
    // Dry-run requests always return synchronously — there's no reason to
    // async a dry-run operation, and clients expect immediate results.
    const taskField = (request.params as { task?: { ttl?: number } }).task;
    const isDryRun = rawArgs.dry_run === true;
    const isTaskRequest = taskField !== undefined && !isDryRun;
    if (isTaskRequest && !toolSupportsTask(name)) {
      throw new Error(`Tool "${name}" does not support task augmentation`);
    }

    // Idempotency enforcement for mutating tools (#2315, #2346).
    // Key presence + format are schema-level requirements; we check them
    // before the handler so a malformed key never touches the cache
    // (prevents key-format-accepting cache misses from leaking timing).
    const authPrincipal = ctx.principal ?? 'anonymous';
    // Partition the idempotency cache by caller-stated account scope so the
    // shared public sandbox token doesn't pool every buyer into one oracle
    // (security.mdx §"three-state response"). An attacker on the same auth
    // principal using a different account ref can still cross-probe, but
    // callers can already enumerate their own account's keys — so the
    // scoping adds no useful probing surface while closing the cross-caller
    // leak.
    let accountScope: string | undefined;
    try {
      accountScope = name === 'comply_test_controller'
        ? undefined
        : await deriveProductDiscoveryAccountScope(name, initialHandlerArgs, normalizedHandlerArgs, ctx);
    } catch (error) {
      if (!(error instanceof AccountRefValidationError)) throw error;
      return {
        result: adcpError('INVALID_REQUEST', {
          message: error.message,
          field: error.field,
          recovery: 'correctable',
        }, callerContext, servedAdcpVersion),
        flushable: true,
      };
    }
    const idempotencyPrincipal = scopedPrincipal(authPrincipal, accountScope);
    const handlerArgs = applyThreeZeroGetProductsIdempotencyCompatibility(
      name,
      normalizedHandlerArgs,
      idempotencyPrincipal,
      ctx.storyboardCompat?.version === '3.0' || initialHandlerArgs.adcp_version === '3.0',
    );
    const idempotencyKey = (handlerArgs as { idempotency_key?: unknown }).idempotency_key;
    let toolResult: CallToolResult | null = null;
    let taskFailed = false;
    let handlerThrew = false;
    let cachableResponse: Record<string, unknown> | null = null;
    let skipHandler = false;
    let idempotencyPayloadHash: string | undefined;
    let idempotencyClaimed = false;
    let idempotencyClaimToken: string | undefined;
    let idempotencyReplayed = false;

    // Product reads may omit an idempotency key, but keylessness must never
    // weaken their request validation. The split names normalize to the same
    // canonical get_products contract before this check.
    const productValidationError = name === 'refine_proposals' && usesTypedProposalNegotiation(ctx)
      ? undefined
      : validateIdempotencyProtectedInput(canonicalProductDiscoveryTool(name), handlerArgs);
    if (productValidationError) {
      return {
        result: adcpError('INVALID_REQUEST', {
          message: productValidationError.message,
          ...(productValidationError.field && { field: productValidationError.field }),
          recovery: 'correctable',
        }, callerContext, servedAdcpVersion),
        flushable: true,
      };
    }

    if (isMutatingTool(name) || idempotencyKey !== undefined) {
      if (isMutatingTool(name) && (idempotencyKey === undefined || idempotencyKey === null)) {
        return {
          result: adcpError('INVALID_REQUEST', {
            message: `idempotency_key is required for ${name}. Generate a UUID v4 and include it on every mutating request; reuse the same key for network retries.`,
            field: 'idempotency_key',
            recovery: 'correctable',
          }, callerContext, servedAdcpVersion),
          flushable: true,
        };
      }
      if (!validateKeyFormat(idempotencyKey)) {
        return {
          result: adcpError('INVALID_REQUEST', {
            message: 'idempotency_key must match ^[A-Za-z0-9_.:-]{16,255}$ (UUID v4 recommended).',
            field: 'idempotency_key',
            recovery: 'correctable',
          }, callerContext, servedAdcpVersion),
          flushable: true,
        };
      }
      const store = getIdempotencyStore();
      const idempotencyPayload = idempotencyPayloadForServedVersion(
        name,
        sourceSchemaName ? initialHandlerArgs : handlerArgs,
        servedAdcpVersion,
      );
      const outcome = await store.check({
        principal: idempotencyPrincipal,
        key: idempotencyKey,
        payload: idempotencyPayload,
      });
      if (outcome.kind === 'expired') {
        return {
          result: adcpError('IDEMPOTENCY_EXPIRED', {
            message: 'idempotency_key is past the replay window. Generate a fresh UUID v4 and resend.',
            recovery: 'correctable',
          }, callerContext, servedAdcpVersion),
          flushable: true,
        };
      }
      if (outcome.kind === 'conflict') {
        // Error body carries code + message only — no `field` json-pointer,
        // no cached payload, no hash, no `recovery` hint. Any shape hint
        // turns key-reuse into a read oracle (security.mdx §IDEMPOTENCY_CONFLICT
        // response shape). The universal idempotency storyboard's
        // `idempotency.conflict_no_payload_leak` cross-step assertion
        // enforces the allowlist on this specific error's envelope.
        return {
          result: adcpError('IDEMPOTENCY_CONFLICT', {
            message: 'idempotency_key was used with a different payload within the replay window. Either resend the exact original payload (to return the cached response) or generate a fresh UUID v4 to submit this new payload.',
          }, callerContext, servedAdcpVersion),
          flushable: true,
        };
      }
      if (outcome.kind === 'in-flight') {
        return {
          result: adcpError('IDEMPOTENCY_IN_FLIGHT', {
            message: 'A concurrent request with this idempotency_key is already in progress. Retry after a short delay.',
            recovery: 'transient',
            retry_after: outcome.retryAfterSeconds,
          }, callerContext, servedAdcpVersion),
          flushable: true,
        };
      }
      if (outcome.kind === 'replay') {
        // Cached inner response; envelope fields (`replayed`, `context`,
        // `status`) are produced fresh on every response per security.mdx.
        // Replayed responses bypass the handler entirely — no mutations, no
        // flush. We stamp envelope `status: 'completed'` defensively in case
        // the cached inner doesn't carry one (older cache entries written
        // before the envelope-fold landed, or handlers that emitted bodies
        // without status). Per #4878, every per-task response schema now
        // requires envelope `status`.
        const replayBody = projectProductDiscoveryResult(
          name,
          outcome.response as Record<string, unknown>,
          initialHandlerArgs,
        );
        const body: Record<string, unknown> = { ...replayBody, replayed: true };
        if (!isTaskRequest && body.status === undefined) body.status = 'completed';
        body.adcp_version = servedAdcpVersion;
        if (callerContext !== undefined) body.context = callerContext;
        toolResult = {
          content: [{ type: 'text', text: `${name} replay completed successfully.` }],
          structuredContent: body,
        };
        cachableResponse = { ...(outcome.response as Record<string, unknown>) };
        idempotencyPayloadHash = payloadHash(idempotencyPayload);
        skipHandler = true;
        idempotencyReplayed = true;
      } else {
        // 'miss' → the store reserved the claim via putIfAbsent. We must
        // call save() on success or release() on any other path so the
        // placeholder doesn't leak.
        idempotencyPayloadHash = outcome.payloadHash;
        idempotencyClaimToken = outcome.claimToken;
        idempotencyClaimed = true;

        // A previous task execution may have durably stored both its domain
        // state and terminal task result, then failed while publishing the
        // idempotency-cache entry. Recover that successful task before the
        // domain handler runs: looking it up afterward can hide a duplicated
        // media buy (or other side effect) behind the original task envelope.
        if (isTaskRequest) {
          const naturalKey = idempotentTaskNaturalKey(
            idempotencyPrincipal,
            name,
            idempotencyKey,
            idempotencyPayloadHash,
          );
          try {
            const recoveredTask = await getIdempotentTask(taskStore, naturalKey);
            if (recoveredTask) {
              if (recoveredTask.status === 'cancelled' || recoveredTask.status === 'failed') {
                // Cancellation is terminal buyer intent, and failed task
                // results are deliberately not cached. Never rerun either
                // receipt as crash recovery: doing so could publish a success
                // cache/webhook that the returned terminal task cannot expose.
                await store.release({
                  principal: idempotencyPrincipal,
                  key: idempotencyKey,
                  claimToken: idempotencyClaimToken,
                });
                return {
                  result: {
                    task: recoveredTask,
                    adcp_version: servedAdcpVersion,
                    replayed: true,
                    ...(callerContext !== undefined && { context: callerContext }),
                  },
                  flushable: false,
                };
              }
              if (recoveredTask.status !== 'completed') {
                // get_products commits converge on the exact stored proposal
                // (including IO and expiry), so it is safe to repair an
                // orphaned deterministic task by rerunning the handler and
                // storing the result into the same task below. Other mutators
                // may have non-reconstructable random IDs and must fail closed.
                if (!isProductDiscoveryTool(name)) {
                  throw new Error(`Prior idempotent task ${recoveredTask.taskId} is not recoverable in status ${recoveredTask.status}`);
                }
              } else {
                const recoveredResult = await taskStore.getTaskResult(recoveredTask.taskId) as CallToolResult;
                const recoveredBody = isRecord(recoveredResult.structuredContent)
                  ? recoveredResult.structuredContent
                  : undefined;
                if (recoveredResult.isError || !recoveredBody) {
                  throw new Error(`Prior idempotent task ${recoveredTask.taskId} has no successful structured result`);
                }

                const {
                  context: _cachedContext,
                  replayed: _cachedReplayMarker,
                  ...notificationResponse
                } = recoveredBody;
                const taskResponse = { task: recoveredTask, adcp_version: servedAdcpVersion };
                await store.save({
                  principal: idempotencyPrincipal,
                  key: idempotencyKey,
                  payloadHash: idempotencyPayloadHash,
                  response: notificationResponse,
                  claimToken: idempotencyClaimToken,
                });
                maybeEmitCompletionWebhook({
                  toolName: name,
                  args: initialHandlerArgs,
                  response: notificationResponse,
                  requestIdempotencyKey: idempotencyKey,
                  principal: idempotencyPrincipal,
                });
                return {
                  result: {
                    ...taskResponse,
                    replayed: true,
                    ...(callerContext !== undefined && { context: callerContext }),
                  },
                  flushable: false,
                };
              }
            }
          } catch (error) {
            await store.release({
              principal: idempotencyPrincipal,
              key: idempotencyKey,
              claimToken: idempotencyClaimToken,
            });
            throw error;
          }
        }
      }
    }

    // Execute the tool handler. Structured AdCP error-only bodies (handler
    // returns { errors: [...] }) are well-formed responses — the task
    // completes successfully with an adcp_error envelope. Some response
    // schemas also permit non-fatal advisories in errors[] alongside a
    // populated success body; those must stay on the success response.
    if (skipHandler) {
      // toolResult already set from idempotency replay path above
    } else try {
      const result = await Promise.resolve(handler(
        (handlerArgs as ToolArgs) || {},
        { ...ctx, servedAdcpVersion },
      ));
      const resultObj = result as Record<string, unknown> & {
        errors?: Array<{ code: string; message: string; field?: string; details?: unknown; recovery?: string }>;
      };
      const hasErrors = Array.isArray(resultObj.errors) && resultObj.errors.length > 0;
      const hasAdvisorySuccessPayload = permitsAdvisoryErrors(name, resultObj);
      if (hasErrors && !hasAdvisorySuccessPayload) {
        // Error-in-body responses are errors from the buyer's POV — do NOT
        // cache (security.mdx rule 3). cachableResponse stays null so the
        // post-dispatch gate below never inserts this into the replay cache.
        const firstError = resultObj.errors![0];
        if (ERROR_IN_BODY_TOOLS.has(name)) {
          // Envelope `status` is required per protocol-envelope.json (#4876)
          // and now folded into every per-task response schema (#4896). The
          // task itself completed successfully and produced a response that
          // happens to describe application-level errors — `completed` is
          // the correct TaskStatus regardless of body shape.
          const body: Record<string, unknown> = { status: 'completed', errors: resultObj.errors };
          body.adcp_version = servedAdcpVersion;
          if (callerContext !== undefined) body.context = callerContext;
          toolResult = {
            content: [{
              type: 'text',
              text: `${name} completed with ${resultObj.errors!.length} reported error${resultObj.errors!.length === 1 ? '' : 's'}.`,
            }],
            structuredContent: body,
          };
        } else {
          toolResult = adcpError(firstError.code, {
            message: firstError.message,
            ...(firstError.field && { field: firstError.field }),
            ...(firstError.recovery && { recovery: firstError.recovery }),
            details: firstError.details !== undefined
              ? firstError.details
              : resultObj.errors!.length > 1
                ? { all_errors: resultObj.errors }
                : undefined,
          }, callerContext, servedAdcpVersion);
        }
      } else {
        // Inner response (what gets cached for replay). Per security.mdx:
        // "replayed: false" MAY be omitted on fresh executions and buyers
        // MUST treat omission as false. We emit it explicitly only on
        // create_media_buy because the universal idempotency storyboard's
        // `field_value allowed_values:[false]` check fails on omitted
        // fields — scoping to this tool keeps the signal without tripping
        // strict per-task response schemas on other tools (several SDK
        // schemas are not passthrough and reject the extra key).
        const inner = { ...(result as Record<string, unknown>) };
        if (inner.adcp_version === undefined) inner.adcp_version = servedAdcpVersion;
        cachableResponse = inner;
        // Envelope `status` is required per protocol-envelope.json (#4876) and
        // now folded into every per-task response schema (#4896). Default to
        // `completed` on synchronous success — handlers that emit a different
        // TaskStatus (e.g., `submitted` for async-task envelopes) set it on
        // `inner` and we honor that value.
        const outwardInner = projectProductDiscoveryResult(name, inner, initialHandlerArgs);
        const response: Record<string, unknown> = { ...outwardInner };
        if (response.status === undefined) response.status = 'completed';
        response.adcp_version = servedAdcpVersion;
        if (name === 'create_media_buy') response.replayed = false;
        if (callerContext !== undefined) response.context = callerContext;
        // `structuredContent` is authoritative on success so raw-probe
        // callers (storyboard runner's rawMcpProbe) can validate envelope
        // fields. `content` stays empty: the SDK unwrapper folds text
        // content into `_message` on the returned object, which trips
        // strict `additionalProperties: false` per-task response schemas.
        toolResult = {
          content: [],
          structuredContent: response,
        };
      }
    } catch (error) {
      logger.error({ error, tool: name }, 'Training agent tool error');
      taskFailed = true;
      handlerThrew = true;
      toolResult = adcpError('SERVICE_UNAVAILABLE', {
        message: error instanceof Error ? error.message : 'Unknown error',
        recovery: 'transient',
      }, callerContext, servedAdcpVersion);
    }

    // TypeScript: by this point toolResult is guaranteed set — either the
    // handler branch wrote it or the replay short-circuit did.
    if (!toolResult) {
      throw new Error('Internal error: toolResult missing after dispatch');
    }

    // Resolve an in-flight idempotency claim only after the complete outward
    // response is known. Task-augmented requests must cache their task
    // envelope, not the handler's inner body, or a replay would allocate a
    // second task. Successful state is flushed before the immutable replay is
    // published so the cache cannot claim a finalize committed when its
    // session mutation was not durable.
    const resolveIdempotencyClaim = async (
      responseToCache: Record<string, unknown> | null,
    ): Promise<boolean> => {
      if (
        !idempotencyClaimed
        || typeof idempotencyKey !== 'string'
        || typeof idempotencyClaimToken !== 'string'
      ) return false;
      const store = getIdempotencyStore();
      const shouldSave = responseToCache !== null && !toolResult!.isError && !handlerThrew;
      if (!shouldSave || !idempotencyPayloadHash) {
        await store.release({
          principal: idempotencyPrincipal,
          key: idempotencyKey,
          claimToken: idempotencyClaimToken,
        });
        return false;
      }
      try {
        const flushedBeforeSave = isProductDiscoveryTool(name);
        if (flushedBeforeSave) await flushDirtySessions();
        await store.save({
          principal: idempotencyPrincipal,
          key: idempotencyKey,
          payloadHash: idempotencyPayloadHash,
          response: responseToCache,
          claimToken: idempotencyClaimToken,
        });
        return flushedBeforeSave;
      } catch (error) {
        await store.release({
          principal: idempotencyPrincipal,
          key: idempotencyKey,
          claimToken: idempotencyClaimToken,
        });
        throw error;
      }
    };

    const emitCompletionWebhook = (): void => {
      if (
        name === 'list_products'
        || idempotencyReplayed
        || cachableResponse === null
        || toolResult!.isError
        || handlerThrew
      ) return;
      const webhookResponse = projectProductDiscoveryResult(
        name,
        cachableResponse,
        initialHandlerArgs,
      );
      maybeEmitCompletionWebhook({
        toolName: name,
        args: initialHandlerArgs,
        response: webhookResponse,
        requestIdempotencyKey: typeof idempotencyKey === 'string' ? idempotencyKey : undefined,
        principal: idempotencyPrincipal,
      });
    };

    // If not task-augmented, return result directly.
    // flushable=!handlerThrew: if the handler threw, discard in-progress session
    // state. Structured { errors: [...] } responses still flush — they are
    // well-formed outcomes that legitimately mutate state.
    if (!isTaskRequest) {
      const flushed = await resolveIdempotencyClaim(cachableResponse);
      // Success notifications must never outrun durable session state or the
      // replay record. resolveIdempotencyClaim flushes then saves for every
      // mutation-capable task; only after both succeed may delivery begin.
      emitCompletionWebhook();
      return { result: toolResult, flushable: !handlerThrew && !flushed };
    }

    // Ordinary/error tasks honor the requested TTL up to the training-agent
    // cap. A successful idempotency-protected task is different: its terminal
    // record is the crash-recovery receipt if cache publication fails. MCP
    // explicitly permits the server to override the requested TTL, so retain
    // that receipt for the complete replay window plus the same one-minute
    // clock-skew allowance used by the idempotency contract. The returned Task
    // reports this actual TTL; callers must not assume their suggestion won.
    const MAX_TASK_TTL = 15 * 60 * 1000;      // 15 minutes
    const DEFAULT_TASK_TTL = 15 * 60 * 1000;  // 15 minutes
    const clampedTtl = Math.min(taskField?.ttl ?? DEFAULT_TASK_TTL, MAX_TASK_TTL);
    const IDEMPOTENT_TASK_RECEIPT_TTL = (REPLAY_TTL_SECONDS + 60) * 1000;

    // Task-augmented: use the raw module-level task store directly.
    // The SDK's extra.taskStore wrapper sends notifications/tasks/status
    // after storing results, which fails in stateless HTTP mode (each
    // request uses a fresh transport). Using the raw store avoids this
    // while keeping tasks visible to subsequent tasks/get requests.
    const terminalStatus: 'completed' | 'failed' = taskFailed ? 'failed' : 'completed';
    let task: Awaited<ReturnType<typeof taskStore.getTask>>;
    try {
      // Commit handler state before exposing a task that contains the result.
      // If task/cache persistence fails afterward, a retry observes the
      // committed proposal and converges on the same IO/expiry.
      await flushDirtySessions();
      const canReuseNaturalTask = (
        typeof idempotencyKey === 'string'
        && typeof idempotencyPayloadHash === 'string'
        && cachableResponse !== null
        && !toolResult.isError
        && !handlerThrew
      );
      const rawTaskRequest = request as unknown as { method: string; params?: Record<string, unknown> };
      const taskRequest = isProductDiscoveryTool(name)
        ? {
            ...rawTaskRequest,
            params: {
              ...rawTaskRequest.params,
              name,
              arguments: initialHandlerArgs,
            },
          }
        : rawTaskRequest;
      const created = canReuseNaturalTask
        ? await createOrReuseIdempotentTask(
            taskStore,
            idempotentTaskNaturalKey(
              idempotencyPrincipal,
              name,
              idempotencyKey!,
              idempotencyPayloadHash!,
            ),
            IDEMPOTENT_TASK_RECEIPT_TTL,
            taskRequest,
          )
        : await taskStore.createTask({ ttl: clampedTtl }, 0, taskRequest);
      if (!['completed', 'failed', 'cancelled'].includes(created.status)) {
        await taskStore.storeTaskResult(created.taskId, terminalStatus, toolResult);
      }
      task = await taskStore.getTask(created.taskId);
      if (!task) {
        throw new Error(`Task disappeared after creation for tool "${name}"`);
      }
    } catch (error) {
      await resolveIdempotencyClaim(null);
      throw error;
    }
    const errorCode = toolResult.isError
      ? (toolResult.structuredContent as { adcp_error?: { code?: string } } | undefined)?.adcp_error?.code
      : undefined;
    logger.info(
      { taskId: task.taskId, tool: name, status: terminalStatus, isError: !!toolResult.isError, ...(errorCode && { errorCode }) },
      'Created MCP task',
    );

    const taskResponse = {
      task,
      adcp_version: servedAdcpVersion,
      ...(idempotencyReplayed && { replayed: true }),
      ...(callerContext !== undefined && { context: callerContext }),
    } as Record<string, unknown>;
    const flushed = await resolveIdempotencyClaim(cachableResponse);
    emitCompletionWebhook();
    return { result: taskResponse, flushable: !handlerThrew && !flushed };
  }

  // tasks/get, tasks/result, tasks/list, tasks/cancel are auto-registered
  // by the SDK when taskStore is provided to the Server constructor.

  return server;
}
