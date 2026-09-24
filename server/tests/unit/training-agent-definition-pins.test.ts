import { describe, expect, it } from 'vitest';
import {
  buildDefinitionPins,
  definitionContentDigest,
} from '../../src/training-agent/definition-pins.js';

describe('training-agent definition pins', () => {
  it('ignores non-binding catalog metadata in the digest', () => {
    const first = definitionContentDigest({
      id: 'collection-1',
      name: 'Original name',
      description: 'Original description',
      content_rating: 'PG',
    });
    const second = definitionContentDigest({
      id: 'collection-1',
      name: 'Renamed collection',
      description: 'Updated description',
      content_rating: 'PG',
    });
    expect(second).toBe(first);
  });

  it('creates publisher format pins from selected publisher references', () => {
    const product = {
      product_id: 'product-1',
      format_options: [{
        scope: 'publisher',
        publisher_domain: 'publisher.example',
        format_option_id: 'format-1',
        format_kind: 'display',
        content_rating: 'PG',
      }],
    };
    const purchases = [{
      product_id: 'product-1',
      format_option_refs: [{
        scope: 'publisher',
        publisher_domain: 'publisher.example',
        format_option_id: 'format-1',
      }],
    }];

    const pins = buildDefinitionPins(purchases, new Map([[product.product_id, product]]));

    expect(pins).toHaveLength(1);
    expect(pins[0]).toMatchObject({
      ref_kind: 'publisher_format_option',
      reference: {
        scope: 'publisher',
        publisher_domain: 'publisher.example',
        format_option_id: 'format-1',
      },
      content_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });
});
