import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

type V2Mapping = {
  canonical: string;
  parameters?: Record<string, unknown>;
};

type RegistryMapping = {
  v1_pattern: {
    format_id_glob?: string;
    structural?: Record<string, unknown>;
  };
  v2: V2Mapping;
};

type Vector = {
  id: string;
  format_id: string;
  expected_v2: V2Mapping | null;
  expected_outcome?: string;
};

type V1Constraint =
  | { kind: 'exact'; value: unknown }
  | { kind: 'range'; min: number | null; max: number | null }
  | { kind: 'set'; values: unknown[] };

type NarrowingVector = {
  id: string;
  v1_baseline: Record<string, V1Constraint>;
  v2_params: Record<string, unknown>;
  expected: { narrows: true } | { narrows: false; conflict: string };
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const registry = JSON.parse(fs.readFileSync(
  path.join(root, 'static/schemas/source/registries/v1-canonical-mapping.json'),
  'utf8',
)) as { version: string; description: string; mappings: RegistryMapping[] };
const fixture = JSON.parse(fs.readFileSync(
  path.join(root, 'static/test-vectors/v1-canonical-mapping.json'),
  'utf8',
)) as { registry_version: string; vectors: Vector[]; narrowing_vectors: NarrowingVector[] };

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Reference implementation of the normative one-way v2-narrows-v1 relation. */
function narrowsV1Baseline(
  v1Baseline: Record<string, V1Constraint>,
  v2Params: Record<string, unknown>,
): { narrows: true } | { narrows: false; conflict: string } {
  for (const [parameter, v2Value] of Object.entries(v2Params)) {
    const constraint = v1Baseline[parameter];
    if (!constraint) continue;

    let narrows = false;
    if (constraint.kind === 'exact') {
      narrows = sameValue(v2Value, constraint.value);
    } else if (constraint.kind === 'set') {
      const values = Array.isArray(v2Value) ? v2Value : [v2Value];
      narrows = values.every(value => constraint.values.some(allowed => sameValue(value, allowed)));
    } else if (typeof v2Value === 'number') {
      narrows = (constraint.min === null || v2Value >= constraint.min) &&
        (constraint.max === null || v2Value <= constraint.max);
    } else if (Array.isArray(v2Value) && v2Value.length === 2) {
      const [lower, upper] = v2Value as [number | null, number | null];
      narrows = (constraint.min === null || (lower !== null && lower >= constraint.min)) &&
        (constraint.max === null || (upper !== null && upper <= constraint.max));
    }

    if (!narrows) return { narrows: false, conflict: parameter };
  }

  return { narrows: true };
}

const literalMappings = registry.mappings.filter(
  (mapping): mapping is RegistryMapping & { v1_pattern: { format_id_glob: string } } =>
    typeof mapping.v1_pattern.format_id_glob === 'string',
);
const literalById = new Map(
  literalMappings.map(mapping => [mapping.v1_pattern.format_id_glob, mapping.v2]),
);

describe('v1 canonical literal mapping vectors', () => {
  it('pins the registry version and keeps literal ids unique and non-wildcarded', () => {
    expect(fixture.registry_version).toBe(registry.version);
    expect(literalById.size).toBe(literalMappings.length);
    expect([...literalById.keys()].every(id => !id.includes('*'))).toBe(true);
  });

  it('matches every positive vector exactly and covers every literal mapping', () => {
    const positiveVectors = fixture.vectors.filter(
      (vector): vector is Vector & { expected_v2: V2Mapping } => vector.expected_v2 !== null,
    );

    for (const vector of positiveVectors) {
      expect(literalById.get(vector.format_id), vector.id).toEqual(vector.expected_v2);
    }

    expect(new Set(positiveVectors.map(vector => vector.format_id))).toEqual(
      new Set(literalById.keys()),
    );
  });

  it('keeps durationless placement ids deliberately unmatched', () => {
    for (const formatId of ['video_pre_roll', 'video_mid_roll']) {
      const vector = fixture.vectors.find(candidate => candidate.format_id === formatId);
      expect(vector?.expected_v2).toBeNull();
      expect(vector?.expected_outcome).toBe('no_literal_match');
      expect(literalById.has(formatId)).toBe(false);
    }
  });

  it('classifies the observed VAST suffix as video_vast', () => {
    expect(literalById.get('video_640x360_vast')?.canonical).toBe('video_vast');
  });

  it('keeps display_static intentionally free of size constraints', () => {
    const mapping = literalById.get('display_static');
    expect(mapping).toEqual({ canonical: 'image' });
    expect(mapping).not.toHaveProperty('parameters.width');
    expect(mapping).not.toHaveProperty('parameters.height');
  });

  it('projects 3.1 reference-catalog 2x-only ids to canonical 2x acceptance', () => {
    const retinaMappings = literalMappings.filter(mapping =>
      mapping.v1_pattern.format_id_glob.endsWith('_image_2x'),
    );
    expect(retinaMappings).toHaveLength(7);
    for (const mapping of retinaMappings) {
      expect(mapping.v2.canonical, mapping.v1_pattern.format_id_glob).toBe('image');
      expect(mapping.v2.parameters, mapping.v1_pattern.format_id_glob).toMatchObject({
        pixel_ratios: [2],
      });
      expect(mapping.v2.parameters, mapping.v1_pattern.format_id_glob).not.toHaveProperty('slots');
    }
  });

  it('projects paired 1x/2x legacy ids to required canonical rendition sets', () => {
    const pairedMappings = literalMappings.filter(mapping =>
      mapping.v1_pattern.format_id_glob.endsWith('_image_1x_2x'),
    );
    expect(pairedMappings).toHaveLength(7);
    for (const mapping of pairedMappings) {
      expect(mapping.v2.canonical, mapping.v1_pattern.format_id_glob).toBe('image');
      expect(mapping.v2.parameters, mapping.v1_pattern.format_id_glob).toMatchObject({
        pixel_ratios: [1, 2],
        slots: [{
          asset_group_id: 'image_main',
          asset_type: 'image',
          required: true,
          min: 2,
          max: 2,
          pixel_ratios: [1, 2],
          required_pixel_ratios: [1, 2],
        }],
      });
    }
  });

  it('projects mapped rendition sets before generic asset-group collision handling', () => {
    expect(registry.description).toContain('Image rendition-set exception (normative)');
    expect(registry.description).toContain('MUST NOT');
    expect(registry.description).toContain('generic alias-collision rule');
  });

  it('applies the documented one-way v2-narrows-v1 relation', () => {
    expect(fixture.narrowing_vectors.length).toBeGreaterThanOrEqual(2);
    expect(fixture.narrowing_vectors.some(vector => vector.expected.narrows)).toBe(true);
    expect(fixture.narrowing_vectors.some(vector => !vector.expected.narrows)).toBe(true);

    for (const vector of fixture.narrowing_vectors) {
      expect(narrowsV1Baseline(vector.v1_baseline, vector.v2_params), vector.id)
        .toEqual(vector.expected);
    }
  });

  it('treats small NxN tokens as aspect ratios rather than pixel dimensions', () => {
    for (const mapping of literalMappings) {
      const match = mapping.v1_pattern.format_id_glob.match(/(?:^|_)(\d+)x(\d+)(?:_|$)/);
      if (!match) continue;

      const [, widthToken, heightToken] = match;
      const width = Number(widthToken);
      const height = Number(heightToken);
      if (width >= 50 || height >= 50) continue;

      expect(mapping.v2.parameters, mapping.v1_pattern.format_id_glob).toMatchObject({
        aspect_ratio: `${widthToken}:${heightToken}`,
      });
      expect(mapping.v2.parameters, mapping.v1_pattern.format_id_glob).not.toHaveProperty('width');
      expect(mapping.v2.parameters, mapping.v1_pattern.format_id_glob).not.toHaveProperty('height');
    }
  });

  it('treats pixel-sized NxN tokens as exact dimensions', () => {
    for (const mapping of literalMappings) {
      const match = mapping.v1_pattern.format_id_glob.match(/(?:^|_)(\d+)x(\d+)(?:_|$)/);
      if (!match) continue;

      const [, widthToken, heightToken] = match;
      const width = Number(widthToken);
      const height = Number(heightToken);
      if (width < 50 && height < 50) continue;

      expect(width >= 50 && height >= 50, mapping.v1_pattern.format_id_glob).toBe(true);
      expect(mapping.v2.parameters, mapping.v1_pattern.format_id_glob).toMatchObject({
        width,
        height,
      });
      expect(mapping.v2.parameters, mapping.v1_pattern.format_id_glob).not.toHaveProperty('aspect_ratio');
    }
  });
});
