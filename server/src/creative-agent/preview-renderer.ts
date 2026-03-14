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

function wrapInPage(body: string, dims: RenderDimensions, title: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
  .preview { width: ${dims.width}px; height: ${dims.height}px; overflow: hidden; position: relative; background: #fff; border: 1px solid #e0e0e0; }
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
  if (imageUrl) {
    const img = `<img src="${escapeHtml(imageUrl)}" alt="Ad creative">`;
    body = click
      ? `<div class="preview"><a href="${escapeHtml(click)}" target="_blank">${img}</a></div>`
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

  const imgTag = image
    ? `<img src="${escapeHtml(image)}" alt="Native ad image">`
    : '';

  const body = `<div class="preview"><div class="native-card">
    ${imgTag}
    ${sponsor ? `<div class="sponsor">Sponsored by ${escapeHtml(sponsor)}</div>` : ''}
    <div class="headline">${escapeHtml(headline || 'Native Content')}</div>
    ${description ? `<div class="body">${escapeHtml(description)}</div>` : ''}
    ${clickUrl ? `<a href="${escapeHtml(clickUrl)}" target="_blank" class="cta">Learn more</a>` : ''}
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

  const imgTag = image
    ? `<img src="${escapeHtml(image)}" alt="Social ad image">`
    : '<div style="flex:1;background:linear-gradient(135deg,#667eea,#764ba2)"></div>';

  const body = `<div class="preview"><div class="social-card">
    ${imgTag}
    <div class="content">
      <div class="headline">${escapeHtml(headline || 'Social Ad')}</div>
      ${bodyText ? `<div class="body">${escapeHtml(bodyText)}</div>` : ''}
      ${cta && clickUrl ? `<a href="${escapeHtml(clickUrl)}" target="_blank" class="cta-btn">${escapeHtml(cta)}</a>` : ''}
    </div>
  </div></div>`;

  return wrapInPage(body, dims, manifest.name || 'Social Preview');
}

function renderPlaceholder(manifest: ManifestInput, dims: RenderDimensions, icon: string, label: string): string {
  const body = `<div class="preview"><div class="placeholder"><div class="icon">${icon}</div><div class="label">${escapeHtml(label)}</div><div class="sub">${dims.width}×${dims.height}</div></div></div>`;
  return wrapInPage(body, dims, manifest.name || label);
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
  if (formatId.startsWith('product_card')) {
    return renderPlaceholder(manifest, dims, '🛒', 'Product Card');
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
