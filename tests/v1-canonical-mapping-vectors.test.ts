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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const registry = JSON.parse(fs.readFileSync(
  path.join(root, 'static/schemas/source/registries/v1-canonical-mapping.json'),
  'utf8',
)) as { version: string; mappings: RegistryMapping[] };
const fixture = JSON.parse(fs.readFileSync(
  path.join(root, 'static/test-vectors/v1-canonical-mapping.json'),
  'utf8',
)) as { registry_version: string; vectors: Vector[] };

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
});
