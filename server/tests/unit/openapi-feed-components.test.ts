import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const specPath = new URL('../../../static/openapi/registry.yaml', import.meta.url);

function loadSpec(): any {
  return YAML.parse(readFileSync(specPath, 'utf8'));
}

describe('OpenAPI feed components', () => {
  it('keeps registry feed events typed by event family', () => {
    const spec = loadSpec();
    const components = spec.components.schemas;

    expect(components.RegistryFeedEvent.oneOf).toBeInstanceOf(Array);
    expect(components.RegistryFeedEvent.oneOf.length).toBeGreaterThan(0);
    expect(components.AgentEventPayload).toBeDefined();
    expect(components.PropertyEventPayload).toBeDefined();
    expect(components.CollectionEventPayload).toBeDefined();
    expect(components.AuthorizationEventPayload).toBeDefined();
    expect(components.PublisherEventPayload).toBeDefined();

    const refs = new Set(
      components.RegistryFeedEvent.oneOf
        .map((arm: any) => arm.properties?.payload?.$ref)
        .filter(Boolean),
    );
    expect(refs).toContain('#/components/schemas/AgentEventPayload');
    expect(refs).toContain('#/components/schemas/AuthorizationEventPayload');

    const feedEventItems = spec.paths['/api/registry/feed'].get.responses['200']
      .content['application/json'].schema.properties.events.items;
    expect(feedEventItems).toEqual({ $ref: '#/components/schemas/RegistryFeedEvent' });
  });
});
