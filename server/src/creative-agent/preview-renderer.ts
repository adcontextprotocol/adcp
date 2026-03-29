/**
 * Template-based HTML preview renderer for standard creative formats.
 *
 * Generates preview HTML from creative manifests without AI. Each format
 * type has a rendering strategy based on its asset types.
 *
 * Asset values follow the AdCP schema:
 * - Image/Video/Audio/URL assets: `url` field
 * - Text/HTML/Markdown assets: `content` field
 */

/** An individual asset value from a creative manifest. */
interface AssetValue {
  url?: string;
  content?: string;
  [key: string]: unknown;
}

/** Assets map: asset_id -> asset value. */
type AssetsMap = Record<string, AssetValue>;

interface ManifestInput {
  format_id?: { agent_url?: string; id?: string; width?: number; height?: number };
  name?: string;
  assets?: AssetsMap;
  [key: string]: unknown;
}

interface RenderDimensions {
  width: number;
  height: number;
}

/**
 * Get a display value from an asset. URL-based assets use `url`,
 * text-based assets use `content`, per the AdCP schema.
 */
function getAssetValue(assets: AssetsMap, assetId: string): string {
  const asset = assets[assetId];
  if (!asset) return '';
  return asset.url || asset.content || '';
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function wrapInPage(body: string, dims: RenderDimensions, title: string, responsive = false): string {
  const previewStyle = responsive
    ? 'width: 100%; max-width: 600px; height: auto; min-height: 400px;'
    : `width: ${dims.width}px; height: ${dims.height}px;`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
  .preview { ${previewStyle} overflow: hidden; position: relative; background: #fff; border: 1px solid #e0e0e0; }
  .preview img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .placeholder { display: flex; flex-direction: column; align-items: center; justify-content: center; width: 100%; height: 100%; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #fff; text-align: center; padding: 16px; }
  .placeholder .icon { font-size: 48px; margin-bottom: 12px; }
  .placeholder .label { font-size: 14px; font-weight: 600; }
  .placeholder .sub { font-size: 11px; opacity: 0.8; margin-top: 4px; }
  .native-card { padding: 16px; display: flex; flex-direction: column; gap: 8px; height: 100%; }
  .native-card img { width: 100%; height: 60%; object-fit: cover; border-radius: 4px; }
  .native-card .headline { font-size: 16px; font-weight: 600; color: #1a1a1a; }
  .native-card .body { font-size: 13px; color: #555; line-height: 1.4; }
  .native-card .sponsor { font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; }
  .native-card .cta { font-size: 13px; color: #667eea; font-weight: 600; }
  .social-card { display: flex; flex-direction: column; height: 100%; }
  .social-card img { width: 100%; flex: 1; object-fit: cover; }
  .social-card .content { padding: 12px; }
  .social-card .headline { font-size: 14px; font-weight: 600; color: #1a1a1a; }
  .social-card .body { font-size: 12px; color: #555; margin-top: 4px; }
  .social-card .cta-btn { display: inline-block; margin-top: 8px; padding: 6px 16px; background: #667eea; color: #fff; border-radius: 4px; font-size: 12px; font-weight: 600; text-decoration: none; }

  /* Clickable cards */
  a.card-link { text-decoration: none; color: inherit; display: block; height: 100%; }
  a.card-link:hover { opacity: 0.97; }
  a.card-link:hover .product-card, a.card-link:hover .product-card-detailed, a.card-link:hover .proposal-card, a.card-link:hover .proposal-card-detailed { box-shadow: 0 4px 16px rgba(0,0,0,0.12); }

  /* Product cards */
  .product-card { display: flex; flex-direction: column; height: 100%; transition: box-shadow 0.15s; }
  .product-card__image { position: relative; flex: 0 0 45%; overflow: hidden; }
  .product-card__image img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .product-card__image-placeholder { width: 100%; height: 100%; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); display: flex; align-items: center; justify-content: center; color: rgba(255,255,255,0.6); font-size: 48px; }
  .product-card__badge { position: absolute; top: 8px; right: 8px; padding: 3px 8px; border-radius: 3px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; }
  .product-card__badge--guaranteed { background: linear-gradient(135deg, #667eea, #764ba2); color: #fff; }
  .product-card__badge--non_guaranteed { background: rgba(255,255,255,0.9); color: #374151; border: 1px solid rgba(0,0,0,0.15); }
  .product-card__publisher { padding: 6px 12px 0; font-size: 10px; font-weight: 600; text-transform: uppercase; color: #9ca3af; letter-spacing: 0.5px; }
  .product-card__body { flex: 1; padding: 6px 12px 12px; display: flex; flex-direction: column; gap: 4px; }
  .product-card__name { font-size: 15px; font-weight: 600; color: #1a1a1a; line-height: 1.3; }
  .product-card__desc { font-size: 12px; color: #6b7280; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .product-card__audience { font-size: 11px; color: #667eea; font-weight: 500; margin-top: 2px; }
  .product-card__volume { font-size: 10px; color: #9ca3af; }
  .product-card__footer { padding: 10px 12px; border-top: 1px solid #f0f0f0; display: flex; align-items: center; justify-content: space-between; margin-top: auto; }
  .product-card__pricing { display: flex; flex-direction: column; gap: 1px; }
  .product-card__pricing-model { font-size: 10px; font-weight: 600; text-transform: uppercase; color: #9ca3af; letter-spacing: 0.5px; }
  .product-card__pricing-amount { font-size: 14px; font-weight: 700; color: #1a1a1a; }
  .product-card__asset-type { font-size: 11px; color: #9ca3af; display: flex; align-items: center; gap: 4px; }
  .product-card__asset-icon { font-size: 16px; }

  /* Product card detailed */
  .product-card-detailed { display: flex; flex-direction: column; transition: box-shadow 0.15s; }
  .product-card-detailed__header { position: relative; height: 200px; overflow: hidden; }
  .product-card-detailed__header img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .product-card-detailed__header-placeholder { width: 100%; height: 100%; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); display: flex; align-items: center; justify-content: center; color: rgba(255,255,255,0.5); font-size: 64px; }
  .product-card-detailed__overlay { position: absolute; top: 12px; right: 12px; display: flex; gap: 6px; }
  .product-card-detailed__badge { padding: 4px 10px; border-radius: 4px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; }
  .product-card-detailed__badge--guaranteed { background: linear-gradient(135deg, #667eea, #764ba2); color: #fff; }
  .product-card-detailed__badge--non_guaranteed { background: rgba(255,255,255,0.9); color: #374151; border: 1px solid rgba(0,0,0,0.15); }
  .product-card-detailed__asset-type { padding: 4px 10px; border-radius: 4px; font-size: 11px; font-weight: 600; background: rgba(0,0,0,0.5); color: #fff; }
  .product-card-detailed__content { padding: 20px; }
  .product-card-detailed__publisher { font-size: 11px; font-weight: 600; text-transform: uppercase; color: #9ca3af; letter-spacing: 0.5px; margin-bottom: 4px; }
  .product-card-detailed__name { font-size: 20px; font-weight: 700; color: #1a1a1a; margin-bottom: 8px; }
  .product-card-detailed__desc { font-size: 14px; color: #6b7280; line-height: 1.6; margin-bottom: 12px; }
  .product-card-detailed__audience { font-size: 13px; color: #667eea; font-weight: 500; margin-bottom: 4px; }
  .product-card-detailed__volume { font-size: 12px; color: #9ca3af; margin-bottom: 16px; }
  .product-card-detailed__pricing { padding: 12px; background: #f9fafb; border-radius: 6px; }
  .product-card-detailed__pricing-label { font-size: 11px; font-weight: 600; text-transform: uppercase; color: #9ca3af; letter-spacing: 0.5px; margin-bottom: 4px; }
  .product-card-detailed__pricing-value { font-size: 18px; font-weight: 700; color: #1a1a1a; }

  /* Proposal cards */
  .proposal-card { display: flex; flex-direction: column; height: 100%; transition: box-shadow 0.15s; }
  .proposal-card__image { width: 100%; height: 120px; object-fit: cover; display: block; }
  .proposal-card__header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 16px; display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
  .proposal-card__name { font-size: 14px; font-weight: 700; color: #fff; line-height: 1.3; flex: 1; }
  .proposal-card__status { padding: 3px 8px; border-radius: 3px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; white-space: nowrap; }
  .proposal-card__status--draft { background: #fbbf24; color: #92400e; }
  .proposal-card__status--committed { background: #34d399; color: #065f46; }
  .proposal-card__publisher { font-size: 10px; font-weight: 600; text-transform: uppercase; color: rgba(255,255,255,0.7); letter-spacing: 0.5px; margin-bottom: 2px; }
  .proposal-card__allocations { flex: 1; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
  .proposal-card__alloc-row { display: flex; align-items: center; gap: 8px; }
  .proposal-card__alloc-label { font-size: 11px; color: #6b7280; width: 90px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .proposal-card__alloc-bar-bg { flex: 1; height: 16px; background: #f3f4f6; border-radius: 3px; overflow: hidden; }
  .proposal-card__alloc-bar { height: 100%; border-radius: 3px; }
  .proposal-card__alloc-pct { font-size: 11px; font-weight: 700; color: #1a1a1a; width: 32px; text-align: right; }
  .proposal-card__budget { padding: 8px 12px; border-top: 1px solid #f0f0f0; display: flex; align-items: center; justify-content: space-between; }
  .proposal-card__budget-label { font-size: 10px; font-weight: 600; text-transform: uppercase; color: #9ca3af; letter-spacing: 0.5px; }
  .proposal-card__budget-range { font-size: 13px; font-weight: 600; color: #1a1a1a; }
  .proposal-card__alignment { padding: 8px 12px; font-size: 11px; color: #9ca3af; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }

  /* Proposal card detailed */
  .proposal-card-detailed { display: flex; flex-direction: column; transition: box-shadow 0.15s; }
  .proposal-card-detailed__image { width: 100%; height: 200px; object-fit: cover; display: block; }
  .proposal-card-detailed__header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 24px; display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
  .proposal-card-detailed__name { font-size: 18px; font-weight: 700; color: #fff; line-height: 1.3; flex: 1; }
  .proposal-card-detailed__status { padding: 4px 10px; border-radius: 4px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; white-space: nowrap; }
  .proposal-card-detailed__status--draft { background: #fbbf24; color: #92400e; }
  .proposal-card-detailed__status--committed { background: #34d399; color: #065f46; }
  .proposal-card-detailed__content { padding: 20px; }
  .proposal-card-detailed__desc { font-size: 14px; color: #6b7280; line-height: 1.5; margin-bottom: 16px; }
  .proposal-card-detailed__section-title { font-size: 11px; font-weight: 600; text-transform: uppercase; color: #9ca3af; letter-spacing: 0.5px; margin-bottom: 8px; }
  .proposal-card-detailed__alloc-row { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; }
  .proposal-card-detailed__alloc-label { font-size: 13px; color: #374151; width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .proposal-card-detailed__publisher { font-size: 11px; font-weight: 600; text-transform: uppercase; color: rgba(255,255,255,0.7); letter-spacing: 0.5px; margin-bottom: 4px; }
  .proposal-card-detailed__alloc-bar-bg { flex: 1; height: 20px; background: #f3f4f6; border-radius: 4px; overflow: hidden; }
  .proposal-card-detailed__alloc-bar { height: 100%; border-radius: 4px; }
  .proposal-card-detailed__alloc-pct { font-size: 13px; font-weight: 700; color: #1a1a1a; width: 40px; text-align: right; }
  .proposal-card-detailed__alloc-rationale { font-size: 11px; color: #9ca3af; margin: 0 0 12px 150px; line-height: 1.4; }
  .proposal-card-detailed__delivery { font-size: 12px; color: #667eea; font-weight: 500; margin-bottom: 16px; }
  .proposal-card-detailed__budget { padding: 16px 20px; background: #f9fafb; border-radius: 6px; margin: 16px 0; display: flex; gap: 24px; }
  .proposal-card-detailed__budget-item { display: flex; flex-direction: column; gap: 2px; }
  .proposal-card-detailed__budget-item-label { font-size: 10px; font-weight: 600; text-transform: uppercase; color: #9ca3af; letter-spacing: 0.5px; }
  .proposal-card-detailed__budget-item-value { font-size: 16px; font-weight: 700; color: #1a1a1a; }
  .proposal-card-detailed__alignment { font-size: 13px; color: #6b7280; line-height: 1.5; margin-top: 16px; padding-top: 16px; border-top: 1px solid #f0f0f0; }
</style>
</head>
<body>${body}</body>
</html>`;
}

function inferDimensions(manifest: ManifestInput, format: Record<string, unknown> | undefined): RenderDimensions {
  // Check format_id parameters first
  const fid = manifest.format_id;
  if (fid?.width && fid?.height) {
    return { width: fid.width, height: fid.height };
  }

  // Check format renders
  if (format) {
    const renders = format.renders as Array<{ dimensions?: { width?: number; height?: number } }> | undefined;
    if (renders?.[0]?.dimensions?.width && renders?.[0]?.dimensions?.height) {
      return {
        width: renders[0].dimensions.width,
        height: renders[0].dimensions.height,
      };
    }
  }

  // Default
  return { width: 300, height: 250 };
}

/** Check if any asset has a url field (image/video/audio). */
function hasImageAsset(assets: AssetsMap): boolean {
  return Object.values(assets).some(a => a.url && !a.content);
}

function renderDisplay(manifest: ManifestInput, dims: RenderDimensions): string {
  const assets = manifest.assets || {};
  // Look for common display asset IDs
  const imageUrl = getAssetValue(assets, 'banner_image') || getAssetValue(assets, 'image');
  const click = getAssetValue(assets, 'click_url');

  let body: string;
  if (imageUrl && isSafeUrl(imageUrl)) {
    const img = `<img src="${escapeHtml(imageUrl)}" alt="Ad creative">`;
    body = click && isSafeUrl(click)
      ? `<div class="preview"><a href="${escapeHtml(click)}" target="_blank" rel="noopener">${img}</a></div>`
      : `<div class="preview">${img}</div>`;
  } else {
    body = `<div class="preview"><div class="placeholder"><div class="icon">🖼</div><div class="label">Display Ad</div><div class="sub">${dims.width}×${dims.height}</div></div></div>`;
  }

  return wrapInPage(body, dims, manifest.name || 'Display Preview');
}

function renderVideo(manifest: ManifestInput, dims: RenderDimensions, label: string): string {
  const assets = manifest.assets || {};
  const videoUrl = getAssetValue(assets, 'video_file') || getAssetValue(assets, 'video_asset') || getAssetValue(assets, 'vast_tag');

  const body = `<div class="preview"><div class="placeholder"><div class="icon">▶</div><div class="label">${escapeHtml(label)}</div><div class="sub">${videoUrl ? 'VAST tag provided' : 'No video asset'}</div></div></div>`;
  return wrapInPage(body, dims, manifest.name || label);
}

function renderAudio(manifest: ManifestInput, dims: RenderDimensions): string {
  const body = `<div class="preview"><div class="placeholder"><div class="icon">♪</div><div class="label">Audio Ad</div><div class="sub">DAAST audio spot</div></div></div>`;
  return wrapInPage(body, dims, manifest.name || 'Audio Preview');
}

function renderNative(manifest: ManifestInput, dims: RenderDimensions): string {
  const assets = manifest.assets || {};
  const image = getAssetValue(assets, 'main_image') || getAssetValue(assets, 'image');
  const headline = getAssetValue(assets, 'title') || getAssetValue(assets, 'headline');
  const description = getAssetValue(assets, 'description');
  const sponsor = getAssetValue(assets, 'sponsored_by') || getAssetValue(assets, 'sponsor');
  const clickUrl = getAssetValue(assets, 'click_url');

  const imgTag = image && isSafeUrl(image)
    ? `<img src="${escapeHtml(image)}" alt="Native ad image">`
    : '';

  const body = `<div class="preview"><div class="native-card">
    ${imgTag}
    ${sponsor ? `<div class="sponsor">Sponsored by ${escapeHtml(sponsor)}</div>` : ''}
    <div class="headline">${escapeHtml(headline || 'Native Content')}</div>
    ${description ? `<div class="body">${escapeHtml(description)}</div>` : ''}
    ${clickUrl && isSafeUrl(clickUrl) ? `<a href="${escapeHtml(clickUrl)}" target="_blank" rel="noopener" class="cta">Learn more</a>` : ''}
  </div></div>`;

  return wrapInPage(body, dims, manifest.name || 'Native Preview');
}

function renderSocial(manifest: ManifestInput, dims: RenderDimensions): string {
  const assets = manifest.assets || {};
  const image = getAssetValue(assets, 'image');
  const headline = getAssetValue(assets, 'headline') || getAssetValue(assets, 'title');
  const bodyText = getAssetValue(assets, 'body') || getAssetValue(assets, 'description');
  const cta = getAssetValue(assets, 'cta_text') || getAssetValue(assets, 'cta');
  const clickUrl = getAssetValue(assets, 'click_url');

  const imgTag = image && isSafeUrl(image)
    ? `<img src="${escapeHtml(image)}" alt="Social ad image">`
    : '<div style="flex:1;background:linear-gradient(135deg,#667eea,#764ba2)"></div>';

  const body = `<div class="preview"><div class="social-card">
    ${imgTag}
    <div class="content">
      <div class="headline">${escapeHtml(headline || 'Social Ad')}</div>
      ${bodyText ? `<div class="body">${escapeHtml(bodyText)}</div>` : ''}
      ${cta && clickUrl && isSafeUrl(clickUrl) ? `<a href="${escapeHtml(clickUrl)}" target="_blank" rel="noopener" class="cta-btn">${escapeHtml(cta)}</a>` : ''}
    </div>
  </div></div>`;

  return wrapInPage(body, dims, manifest.name || 'Social Preview');
}

function renderPlaceholder(manifest: ManifestInput, dims: RenderDimensions, icon: string, label: string): string {
  const body = `<div class="preview"><div class="placeholder"><div class="icon">${icon}</div><div class="label">${escapeHtml(label)}</div><div class="sub">${dims.width}×${dims.height}</div></div></div>`;
  return wrapInPage(body, dims, manifest.name || label);
}

const ASSET_TYPE_ICONS: Record<string, string> = {
  video: '\u25B6',   // ▶
  audio: '\u266A',   // ♪
  social: '\u2B50',  // ⭐ -- not an emoji, just a star
  display: '\u25A6', // ▦
  native: '\u2B1A',  // ⬚
};

function isSafeUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function wrapClickable(inner: string, clickUrl: string): string {
  if (!clickUrl || !isSafeUrl(clickUrl)) return inner;
  return `<a href="${escapeHtml(clickUrl)}" target="_blank" rel="noopener" class="card-link">${inner}</a>`;
}

const VALID_PROPOSAL_STATUSES = new Set(['draft', 'committed']);

/** Distinct hues for allocation bars so products are visually distinguishable. */
const ALLOC_COLORS = [
  'linear-gradient(90deg, #667eea, #764ba2)', // purple
  'linear-gradient(90deg, #f59e0b, #d97706)', // amber
  'linear-gradient(90deg, #10b981, #059669)', // emerald
  'linear-gradient(90deg, #3b82f6, #2563eb)', // blue
  'linear-gradient(90deg, #ef4444, #dc2626)', // red
  'linear-gradient(90deg, #8b5cf6, #7c3aed)', // violet
];

function getAllocColor(index: number): string {
  return ALLOC_COLORS[index % ALLOC_COLORS.length];
}

function renderProductCard(manifest: ManifestInput, dims: RenderDimensions): string {
  const assets = manifest.assets || {};
  const image = getAssetValue(assets, 'product_image');
  const name = getAssetValue(assets, 'product_name') || 'Product';
  const description = getAssetValue(assets, 'product_description');
  const pricingModel = getAssetValue(assets, 'pricing_model');
  const pricingAmount = getAssetValue(assets, 'pricing_amount');
  const pricingCurrency = getAssetValue(assets, 'pricing_currency');
  const deliveryType = getAssetValue(assets, 'delivery_type');
  const assetType = getAssetValue(assets, 'primary_asset_type');
  const clickUrl = getAssetValue(assets, 'click_url');
  const publisherName = getAssetValue(assets, 'publisher_name');
  const audienceSummary = getAssetValue(assets, 'audience_summary');
  const estimatedVolume = getAssetValue(assets, 'estimated_volume');

  const imageHtml = image && isSafeUrl(image)
    ? `<img src="${escapeHtml(image)}" alt="${escapeHtml(name)}">`
    : `<div class="product-card__image-placeholder">${ASSET_TYPE_ICONS[assetType] || ASSET_TYPE_ICONS.display}</div>`;

  const badgeClass = deliveryType === 'guaranteed' ? 'guaranteed' : 'non_guaranteed';
  const badgeLabel = deliveryType === 'guaranteed' ? 'Guaranteed' : 'Auction';
  const badgeHtml = deliveryType
    ? `<span class="product-card__badge product-card__badge--${badgeClass}">${escapeHtml(badgeLabel)}</span>`
    : '';

  const pricingHtml = pricingModel
    ? `<div class="product-card__pricing">
        <span class="product-card__pricing-model">${escapeHtml(pricingModel)}</span>
        <span class="product-card__pricing-amount">${pricingCurrency ? escapeHtml(pricingCurrency) + ' ' : ''}${pricingAmount ? escapeHtml(pricingAmount) : ''}</span>
      </div>`
    : '';

  const assetIcon = ASSET_TYPE_ICONS[assetType] || '';
  const assetTypeHtml = assetType
    ? `<span class="product-card__asset-type"><span class="product-card__asset-icon">${assetIcon}</span>${escapeHtml(assetType)}</span>`
    : '';

  const card = `<div class="product-card">
    <div class="product-card__image">${imageHtml}${badgeHtml}</div>
    ${publisherName ? `<div class="product-card__publisher">${escapeHtml(publisherName)}</div>` : ''}
    <div class="product-card__body">
      <h3 class="product-card__name">${escapeHtml(name)}</h3>
      ${description ? `<p class="product-card__desc" title="${escapeHtml(description)}">${escapeHtml(description)}</p>` : ''}
      ${audienceSummary ? `<div class="product-card__audience">${escapeHtml(audienceSummary)}</div>` : ''}
      ${estimatedVolume ? `<div class="product-card__volume">${escapeHtml(estimatedVolume)}</div>` : ''}
    </div>
    <div class="product-card__footer">${pricingHtml}${assetTypeHtml}</div>
  </div>`;

  const body = `<div class="preview">${wrapClickable(card, clickUrl)}</div>`;
  return wrapInPage(body, dims, manifest.name || name);
}

function renderProductCardDetailed(manifest: ManifestInput, dims: RenderDimensions): string {
  const assets = manifest.assets || {};
  const image = getAssetValue(assets, 'product_image');
  const name = getAssetValue(assets, 'product_name') || 'Product';
  const description = getAssetValue(assets, 'product_description');
  const pricingModel = getAssetValue(assets, 'pricing_model');
  const pricingAmount = getAssetValue(assets, 'pricing_amount');
  const pricingCurrency = getAssetValue(assets, 'pricing_currency');
  const deliveryType = getAssetValue(assets, 'delivery_type');
  const assetType = getAssetValue(assets, 'primary_asset_type');
  const clickUrl = getAssetValue(assets, 'click_url');
  const publisherName = getAssetValue(assets, 'publisher_name');
  const audienceSummary = getAssetValue(assets, 'audience_summary');
  const estimatedVolume = getAssetValue(assets, 'estimated_volume');

  const imageHtml = image && isSafeUrl(image)
    ? `<img src="${escapeHtml(image)}" alt="${escapeHtml(name)}">`
    : `<div class="product-card-detailed__header-placeholder">${ASSET_TYPE_ICONS[assetType] || ASSET_TYPE_ICONS.display}</div>`;

  const badgeClass = deliveryType === 'guaranteed' ? 'guaranteed' : 'non_guaranteed';
  const badgeLabel = deliveryType === 'guaranteed' ? 'Guaranteed' : 'Auction';
  const overlayHtml = `<div class="product-card-detailed__overlay">
    ${deliveryType ? `<span class="product-card-detailed__badge product-card-detailed__badge--${badgeClass}">${escapeHtml(badgeLabel)}</span>` : ''}
    ${assetType ? `<span class="product-card-detailed__asset-type">${escapeHtml(assetType)}</span>` : ''}
  </div>`;

  const pricingHtml = pricingModel
    ? `<div class="product-card-detailed__pricing">
        <div class="product-card-detailed__pricing-label">${escapeHtml(pricingModel)}</div>
        <div class="product-card-detailed__pricing-value">${pricingCurrency ? escapeHtml(pricingCurrency) + ' ' : ''}${pricingAmount ? escapeHtml(pricingAmount) : ''}</div>
      </div>`
    : '';

  const card = `<div class="product-card-detailed">
    <div class="product-card-detailed__header">${imageHtml}${overlayHtml}</div>
    <div class="product-card-detailed__content">
      ${publisherName ? `<div class="product-card-detailed__publisher">${escapeHtml(publisherName)}</div>` : ''}
      <h2 class="product-card-detailed__name">${escapeHtml(name)}</h2>
      ${description ? `<p class="product-card-detailed__desc">${escapeHtml(description)}</p>` : ''}
      ${audienceSummary ? `<div class="product-card-detailed__audience">${escapeHtml(audienceSummary)}</div>` : ''}
      ${estimatedVolume ? `<div class="product-card-detailed__volume">${escapeHtml(estimatedVolume)}</div>` : ''}
      ${pricingHtml}
    </div>
  </div>`;

  const body = `<div class="preview">${wrapClickable(card, clickUrl)}</div>`;
  return wrapInPage(body, dims, manifest.name || name, true);
}

interface AllocationEntry {
  product_id: string;
  product_name?: string;
  allocation_percentage: number;
  rationale?: string;
  estimated_impressions?: string;
}

function parseAllocations(raw: string): AllocationEntry[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (a: unknown): a is AllocationEntry =>
        typeof a === 'object' && a !== null &&
        typeof (a as AllocationEntry).product_id === 'string' &&
        typeof (a as AllocationEntry).allocation_percentage === 'number',
    );
  } catch {
    return [];
  }
}

function allocLabel(a: AllocationEntry): string {
  if (a.product_name) return a.product_name;
  // Fallback: turn "pinnacle_news_video_premium" into "video premium"
  const parts = a.product_id.split('_');
  if (parts.length <= 2) return a.product_id;
  return parts.slice(-2).join(' ');
}

function renderProposalCard(manifest: ManifestInput, dims: RenderDimensions): string {
  const assets = manifest.assets || {};
  const name = getAssetValue(assets, 'proposal_name') || 'Proposal';
  const status = getAssetValue(assets, 'proposal_status');
  const allocationData = getAssetValue(assets, 'allocation_data');
  const budgetMin = getAssetValue(assets, 'budget_min');
  const budgetRec = getAssetValue(assets, 'budget_recommended');
  const budgetCurrency = getAssetValue(assets, 'budget_currency') || 'USD';
  const alignment = getAssetValue(assets, 'brief_alignment');
  const proposalImage = getAssetValue(assets, 'proposal_image');
  const clickUrl = getAssetValue(assets, 'click_url');
  const publisherName = getAssetValue(assets, 'publisher_name');

  const allocations = parseAllocations(allocationData);

  const statusHtml = status
    ? `<span class="proposal-card__status proposal-card__status--${VALID_PROPOSAL_STATUSES.has(status) ? status : 'draft'}">${escapeHtml(status)}</span>`
    : '';

  const imageHtml = proposalImage && isSafeUrl(proposalImage)
    ? `<img class="proposal-card__image" src="${escapeHtml(proposalImage)}" alt="${escapeHtml(name)}">`
    : '';

  const allocRows = allocations.map((a, i) =>
    `<div class="proposal-card__alloc-row">
      <div class="proposal-card__alloc-label" title="${escapeHtml(allocLabel(a))}">${escapeHtml(allocLabel(a))}</div>
      <div class="proposal-card__alloc-bar-bg"><div class="proposal-card__alloc-bar" style="width:${Math.min(100, Math.max(0, a.allocation_percentage))}%;background:${getAllocColor(i)}" role="progressbar" aria-valuenow="${a.allocation_percentage}" aria-valuemin="0" aria-valuemax="100"></div></div>
      <div class="proposal-card__alloc-pct">${a.allocation_percentage}%</div>
    </div>`).join('');

  const budgetHtml = budgetMin || budgetRec
    ? `<div class="proposal-card__budget">
        <span class="proposal-card__budget-label">Budget</span>
        <span class="proposal-card__budget-range">${escapeHtml(budgetCurrency)} ${budgetMin ? escapeHtml(formatBudget(Number(budgetMin))) : ''} \u2013 ${budgetRec ? escapeHtml(formatBudget(Number(budgetRec))) : ''}</span>
      </div>`
    : '';

  const card = `<div class="proposal-card">
    ${imageHtml}
    <div class="proposal-card__header">
      ${publisherName ? `<div class="proposal-card__publisher">${escapeHtml(publisherName)}</div>` : ''}
      <div class="proposal-card__name">${escapeHtml(name)}</div>
      ${statusHtml}
    </div>
    <div class="proposal-card__allocations">${allocRows || '<div style="color:#9ca3af;font-size:12px;text-align:center;padding:16px;">No allocations</div>'}</div>
    ${budgetHtml}
    ${alignment ? `<div class="proposal-card__alignment">${escapeHtml(alignment)}</div>` : ''}
  </div>`;

  const body = `<div class="preview">${wrapClickable(card, clickUrl)}</div>`;
  return wrapInPage(body, dims, manifest.name || name);
}

function renderProposalCardDetailed(manifest: ManifestInput, dims: RenderDimensions): string {
  const assets = manifest.assets || {};
  const name = getAssetValue(assets, 'proposal_name') || 'Proposal';
  const description = getAssetValue(assets, 'proposal_description');
  const status = getAssetValue(assets, 'proposal_status');
  const allocationData = getAssetValue(assets, 'allocation_data');
  const budgetMin = getAssetValue(assets, 'budget_min');
  const budgetRec = getAssetValue(assets, 'budget_recommended');
  const budgetCurrency = getAssetValue(assets, 'budget_currency') || 'USD';
  const alignment = getAssetValue(assets, 'brief_alignment');
  const proposalImage = getAssetValue(assets, 'proposal_image');
  const clickUrl = getAssetValue(assets, 'click_url');
  const publisherName = getAssetValue(assets, 'publisher_name');
  const estimatedDelivery = getAssetValue(assets, 'estimated_delivery');

  const allocations = parseAllocations(allocationData);

  const statusHtml = status
    ? `<span class="proposal-card-detailed__status proposal-card-detailed__status--${VALID_PROPOSAL_STATUSES.has(status) ? status : 'draft'}">${escapeHtml(status)}</span>`
    : '';

  // Header: image replaces gradient when provided
  const safeImage = proposalImage && isSafeUrl(proposalImage);
  const headerStyle = safeImage ? '' : ' style="background:linear-gradient(135deg,#667eea 0%,#764ba2 100%)"';
  const headerContent = safeImage
    ? `<img class="proposal-card-detailed__image" src="${escapeHtml(proposalImage)}" alt="${escapeHtml(name)}">
       <div style="position:absolute;bottom:0;left:0;right:0;padding:24px;background:linear-gradient(transparent,rgba(0,0,0,0.6))">
         ${publisherName ? `<div class="proposal-card-detailed__publisher">${escapeHtml(publisherName)}</div>` : ''}
         <div class="proposal-card-detailed__name">${escapeHtml(name)}</div>
         ${statusHtml}
       </div>`
    : `${publisherName ? `<div class="proposal-card-detailed__publisher">${escapeHtml(publisherName)}</div>` : ''}<div class="proposal-card-detailed__name">${escapeHtml(name)}</div>${statusHtml}`;

  const allocRows = allocations.map((a, i) =>
    `<div class="proposal-card-detailed__alloc-row">
      <div class="proposal-card-detailed__alloc-label" title="${escapeHtml(allocLabel(a))}">${escapeHtml(allocLabel(a))}</div>
      <div class="proposal-card-detailed__alloc-bar-bg"><div class="proposal-card-detailed__alloc-bar" style="width:${Math.min(100, Math.max(0, a.allocation_percentage))}%;background:${getAllocColor(i)}" role="progressbar" aria-valuenow="${a.allocation_percentage}" aria-valuemin="0" aria-valuemax="100"></div></div>
      <div class="proposal-card-detailed__alloc-pct">${a.allocation_percentage}%</div>
    </div>
    ${a.rationale ? `<div class="proposal-card-detailed__alloc-rationale">${escapeHtml(a.rationale)}${a.estimated_impressions ? ` \u2014 est. ${escapeHtml(a.estimated_impressions)} impressions` : ''}</div>` : ''}`).join('');

  const budgetItems: string[] = [];
  if (budgetMin) {
    budgetItems.push(`<div class="proposal-card-detailed__budget-item">
      <span class="proposal-card-detailed__budget-item-label">Minimum</span>
      <span class="proposal-card-detailed__budget-item-value">${escapeHtml(budgetCurrency)} ${escapeHtml(formatBudgetFull(Number(budgetMin)))}</span>
    </div>`);
  }
  if (budgetRec) {
    budgetItems.push(`<div class="proposal-card-detailed__budget-item">
      <span class="proposal-card-detailed__budget-item-label">Recommended</span>
      <span class="proposal-card-detailed__budget-item-value">${escapeHtml(budgetCurrency)} ${escapeHtml(formatBudgetFull(Number(budgetRec)))}</span>
    </div>`);
  }

  const card = `<div class="proposal-card-detailed">
    <div class="proposal-card-detailed__header"${headerStyle}>
      ${headerContent}
    </div>
    <div class="proposal-card-detailed__content">
      ${description ? `<p class="proposal-card-detailed__desc">${escapeHtml(description)}</p>` : ''}
      ${estimatedDelivery ? `<div class="proposal-card-detailed__delivery">${escapeHtml(estimatedDelivery)}</div>` : ''}
      <div class="proposal-card-detailed__section-title">Allocations</div>
      ${allocRows || '<div style="color:#9ca3af;font-size:13px;">No allocations</div>'}
      ${budgetItems.length > 0 ? `<div class="proposal-card-detailed__budget">${budgetItems.join('')}</div>` : ''}
      ${alignment ? `<div class="proposal-card-detailed__alignment">${escapeHtml(alignment)}</div>` : ''}
    </div>
  </div>`;

  const body = `<div class="preview">${wrapClickable(card, clickUrl)}</div>`;
  return wrapInPage(body, dims, manifest.name || name, true);
}

function formatBudget(amount: number): string {
  if (isNaN(amount)) return '';
  if (amount >= 1000) return `${Math.round(amount / 1000)}K`;
  return String(amount);
}

function formatBudgetFull(amount: number): string {
  if (isNaN(amount)) return '';
  return amount.toLocaleString('en-US');
}

/**
 * Render a creative manifest to an HTML preview string.
 */
export function renderPreview(
  manifest: ManifestInput,
  format: Record<string, unknown> | undefined,
): string {
  const dims = inferDimensions(manifest, format);
  const formatId = manifest.format_id?.id || '';

  // Route to format-specific renderer.
  // Handles both training agent IDs (display_300x250) and reference agent IDs (display_300x250_image).
  if (formatId.startsWith('display_') || formatId === 'email_sponsored') {
    return renderDisplay(manifest, dims);
  }
  if (formatId.startsWith('video_') || formatId.startsWith('ctv_') || formatId.startsWith('gaming_rewarded')) {
    return renderVideo(manifest, dims, formatId.includes('ctv') ? 'CTV Ad' : 'Video Ad');
  }
  if (formatId.startsWith('audio_') || formatId === 'radio_spot') {
    return renderAudio(manifest, dims);
  }
  if (formatId.startsWith('native_')) {
    return renderNative(manifest, dims);
  }
  if (formatId.startsWith('social_')) {
    return renderSocial(manifest, dims);
  }
  if (formatId.startsWith('dooh_')) {
    return renderDisplay(manifest, dims);
  }
  if (formatId === 'product_card_standard') {
    return renderProductCard(manifest, dims);
  }
  if (formatId === 'product_card_detailed') {
    return renderProductCardDetailed(manifest, { width: 600, height: 800 });
  }
  if (formatId.startsWith('product_card')) {
    return renderPlaceholder(manifest, dims, '🛒', 'Product Card');
  }
  if (formatId === 'proposal_card_standard') {
    return renderProposalCard(manifest, dims);
  }
  if (formatId === 'proposal_card_detailed') {
    return renderProposalCardDetailed(manifest, { width: 600, height: 800 });
  }
  if (formatId.startsWith('format_card')) {
    return renderPlaceholder(manifest, dims, '📋', 'Format Card');
  }
  if (formatId === 'carousel_card') {
    return renderPlaceholder(manifest, dims, '⊞', 'Carousel Ad');
  }
  if (formatId === 'sponsored_product' || formatId === 'search_shopping') {
    return renderPlaceholder(manifest, dims, '🛒', 'Product Listing');
  }
  if (formatId === 'search_text_ad') {
    return renderPlaceholder(manifest, dims, '🔍', 'Search Text Ad');
  }
  if (formatId.startsWith('ai_')) {
    return renderPlaceholder(manifest, dims, '✦', 'AI Ad Format');
  }
  if (formatId === 'creator_brief') {
    return renderPlaceholder(manifest, dims, '✎', 'Creator Brief');
  }
  if (formatId === 'gaming_interstitial') {
    return renderDisplay(manifest, dims);
  }
  if (formatId === 'print_full_page') {
    return renderPlaceholder(manifest, { width: 400, height: 520 }, '📄', 'Print Ad');
  }

  // Fallback: try display rendering if there's an image asset, otherwise placeholder
  const assets = manifest.assets || {};
  if (hasImageAsset(assets)) {
    return renderDisplay(manifest, dims);
  }
  return renderPlaceholder(manifest, dims, '📐', formatId || 'Creative Preview');
}
