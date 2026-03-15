/**
 * Product factory — generates schema-compliant products from publisher profiles.
 *
 * Each publisher produces 1-4 products depending on its channel/delivery
 * combinations. Products reference formats from formats.ts via format_id.
 */

import type { PublisherProfile, PricingTemplate, CatalogProduct, ShowDefinition } from './types.js';
import { PUBLISHERS } from './publishers.js';
import { FORMAT_CHANNEL_MAP } from './formats.js';
import { getAgentUrl } from './config.js';

function buildPricingOption(
  template: PricingTemplate,
  productId: string,
  index: number,
): Record<string, unknown> {
  const option: Record<string, unknown> = {
    pricing_option_id: `${productId}_pricing_${index}`,
    pricing_model: template.model,
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

function formatIdsForChannels(channels: string[], agentUrl: string): Record<string, unknown>[] {
  const ids: Record<string, unknown>[] = [];
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

function publisherPropertySelectors(pub: PublisherProfile, channels?: string[]): Record<string, unknown>[] {
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

  const product: Record<string, unknown> = {
    product_id: productId,
    name: template.name,
    description: template.description,
    publisher_properties: publisherPropertySelectors(pub, template.channels),
    channels: template.channels,
    format_ids: formatIdsForChannels(template.channels, agentUrl),
    delivery_type: template.deliveryType,
    delivery_measurement: {
      provider: pub.measurementProvider,
      notes: pub.measurementNotes,
    },
    pricing_options: effectivePricing.map((t, i) => buildPricingOption(t, productId, i)),
  };

  if (pub.reportingFrequencies || pub.reportingMetrics) {
    product.reporting_capabilities = {
      available_reporting_frequencies: pub.reportingFrequencies || ['daily'],
      expected_delay_minutes: 240,
      timezone: 'UTC',
      supports_webhooks: false,
      ...(pub.reportingMetrics && { available_metrics: pub.reportingMetrics }),
      date_range_support: 'date_range',
      supports_creative_breakdown: true,
    };
  }

  if (pub.catalogTypes?.length) {
    product.catalog_types = pub.catalogTypes;
  }

  // Add metric optimization for non-guaranteed products with appropriate channels
  if (template.deliveryType === 'non_guaranteed') {
    const metrics: string[] = ['clicks'];
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

    product.forecast = {
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

  // Add conversion tracking for retail/social
  if (pub.catalogTypes?.includes('product') || template.channels.includes('social')) {
    product.conversion_tracking = {
      action_sources: ['website'],
      supported_targets: ['cost_per'],
      ...(pub.catalogTypes?.includes('product') && { platform_managed: true }),
    };
  }

  // Attach shows whose channels overlap with this product's channels
  if (pub.shows?.length) {
    const matchingShows = pub.shows.filter(s =>
      s.channels.some(c => template.channels.includes(c)),
    );
    if (matchingShows.length > 0) {
      product.show_ids = matchingShows.map(s => s.showId);
      // Guaranteed products with shows get exclusivity
      if (template.deliveryType === 'guaranteed') {
        product.exclusivity = matchingShows.length === 1 ? 'exclusive' : 'category';
      }
      // Flatten episodes from matching shows
      const episodes: Record<string, unknown>[] = [];
      for (const show of matchingShows) {
        for (const ep of show.episodes || []) {
          const episode: Record<string, unknown> = {
            episode_id: ep.episodeId,
            show_id: show.showId,
            name: ep.title,
            status: ep.status,
          };
          if (ep.scheduledAt) episode.scheduled_at = ep.scheduledAt;
          if (ep.duration) episode.duration_seconds = ep.duration;
          episodes.push(episode);
        }
      }
      if (episodes.length > 0) {
        product.episodes = episodes;
      }
    }
  }

  return {
    product,
    publisherId: pub.id,
    trainingTier: tierForProduct(pub, template.deliveryType, template.channels),
    scenarioTags: scenarioTagsForProduct(pub, template.deliveryType, template.channels),
  };
}

function buildShowObject(show: ShowDefinition): Record<string, unknown> {
  const obj: Record<string, unknown> = {
    show_id: show.showId,
    name: show.name,
    genre: show.genre,
    cadence: show.cadence,
    status: show.status,
  };
  if (show.description) obj.description = show.description;
  if (show.contentRatings?.length) {
    obj.content_rating = show.contentRatings.map(r => ({
      system: r.system,
      rating: r.rating,
    }));
  }
  if (show.talent?.length) {
    obj.talent = show.talent.map(t => ({
      name: t.name,
      role: t.role,
    }));
  }
  if (show.distribution?.length) {
    obj.distribution = show.distribution.map(d => ({
      publisher_domain: d.publisherDomain,
      identifiers: d.identifiers.map(id => ({ type: id.type, value: id.value })),
    }));
  }
  return obj;
}

/**
 * Build the top-level shows array for a get_products response,
 * scoped to only shows referenced by the given products.
 */
export function buildShowsForProducts(products: Record<string, unknown>[]): Record<string, unknown>[] {
  const referencedIds = new Set<string>();
  for (const p of products) {
    const ids = p.show_ids as string[] | undefined;
    if (ids) ids.forEach(id => referencedIds.add(id));
  }
  if (referencedIds.size === 0) return [];

  const shows: Record<string, unknown>[] = [];
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
