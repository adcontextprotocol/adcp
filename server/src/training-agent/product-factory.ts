/**
 * Product factory — generates schema-compliant products from publisher profiles.
 *
 * Each publisher produces 1-4 products depending on its channel/delivery
 * combinations. Products reference formats from formats.ts via format_id.
 */

import type { PublisherProfile, PricingTemplate, CatalogProduct, ShowDefinition, ShowResponse } from './types.js';
import type {
  Product,
  FormatID,
  CPAPricingOption,
  CatalogType,
} from '@adcp/client';
// Derive structural types from Product's own fields — these types are defined in
// core.generated but not re-exported from @adcp/client's main entry.
type PricingOption = Product['pricing_options'][number];
type PriceGuidance = NonNullable<Extract<PricingOption, { pricing_model: 'cpm' }>['price_guidance']>;
type Episode = NonNullable<Product['episodes']>[number];
type ShowSelector = NonNullable<Product['shows']>[number];
type MediaChannel = NonNullable<Product['channels']>[number];
type DeliveryType = Product['delivery_type'];
type Exclusivity = NonNullable<Product['exclusivity']>;
type PublisherPropertySelector = Product['publisher_properties'][number];
type EpisodeStatus = NonNullable<Episode['status']>;
type FlatRatePricingOption = Extract<PricingOption, { pricing_model: 'flat_rate' }>;
type TimeBasedPricingOption = Extract<PricingOption, { pricing_model: 'time' }>;
import { PUBLISHERS } from './publishers.js';
import { FORMAT_CHANNEL_MAP } from './formats.js';
import { getAgentUrl } from './config.js';

/**
 * Parse ISO 8601 duration (e.g. "PT60M", "PT180M", "PT1H30M") to seconds.
 */
function parseDurationToSeconds(iso: string): number | null {
  const match = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!match) return null;
  const hours = parseInt(match[1] || '0', 10);
  const minutes = parseInt(match[2] || '0', 10);
  const seconds = parseInt(match[3] || '0', 10);
  return hours * 3600 + minutes * 60 + seconds;
}

function buildPriceGuidance(template: PricingTemplate): PriceGuidance | undefined {
  if (!template.priceGuidance) return undefined;
  const { suggested, range } = template.priceGuidance;
  return {
    p25: range.min,
    p50: suggested,
    p75: Math.round((suggested + range.max) / 2 * 100) / 100,
    p90: range.max,
  };
}

function buildPricingOption(
  template: PricingTemplate,
  productId: string,
  index: number,
): PricingOption {
  const id = `${productId}_pricing_${index}`;
  const priceGuidance = buildPriceGuidance(template);

  switch (template.model) {
    case 'cpm':
      return {
        pricing_option_id: id,
        pricing_model: 'cpm',
        currency: template.currency,
        ...(template.fixedPrice !== undefined && { fixed_price: template.fixedPrice }),
        ...(template.floorPrice !== undefined && { floor_price: template.floorPrice }),
        ...(priceGuidance && { price_guidance: priceGuidance }),
        ...(template.minSpendPerPackage !== undefined && { min_spend_per_package: template.minSpendPerPackage }),
      };
    case 'vcpm':
      return {
        pricing_option_id: id,
        pricing_model: 'vcpm',
        currency: template.currency,
        ...(template.fixedPrice !== undefined && { fixed_price: template.fixedPrice }),
        ...(template.floorPrice !== undefined && { floor_price: template.floorPrice }),
        ...(priceGuidance && { price_guidance: priceGuidance }),
        ...(template.minSpendPerPackage !== undefined && { min_spend_per_package: template.minSpendPerPackage }),
      };
    case 'cpc':
      return {
        pricing_option_id: id,
        pricing_model: 'cpc',
        currency: template.currency,
        ...(template.fixedPrice !== undefined && { fixed_price: template.fixedPrice }),
        ...(template.floorPrice !== undefined && { floor_price: template.floorPrice }),
        ...(priceGuidance && { price_guidance: priceGuidance }),
        ...(template.minSpendPerPackage !== undefined && { min_spend_per_package: template.minSpendPerPackage }),
      };
    case 'cpcv':
      return {
        pricing_option_id: id,
        pricing_model: 'cpcv',
        currency: template.currency,
        ...(template.fixedPrice !== undefined && { fixed_price: template.fixedPrice }),
        ...(template.floorPrice !== undefined && { floor_price: template.floorPrice }),
        ...(priceGuidance && { price_guidance: priceGuidance }),
        ...(template.minSpendPerPackage !== undefined && { min_spend_per_package: template.minSpendPerPackage }),
      };
    case 'cpv':
      return {
        pricing_option_id: id,
        pricing_model: 'cpv',
        currency: template.currency,
        ...(template.fixedPrice !== undefined && { fixed_price: template.fixedPrice }),
        ...(template.floorPrice !== undefined && { floor_price: template.floorPrice }),
        ...(priceGuidance && { price_guidance: priceGuidance }),
        parameters: template.cpvParameters ?? { view_threshold: { duration_seconds: 30 } },
        ...(template.minSpendPerPackage !== undefined && { min_spend_per_package: template.minSpendPerPackage }),
      };
    case 'cpp':
      return {
        pricing_option_id: id,
        pricing_model: 'cpp',
        currency: template.currency,
        ...(template.fixedPrice !== undefined && { fixed_price: template.fixedPrice }),
        ...(template.floorPrice !== undefined && { floor_price: template.floorPrice }),
        ...(priceGuidance && { price_guidance: priceGuidance }),
        parameters: template.cppParameters ?? { demographic: 'P18-49' },
        ...(template.minSpendPerPackage !== undefined && { min_spend_per_package: template.minSpendPerPackage }),
      };
    case 'cpa':
      return {
        pricing_option_id: id,
        pricing_model: 'cpa',
        currency: template.currency,
        fixed_price: template.fixedPrice ?? 0,
        event_type: (template.eventType ?? 'purchase') as CPAPricingOption['event_type'],
        ...(template.minSpendPerPackage !== undefined && { min_spend_per_package: template.minSpendPerPackage }),
      };
    case 'flat_rate':
      return {
        pricing_option_id: id,
        pricing_model: 'flat_rate',
        currency: template.currency,
        ...(template.fixedPrice !== undefined && { fixed_price: template.fixedPrice }),
        ...(template.floorPrice !== undefined && { floor_price: template.floorPrice }),
        ...(priceGuidance && { price_guidance: priceGuidance }),
        ...(template.doohParameters && { parameters: template.doohParameters as FlatRatePricingOption['parameters'] }),
        ...(template.minSpendPerPackage !== undefined && { min_spend_per_package: template.minSpendPerPackage }),
      };
    case 'time':
      return {
        pricing_option_id: id,
        pricing_model: 'time',
        currency: template.currency,
        ...(template.fixedPrice !== undefined && { fixed_price: template.fixedPrice }),
        ...(template.floorPrice !== undefined && { floor_price: template.floorPrice }),
        ...(priceGuidance && { price_guidance: priceGuidance }),
        parameters: template.timeParameters ?? { time_unit: 'day', min_duration: 1, max_duration: 30 },
        ...(template.minSpendPerPackage !== undefined && { min_spend_per_package: template.minSpendPerPackage }),
      };
  }
}

function formatIdsForChannels(channels: string[], agentUrl: string): FormatID[] {
  const ids: FormatID[] = [];
  const seen = new Set<string>();
  for (const channel of channels) {
    for (const [formatId, formatChannels] of Object.entries(FORMAT_CHANNEL_MAP)) {
      if (formatChannels.includes(channel) && !seen.has(formatId)) {
        seen.add(formatId);
        ids.push({ agent_url: agentUrl, id: formatId });
      }
    }
  }
  return ids;
}

function publisherPropertySelectors(pub: PublisherProfile, channels?: string[]): PublisherPropertySelector[] {
  if (!channels) {
    return [{ publisher_domain: pub.domain, selection_type: 'all' as const }];
  }
  // Filter properties that support at least one of the given channels
  const matchingProps = pub.properties.filter(p =>
    p.channels.some(c => channels.includes(c)),
  );
  if (matchingProps.length === pub.properties.length || matchingProps.length === 0) {
    return [{ publisher_domain: pub.domain, selection_type: 'all' as const }];
  }
  return [{
    publisher_domain: pub.domain,
    selection_type: 'by_id' as const,
    property_ids: matchingProps.map(p => p.propertyId),
  }];
}

function tierForProduct(pub: PublisherProfile, deliveryType: string, channels: string[]): 'basics' | 'practitioner' | 'specialist' {
  const highComplexity = ['ctv', 'linear_tv', 'dooh', 'ooh', 'influencer'];
  const niche = ['gaming'];

  if (channels.includes('search')) return 'basics';
  if (channels.some(c => niche.includes(c))) return 'specialist';
  if (deliveryType === 'guaranteed' && channels.some(c => highComplexity.includes(c))) return 'practitioner';
  if (deliveryType === 'guaranteed') return 'practitioner';
  return 'basics';
}

function scenarioTagsForProduct(pub: PublisherProfile, deliveryType: string, channels: string[]): string[] {
  const tags: string[] = [];
  if (deliveryType === 'guaranteed') tags.push('approval_required');
  if (pub.pricingTemplates.some(t => t.minSpendPerPackage && t.minSpendPerPackage >= 10000)) tags.push('budget_constraint');
  if (pub.catalogTypes?.length) tags.push('catalog_driven');
  if (channels.includes('influencer')) tags.push('creative_review');
  if (channels.includes('ctv') || channels.includes('linear_tv')) tags.push('high_value');
  return tags;
}

interface ProductTemplate {
  suffix: string;
  name: string;
  description: string;
  channels: string[];
  deliveryType: 'guaranteed' | 'non_guaranteed';
  pricingFilter?: (t: PricingTemplate) => boolean;
}

function productTemplatesForPublisher(pub: PublisherProfile): ProductTemplate[] {
  const templates: ProductTemplate[] = [];

  // Group by delivery type and channel combinations that make sense
  for (const deliveryType of pub.deliveryTypes) {
    if (pub.channels.length <= 2) {
      // Small channel set — one product per delivery type
      const channelLabel = pub.channels.join(' & ');
      templates.push({
        suffix: deliveryType === 'guaranteed' ? 'premium' : 'standard',
        name: deliveryType === 'guaranteed'
          ? `${pub.name} ${channelLabel} guaranteed`
          : `${pub.name} ${channelLabel}`,
        description: deliveryType === 'guaranteed'
          ? `Guaranteed delivery across ${pub.name} ${channelLabel} inventory. ${pub.description}`
          : `Auction-based delivery across ${pub.name} ${channelLabel} inventory. ${pub.description}`,
        channels: pub.channels,
        deliveryType,
        pricingFilter: deliveryType === 'guaranteed'
          ? (t) => t.fixedPrice !== undefined
          : (t) => t.fixedPrice === undefined,
      });
    } else {
      // Larger channel set — split into logical product groups
      const videoChannels = pub.channels.filter(c => ['olv', 'ctv', 'linear_tv'].includes(c));
      const displayChannels = pub.channels.filter(c => ['display', 'email'].includes(c));
      const socialChannels = pub.channels.filter(c => ['social', 'influencer'].includes(c));
      const searchChannels = pub.channels.filter(c => ['search'].includes(c));
      const audioChannels = pub.channels.filter(c => ['radio', 'streaming_audio', 'podcast'].includes(c));
      const printChannels = pub.channels.filter(c => ['print'].includes(c));
      const otherChannels = pub.channels.filter(c =>
        !['olv', 'ctv', 'linear_tv', 'display', 'email', 'social', 'influencer', 'search', 'radio', 'streaming_audio', 'podcast', 'print'].includes(c),
      );

      if (videoChannels.length > 0) {
        templates.push({
          suffix: `video_${deliveryType === 'guaranteed' ? 'premium' : 'standard'}`,
          name: `${pub.name} video${deliveryType === 'guaranteed' ? ' guaranteed' : ''}`,
          description: `${deliveryType === 'guaranteed' ? 'Guaranteed' : 'Auction-based'} video inventory across ${pub.name}. Channels: ${videoChannels.join(', ')}.`,
          channels: videoChannels,
          deliveryType,
          pricingFilter: deliveryType === 'guaranteed'
            ? (t) => t.fixedPrice !== undefined
            : (t) => t.fixedPrice === undefined,
        });
      }

      if (displayChannels.length > 0) {
        templates.push({
          suffix: `display_${deliveryType === 'guaranteed' ? 'premium' : 'standard'}`,
          name: `${pub.name} display${deliveryType === 'guaranteed' ? ' guaranteed' : ''}`,
          description: `${deliveryType === 'guaranteed' ? 'Guaranteed' : 'Auction-based'} display inventory across ${pub.name}. Channels: ${displayChannels.join(', ')}.`,
          channels: displayChannels,
          deliveryType,
          pricingFilter: deliveryType === 'guaranteed'
            ? (t) => t.fixedPrice !== undefined
            : (t) => t.fixedPrice === undefined,
        });
      }

      if (socialChannels.length > 0) {
        templates.push({
          suffix: `social_${deliveryType === 'guaranteed' ? 'premium' : 'standard'}`,
          name: `${pub.name} social${deliveryType === 'guaranteed' ? ' guaranteed' : ''}`,
          description: `${deliveryType === 'guaranteed' ? 'Guaranteed' : 'Auction-based'} social inventory on ${pub.name}. Channels: ${socialChannels.join(', ')}.`,
          channels: socialChannels,
          deliveryType,
          pricingFilter: deliveryType === 'guaranteed'
            ? (t) => t.fixedPrice !== undefined
            : (t) => t.fixedPrice === undefined,
        });
      }

      if (searchChannels.length > 0) {
        templates.push({
          suffix: `search_${deliveryType === 'guaranteed' ? 'premium' : 'standard'}`,
          name: `${pub.name} search${deliveryType === 'guaranteed' ? ' guaranteed' : ''}`,
          description: `${deliveryType === 'guaranteed' ? 'Guaranteed' : 'Auction-based'} search inventory on ${pub.name}. Keyword-targeted text and shopping ads.`,
          channels: searchChannels,
          deliveryType,
          pricingFilter: deliveryType === 'guaranteed'
            ? (t) => t.fixedPrice !== undefined
            : (t) => t.fixedPrice === undefined,
        });
      }

      if (audioChannels.length > 0) {
        templates.push({
          suffix: `audio_${deliveryType === 'guaranteed' ? 'premium' : 'standard'}`,
          name: `${pub.name} audio${deliveryType === 'guaranteed' ? ' guaranteed' : ''}`,
          description: `${deliveryType === 'guaranteed' ? 'Guaranteed' : 'Auction-based'} audio inventory on ${pub.name}. Channels: ${audioChannels.join(', ')}.`,
          channels: audioChannels,
          deliveryType,
          pricingFilter: deliveryType === 'guaranteed'
            ? (t) => t.fixedPrice !== undefined
            : (t) => t.fixedPrice === undefined,
        });
      }

      if (printChannels.length > 0) {
        templates.push({
          suffix: `print_${deliveryType === 'guaranteed' ? 'premium' : 'standard'}`,
          name: `${pub.name} print${deliveryType === 'guaranteed' ? ' guaranteed' : ''}`,
          description: `${deliveryType === 'guaranteed' ? 'Guaranteed' : 'Auction-based'} print inventory across ${pub.name}. Premium magazine and newspaper placements.`,
          channels: printChannels,
          deliveryType,
          pricingFilter: deliveryType === 'guaranteed'
            ? (t) => t.fixedPrice !== undefined
            : (t) => t.fixedPrice === undefined,
        });
      }

      if (otherChannels.length > 0) {
        templates.push({
          suffix: `other_${deliveryType === 'guaranteed' ? 'premium' : 'standard'}`,
          name: `${pub.name} ${otherChannels.join(' & ')}`,
          description: `${deliveryType === 'guaranteed' ? 'Guaranteed' : 'Auction-based'} inventory on ${pub.name}. Channels: ${otherChannels.join(', ')}.`,
          channels: otherChannels,
          deliveryType,
        });
      }
    }
  }

  return templates;
}

function buildProduct(
  pub: PublisherProfile,
  template: ProductTemplate,
  agentUrl: string,
): CatalogProduct {
  const productId = `${pub.id}_${template.suffix}`;
  const pricingTemplates = template.pricingFilter
    ? pub.pricingTemplates.filter(template.pricingFilter)
    : pub.pricingTemplates;

  // Fall back to all pricing if filter yields nothing
  const effectivePricing = pricingTemplates.length > 0 ? pricingTemplates : pub.pricingTemplates;

  // Build metric optimization for non-guaranteed products
  type SupportedMetric = NonNullable<Product['metric_optimization']>['supported_metrics'][number];
  let metricOptimization: Product['metric_optimization'];
  if (template.deliveryType === 'non_guaranteed') {
    const metrics: SupportedMetric[] = ['clicks'];
    if (template.channels.some(c => ['olv', 'ctv', 'social', 'gaming'].includes(c))) {
      metrics.push('views', 'completed_views');
    }
    if (template.channels.includes('social')) {
      metrics.push('engagements', 'reach');
    }
    if (metrics.length > 0) {
      metricOptimization = {
        supported_metrics: metrics,
        supported_targets: ['cost_per'],
      };
    }
  }

  // Build forecast for non-guaranteed products
  let forecast: Product['forecast'];
  if (template.deliveryType === 'non_guaranteed') {
    const baseCpm = effectivePricing[0]?.floorPrice || effectivePricing[0]?.fixedPrice || 10;
    const impressionsPer1k = Math.round(1000 / baseCpm * 1000);

    forecast = {
      points: [
        {
          budget: 5000,
          metrics: {
            impressions: { low: impressionsPer1k * 4, mid: impressionsPer1k * 5, high: Math.round(impressionsPer1k * 5.5) },
            reach: { low: Math.round(impressionsPer1k * 3), mid: Math.round(impressionsPer1k * 3.5), high: Math.round(impressionsPer1k * 4) },
          },
        },
        {
          budget: 25000,
          metrics: {
            impressions: { low: impressionsPer1k * 22, mid: impressionsPer1k * 25, high: impressionsPer1k * 27 },
            reach: { low: Math.round(impressionsPer1k * 12), mid: Math.round(impressionsPer1k * 15), high: Math.round(impressionsPer1k * 17) },
          },
        },
      ],
      method: 'modeled',
      currency: effectivePricing[0]?.currency || 'USD',
    };
  }

  // Build conversion tracking for retail/social
  let conversionTracking: Product['conversion_tracking'];
  if (pub.catalogTypes?.includes('product') || template.channels.includes('social')) {
    conversionTracking = {
      action_sources: ['website'],
      supported_targets: ['cost_per'],
      ...(pub.catalogTypes?.includes('product') && { platform_managed: true }),
    };
  }

  // Build show/episode associations
  let showSelectors: ShowSelector[] | undefined;
  let exclusivity: Exclusivity | undefined;
  let episodes: Episode[] | undefined;
  if (pub.shows?.length) {
    const matchingShows = pub.shows.filter(s =>
      s.channels.some(c => template.channels.includes(c)),
    );
    if (matchingShows.length > 0) {
      showSelectors = [{
        publisher_domain: pub.domain,
        show_ids: matchingShows.map(s => s.showId),
      }];
      if (template.deliveryType === 'guaranteed') {
        exclusivity = matchingShows.length === 1 ? 'exclusive' : 'category';
      }
      const builtEpisodes: Episode[] = [];
      for (const show of matchingShows) {
        for (const ep of show.episodes || []) {
          const episode: Episode = {
            episode_id: ep.episodeId,
            show_id: show.showId,
            name: ep.title,
            status: ep.status as EpisodeStatus,
            ...(ep.scheduledAt && { scheduled_at: ep.scheduledAt }),
            ...(ep.duration && parseDurationToSeconds(ep.duration) !== null && {
              duration_seconds: parseDurationToSeconds(ep.duration)!,
            }),
          };
          builtEpisodes.push(episode);
        }
      }
      if (builtEpisodes.length > 0) {
        episodes = builtEpisodes;
      }
    }
  }

  const product: Product = {
    product_id: productId,
    name: template.name,
    description: template.description,
    publisher_properties: publisherPropertySelectors(pub, template.channels),
    channels: template.channels as MediaChannel[],
    format_ids: formatIdsForChannels(template.channels, agentUrl),
    delivery_type: template.deliveryType as DeliveryType,
    delivery_measurement: {
      provider: pub.measurementProvider,
      notes: pub.measurementNotes,
    },
    pricing_options: effectivePricing.map((t, i) => buildPricingOption(t, productId, i)),
    ...((pub.reportingFrequencies || pub.reportingMetrics) && {
      reporting_capabilities: {
        available_reporting_frequencies: (pub.reportingFrequencies || ['daily']) as NonNullable<Product['reporting_capabilities']>['available_reporting_frequencies'],
        expected_delay_minutes: 240,
        timezone: 'UTC',
        supports_webhooks: false,
        available_metrics: (pub.reportingMetrics || []) as NonNullable<Product['reporting_capabilities']>['available_metrics'],
        date_range_support: 'date_range' as const,
        supports_creative_breakdown: true,
      },
    }),
    ...(pub.catalogTypes?.length && { catalog_types: pub.catalogTypes as CatalogType[] }),
    ...(metricOptimization && { metric_optimization: metricOptimization }),
    ...(forecast && { forecast }),
    ...(conversionTracking && { conversion_tracking: conversionTracking }),
    ...(showSelectors && { shows: showSelectors }),
    ...(exclusivity && { exclusivity }),
    ...(episodes && { episodes }),
  };

  return {
    product,
    publisherId: pub.id,
    trainingTier: tierForProduct(pub, template.deliveryType, template.channels),
    scenarioTags: scenarioTagsForProduct(pub, template.deliveryType, template.channels),
  };
}

function buildShowObject(show: ShowDefinition): ShowResponse {
  return {
    show_id: show.showId,
    name: show.name,
    genre: show.genre,
    cadence: show.cadence,
    status: show.status,
    ...(show.description && { description: show.description }),
    ...(show.contentRatings?.length && {
      content_rating: show.contentRatings.map(r => ({
        system: r.system,
        rating: r.rating,
      })),
    }),
    ...(show.talent?.length && {
      talent: show.talent.map(t => ({
        name: t.name,
        role: t.role,
      })),
    }),
    ...(show.distribution?.length && {
      distribution: show.distribution.map(d => ({
        publisher_domain: d.publisherDomain,
        identifiers: d.identifiers.map(id => ({ type: id.type, value: id.value })),
      })),
    }),
  };
}

/**
 * Build the top-level shows array for a get_products response,
 * scoped to only shows referenced by the given products.
 */
export function buildShowsForProducts(products: Product[]): ShowResponse[] {
  const referencedIds = new Set<string>();
  for (const p of products) {
    if (p.shows) {
      for (const selector of p.shows) {
        selector.show_ids.forEach(id => referencedIds.add(id));
      }
    }
  }
  if (referencedIds.size === 0) return [];

  const shows: ShowResponse[] = [];
  for (const pub of PUBLISHERS) {
    for (const show of pub.shows || []) {
      if (referencedIds.has(show.showId)) {
        shows.push(buildShowObject(show));
      }
    }
  }
  return shows;
}

/**
 * Generate the full product catalog from all publisher profiles.
 * Called once at startup.
 */
export function buildCatalog(): CatalogProduct[] {
  const agentUrl = getAgentUrl();
  const catalog: CatalogProduct[] = [];

  for (const pub of PUBLISHERS) {
    const templates = productTemplatesForPublisher(pub);
    for (const template of templates) {
      catalog.push(buildProduct(pub, template, agentUrl));
    }
  }

  return catalog;
}
