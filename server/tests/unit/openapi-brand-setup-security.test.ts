import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const specPath = new URL('../../../static/openapi/registry.yaml', import.meta.url);

describe('Brand setup OpenAPI security contract', () => {
  it('documents the enforced logo URL and brand color constraints', () => {
    const spec = YAML.parse(readFileSync(specPath, 'utf8'));
    const requestProperties = spec.paths['/api/brands/setup-my-brand'].post.requestBody
      .content['application/json'].schema.properties;

    expect(requestProperties.logo_url).toMatchObject({
      type: 'string',
      format: 'uri',
      maxLength: 2048,
      description: expect.stringContaining('Absolute HTTPS URL'),
    });
    expect(requestProperties.logo_url.description).toContain('credentials');
    expect(requestProperties.logo_url.description).toContain('backslashes');
    expect(requestProperties.brand_color).toMatchObject({
      type: 'string',
      pattern: '^#[0-9a-fA-F]{6}$',
    });
    expect(requestProperties.brand_json.description).toContain('Every recognized logo URL');
    expect(requestProperties.brand_json.description).toContain('absolute HTTPS URL');
    expect(requestProperties.brand_json.description).toContain('at most 2048 characters');
    expect(requestProperties.brand_json.description).toContain('backslashes');
    expect(requestProperties.brand_json.description).toContain('#RRGGBB');
  });
});
