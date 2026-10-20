import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';

type Declaration = { format_kind: string; params: Record<string, unknown> };
type Slot = { asset_group_id: string; asset_type: string; required?: boolean };
type Asset = Record<string, unknown>;
type CatalogEntry = {
  format_id: { id: string };
  renders?: Array<{ dimensions?: { width?: number; height?: number } }>;
  assets?: Array<{ asset_id?: string; asset_type?: string; required?: boolean }>;
  canonical?: { kind: string; asset_source?: string; slots_override?: Slot[]; supported_delivery_types?: string[] };
};
type SelectionVector = {
  id: string;
  product_legacy_formats: string[];
  creative: { format_kind: string; assets: Record<string, Asset> };
  expected:
    | { status: 'selected'; format_id: string; legacy_assets: Record<string, Asset> }
    | { status: 'unavailable' | 'ambiguous'; reason?: string };
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(fs.readFileSync(
  path.join(root, 'static/test-vectors/html-markup-legacy-projection.json'), 'utf8',
)) as {
  catalog: string;
  product_projection_vectors: Array<{ id: string; format_id: string; expected_v2: Declaration }>;
  legacy_selection_vectors: SelectionVector[];
};
const catalog = JSON.parse(fs.readFileSync(path.join(root, fixture.catalog), 'utf8')) as CatalogEntry[];
const byId = new Map(catalog.map(entry => [entry.format_id.id, entry]));

const ajv = new Ajv({ allErrors: true, strict: false, discriminator: true });
addFormats(ajv);
ajv.addFormat('uri-template', true);
function addSchemas(dir: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) addSchemas(file);
    else if (entry.name.endsWith('.json')) {
      const schema = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (schema.$id && !ajv.getSchema(schema.$id)) ajv.addSchema(schema, schema.$id);
    }
  }
}
addSchemas(path.join(root, 'static/schemas/source'));
const schema = (id: string) => {
  const validate = ajv.getSchema(id);
  if (!validate) throw new Error(`missing schema ${id}`);
  return validate;
};

/** Reference implementation of canonical-projection-ref rules 1-6 plus fixed render dimensions. */
function project(formatId: string): Declaration {
  const entry = byId.get(formatId);
  if (!entry?.canonical) throw new Error(`${formatId} has no canonical annotation`);
  const { canonical } = entry;
  const params: Record<string, unknown> = {};
  const dimensions = entry.renders?.[0]?.dimensions;
  if (dimensions?.width && dimensions?.height) {
    params.width = dimensions.width;
    params.height = dimensions.height;
  }
  if (canonical.asset_source !== undefined) params.asset_source = canonical.asset_source;
  if (canonical.slots_override !== undefined) params.slots = canonical.slots_override;
  if (canonical.supported_delivery_types !== undefined) {
    params.supported_delivery_types = canonical.supported_delivery_types;
  }
  return { format_kind: canonical.kind, params };
}

const REASON_ORDER = ['format_kind_mismatch', 'delivery_type_not_supported', 'rendered_size_unproven', 'no_size_match'];

/** Reference legacy selection for a canonical creative against a product's legacy refs. */
function select(vector: SelectionVector): SelectionVector['expected'] {
  const failures: string[] = [];
  const matches: Array<{ formatId: string; slots: Slot[] }> = [];
  for (const formatId of vector.product_legacy_formats) {
    const { format_kind: kind, params } = project(formatId);
    if (kind !== vector.creative.format_kind) { failures.push('format_kind_mismatch'); continue; }
    const slots = (params.slots as Slot[] | undefined) ?? [];
    const required = slots.filter(slot => slot.required);
    const accepted = (params.supported_delivery_types as string[] | undefined) ?? ['tag_url'];
    const assets = required.map(slot => vector.creative.assets[slot.asset_group_id]);
    if (assets.some(asset => !asset || asset.asset_type !== 'display_tag'
      || !accepted.includes(String(asset.delivery_type)))) {
      failures.push('delivery_type_not_supported');
      continue;
    }
    if (params.width !== undefined) {
      if (assets.some(asset => asset!.width === undefined || asset!.height === undefined)) {
        failures.push('rendered_size_unproven');
        continue;
      }
      if (assets.some(asset => asset!.width !== params.width || asset!.height !== params.height)) {
        failures.push('no_size_match');
        continue;
      }
    }
    matches.push({ formatId, slots: required });
  }
  if (matches.length > 1) return { status: 'ambiguous' };
  if (matches.length === 0) {
    const reason = REASON_ORDER.filter(candidate => failures.includes(candidate)).pop();
    return { status: 'unavailable', reason };
  }
  const [{ formatId, slots }] = matches;
  const legacyAssets = Object.fromEntries(slots.map(slot => {
    const asset = vector.creative.assets[slot.asset_group_id]!;
    return [slot.asset_group_id, { asset_type: 'html', content: asset.markup }];
  }));
  return { status: 'selected', format_id: formatId, legacy_assets: legacyAssets };
}

describe('HTML-markup legacy format projection vectors', () => {
  it('annotates every HTML-markup catalog entry with a schema-valid inline-markup projection', () => {
    const validateRef = schema('/schemas/core/canonical-projection-ref.json');
    const htmlEntries = catalog.filter(entry => /^display_(?:\d+x\d+_)?html$/.test(entry.format_id.id));
    expect(htmlEntries.length).toBeGreaterThan(0);
    for (const entry of htmlEntries) {
      expect(validateRef(entry.canonical), JSON.stringify(validateRef.errors)).toBe(true);
      expect(entry.canonical?.kind, entry.format_id.id).toBe('display_tag');
      expect(entry.canonical?.supported_delivery_types, entry.format_id.id).toEqual(['inline_markup']);
      // Rule 5: the slot keeps the v1 asset_id, so the legacy round trip is lossless.
      const requiredV1 = (entry.assets ?? []).filter(asset => asset.required).map(asset => asset.asset_id);
      expect(entry.canonical?.slots_override?.map(slot => slot.asset_group_id), entry.format_id.id).toEqual(requiredV1);
    }
    expect(catalog.filter(entry => entry.canonical?.kind === 'html5')).toEqual([]);
  });

  it('rejects a delivery-type hint on a non-display_tag projection', () => {
    const validateRef = schema('/schemas/core/canonical-projection-ref.json');
    expect(validateRef({ kind: 'html5', supported_delivery_types: ['inline_markup'] })).toBe(false);
    expect(validateRef({ kind: 'display_tag', supported_delivery_types: [] })).toBe(false);
    expect(validateRef({ kind: 'display_tag', supported_delivery_types: ['inline_html'] })).toBe(false);
  });

  for (const vector of fixture.product_projection_vectors) {
    it(`product projection: ${vector.id}`, () => {
      expect(project(vector.format_id)).toEqual(vector.expected_v2);
      const validate = schema(`/schemas/formats/canonical/${vector.expected_v2.format_kind}.json`);
      expect(validate(vector.expected_v2.params), JSON.stringify(validate.errors)).toBe(true);
    });
  }

  for (const vector of fixture.legacy_selection_vectors) {
    it(`legacy selection: ${vector.id}`, () => {
      const validateAsset = schema('/schemas/core/assets/asset-union.json');
      for (const asset of Object.values(vector.creative.assets)) {
        expect(validateAsset(asset), JSON.stringify(validateAsset.errors)).toBe(true);
      }
      expect(select(vector)).toEqual(vector.expected);
      expect(select({ ...vector, product_legacy_formats: [...vector.product_legacy_formats].reverse() }))
        .toEqual(vector.expected);
      if (vector.expected.status === 'selected') {
        const validateHtml = schema('/schemas/core/assets/html-asset.json');
        for (const asset of Object.values(vector.expected.legacy_assets)) {
          expect(validateHtml(asset), JSON.stringify(validateHtml.errors)).toBe(true);
        }
      }
    });
  }
});
