/**
 * Creative format definitions for the training agent.
 *
 * Each format is a schema-compliant object matching
 * static/schemas/source/core/format.json.
 */

/**
 * Build all format definitions for the given agent URL.
 * Called once at startup with the resolved base URL.
 */
export function buildFormats(agentUrl: string): Record<string, unknown>[] {
  return [
    // ── Display ──────────────────────────────────────────────
    {
      format_id: { agent_url: agentUrl, id: 'display_static' },
      name: 'Static display',
      description: 'Static image display ad. Provide width and height in format_id to specify dimensions (e.g., 300x250, 728x90, 160x600, 320x50).',
      accepts_parameters: ['width', 'height'],
      renders: [{ role: 'primary', parameters_from_format_id: true }],
      assets: [
        { item_type: 'individual', asset_id: 'image', asset_type: 'image', asset_role: 'hero_image', required: true,
          requirements: { mime_types: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'], max_file_size_bytes: 200000 } },
        { item_type: 'individual', asset_id: 'click_url', asset_type: 'url', asset_role: 'click_through', required: true,
          requirements: { url_type: 'click_through' } },
        { item_type: 'individual', asset_id: 'impression_tracker', asset_type: 'url', asset_role: 'third_party_tracking', required: false,
          requirements: { url_type: 'impression_tracker' } },
      ],
    },

    {
      format_id: { agent_url: agentUrl, id: 'display_300x250' },
      name: 'Medium rectangle (300x250)',
      description: 'Standard IAB medium rectangle display ad.',
      renders: [{ role: 'primary', dimensions: { width: 300, height: 250 } }],
      assets: [
        { item_type: 'individual', asset_id: 'image', asset_type: 'image', asset_role: 'hero_image', required: true,
          requirements: { mime_types: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'], max_file_size_bytes: 200000, min_width: 300, min_height: 250 } },
        { item_type: 'individual', asset_id: 'click_url', asset_type: 'url', asset_role: 'click_through', required: true,
          requirements: { url_type: 'click_through' } },
      ],
    },

    {
      format_id: { agent_url: agentUrl, id: 'display_728x90' },
      name: 'Leaderboard (728x90)',
      description: 'Standard IAB leaderboard display ad.',
      renders: [{ role: 'primary', dimensions: { width: 728, height: 90 } }],
      assets: [
        { item_type: 'individual', asset_id: 'image', asset_type: 'image', asset_role: 'hero_image', required: true,
          requirements: { mime_types: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'], max_file_size_bytes: 200000, min_width: 728, min_height: 90 } },
        { item_type: 'individual', asset_id: 'click_url', asset_type: 'url', asset_role: 'click_through', required: true,
          requirements: { url_type: 'click_through' } },
      ],
    },

    {
      format_id: { agent_url: agentUrl, id: 'display_320x50' },
      name: 'Mobile banner (320x50)',
      description: 'Standard mobile banner display ad.',
      renders: [{ role: 'primary', dimensions: { width: 320, height: 50 } }],
      assets: [
        { item_type: 'individual', asset_id: 'image', asset_type: 'image', asset_role: 'hero_image', required: true,
          requirements: { mime_types: ['image/jpeg', 'image/png', 'image/webp'], max_file_size_bytes: 100000, min_width: 320, min_height: 50 } },
        { item_type: 'individual', asset_id: 'click_url', asset_type: 'url', asset_role: 'click_through', required: true,
          requirements: { url_type: 'click_through' } },
      ],
    },

    // ── Video ─────────────────────────────────────────────────
    {
      format_id: { agent_url: agentUrl, id: 'video_preroll' },
      name: 'Pre-roll video',
      description: 'In-stream pre-roll video ad. Provide duration_ms in format_id (15000 or 30000). Accepts VAST tags or hosted video.',
      accepts_parameters: ['duration_ms'],
      renders: [{ role: 'primary', parameters_from_format_id: true }],
      assets: [
        { item_type: 'individual', asset_id: 'video', asset_type: 'vast', asset_role: 'video_ad', required: true,
          requirements: { vast_versions: ['3.0', '4.0', '4.1', '4.2'] } },
      ],
    },

    {
      format_id: { agent_url: agentUrl, id: 'video_outstream' },
      name: 'Outstream video',
      description: 'Out-stream video ad that plays in-content. Auto-plays muted, expands on interaction.',
      renders: [{ role: 'primary', dimensions: { width: 640, height: 360 } }],
      assets: [
        { item_type: 'individual', asset_id: 'video', asset_type: 'vast', asset_role: 'video_ad', required: true,
          requirements: { vast_versions: ['3.0', '4.0', '4.1', '4.2'] } },
      ],
    },

    // ── CTV ───────────────────────────────────────────────────
    {
      format_id: { agent_url: agentUrl, id: 'ctv_fullscreen' },
      name: 'CTV full-screen',
      description: 'Full-screen connected TV ad at 1920x1080 (16:9). 15s or 30s spots.',
      renders: [{ role: 'primary', dimensions: { width: 1920, height: 1080, aspect_ratio: '16:9' } }],
      assets: [
        { item_type: 'individual', asset_id: 'video', asset_type: 'vast', asset_role: 'video_ad', required: true,
          requirements: { vast_versions: ['4.0', '4.1', '4.2'], min_bitrate_kbps: 2000 } },
      ],
    },

    // ── Audio ─────────────────────────────────────────────────
    {
      format_id: { agent_url: agentUrl, id: 'audio_spot' },
      name: 'Audio spot',
      description: 'Audio ad spot for streaming platforms. Provide duration_ms in format_id (15000, 30000, or 60000).',
      accepts_parameters: ['duration_ms'],
      renders: [{ role: 'primary', parameters_from_format_id: true }],
      assets: [
        { item_type: 'individual', asset_id: 'audio', asset_type: 'daast', asset_role: 'audio_ad', required: true,
          requirements: { daast_versions: ['1.0'] } },
        { item_type: 'individual', asset_id: 'companion', asset_type: 'image', asset_role: 'companion_banner', required: false,
          requirements: { mime_types: ['image/jpeg', 'image/png'], min_width: 300, min_height: 250 } },
      ],
    },

    // ── DOOH ──────────────────────────────────────────────────
    {
      format_id: { agent_url: agentUrl, id: 'dooh_landscape' },
      name: 'DOOH landscape screen',
      description: 'Digital out-of-home landscape display at 1920x1080.',
      renders: [{ role: 'primary', dimensions: { width: 1920, height: 1080 } }],
      assets: [
        { item_type: 'individual', asset_id: 'image', asset_type: 'image', asset_role: 'screen_creative', required: true,
          requirements: { mime_types: ['image/jpeg', 'image/png'], min_width: 1920, min_height: 1080, max_file_size_bytes: 5000000 } },
      ],
    },

    {
      format_id: { agent_url: agentUrl, id: 'dooh_portrait' },
      name: 'DOOH portrait screen',
      description: 'Digital out-of-home portrait display at 1080x1920.',
      renders: [{ role: 'primary', dimensions: { width: 1080, height: 1920 } }],
      assets: [
        { item_type: 'individual', asset_id: 'image', asset_type: 'image', asset_role: 'screen_creative', required: true,
          requirements: { mime_types: ['image/jpeg', 'image/png'], min_width: 1080, min_height: 1920, max_file_size_bytes: 5000000 } },
      ],
    },

    // ── Social ────────────────────────────────────────────────
    {
      format_id: { agent_url: agentUrl, id: 'social_feed_card' },
      name: 'Social feed card',
      description: 'In-feed social ad card at 1080x1080 (1:1 square). Includes image, headline, body text, and CTA.',
      renders: [{ role: 'primary', dimensions: { width: 1080, height: 1080, aspect_ratio: '1:1' } }],
      assets: [
        { item_type: 'individual', asset_id: 'image', asset_type: 'image', asset_role: 'hero_image', required: true,
          requirements: { mime_types: ['image/jpeg', 'image/png'], min_width: 1080, min_height: 1080 } },
        { item_type: 'individual', asset_id: 'headline', asset_type: 'text', asset_role: 'headline', required: true,
          requirements: { max_length: 100 } },
        { item_type: 'individual', asset_id: 'body', asset_type: 'text', asset_role: 'body_copy', required: true,
          requirements: { max_length: 300 } },
        { item_type: 'individual', asset_id: 'cta', asset_type: 'text', asset_role: 'call_to_action', required: false,
          requirements: { max_length: 30 } },
        { item_type: 'individual', asset_id: 'click_url', asset_type: 'url', asset_role: 'click_through', required: true,
          requirements: { url_type: 'click_through' } },
      ],
    },

    {
      format_id: { agent_url: agentUrl, id: 'social_story' },
      name: 'Social story',
      description: 'Full-screen vertical story ad at 1080x1920 (9:16).',
      renders: [{ role: 'primary', dimensions: { width: 1080, height: 1920, aspect_ratio: '9:16' } }],
      assets: [
        { item_type: 'individual', asset_id: 'image', asset_type: 'image', asset_role: 'hero_image', required: true,
          requirements: { mime_types: ['image/jpeg', 'image/png', 'image/webp'], min_width: 1080, min_height: 1920 } },
        { item_type: 'individual', asset_id: 'click_url', asset_type: 'url', asset_role: 'click_through', required: true,
          requirements: { url_type: 'click_through' } },
      ],
    },

    {
      format_id: { agent_url: agentUrl, id: 'social_video_reel' },
      name: 'Social video reel',
      description: 'Short-form vertical video for social reels/shorts. 9:16 aspect ratio, 15-60s.',
      renders: [{ role: 'primary', dimensions: { width: 1080, height: 1920, aspect_ratio: '9:16' } }],
      assets: [
        { item_type: 'individual', asset_id: 'video', asset_type: 'video', asset_role: 'reel_video', required: true,
          requirements: { mime_types: ['video/mp4'], min_width: 1080, min_height: 1920, min_duration_ms: 5000, max_duration_ms: 60000, max_file_size_bytes: 100000000 } },
        { item_type: 'individual', asset_id: 'click_url', asset_type: 'url', asset_role: 'click_through', required: false,
          requirements: { url_type: 'click_through' } },
      ],
    },

    // ── Native ────────────────────────────────────────────────
    {
      format_id: { agent_url: agentUrl, id: 'native_content_card' },
      name: 'Native content card',
      description: 'Responsive native content card that adapts to the host page layout. Includes image, headline, description, and sponsor label.',
      renders: [{ role: 'primary', dimensions: { responsive: { width: true, height: true }, min_width: 280, max_width: 800 } }],
      assets: [
        { item_type: 'individual', asset_id: 'image', asset_type: 'image', asset_role: 'thumbnail', required: true,
          requirements: { mime_types: ['image/jpeg', 'image/png', 'image/webp'], min_width: 600, min_height: 400 } },
        { item_type: 'individual', asset_id: 'headline', asset_type: 'text', asset_role: 'headline', required: true,
          requirements: { max_length: 90 } },
        { item_type: 'individual', asset_id: 'description', asset_type: 'text', asset_role: 'body_copy', required: true,
          requirements: { max_length: 200 } },
        { item_type: 'individual', asset_id: 'sponsor', asset_type: 'text', asset_role: 'sponsor_name', required: true,
          requirements: { max_length: 50 } },
        { item_type: 'individual', asset_id: 'click_url', asset_type: 'url', asset_role: 'click_through', required: true,
          requirements: { url_type: 'click_through' } },
      ],
    },

    // ── Carousel ──────────────────────────────────────────────
    {
      format_id: { agent_url: agentUrl, id: 'carousel_card' },
      name: 'Carousel',
      description: 'Multi-card carousel ad. 2-10 cards, each with image, headline, and link. Cards display sequentially.',
      renders: [{ role: 'primary', dimensions: { width: 1080, height: 1080, aspect_ratio: '1:1' } }],
      assets: [
        {
          item_type: 'repeatable_group', asset_group_id: 'card', required: true, min_count: 2, max_count: 10, selection_mode: 'sequential',
          assets: [
            { asset_id: 'card_image', asset_type: 'image', required: true,
              requirements: { mime_types: ['image/jpeg', 'image/png'], min_width: 1080, min_height: 1080 } },
            { asset_id: 'card_headline', asset_type: 'text', required: true,
              requirements: { max_length: 80 } },
            { asset_id: 'card_url', asset_type: 'url', required: true,
              requirements: { url_type: 'click_through' } },
          ],
        },
      ],
    },

    // ── Email ─────────────────────────────────────────────────
    {
      format_id: { agent_url: agentUrl, id: 'email_sponsored' },
      name: 'Sponsored email placement',
      description: 'Sponsored content block within email newsletters. HTML-safe image + text.',
      renders: [{ role: 'primary', dimensions: { width: 600, height: 250 } }],
      assets: [
        { item_type: 'individual', asset_id: 'image', asset_type: 'image', asset_role: 'hero_image', required: true,
          requirements: { mime_types: ['image/jpeg', 'image/png', 'image/gif'], min_width: 600, min_height: 200, max_file_size_bytes: 300000 } },
        { item_type: 'individual', asset_id: 'headline', asset_type: 'text', asset_role: 'headline', required: true,
          requirements: { max_length: 80 } },
        { item_type: 'individual', asset_id: 'body', asset_type: 'text', asset_role: 'body_copy', required: true,
          requirements: { max_length: 250 } },
        { item_type: 'individual', asset_id: 'click_url', asset_type: 'url', asset_role: 'click_through', required: true,
          requirements: { url_type: 'click_through' } },
      ],
    },

    // ── Retail / Sponsored Product ────────────────────────────
    {
      format_id: { agent_url: agentUrl, id: 'sponsored_product' },
      name: 'Sponsored product listing',
      description: 'Native product listing within retail search and browse results. Uses catalog data for product image, title, and pricing.',
      renders: [{ role: 'primary', dimensions: { responsive: { width: true, height: true }, min_width: 200, max_width: 400 } }],
      assets: [
        { item_type: 'individual', asset_id: 'catalog', asset_type: 'catalog', asset_role: 'product_feed', required: true,
          requirements: { catalog_types: ['product'] } },
      ],
    },

    // ── Influencer / Creator ─────────────────────────────────
    {
      format_id: { agent_url: agentUrl, id: 'creator_brief' },
      name: 'Creator content brief',
      description: 'Brief-driven creator content. Provide a creative brief and the creator produces content matching brand guidelines.',
      renders: [{ role: 'primary', dimensions: { responsive: { width: true, height: true } } }],
      assets: [
        { item_type: 'individual', asset_id: 'brief', asset_type: 'brief', asset_role: 'creative_brief', required: true },
        { item_type: 'individual', asset_id: 'logo', asset_type: 'image', asset_role: 'brand_logo', required: false,
          requirements: { mime_types: ['image/png', 'image/svg+xml'], min_width: 200, min_height: 200 } },
      ],
    },

    // ── Gaming ────────────────────────────────────────────────
    {
      format_id: { agent_url: agentUrl, id: 'gaming_interstitial' },
      name: 'In-game interstitial',
      description: 'Full-screen interstitial displayed between game levels or during natural breaks.',
      renders: [{ role: 'primary', dimensions: { width: 1080, height: 1920, aspect_ratio: '9:16' } }],
      assets: [
        { item_type: 'individual', asset_id: 'image', asset_type: 'image', asset_role: 'interstitial_creative', required: true,
          requirements: { mime_types: ['image/jpeg', 'image/png'], min_width: 1080, min_height: 1920, max_file_size_bytes: 500000 } },
        { item_type: 'individual', asset_id: 'click_url', asset_type: 'url', asset_role: 'click_through', required: true,
          requirements: { url_type: 'click_through' } },
      ],
    },

    {
      format_id: { agent_url: agentUrl, id: 'gaming_rewarded_video' },
      name: 'Rewarded video',
      description: 'Opt-in video ad that rewards the player (extra lives, in-game currency) after viewing. High completion rates.',
      renders: [{ role: 'primary', dimensions: { width: 1920, height: 1080, aspect_ratio: '16:9' } }],
      assets: [
        { item_type: 'individual', asset_id: 'video', asset_type: 'vast', asset_role: 'rewarded_video', required: true,
          requirements: { vast_versions: ['4.0', '4.1', '4.2'] } },
      ],
    },

    // ── Search ──────────────────────────────────────────────
    {
      format_id: { agent_url: agentUrl, id: 'search_text_ad' },
      name: 'Search text ad',
      description: 'Text-based search ad with headline, description, display URL, and sitelinks. Rendered in search results alongside organic listings.',
      renders: [{ role: 'primary', dimensions: { responsive: { width: true, height: true } } }],
      assets: [
        { item_type: 'individual', asset_id: 'headline_1', asset_type: 'text', asset_role: 'headline', required: true,
          requirements: { max_length: 30 } },
        { item_type: 'individual', asset_id: 'headline_2', asset_type: 'text', asset_role: 'headline', required: true,
          requirements: { max_length: 30 } },
        { item_type: 'individual', asset_id: 'headline_3', asset_type: 'text', asset_role: 'headline', required: false,
          requirements: { max_length: 30 } },
        { item_type: 'individual', asset_id: 'description_1', asset_type: 'text', asset_role: 'body_copy', required: true,
          requirements: { max_length: 90 } },
        { item_type: 'individual', asset_id: 'description_2', asset_type: 'text', asset_role: 'body_copy', required: false,
          requirements: { max_length: 90 } },
        { item_type: 'individual', asset_id: 'display_url', asset_type: 'text', asset_role: 'display_url', required: true,
          requirements: { max_length: 35 } },
        { item_type: 'individual', asset_id: 'click_url', asset_type: 'url', asset_role: 'click_through', required: true,
          requirements: { url_type: 'click_through' } },
      ],
    },

    {
      format_id: { agent_url: agentUrl, id: 'search_shopping' },
      name: 'Search shopping listing',
      description: 'Product listing ad shown in search shopping results. Uses catalog data for product image, title, price, and merchant info.',
      renders: [{ role: 'primary', dimensions: { responsive: { width: true, height: true }, min_width: 150, max_width: 300 } }],
      assets: [
        { item_type: 'individual', asset_id: 'catalog', asset_type: 'catalog', asset_role: 'product_feed', required: true,
          requirements: { catalog_types: ['product'] } },
        { item_type: 'individual', asset_id: 'click_url', asset_type: 'url', asset_role: 'click_through', required: true,
          requirements: { url_type: 'click_through' } },
      ],
    },

    // ── AI / Conversational ──────────────────────────────────
    {
      format_id: { agent_url: agentUrl, id: 'ai_sponsored_recommendation' },
      name: 'AI sponsored recommendation',
      description: 'Native sponsored recommendation within AI assistant responses. Markdown-formatted content that blends with conversational context.',
      renders: [{ role: 'primary', dimensions: { responsive: { width: true, height: true } } }],
      assets: [
        { item_type: 'individual', asset_id: 'content', asset_type: 'markdown', asset_role: 'recommendation_content', required: true,
          requirements: { max_length: 500 } },
        { item_type: 'individual', asset_id: 'image', asset_type: 'image', asset_role: 'product_image', required: false,
          requirements: { mime_types: ['image/jpeg', 'image/png', 'image/webp'], min_width: 400, min_height: 400 } },
        { item_type: 'individual', asset_id: 'click_url', asset_type: 'url', asset_role: 'click_through', required: true,
          requirements: { url_type: 'click_through' } },
      ],
    },

    {
      format_id: { agent_url: agentUrl, id: 'ai_sponsored_agent' },
      name: 'Sponsored intelligence agent',
      description: 'Brand-sponsored AI agent on NovaMind AI platform. Buyers provide agent persona instructions, brand identity, and an optional knowledge base URL. The platform hosts the agent in discovery and conversational surfaces. System prompt limited to 4,000 characters (~1,000 tokens). Knowledge base content retrieved dynamically with up to 8,000 tokens per conversation turn.',
      renders: [
        { role: 'agent_card', dimensions: { width: 300, height: 250, responsive: { width: true, height: false } } },
        { role: 'conversational', dimensions: { responsive: { width: true, height: true } } },
      ],
      assets: [
        { item_type: 'individual', asset_id: 'agent_name', asset_type: 'text', asset_role: 'agent_identity', required: true,
          requirements: { max_length: 60 } },
        { item_type: 'individual', asset_id: 'system_prompt', asset_type: 'text', asset_role: 'system_prompt', required: true,
          requirements: { min_length: 50, max_length: 4000 } },
        { item_type: 'individual', asset_id: 'welcome_message', asset_type: 'text', asset_role: 'greeting', required: true,
          requirements: { max_length: 300 } },
        { item_type: 'individual', asset_id: 'agent_icon', asset_type: 'image', asset_role: 'brand_logo', required: true,
          requirements: { mime_types: ['image/png', 'image/webp'], min_width: 256, min_height: 256, max_file_size_bytes: 500000 } },
        { item_type: 'individual', asset_id: 'knowledge_base', asset_type: 'url', asset_role: 'data_source', required: false,
          requirements: { url_type: 'data_feed' } },
        { item_type: 'individual', asset_id: 'click_url', asset_type: 'url', asset_role: 'click_through', required: true,
          requirements: { url_type: 'click_through' } },
      ],
    },
  ];
}

/**
 * Map of format IDs to the channels they're typically used with.
 * Used by the product factory to assign appropriate formats to products.
 */
export const FORMAT_CHANNEL_MAP: Record<string, string[]> = {
  display_static: ['display'],
  display_300x250: ['display'],
  display_728x90: ['display'],
  display_320x50: ['display'],
  video_preroll: ['olv'],
  video_outstream: ['olv', 'display'],
  ctv_fullscreen: ['ctv', 'linear_tv'],
  audio_spot: ['streaming_audio', 'podcast'],
  dooh_landscape: ['dooh'],
  dooh_portrait: ['dooh'],
  social_feed_card: ['social'],
  social_story: ['social'],
  social_video_reel: ['social'],
  native_content_card: ['display'],
  carousel_card: ['social', 'display'],
  email_sponsored: ['email'],
  sponsored_product: ['retail_media'],
  creator_brief: ['influencer'],
  gaming_interstitial: ['gaming'],
  gaming_rewarded_video: ['gaming'],
  search_text_ad: ['search'],
  search_shopping: ['search'],
  ai_sponsored_recommendation: ['display'],
  ai_sponsored_agent: ['display'],
};
