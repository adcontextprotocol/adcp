/**
 * Document-level VAST validation for the training seller.
 *
 * Implements `creative_specs.vast_validation: "document"` from the video
 * channel contract: parse inline XML, require a `<VAST>` root, compare the
 * submitted document's version with the asset declaration, and apply the
 * product ∩ seller acceptance intersection when both sets are known.
 * Wrapper-chain resolution is out of scope (that is the `wrapper` level).
 * URL-delivered assets stay opaque here so the training agent does not fetch
 * buyer-supplied URLs.
 */

import { DOMParser } from 'linkedom';
import { SaxesParser } from 'saxes';

export const TRAINING_SELLER_VAST_VERSIONS = ['2.0', '3.0', '4.0', '4.1', '4.2', '4.3'] as const;

export type TrainingSellerVastVersion = (typeof TRAINING_SELLER_VAST_VERSIONS)[number];

export type VastDocumentValidationError = {
  code: 'VAST_PARSE_FAILED' | 'VAST_VERSION_MISMATCH';
  message: string;
  field: string;
  recovery: 'correctable';
  details: Record<string, unknown>;
};

type VastAssetRecord = {
  asset_type?: unknown;
  delivery_type?: unknown;
  content?: unknown;
  url?: unknown;
  vast_version?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function elementName(node: { localName?: string; tagName?: string }): string {
  const raw = typeof node.localName === 'string' && node.localName.length > 0
    ? node.localName
    : typeof node.tagName === 'string'
      ? node.tagName.replace(/^.*:/, '')
      : '';
  return raw.toLowerCase();
}

function walkElements(node: { childNodes?: ArrayLike<unknown> } | null | undefined): Array<{ localName?: string; tagName?: string; childNodes?: ArrayLike<unknown> }> {
  const found: Array<{ localName?: string; tagName?: string; childNodes?: ArrayLike<unknown> }> = [];
  if (!node?.childNodes) return found;
  for (const child of Array.from(node.childNodes)) {
    if (!child || typeof child !== 'object') continue;
    const element = child as { nodeType?: number; localName?: string; tagName?: string; childNodes?: ArrayLike<unknown> };
    if (element.nodeType === 1 || element.localName || element.tagName) {
      found.push(element);
      found.push(...walkElements(element));
    }
  }
  return found;
}

function namedDescendants(
  root: { childNodes?: ArrayLike<unknown> },
  name: string,
): Array<{ localName?: string; tagName?: string }> {
  return walkElements(root).filter(node => elementName(node) === name);
}

function isWellFormedXml(xml: string): boolean {
  let parseError: Error | undefined;
  const parser = new SaxesParser({ xmlns: true });
  parser.on('error', error => {
    parseError ??= error;
  });
  try {
    parser.write(xml).close();
  } catch {
    return false;
  }
  return parseError === undefined;
}

export function formatOptionVastVersions(params: unknown): string[] | undefined {
  if (!isRecord(params)) return undefined;
  if (Array.isArray(params.vast_versions)) {
    const versions = params.vast_versions.filter((value): value is string => typeof value === 'string');
    return versions.length > 0 ? versions : undefined;
  }
  if (typeof params.vast_version === 'string' && params.vast_version.length > 0) {
    return [params.vast_version];
  }
  return undefined;
}

export function resolveProductVastVersions(
  formatOptionRef: Record<string, unknown> | undefined,
  products: Iterable<{ format_options?: unknown }>,
): string[] | undefined {
  const optionId = typeof formatOptionRef?.format_option_id === 'string'
    ? formatOptionRef.format_option_id
    : undefined;
  if (!optionId) return undefined;
  for (const product of products) {
    if (!Array.isArray(product.format_options)) continue;
    for (const option of product.format_options) {
      if (!isRecord(option)) continue;
      if (option.format_option_id !== optionId) continue;
      return formatOptionVastVersions(option.params);
    }
  }
  return undefined;
}

function collectInlineVastAssets(
  assets: unknown,
): Array<{ groupId: string; asset: VastAssetRecord }> {
  if (!isRecord(assets)) return [];
  const found: Array<{ groupId: string; asset: VastAssetRecord }> = [];
  for (const [groupId, value] of Object.entries(assets)) {
    if (!isRecord(value) || value.asset_type !== 'vast') continue;
    found.push({ groupId, asset: value });
  }
  return found;
}

export function validateInlineVastDocument(args: {
  xml: string;
  field: string;
  assetVastVersion?: string;
  productVastVersions?: string[];
  sellerVastVersions: readonly string[];
}): VastDocumentValidationError | null {
  const { xml, field, assetVastVersion, productVastVersions, sellerVastVersions } = args;
  const trimmed = xml.trim();
  if (!trimmed.startsWith('<')) {
    return {
      code: 'VAST_PARSE_FAILED',
      message: 'VAST document is not well-formed XML',
      field,
      recovery: 'correctable',
      details: { reason: 'not_xml' },
    };
  }

  if (!isWellFormedXml(trimmed)) {
    return {
      code: 'VAST_PARSE_FAILED',
      message: 'VAST document is not well-formed XML',
      field,
      recovery: 'correctable',
      details: { reason: 'not_xml' },
    };
  }

  let document: ReturnType<DOMParser['parseFromString']>;
  try {
    document = new DOMParser().parseFromString(trimmed, 'text/xml');
  } catch {
    return {
      code: 'VAST_PARSE_FAILED',
      message: 'VAST document is not well-formed XML',
      field,
      recovery: 'correctable',
      details: { reason: 'not_xml' },
    };
  }
  const root = document.documentElement;
  if (!root || elementName(root) === 'parsererror') {
    return {
      code: 'VAST_PARSE_FAILED',
      message: 'VAST document is not well-formed XML',
      field,
      recovery: 'correctable',
      details: { reason: 'not_xml' },
    };
  }
  if (elementName(root) !== 'vast') {
    return {
      code: 'VAST_PARSE_FAILED',
      message: 'VAST document root element is not <VAST>',
      field,
      recovery: 'correctable',
      details: { reason: 'no_vast_root' },
    };
  }

  const observedVersion = root.getAttribute('version');
  const observedDocumentVastVersion = observedVersion === null || observedVersion === ''
    ? null
    : observedVersion;

  if (assetVastVersion) {
    if (observedDocumentVastVersion !== assetVastVersion) {
      return {
        code: 'VAST_VERSION_MISMATCH',
        message: 'Submitted VAST document version does not match the asset declaration',
        field,
        recovery: 'correctable',
        details: {
          mismatch_reason: 'document_version_mismatch',
          asset_vast_version: assetVastVersion,
          observed_document_vast_version: observedDocumentVastVersion,
          document_role: 'submitted',
        },
      };
    }

    const productSet = productVastVersions && productVastVersions.length > 0
      ? productVastVersions
      : undefined;
    const sellerSet = sellerVastVersions.length > 0 ? [...sellerVastVersions] : undefined;
    if (productSet && sellerSet && !productSet.filter(version => sellerSet.includes(version)).includes(assetVastVersion)) {
      return {
        code: 'VAST_VERSION_MISMATCH',
        message: 'VAST asset version is outside the product and seller compatibility intersection',
        field,
        recovery: 'correctable',
        details: {
          mismatch_reason: 'asset_outside_acceptance',
          asset_vast_version: assetVastVersion,
          product_vast_versions: productSet,
          seller_vast_versions: sellerSet,
        },
      };
    }
  }

  if (namedDescendants(root, 'ad').length === 0) {
    return {
      code: 'VAST_PARSE_FAILED',
      message: 'VAST document contains no <Ad> element',
      field,
      recovery: 'correctable',
      details: { reason: 'no_ad' },
    };
  }

  const hasInlineLinear = namedDescendants(root, 'inline').length > 0
    && namedDescendants(root, 'linear').length > 0;
  if (hasInlineLinear && namedDescendants(root, 'mediafile').length === 0) {
    return {
      code: 'VAST_PARSE_FAILED',
      message: 'Inline linear VAST creative carries no <MediaFile>',
      field,
      recovery: 'correctable',
      details: { reason: 'no_media_file' },
    };
  }

  return null;
}

export function validateCreativeVastDocuments(args: {
  assets: unknown;
  fieldPrefix: string;
  productVastVersions?: string[];
  sellerVastVersions?: readonly string[];
}): VastDocumentValidationError | null {
  const sellerVastVersions = args.sellerVastVersions ?? TRAINING_SELLER_VAST_VERSIONS;
  for (const { groupId, asset } of collectInlineVastAssets(args.assets)) {
    if (asset.delivery_type !== 'inline') continue;
    const field = `${args.fieldPrefix}.assets.${groupId}`;
    if (typeof asset.content !== 'string') {
      return {
        code: 'VAST_PARSE_FAILED',
        message: 'Inline VAST asset is missing XML content',
        field,
        recovery: 'correctable',
        details: { reason: 'not_xml' },
      };
    }
    const error = validateInlineVastDocument({
      xml: asset.content,
      field,
      assetVastVersion: typeof asset.vast_version === 'string' ? asset.vast_version : undefined,
      productVastVersions: args.productVastVersions,
      sellerVastVersions,
    });
    if (error) return error;
  }
  return null;
}
