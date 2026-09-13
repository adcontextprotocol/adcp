import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

describe('compliance publication OpenAPI contract', () => {
  it('exposes publication and provenance on refresh and targeted run responses', () => {
    const spec = YAML.parse(readFileSync(new URL('../../../static/openapi/registry.yaml', import.meta.url), 'utf8'));
    const response = (path: string) => spec.paths[path].post.responses['200'].content['application/json'].schema.properties;
    const refresh = response('/api/registry/agents/{encodedUrl}/refresh').compliance.properties;
    const targeted = response('/api/registry/agents/{encodedUrl}/storyboard/{storyboardId}/run');
    for (const properties of [refresh, targeted]) {
      expect(properties.completeness.enum).toContain('timed_out');
      expect(properties.is_authoritative.type).toBe('boolean');
      expect(properties.provenance).toBeDefined();
    }
    expect(refresh.ran.description).toContain('recorded');
    expect(refresh.ran.description).not.toContain('agent_storyboard_status was updated');
  });
});
