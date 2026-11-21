/**
 * The media-buy surface of an inventory tenant (#9025 part B, #8993's
 * inventory role): get_products with forecasts, create_media_buy,
 * update_media_buy, get_media_buys and get_media_buy_delivery over a
 * simulated market (`market-store.ts`), plus the creative library a buyer or
 * storefront traffics its buys with (`creatives.ts`). No new tasks: AdCP
 * shapes as they are, filled from the delivery engine.
 */
import { AdcpError, type AccountStore, type DecisioningPlatform, type SalesPlatform } from '@adcp/sdk/server';
import { assertDiscoveryAccountProvisioned, syncAccountsUpsert } from '../v6-account-helpers.js';
import { canonicalizeAccountRef } from '../account-scope.js';
import { trainingBuyerAgentRegistry } from '../buyer-agent-registry.js';
import { getAgentUrl } from '../config.js';
import { formatOptionsForTrainingFormats } from '../product-factory.js';
import {
  DAY_MS,
  EngineError,
  audienceCurve,
  toAdcpForecast,
  type BookingTargeting,
  type ForecastResult,
  type Installment,
  InventorySimulation,
  type SeasonSeed,
  type SeedProduct,
} from './engine/index.js';
import { openMarket, withCallerMarkets, type MediaBuyRecord, type OpenMarket, type PackageRecord } from './market-store.js';
import {
  CreativeRequestError,
  assign,
  assignmentError,
  creativeApprovals,
  listCreatives,
  parseCreative,
  syncCreatives,
  upsertCreative,
  type CreativeCatalog,
  type CreativeError,
} from './creatives.js';
import { catalogIdOf, formatFilter, listSeedCreativeFormats, resolveCreativeFormat, seedFormatDeclarations, wireFormat, type FormatDeclaration } from './creative-wire.js';
import type { TrainingContext } from '../types.js';

export interface InventoryTenantProfile {
  tenantId: string;
  seed: SeasonSeed;
}

interface InventoryMeta {
  brand_domain?: string;
  [key: string]: unknown;
}

const DEFAULT_FORECAST_DAYS = 30;
/** How long past its curve a sponsorship keeps serving, so an installment
 * postponed by up to two weeks still delivers its audience. */
const POSTPONEMENT_ALLOWANCE_DAYS = 14;

/** Engine channels on the AdCP channel enum. */
const ADCP_CHANNEL: Record<string, string> = {
  display: 'display',
  olv: 'olv',
  podcast: 'podcast',
  newsletter: 'email',
  creator_video: 'influencer',
};

const REPORTED_METRICS = ['impressions', 'spend', 'clicks', 'ctr', 'viewable_impressions', 'conversions'];

type Ctx = { account?: unknown; authInfo?: { clientId?: string } };

function principalOf(ctx: Ctx): string | undefined {
  const account = ctx.account as { authInfo?: { principal?: unknown } } | undefined;
  const fromAccount = typeof account?.authInfo?.principal === 'string' ? account.authInfo.principal : undefined;
  return ctx.authInfo?.clientId ?? fromAccount;
}

function accountIdOf(ctx: Ctx): string {
  const id = (ctx.account as { id?: unknown } | undefined)?.id;
  return typeof id === 'string' ? id : 'public_sandbox';
}

function invalid(message: string, field?: string): AdcpError {
  return new AdcpError('INVALID_REQUEST', { recovery: 'correctable', message, ...(field && { field }) });
}

function isContext(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function creativeFailure(error: CreativeError): AdcpError {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new AdcpError(error.code as any, { recovery: 'correctable', message: error.message, ...(error.field && { field: error.field }) });
}

function fromEngine(error: unknown, field?: string): never {
  if (!(error instanceof EngineError)) throw error;
  switch (error.code) {
    case 'UNKNOWN_PRODUCT':
      throw new AdcpError('PRODUCT_NOT_FOUND', { recovery: 'correctable', message: error.message, ...(field && { field }) });
    case 'SOLD_OUT':
      throw new AdcpError('PRODUCT_UNAVAILABLE', { recovery: 'correctable', message: error.message, ...(field && { field }) });
    case 'BOOKING_NOT_FOUND':
      throw new AdcpError('PACKAGE_NOT_FOUND', { recovery: 'correctable', message: error.message, ...(field && { field }) });
    default:
      throw invalid(error.message, field);
  }
}

function parseInstant(value: unknown, field: string, nowMs: number): number {
  if (value === 'asap') return nowMs;
  const ms = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(ms)) throw invalid(`${field} must be an ISO 8601 date-time`, field);
  return ms;
}

function parseDateStart(value: unknown, field: string): number {
  const ms = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T00:00:00Z`) : Number.NaN;
  if (!Number.isFinite(ms)) throw invalid(`${field} must be a YYYY-MM-DD date`, field);
  return ms;
}

export class InventoryPlatform implements DecisioningPlatform<{ strict: boolean }, InventoryMeta> {
  private readonly products: SeedProduct[];
  private readonly declarations: FormatDeclaration[];
  private readonly catalog: CreativeCatalog;

  constructor(private readonly profile: InventoryTenantProfile) {
    this.products = profile.seed.products;
    this.declarations = seedFormatDeclarations(profile.seed.placements.flatMap(placement => placement.formats));
    // Placements name formats by training catalogue id; the creative library
    // keys them by format_option_id.
    const optionIds = new Map(this.declarations.map(declaration => [catalogIdOf(declaration), declaration.format_option_id]));
    const productFormats = new Map(this.products.map(product => [product.product_id, new Set(product.placement_ids.flatMap(id =>
      (profile.seed.placements.find(placement => placement.placement_id === id)?.formats ?? []).map(label => optionIds.get(label)!)))]));
    const labels = new Map(this.declarations.map(declaration => [declaration.format_option_id, catalogIdOf(declaration)]));
    this.catalog = {
      formats: new Set(optionIds.values()),
      productFormats: productId => productFormats.get(productId) ?? new Set(),
      label: formatOptionId => labels.get(formatOptionId) ?? formatOptionId,
      resolve: (input, field, allowed) => resolveCreativeFormat(this.declarations, input, field, allowed),
      wire: formatOptionId => wireFormat(this.declarations, formatOptionId),
      filter: filters => formatFilter(this.declarations, filters),
    };
  }

  get capabilities() {
    const channels = [...new Set(this.profile.seed.placements.map(placement => ADCP_CHANNEL[placement.channel]))];
    // Claim only the delivery types the seed sells: the content seed sells
    // guaranteed sponsorships only.
    const deliveryTypes = new Set(this.products.map(product => product.delivery_type));
    const specialisms = [
      ...(deliveryTypes.has('guaranteed') ? ['sales-guaranteed' as const] : []),
      ...(deliveryTypes.has('non_guaranteed') ? ['sales-non-guaranteed' as const] : []),
    ];
    return {
      specialisms,
      creative_agents: [],
      channels: channels as never,
      pricingModels: ['cpm'] as const,
      supportedBillings: ['agent', 'operator'] as const,
      // An inventory agent is read as a wholesale catalogue by the storefront
      // in front of it, as well as briefed directly.
      buyingModes: ['brief', 'wholesale'] as const,
      // A storefront calls with its own credential, not a per-buyer operator.
      requireOperatorAuth: false,
      // Creatives are synced to a library, or uploaded inline on a package,
      // and assigned to the packages that serve their format.
      creative: {
        hasCreativeLibrary: true,
        supportsCompliance: false,
        supportsGeneration: false,
        supportsTransformation: false,
        assignmentOperations: ['assign', 'unassign', 'replace'] as const,
      },
      features: { inlineCreativeManagement: true },
      // The router lists the scenarios (tenants/inventory.ts).
      compliance_testing: {},
      config: { strict: false },
    };
  }

  statusMappers = {};
  agentRegistry = trainingBuyerAgentRegistry;

  accounts: AccountStore<InventoryMeta> = {
    resolution: 'explicit',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolve: async (ref: any, ctx?: { authInfo?: { clientId?: string }; toolName?: string }) => {
      const principal = ctx?.authInfo?.clientId;
      const authInfo = principal ? { kind: 'api_key' as const, principal } : { kind: 'public' as const };
      if (ref == null) {
        return { id: 'public_sandbox', name: 'Public Sandbox', status: 'active', mode: 'sandbox', ctx_metadata: {}, sandbox: true, authInfo };
      }
      // get_products, the one discovery task these tenants serve, takes only
      // a natural key already provisioned with sync_accounts:
      // ACCOUNT_NOT_FOUND, never the public card. Other tasks keep resolving
      // any reference.
      const toolName = ctx?.toolName;
      if (toolName === 'get_products') {
        await assertDiscoveryAccountProvisioned(canonicalizeAccountRef(ref), toolName, principal);
      }
      const brandDomain = typeof ref.brand?.domain === 'string' ? (ref.brand.domain as string) : undefined;
      const id = typeof ref.account_id === 'string' ? (ref.account_id as string) : `synthetic_${brandDomain ?? 'anon'}`;
      return {
        id,
        name: brandDomain ?? id,
        status: 'active',
        mode: 'sandbox',
        ...(brandDomain && { brand: { domain: brandDomain } }),
        ctx_metadata: { brand_domain: brandDomain },
        sandbox: true,
        authInfo,
      };
    },
    upsert: syncAccountsUpsert,
  };

  private market(ctx: Ctx): Promise<OpenMarket> {
    return openMarket(this.profile.tenantId, this.profile.seed, principalOf(ctx));
  }

  /** Run a market handler as the caller's only market request
   * (`withCallerMarkets`). Every handler takes its context last. */
  private serialized<A extends unknown[], R>(handler: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
    return (...args: A) => withCallerMarkets(principalOf((args[args.length - 1] ?? {}) as Ctx), () => handler(...args));
  }

  private pricingOptionId(product: SeedProduct): string {
    return `${product.product_id}_cpm`;
  }

  private targetingFrom(overlay: unknown, field: string): BookingTargeting {
    const countries = (overlay as { geo_countries?: unknown } | undefined)?.geo_countries;
    if (countries === undefined) return {};
    if (!Array.isArray(countries) || countries.some(country => typeof country !== 'string')) {
      throw invalid('geo_countries must be an array of ISO 3166-1 alpha-2 codes', `${field}.geo_countries`);
    }
    const wanted = new Set(countries.map(country => String(country).toUpperCase()));
    const regionIds = this.profile.seed.regions.filter(region => wanted.has(region.country)).map(region => region.region_id);
    if (regionIds.length === 0) throw invalid(`No inventory in ${[...wanted].join(', ')}`, `${field}.geo_countries`);
    return { region_ids: regionIds };
  }

  /** Installments a collection product sells that are scheduled within the
   * flight: what a sponsorship package over that flight buys. */
  private installmentsIn(product: SeedProduct, sim: InventorySimulation, startMs: number, endMs: number): Installment[] {
    const first = sim.traffic.calendar.dayOf(startMs);
    const last = Math.ceil((endMs - sim.traffic.calendar.startMs) / DAY_MS);
    return sim.traffic.productInstallments(product.product_id)
      .filter(installment => installment.scheduled_day >= first && installment.scheduled_day < last);
  }

  /** When the audience of the last of these installments has built up. */
  private audienceEndMs(installments: Installment[], sim: InventorySimulation): number {
    const ends = installments.map(installment => {
      const channel = sim.traffic.collections.get(installment.collection_id)!.channel;
      return installment.scheduled_day + audienceCurve(channel).length + POSTPONEMENT_ALLOWANCE_DAYS;
    });
    return sim.traffic.calendar.startMs + Math.max(...ends) * DAY_MS;
  }

  private wireInstallments(product: SeedProduct, installments: Installment[], sim: InventorySimulation, nowMs: number) {
    const known = new Map(sim.installmentStatuses(nowMs, product.product_id).map(status => [status.installment_id, status]));
    return installments.map(installment => {
      const collection = sim.traffic.collections.get(installment.collection_id)!;
      const status = known.get(installment.installment_id)!;
      const domain = this.profile.seed.properties.find(property => property.property_id === collection.property_id)!.domain;
      return {
        installment_id: installment.installment_id,
        collection_ref: { publisher_domain: domain, collection_id: collection.collection_id },
        name: `${collection.name} #${installment.sequence}`,
        installment_number: String(installment.sequence),
        scheduled_at: `${status.rescheduled_date ?? installment.scheduled_date}T00:00:00Z`,
        status: status.state,
      };
    });
  }

  private wireProduct(product: SeedProduct, sim: InventorySimulation, nowMs: number, flight: { startMs: number; endMs: number }, targeting: BookingTargeting, budget?: number) {
    const seed = this.profile.seed;
    const installments = product.collection_ids ? this.installmentsIn(product, sim, flight.startMs, flight.endMs) : undefined;
    const placements = product.placement_ids.map(id => seed.placements.find(placement => placement.placement_id === id)!);
    const propertyIds = new Set(product.property_ids ?? placements.flatMap(placement => placement.property_ids));
    const properties = seed.properties.filter(property => propertyIds.has(property.property_id));
    const lag = Math.max(...placements.map(placement => placement.reporting_lag_days));
    const guaranteed = product.delivery_type === 'guaranteed';
    const floor = Math.min(...placements.map(placement => placement.floor_cpm));
    const forecast: ForecastResult = installments?.length === 0
      ? { ...sim.forecast({ product_id: product.product_id, flight_start_ms: flight.startMs, flight_end_ms: flight.endMs }, nowMs), available: 0, impressions: 0, low: 0, high: 0, spend: 0, clicks: 0, viewable_impressions: 0, completed_views: 0, conversions: 0 }
      : sim.forecast({
        product_id: product.product_id,
        targeting: installments ? { ...targeting, installment_ids: installments.map(installment => installment.installment_id) } : targeting,
        flight_start_ms: flight.startMs,
        // A sponsorship's audience keeps arriving after the flight.
        flight_end_ms: installments ? Math.max(flight.endMs, this.audienceEndMs(installments, sim)) : flight.endMs,
        ...(budget !== undefined && { budget }),
        ...(!guaranteed && { bid_cpm: floor }),
      }, nowMs);
    const agentUrl = getAgentUrl();
    return {
      product_id: product.product_id,
      name: product.name,
      description: product.description,
      publisher_properties: properties.map(property => ({ publisher_domain: property.domain, selection_type: 'all' as const })),
      channels: [...new Set(placements.map(placement => ADCP_CHANNEL[placement.channel]))],
      format_options: formatOptionsForTrainingFormats([...new Set(placements.flatMap(placement => placement.formats))], agentUrl),
      delivery_type: product.delivery_type,
      ...(product.share_of_voice && { exclusivity: product.share_of_voice >= 1 ? 'exclusive' : 'non_exclusive' }),
      pricing_options: [{
        pricing_option_id: this.pricingOptionId(product),
        pricing_model: 'cpm' as const,
        currency: seed.currency,
        ...(guaranteed ? { fixed_price: product.rate_cpm! } : { floor_price: floor }),
      }],
      forecast: toAdcpForecast(forecast, {
        guaranteed,
        ...(budget !== undefined && { budget }),
        generatedAt: new Date(nowMs).toISOString(),
        validUntil: new Date(nowMs + DAY_MS).toISOString(),
      }),
      reporting_capabilities: {
        available_reporting_frequencies: ['daily'],
        expected_delay_minutes: (lag + 1) * 24 * 60,
        timezone: 'UTC',
        supports_webhooks: false,
        available_metrics: placements.some(placement => placement.rates.completion_rate > 0)
          ? [...REPORTED_METRICS, 'completed_views', 'completion_rate']
          : REPORTED_METRICS,
        date_range_support: 'date_range' as const,
      },
      overlay_support: { geo_countries: true },
      ...(installments && {
        collections: (product.collection_ids ?? []).map(id => {
          const collection = sim.traffic.collections.get(id)!;
          const domain = seed.properties.find(property => property.property_id === collection.property_id)!.domain;
          return { publisher_domain: domain, collection_ids: [id] };
        }),
        installments: this.wireInstallments(product, installments, sim, nowMs),
      }),
    };
  }

  private buyStatus(buy: MediaBuyRecord, nowMs: number): string {
    if (buy.canceled) return 'canceled';
    if (nowMs >= Date.parse(buy.end_time)) return 'completed';
    if (buy.paused) return 'paused';
    // No live package has a creative, so none can begin delivery: the buyer
    // has to act. The simulation still delivers the bookings as seeded.
    const live = buy.packages.filter(pkg => !pkg.canceled);
    if (live.length > 0 && live.every(pkg => !pkg.creative_assignments?.length)) return 'pending_creatives';
    if (nowMs < Date.parse(buy.start_time)) return 'pending_start';
    return 'active';
  }

  private wirePackage(pkg: PackageRecord, currency: string) {
    return {
      package_id: pkg.package_id,
      product_id: pkg.product_id,
      pricing_option_id: pkg.pricing_option_id,
      budget: pkg.budget,
      currency,
      ...(pkg.impressions !== undefined && { impressions: pkg.impressions }),
      ...(pkg.bid_price !== undefined && { bid_price: pkg.bid_price }),
      ...(pkg.countries && { targeting_overlay: { geo_countries: pkg.countries } }),
      start_time: pkg.start_time,
      end_time: pkg.end_time,
      paused: pkg.paused,
      canceled: pkg.canceled,
      // Opaque buyer correlation data: kept unchanged, never interpreted.
      ...(pkg.context && { context: pkg.context }),
    };
  }

  /** This seed's formats as product format declarations, for the SDK's
   * creative format projection (`tenants/inventory.ts`): canonical inline
   * creatives in them then reach create_media_buy as these options. */
  formatDeclarations(): Record<string, unknown>[] {
    return this.declarations as unknown as Record<string, unknown>[];
  }

  /**
   * A package's inline creatives and creative_assignments. Inline creatives
   * join the caller's library; both must exist and be in a format the
   * package's product serves. create_media_buy adds, update_media_buy
   * replaces the package's assignments.
   */
  private applyPackageCreatives(market: OpenMarket, accountId: string, record: PackageRecord, pkg: Record<string, unknown>, field: string, replace: boolean): boolean {
    const inline = Array.isArray(pkg.creatives) ? pkg.creatives as unknown[] : undefined;
    const assignments = Array.isArray(pkg.creative_assignments) ? pkg.creative_assignments as unknown[] : undefined;
    if (!inline && !assignments) return false;
    const weightOf = (value: unknown, at: string) => {
      if (value === undefined) return undefined;
      if (typeof value !== 'number' || !(value >= 0 && value <= 100)) throw invalid('weight must be a number from 0 to 100', at);
      return value;
    };
    const wanted: Array<{ creative_id: string; weight?: number }> = [];
    try {
      inline?.forEach((input, index) => {
        const at = `${field}.creatives[${index}]`;
        // The SDK hands these over canonicalized (format_option_ref and
        // format_kind); a kind matches only among the product's formats.
        const parsed = parseCreative(input, at, this.catalog, this.catalog.productFormats(record.product_id));
        if ('error' in parsed) throw creativeFailure(parsed.error);
        upsertCreative(market.doc, accountId, parsed.creative, market.nowIso);
        wanted.push({ creative_id: parsed.creative.creative_id, weight: weightOf((input as Record<string, unknown>).weight, `${at}.weight`) });
      });
    } catch (error) {
      if (error instanceof CreativeRequestError) throw creativeFailure(error.errors[0]);
      throw error;
    }
    assignments?.forEach((input, index) => {
      const at = `${field}.creative_assignments[${index}]`;
      const assignment = input as Record<string, unknown> | null;
      if (typeof assignment !== 'object' || assignment === null || typeof assignment.creative_id !== 'string') throw invalid('Each creative assignment needs a creative_id', at);
      if (assignment.placement_ids !== undefined || assignment.placement_refs !== undefined) {
        throw new AdcpError('UNSUPPORTED_FEATURE', { recovery: 'correctable', message: 'Products here do not declare placements to route creatives to', field: `${at}.placement_ids` });
      }
      wanted.push({ creative_id: assignment.creative_id, weight: weightOf(assignment.weight, `${at}.weight`) });
    });
    for (const { creative_id } of wanted) {
      const error = assignmentError(market.doc, accountId, this.catalog, creative_id, record, record.package_id, field);
      if (error) throw creativeFailure(error);
    }
    if (replace) delete record.creative_assignments;
    for (const { creative_id, weight } of wanted) assign(record, creative_id, weight, market.nowIso);
    return true;
  }

  private requireBuy(market: OpenMarket, mediaBuyId: string, ctx: Ctx): MediaBuyRecord {
    const buy = market.doc.media_buys.find(candidate => candidate.media_buy_id === mediaBuyId && candidate.account_id === accountIdOf(ctx));
    if (!buy) throw new AdcpError('MEDIA_BUY_NOT_FOUND', { recovery: 'correctable', message: `Unknown media buy ${mediaBuyId}`, field: 'media_buy_id' });
    return buy;
  }

  sales: SalesPlatform<InventoryMeta> = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getProducts: this.serialized(async (req: any, ctx) => {
      const market = await this.market(ctx);
      const filters = (req.filters ?? {}) as Record<string, unknown>;
      const startMs = filters.start_date !== undefined ? parseDateStart(filters.start_date, 'filters.start_date') : market.nowMs;
      const endMs = filters.end_date !== undefined
        ? parseDateStart(filters.end_date, 'filters.end_date') + DAY_MS
        : startMs + DEFAULT_FORECAST_DAYS * DAY_MS;
      if (endMs <= startMs) throw invalid('filters.end_date must not be before filters.start_date', 'filters.end_date');
      const countries = Array.isArray(filters.countries) ? filters.countries : undefined;
      const targeting = countries ? this.targetingFrom({ geo_countries: countries }, 'filters') : {};
      const budgetMax = (filters.budget_range as { max?: unknown } | undefined)?.max;
      const budget = typeof budgetMax === 'number' && budgetMax > 0 ? budgetMax : undefined;
      const channels = Array.isArray(filters.channels) ? new Set(filters.channels as string[]) : undefined;
      // With an account, forecasts net out the caller's own bookings, an
      // account-specific overlay. Without one the seller MUST answer with the
      // public card, so forecast against an empty market: the same for every
      // caller at the same simulated time.
      const scoped = req.account !== undefined && req.account !== null;
      const sim = scoped ? market.sim : InventorySimulation.create(this.profile.seed, market.nowMs);
      const products = this.products
        .filter(product => filters.delivery_type === undefined || product.delivery_type === filters.delivery_type)
        .filter(product => !channels || product.placement_ids.some(id => channels.has(ADCP_CHANNEL[this.profile.seed.placements.find(p => p.placement_id === id)!.channel])))
        .map(product => this.wireProduct(product, sim, market.nowMs, { startMs, endMs }, targeting, budget));
      market.save();
      return { products, cache_scope: scoped ? 'account' : 'public' } as never;
    }),

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createMediaBuy: this.serialized(async (req: any, ctx) => {
      const market = await this.market(ctx);
      const packages = Array.isArray(req.packages) ? req.packages : [];
      if (packages.length === 0) throw invalid('create_media_buy needs at least one package', 'packages');
      const buyStart = parseInstant(req.start_time, 'start_time', market.nowMs);
      const buyEnd = parseInstant(req.end_time, 'end_time', market.nowMs);
      if (buyEnd <= buyStart) throw invalid('end_time must be after start_time', 'end_time');
      const mediaBuyId = market.nextId('mb');
      const records: PackageRecord[] = [];
      packages.forEach((pkg: Record<string, unknown>, index: number) => {
        const field = `packages[${index}]`;
        const product = this.products.find(candidate => candidate.product_id === pkg.product_id);
        if (!product) throw new AdcpError('PRODUCT_NOT_FOUND', { recovery: 'correctable', message: `Unknown product ${String(pkg.product_id)}`, field: `${field}.product_id` });
        if (pkg.pricing_option_id !== this.pricingOptionId(product)) {
          throw new AdcpError('INVALID_PRICING_OPTION', { recovery: 'correctable', message: `Product ${product.product_id} is priced by ${this.pricingOptionId(product)}`, field: `${field}.pricing_option_id` });
        }
        const budget = typeof pkg.budget === 'number' ? pkg.budget : Number.NaN;
        if (!(budget > 0)) throw invalid('Each package needs a positive budget', `${field}.budget`);
        const startMs = pkg.start_time !== undefined ? parseInstant(pkg.start_time, `${field}.start_time`, market.nowMs) : buyStart;
        const endMs = pkg.end_time !== undefined ? parseInstant(pkg.end_time, `${field}.end_time`, market.nowMs) : buyEnd;
        const targeting = this.targetingFrom(pkg.targeting_overlay, `${field}.targeting_overlay`);
        const bid = typeof pkg.bid_price === 'number' ? pkg.bid_price : undefined;
        const impressions = typeof pkg.impressions === 'number' ? pkg.impressions : undefined;
        let bookingEndMs = endMs;
        if (product.collection_ids) {
          // A sponsorship buys every installment scheduled in its flight, and
          // serves until their audience has built up.
          const installments = this.installmentsIn(product, market.sim, startMs, endMs);
          if (installments.length === 0) throw invalid(`No ${product.name} installments are scheduled in this flight`, `${field}.start_time`);
          targeting.installment_ids = installments.map(installment => installment.installment_id);
          bookingEndMs = Math.max(endMs, this.audienceEndMs(installments, market.sim));
        }
        const packageId = market.nextId('pkg');
        try {
          market.sim.book({
            booking_id: packageId,
            product_id: product.product_id,
            targeting,
            flight_start_ms: startMs,
            flight_end_ms: bookingEndMs,
            budget,
            ...(impressions !== undefined && { impression_goal: impressions }),
            ...(product.delivery_type === 'non_guaranteed' && { bid_cpm: bid ?? Math.min(...product.placement_ids.map(id => this.profile.seed.placements.find(p => p.placement_id === id)!.floor_cpm)) }),
          }, market.nowMs);
        } catch (error) {
          fromEngine(error, field);
        }
        const booking = market.sim.booking(packageId);
        records.push({
          package_id: packageId,
          product_id: product.product_id,
          pricing_option_id: this.pricingOptionId(product),
          budget,
          ...(booking.impression_goal !== undefined && { impressions: booking.impression_goal }),
          ...(booking.kind === 'auction' && { bid_price: booking.cpm }),
          ...(targeting.installment_ids && { installment_ids: targeting.installment_ids }),
          ...(targeting.region_ids && { countries: [...new Set((pkg.targeting_overlay as { geo_countries: string[] }).geo_countries.map(c => c.toUpperCase()))] }),
          start_time: new Date(startMs).toISOString(),
          end_time: new Date(endMs).toISOString(),
          paused: false,
          canceled: false,
          ...(isContext(pkg.context) && { context: structuredClone(pkg.context) }),
        });
        this.applyPackageCreatives(market, accountIdOf(ctx), records[records.length - 1], pkg, field, false);
      });
      const buy: MediaBuyRecord = {
        media_buy_id: mediaBuyId,
        account_id: accountIdOf(ctx),
        ...(typeof req.name === 'string' && { name: req.name }),
        currency: this.profile.seed.currency,
        start_time: new Date(buyStart).toISOString(),
        end_time: new Date(buyEnd).toISOString(),
        confirmed_at: market.nowIso,
        updated_at: market.nowIso,
        revision: 1,
        paused: false,
        canceled: false,
        packages: records,
        ...(isContext(req.context) && { context: structuredClone(req.context) }),
      };
      market.doc.media_buys.push(buy);
      market.save();
      return {
        media_buy_id: buy.media_buy_id,
        media_buy_status: this.buyStatus(buy, market.nowMs),
        confirmed_at: buy.confirmed_at,
        revision: buy.revision,
        currency: buy.currency,
        total_budget: records.reduce((sum, pkg) => sum + pkg.budget, 0),
        packages: records.map(pkg => this.wirePackage(pkg, buy.currency)),
        sandbox: true,
      } as never;
    }),

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    updateMediaBuy: this.serialized(async (buyId: string, patch: any, ctx) => {
      const market = await this.market(ctx);
      const buy = this.requireBuy(market, buyId, ctx);
      if (buy.canceled) throw new AdcpError('INVALID_STATE', { recovery: 'terminal', message: `Media buy ${buyId} is canceled` });
      if (typeof patch.revision === 'number' && patch.revision !== buy.revision) {
        throw new AdcpError('CONFLICT', { recovery: 'correctable', message: `Media buy ${buyId} is at revision ${buy.revision}`, field: 'revision' });
      }
      const affected = new Set<string>();
      const apply = (pkg: PackageRecord, change: Parameters<InventorySimulation['update']>[1], field: string) => {
        try {
          market.sim.update(pkg.package_id, change, market.nowMs);
        } catch (error) {
          fromEngine(error, field);
        }
        affected.add(pkg.package_id);
      };
      if (patch.end_time !== undefined) {
        const endMs = parseInstant(patch.end_time, 'end_time', market.nowMs);
        buy.end_time = new Date(endMs).toISOString();
        for (const pkg of buy.packages) {
          if (pkg.canceled) continue;
          pkg.end_time = buy.end_time;
          apply(pkg, { flight_end_ms: endMs }, 'end_time');
        }
      }
      (Array.isArray(patch.packages) ? patch.packages : []).forEach((change: Record<string, unknown>, index: number) => {
        const field = `packages[${index}]`;
        const pkg = buy.packages.find(candidate => candidate.package_id === change.package_id);
        if (!pkg) throw new AdcpError('PACKAGE_NOT_FOUND', { recovery: 'correctable', message: `Unknown package ${String(change.package_id)}`, field: `${field}.package_id` });
        if (pkg.canceled) throw new AdcpError('INVALID_STATE', { recovery: 'terminal', message: `Package ${pkg.package_id} is canceled`, field });
        if (typeof change.budget === 'number') {
          pkg.budget = change.budget;
          apply(pkg, { budget: change.budget }, `${field}.budget`);
        }
        if (typeof change.impressions === 'number') {
          pkg.impressions = change.impressions;
          apply(pkg, { impression_goal: change.impressions }, `${field}.impressions`);
        }
        if (typeof change.bid_price === 'number') {
          pkg.bid_price = change.bid_price;
          apply(pkg, { bid_cpm: change.bid_price }, `${field}.bid_price`);
        }
        if (typeof change.paused === 'boolean') {
          pkg.paused = change.paused;
          apply(pkg, { status: change.paused || buy.paused ? 'paused' : 'active' }, `${field}.paused`);
        }
        if (change.canceled === true) {
          pkg.canceled = true;
          apply(pkg, { status: 'canceled' }, `${field}.canceled`);
        }
        if (this.applyPackageCreatives(market, accountIdOf(ctx), pkg, change, field, true)) affected.add(pkg.package_id);
        if (isContext(change.context)) {
          pkg.context = structuredClone(change.context);
          affected.add(pkg.package_id);
        }
      });
      if (typeof patch.paused === 'boolean') {
        buy.paused = patch.paused;
        for (const pkg of buy.packages) {
          if (!pkg.canceled) apply(pkg, { status: patch.paused || pkg.paused ? 'paused' : 'active' }, 'paused');
        }
      }
      if (patch.canceled === true) {
        buy.canceled = true;
        for (const pkg of buy.packages) {
          if (pkg.canceled) continue;
          pkg.canceled = true;
          apply(pkg, { status: 'canceled' }, 'canceled');
        }
      }
      buy.revision += 1;
      buy.updated_at = market.nowIso;
      market.save();
      return {
        media_buy_id: buy.media_buy_id,
        media_buy_status: this.buyStatus(buy, market.nowMs),
        revision: buy.revision,
        currency: buy.currency,
        total_budget: buy.packages.reduce((sum, pkg) => sum + pkg.budget, 0),
        affected_packages: buy.packages.filter(pkg => affected.has(pkg.package_id)).map(pkg => this.wirePackage(pkg, buy.currency)),
        sandbox: true,
      } as never;
    }),

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getMediaBuys: this.serialized(async (req: any, ctx) => {
      const market = await this.market(ctx);
      const ids = Array.isArray(req.media_buy_ids) ? new Set(req.media_buy_ids as string[]) : undefined;
      const buys = market.doc.media_buys.filter(buy => buy.account_id === accountIdOf(ctx) && (!ids || ids.has(buy.media_buy_id)));
      market.save();
      return {
        media_buys: buys.map(buy => ({
          media_buy_id: buy.media_buy_id,
          ...(buy.name && { name: buy.name }),
          status: this.buyStatus(buy, market.nowMs),
          currency: buy.currency,
          total_budget: buy.packages.reduce((sum, pkg) => sum + pkg.budget, 0),
          start_time: buy.start_time,
          end_time: buy.end_time,
          confirmed_at: buy.confirmed_at,
          created_at: buy.confirmed_at,
          updated_at: buy.updated_at,
          revision: buy.revision,
          ...(buy.context && { context: buy.context }),
          packages: buy.packages.map(pkg => {
            const approvals = creativeApprovals(pkg);
            return { ...this.wirePackage(pkg, buy.currency), ...(approvals && { creative_approvals: approvals }) };
          }),
        })),
        sandbox: true,
      } as never;
    }),

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getMediaBuyDelivery: this.serialized(async (filter: any, ctx) => {
      const market = await this.market(ctx);
      const ids = Array.isArray(filter.media_buy_ids) ? new Set(filter.media_buy_ids as string[]) : undefined;
      const buys = market.doc.media_buys.filter(buy => buy.account_id === accountIdOf(ctx) && (!ids || ids.has(buy.media_buy_id)));
      const fromDate = typeof filter.start_date === 'string' ? filter.start_date : undefined;
      const toDate = typeof filter.end_date === 'string' ? filter.end_date : undefined;
      const inRange = (date: string) => (!fromDate || date >= fromDate) && (!toDate || date < toDate);
      const deliveries = buys.map(buy => {
        const daily = new Map<string, { impressions: number; spend: number }>();
        const byPackage = buy.packages.map(pkg => {
          const report = market.sim.delivery(pkg.package_id, market.nowMs);
          const days = report.days.filter(day => inRange(day.date));
          const sum = (key: 'impressions' | 'spend' | 'clicks' | 'viewable_impressions' | 'completed_views' | 'conversions') =>
            days.reduce((total, day) => total + day[key], 0);
          for (const day of days) {
            const row = daily.get(day.date) ?? { impressions: 0, spend: 0 };
            row.impressions += day.impressions;
            row.spend = Math.round((row.spend + day.spend) * 100) / 100;
            daily.set(day.date, row);
          }
          const impressions = sum('impressions');
          const expected = report.expected_impressions;
          return {
            package_id: pkg.package_id,
            impressions,
            spend: Math.round(sum('spend') * 100) / 100,
            clicks: sum('clicks'),
            ...(impressions > 0 && { ctr: sum('clicks') / impressions }),
            viewable_impressions: sum('viewable_impressions'),
            ...(sum('completed_views') > 0 && { completed_views: sum('completed_views') }),
            conversions: sum('conversions'),
            pricing_model: 'cpm',
            rate: report.booking.cpm,
            currency: buy.currency,
            ...(expected !== undefined && expected > 0 && !fromDate && !toDate && { pacing_index: Math.round((impressions / expected) * 1000) / 1000 }),
          };
        });
        const totals = byPackage.reduce((acc, row) => ({
          impressions: acc.impressions + row.impressions,
          spend: Math.round((acc.spend + row.spend) * 100) / 100,
          clicks: acc.clicks + row.clicks,
          conversions: acc.conversions + row.conversions,
        }), { impressions: 0, spend: 0, clicks: 0, conversions: 0 });
        return {
          media_buy_id: buy.media_buy_id,
          currency: buy.currency,
          status: this.buyStatus(buy, market.nowMs),
          pricing_model: 'cpm',
          totals,
          by_package: byPackage,
          daily_breakdown: [...daily.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, row]) => ({ date, ...row })),
        };
      });
      const starts = buys.map(buy => Date.parse(buy.start_time));
      const periodStart = fromDate ? Date.parse(`${fromDate}T00:00:00Z`) : starts.length > 0 ? Math.min(...starts) : market.nowMs;
      const periodEnd = toDate ? Math.min(Date.parse(`${toDate}T00:00:00Z`), market.nowMs) : market.nowMs;
      market.save();
      return {
        reporting_period: {
          start: new Date(Math.min(periodStart, periodEnd)).toISOString(),
          end: new Date(periodEnd).toISOString(),
        },
        currency: this.profile.seed.currency,
        media_buy_deliveries: deliveries,
        sandbox: true,
      } as never;
    }),
  };

  /**
   * sync_creatives, list_creatives and list_creative_formats. They register as
   * raw media-buy handlers because sync_creatives needs the whole request:
   * the SDK hands `sales.syncCreatives` only the creatives, without the
   * assignments.
   */
  creativeHandlers(storyboardCompat?: TrainingContext['storyboardCompat']) {
    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      syncCreatives: this.serialized(async (req: any, ctx: Ctx) => {
        const market = await this.market(ctx);
        const { payload, persist } = syncCreatives(market.doc, accountIdOf(ctx), req, this.catalog, market.nowIso);
        if (persist) market.save();
        return payload as never;
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      listCreatives: this.serialized(async (req: any, ctx: Ctx) => {
        const market = await this.market(ctx);
        const payload = listCreatives(market.doc, accountIdOf(ctx), req, this.catalog);
        market.save();
        return payload as never;
      }),
      // The training creative catalogue, limited to the formats this seed
      // serves.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      listCreativeFormats: async (req: any, ctx: Ctx) => {
        const training: TrainingContext = { mode: 'open', principal: principalOf(ctx) ?? 'anonymous', ...(storyboardCompat && { storyboardCompat }) };
        return await listSeedCreativeFormats(this.declarations, req ?? {}, training) as never;
      },
    };
  }
}

