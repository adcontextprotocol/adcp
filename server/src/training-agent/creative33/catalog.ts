/** Bounded, deterministic fixtures for the isolated AdCP 3.3 beta sandbox. */
import { createHash } from 'node:crypto';
import { getAgentUrl } from '../config.js';

export const CREATIVE33_WIRE_VERSION = '3.3-beta.1';
export const CREATIVE33_SCHEMA_VERSION = '3.3.0-beta.1';
export const CREATIVE33_ROUTE = '/beta/3.3/creative';
export const CREATIVE33_SIZES = [{ width: 300, height: 250 }, { width: 728, height: 90 }];
export const CREATIVE33_RESPONSIVE_HTML = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;width:100%;height:100%}body{display:grid;place-items:center;background:#163c31;color:white;font:18px sans-serif}</style></head><body>Acme outdoor — deterministic sandbox fixture</body></html>';

export const CREATIVE33_HTML_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  properties: {
    slots: { const: [{ asset_group_id: 'html_document', asset_type: 'html', required: true }] },
    sizes: { type: 'array', minItems: 1, uniqueItems: true, items: { enum: CREATIVE33_SIZES } },
  },
  required: ['slots', 'sizes'],
  additionalProperties: false,
};
export const CREATIVE33_HTML_SCHEMA_BYTES = Buffer.from(JSON.stringify(CREATIVE33_HTML_SCHEMA));
export const CREATIVE33_HTML_SCHEMA_DIGEST = `sha256:${createHash('sha256').update(CREATIVE33_HTML_SCHEMA_BYTES).digest('hex')}`;

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
/** One stored ZIP member; no extraction or execution of buyer archives. */
function fixtureZip(): Buffer {
  const filename = Buffer.from('index.html');
  const data = Buffer.from(CREATIVE33_RESPONSIVE_HTML);
  const checksum = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
  local.writeUInt32LE(checksum, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(filename.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt32LE(checksum, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(filename.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + filename.length, 12); end.writeUInt32LE(local.length + filename.length + data.length, 16);
  return Buffer.concat([local, filename, data, central, filename, end]);
}
export const CREATIVE33_ZIP_BYTES = fixtureZip();
export const CREATIVE33_ZIP_DIGEST = `sha256:${createHash('sha256').update(CREATIVE33_ZIP_BYTES).digest('hex')}`;

export function creative33FixtureUrl(file: string): string {
  return `${getAgentUrl()}${CREATIVE33_ROUTE}/fixtures/${file}`;
}

export function creative33Catalog() {
  const sizeParams = { sizes: structuredClone(CREATIVE33_SIZES) };
  const slot = (asset_group_id: string, asset_type: string, required = true) => ({ asset_group_id, asset_type, required });
  const destinationSlot = [slot('landing_page_url', 'url', false)];
  return [
    { capability_id: 'beta_html5_responsive', operations: ['build', 'validate', 'preview'], format: {
      format_kind: 'html5', technical_requirements_complete: true,
      params: { ...sizeParams, slots: [slot('html5_bundle', 'zip'), ...destinationSlot] },
    } },
    ...(['inline', 'url'] as const).map(delivery => ({
      capability_id: `beta_display_${delivery}`, operations: ['build', 'validate', 'preview'], format: {
        format_kind: 'display_tag', technical_requirements_complete: true,
        params: { ...sizeParams, supported_delivery_types: [delivery === 'inline' ? 'inline_markup' : 'tag_url'], slots: [slot('serving_tag', 'display_tag'), ...destinationSlot] },
      },
    })),
    { capability_id: 'beta_video_15s', operations: ['build', 'validate', 'preview'], format: {
      format_kind: 'video_hosted', technical_requirements_complete: true,
      params: { width: 640, height: 360, duration_ms_exact: 15000, slots: [slot('video_main', 'video'), slot('landing_page_url', 'url', false)] },
    } },
    { capability_id: 'beta_video_brief_input', operations: ['validate'], format: {
      format_kind: 'video_hosted', technical_requirements_complete: true,
      params: { slots: [{ ...slot('video_brief', 'video_brief'), consumed_for_production: true }, slot('creative_brief', 'brief', false), slot('landing_page_url', 'url', false)] },
    } },
    { capability_id: 'beta_inline_html', operations: ['validate', 'preview'], format: {
      format_kind: 'custom', format_shape: 'inline_html_document', canonical_formats_only: true,
      format_schema: { uri: `${getAgentUrl()}${CREATIVE33_ROUTE}/formats/inline-html.json`, digest: CREATIVE33_HTML_SCHEMA_DIGEST },
      technical_requirements_complete: true,
      params: { ...sizeParams, slots: [slot('html_document', 'html')] },
    } },
  ];
}

export function creative33FixtureManifest(capabilityId: string): Record<string, unknown> {
  const sizes = structuredClone(CREATIVE33_SIZES);
  if (capabilityId === 'beta_html5_responsive') return { format_kind: 'html5', assets: {
    html5_bundle: { asset_type: 'zip', url: creative33FixtureUrl('responsive.zip'), digest: CREATIVE33_ZIP_DIGEST, entry_point: 'index.html', sizes },
  } };
  if (capabilityId === 'beta_display_inline') return { format_kind: 'display_tag', assets: {
    serving_tag: { asset_type: 'display_tag', delivery_type: 'inline_markup', markup_type: 'iframe_javascript', markup: `<iframe src="${creative33FixtureUrl('responsive.html')}" style="display:block;width:100%;height:100%;border:0" title="Acme sandbox"></iframe>`, sizes },
  } };
  if (capabilityId === 'beta_display_url') return { format_kind: 'display_tag', assets: {
    serving_tag: { asset_type: 'display_tag', delivery_type: 'tag_url', url: creative33FixtureUrl('responsive.html'), sizes },
  } };
  throw new Error('No deterministic build fixture for this capability');
}
