/**
 * Product factory — generates schema-compliant products from publisher profiles.
 *
 * Each publisher produces 1-4 products depending on its channel/delivery
 * combinations. Products reference formats from formats.ts via format_id.
 */

import type { Product, FormatID } from '@adcp/client';

/** Types re-declared locally — not exported from @adcp/client's public API. */
type MediaChannel = string;
type ReportingFrequency = string;
type AvailableMetric = string;

interface Episode {
  episode_id: string;
  show_id: string;
  name: string;
  status: string;
  scheduled_at?: string;
  duration_seconds?: number;
  special?: {
    name: string;
    category?: string;
    starts?: string;
    ends?: string;
  };
}

interface ShowSelector {
  publisher_domain: string;
  show_ids: string[];
}

interface ReportingCapabilities {
  available_reporting_frequencies: ReportingFrequency[];
  expected_delay_minutes: number;
  timezone: string;
  supports_webhooks: boolean;
  available_metrics?: AvailableMetric[];
  date_range_support: string;
  supports_creative_breakdown: boolean;
}

interface ForecastPoint {
  budget: number;
  metrics: Record<string, { low: number; mid: number; high: number }>;
}

interface PublisherPropertySelector {
  publisher_domain: string;
  selection_type: 'all' | 'by_id';
  property_ids?: string[];
}
import type { PublisherProfile, PricingTemplate, CatalogProduct } from './types.js';
import { PUBLISHERS } from './publishers.js';
import { FORMAT_CHANNEL_MAP } from './formats.js';
import { getAgentUrl } from './config.js';

/** Pricing model identifiers from the AdCP spec. */
type PricingModel = 'cpm' | 'vcpm' | 'cpc' | 'cpcv' | 'cpv' | 'cpp' | 'cpa' | 'flat_rate' | 'time';

/** Shape built by the training agent for pricing options — covers all PricingOption union members. */
interface TrainingPricingOption {
  pricing_option_id: string;
  pricing_model: PricingModel;
  model: PricingModel; // #1525: alias for @adcp/client < 4.11.0
  currency: string;
  fixed_price?: number;
  floor_price?: number;
  price_guidance?: { p25: number; p50: number; p75: number; p90: number };
  min_spend_per_package?: number;
  parameters?: unknown;
  event_type?: string;
}

function buildPricingOption(
  template: PricingTemplate,
  productId: string,
  index: number,
): TrainingPricingOption {
  const option: TrainingPricingOption = {
    pricing_option_id: `${productId}_pricing_${index}`,
    pricing_model: template.model,
    model: template.model,
    currency: template.currency,
  };
  if (template.fixedPrice !== undefined) option.fixed_price = template.fixedPrice;
  if (template.floorPrice !== undefined) option.floor_price = template.floorPrice;
  if (template.priceGuidance) {
    const { suggested, range } = template.priceGuidance;
    option.price_guidance = {
      p25: range.min,
      p50: suggested,
      p75: Math.round((suggested + range.max) / 2 * 100) / 100,
      p90: range.max,
    };
  }
  if (template.minSpendPerPackage !== undefined) option.min_spend_per_package = template.minSpendPerPackage;
  if (template.doohParameters) option.parameters = template.doohParameters;
  if (template.eventType) option.event_type = template.eventType;
  if (template.cppParameters) option.parameters = template.cppParameters;
  if (template.cpvParameters) option.parameters = template.cpvParameters;
  if (template.timeParameters) option.parameters = template.timeParameters;
  return option;
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

  const product: Partial<Product> & Record<string, unknown> = {
    product_id: productId,
    name: template.name,
    description: template.description,
    publisher_properties: publisherPropertySelectors(pub, template.channels) as Product['publisher_properties'],
    channels: template.channels as Product['channels'],
    format_ids: formatIdsForChannels(template.channels, agentUrl),
    delivery_type: template.deliveryType,
    delivery_measurement: {
      provider: pub.measurementProvider,
      notes: pub.measurementNotes,
    },
    pricing_options: effectivePricing.map((t, i) => buildPricingOption(t, productId, i)) as unknown as Product['pricing_options'],
  };

  if (pub.reportingFrequencies || pub.reportingMetrics) {
    product.reporting_capabilities = {
      available_reporting_frequencies: (pub.reportingFrequencies || ['daily']) as ReportingFrequency[],
      expected_delay_minutes: 240,
      timezone: 'UTC',
      supports_webhooks: false,
      ...(pub.reportingMetrics && { available_metrics: pub.reportingMetrics as AvailableMetric[] }),
      date_range_support: 'date_range' as const,
      supports_creative_breakdown: true,
    } as Product['reporting_capabilities'];
  }

  if (pub.catalogTypes?.length) {
    product.catalog_types = pub.catalogTypes as Product['catalog_types'];
  }

  // Add metric optimization for non-guaranteed products with appropriate channels
  if (template.deliveryType === 'non_guaranteed') {
    type SupportedMetric = NonNullable<Product['metric_optimization']>['supported_metrics'][number];
    const metrics: SupportedMetric[] = ['clicks'];
    if (template.channels.some(c => ['olv', 'ctv', 'social', 'gaming'].includes(c))) {
      metrics.push('views', 'completed_views');
    }
    if (template.channels.includes('social')) {
      metrics.push('engagements', 'reach');
    }
    if (metrics.length > 0) {
      product.metric_optimization = {
        supported_metrics: metrics,
        supported_targets: ['cost_per'],
      };
    }
  }

  // Add forecast for non-guaranteed products
  if (template.deliveryType === 'non_guaranteed') {
    const baseCpm = effectivePricing[0]?.floorPrice || effectivePricing[0]?.fixedPrice || 10;
    const impressionsPer1k = Math.round(1000 / baseCpm * 1000);

    const forecastPoints: ForecastPoint[] = [
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
    ];

    product.forecast = {
      points: forecastPoints,
      method: 'modeled',
      currency: effectivePricing[0]?.currency || 'USD',
    };
  }

  // Add conversion tracking for retail/social
  if (pub.catalogTypes?.includes('product') || template.channels.includes('social')) {
    product.conversion_tracking = {
      action_sources: ['website' as const],
      supported_targets: ['cost_per' as const],
      ...(pub.catalogTypes?.includes('product') && { platform_managed: true }),
    };
  }

  // Attach shows whose channels overlap with this product's channels
  if (pub.shows?.length) {
    const matchingShows = pub.shows.filter(s =>
      s.channels.some(c => template.channels.includes(c)),
    );
    if (matchingShows.length > 0) {
      const showSelectors: ShowSelector[] = [{
        publisher_domain: pub.domain,
        show_ids: matchingShows.map(s => s.showId),
      }];
      product.shows = showSelectors;
      // Guaranteed products with shows get exclusivity
      if (template.deliveryType === 'guaranteed') {
        product.exclusivity = matchingShows.length === 1 ? 'exclusive' : 'category';
      }
      // Multi-show non-guaranteed products allow show targeting
      if (matchingShows.length > 1 && template.deliveryType === 'non_guaranteed') {
        product.show_targeting_allowed = true;
      }
      // Flatten episodes from matching shows
      const episodes: Partial<Episode>[] = [];
      for (const show of matchingShows) {
        for (const ep of show.episodes || []) {
          const episode: Partial<Episode> = {
            episode_id: ep.episodeId,
            show_id: show.showId,
            name: ep.title,
            status: ep.status as Episode['status'],
          };
          if (ep.scheduledAt) episode.scheduled_at = ep.scheduledAt;
          if (ep.durationSeconds) episode.duration_seconds = ep.durationSeconds;
          if (ep.special) {
            episode.special = {
              name: ep.special.name,
              ...(ep.special.category && { category: ep.special.category }),
              ...(ep.special.starts && { starts: ep.special.starts }),
              ...(ep.special.ends && { ends: ep.special.ends }),
            };
          }
          episodes.push(episode);
        }
      }
      if (episodes.length > 0) {
        product.episodes = episodes;
      }
    }
  }

  return {
    product: product as Partial<Product>,
    publisherId: pub.id,
    trainingTier: tierForProduct(pub, template.deliveryType, template.channels),
    scenarioTags: scenarioTagsForProduct(pub, template.deliveryType, template.channels),
  };
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
