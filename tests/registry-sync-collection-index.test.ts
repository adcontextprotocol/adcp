import { describe, expect, it } from 'vitest';
import { CatalogCollectionIndex } from '../server/src/registry-sync/collection-index.js';

describe('CatalogCollectionIndex', () => {
  it('indexes collections by publisher collection ID and case-sensitive distribution identifiers', () => {
    const index = new CatalogCollectionIndex();

    index.upsert({
      collection_rid: '019539a0-b1c2-7000-8000-000000000011',
      publisher_domain: 'stuk.tv',
      collection_id: 'stuktv',
      name: 'StukTV',
      kind: 'series',
      identifiers: [
        {
          publisher_domain: 'youtube.com',
          type: 'youtube_channel_id',
          value: 'UCK5Fn7Z6-iFMdxEye2FsKXg',
        },
        {
          publisher_domain: 'youtube.com',
          type: 'youtube_channel_handle',
          value: '@stuktv',
        },
        {
          publisher_domain: 'youtube.com',
          type: 'youtube_channel_url',
          value: 'https://www.youtube.com/@stuktv',
        },
      ],
    });

    expect(index.getByCollectionId('stuk.tv', 'stuktv')?.name).toBe('StukTV');
    expect(index.getByCollectionId('STUK.TV', 'stuktv')?.name).toBe('StukTV');
    expect(index.getByDistributionIdentifier(
      'youtube.com',
      'youtube_channel_id',
      'UCK5Fn7Z6-iFMdxEye2FsKXg',
    )?.publisher_domain).toBe('stuk.tv');
    expect(index.getByDistributionIdentifier(
      'youtube.com',
      'youtube_channel_handle',
      '@stuktv',
    )?.collection_id).toBe('stuktv');
    expect(index.getByDistributionIdentifier(
      'https://youtube.com',
      'youtube_channel_handle',
      'StukTV',
    )?.collection_id).toBe('stuktv');
    expect(index.getByDistributionIdentifier(
      'youtube.com',
      'youtube_channel_url',
      'https://www.youtube.com/@stuktv',
    )?.collection_id).toBe('stuktv');
    expect(index.getByDistributionIdentifier(
      'youtube.com',
      'youtube_channel_url',
      'https://youtube.com/@StukTV/',
    )?.collection_id).toBe('stuktv');
    expect(index.getByDistributionIdentifier(
      'youtube.com',
      'youtube_channel_url',
      'm.youtube.com/@StukTV/videos',
    )?.collection_id).toBe('stuktv');
    expect(index.getByDistributionIdentifier(
      'youtube.com',
      'youtube_channel_id',
      'uck5fn7z6-ifmdxeye2fsKXg',
    )).toBeUndefined();
  });

  it('redirects distribution identifiers when collections merge', () => {
    const index = new CatalogCollectionIndex();

    index.upsert({
      collection_rid: '019539a0-b1c2-7000-8000-000000000011',
      publisher_domain: 'stuk.tv',
      collection_id: 'stuktv',
      identifiers: [],
    });
    index.upsert({
      collection_rid: '019539a0-b1c2-7000-8000-000000000012',
      publisher_domain: 'talpanetwork.com',
      collection_id: 'stuk-tv',
      identifiers: [
        {
          publisher_domain: 'youtube.com',
          type: 'youtube_channel_id',
          value: 'UCK5Fn7Z6-iFMdxEye2FsKXg',
        },
      ],
    });

    index.handleMerge(
      '019539a0-b1c2-7000-8000-000000000012',
      '019539a0-b1c2-7000-8000-000000000011',
    );

    const canonical = index.getByDistributionIdentifier(
      'youtube.com',
      'youtube_channel_id',
      'UCK5Fn7Z6-iFMdxEye2FsKXg',
    );
    expect(canonical?.collection_rid).toBe('019539a0-b1c2-7000-8000-000000000011');
    expect(index.getByRid('019539a0-b1c2-7000-8000-000000000012')).toBeUndefined();
  });

  it('removes alias distribution identifiers when merge canonical is absent', () => {
    const index = new CatalogCollectionIndex();

    index.upsert({
      collection_rid: '019539a0-b1c2-7000-8000-000000000012',
      publisher_domain: 'talpanetwork.com',
      collection_id: 'stuk-tv',
      identifiers: [
        {
          publisher_domain: 'youtube.com',
          type: 'youtube_channel_handle',
          value: '@stuktv',
        },
      ],
    });

    index.handleMerge(
      '019539a0-b1c2-7000-8000-000000000012',
      '019539a0-b1c2-7000-8000-000000000011',
    );

    expect(index.getByRid('019539a0-b1c2-7000-8000-000000000012')).toBeUndefined();
    expect(index.getByDistributionIdentifier(
      'youtube.com',
      'youtube_channel_handle',
      '@stuktv',
    )).toBeUndefined();
  });
});
