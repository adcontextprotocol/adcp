import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  handleGetAdcpCapabilities,
  handleSyncCreatives,
} from '../../src/training-agent/task-handlers.js';
import { clearSessions, runWithSessionContext } from '../../src/training-agent/state.js';
import {
  TRAINING_SELLER_VAST_VERSIONS,
  validateCreativeVastDocuments,
  validateInlineVastDocument,
} from '../../src/training-agent/vast-document-validation.js';
import type { TrainingContext } from '../../src/training-agent/types.js';

const CTX: TrainingContext = { mode: 'open', authenticatedAgentUrl: 'https://buyer.example' };

function vastXml(opts: { version?: string; ad?: boolean; media?: boolean } = {}): string {
  const version = opts.version ?? '4.2';
  const includeAd = opts.ad !== false;
  const includeMedia = opts.media !== false;
  const media = includeMedia
    ? '<MediaFiles><MediaFile delivery="progressive" type="video/mp4" width="1920" height="1080"><![CDATA[https://cdn.acme.example/video.mp4]]></MediaFile></MediaFiles>'
    : '';
  const ad = includeAd
    ? `<Ad id="1"><InLine><AdSystem>Acme</AdSystem><AdTitle>Trail</AdTitle><Impression><![CDATA[https://track.acme.example/i]]></Impression><Creatives><Creative><Linear><Duration>00:00:15</Duration>${media}</Linear></Creative></Creatives></InLine></Ad>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?><VAST version="${version}">${ad}</VAST>`;
}

function inlineVast(xml: string, version = '4.2') {
  return {
    vast_tag: {
      asset_type: 'vast' as const,
      delivery_type: 'inline' as const,
      vast_version: version,
      content: xml,
    },
  };
}

describe('validateInlineVastDocument', () => {
  const seller = TRAINING_SELLER_VAST_VERSIONS;

  it('accepts a well-formed inline linear VAST document', () => {
    expect(validateInlineVastDocument({
      xml: vastXml(),
      field: 'assets.vast_tag',
      assetVastVersion: '4.2',
      sellerVastVersions: seller,
    })).toBeNull();
  });

  it('rejects non-XML content', () => {
    expect(validateInlineVastDocument({
      xml: 'not xml',
      field: 'assets.vast_tag',
      assetVastVersion: '4.2',
      sellerVastVersions: seller,
    })).toMatchObject({ code: 'VAST_PARSE_FAILED', details: { reason: 'not_xml' } });
  });

  it.each([
    '<VAST version="4.2"><Ad>',
    '<VAST version="4.2"><Ad></VAST>',
    '<VAST version="4.2"><Ad></Ad></VAST>trailing text',
    '<VAST version="4.2"><Ad>&unknown;</Ad></VAST>',
  ])('rejects malformed XML that a lenient DOM parser repairs: %s', xml => {
    expect(validateInlineVastDocument({
      xml,
      field: 'assets.vast_tag',
      assetVastVersion: '4.2',
      sellerVastVersions: seller,
    })).toMatchObject({ code: 'VAST_PARSE_FAILED', details: { reason: 'not_xml' } });
  });

  it('rejects a non-VAST root', () => {
    expect(validateInlineVastDocument({
      xml: '<VMAP version="1.0"></VMAP>',
      field: 'assets.vast_tag',
      assetVastVersion: '4.2',
      sellerVastVersions: seller,
    })).toMatchObject({ code: 'VAST_PARSE_FAILED', details: { reason: 'no_vast_root' } });
  });

  it('rejects a submitted document whose version differs from the asset', () => {
    expect(validateInlineVastDocument({
      xml: vastXml({ version: '3.0' }),
      field: 'assets.vast_tag',
      assetVastVersion: '4.2',
      sellerVastVersions: seller,
    })).toMatchObject({
      code: 'VAST_VERSION_MISMATCH',
      details: {
        mismatch_reason: 'document_version_mismatch',
        asset_vast_version: '4.2',
        observed_document_vast_version: '3.0',
        document_role: 'submitted',
      },
    });
  });

  it('rejects an asset outside the product and seller intersection', () => {
    expect(validateInlineVastDocument({
      xml: vastXml({ version: '4.2' }),
      field: 'assets.vast_tag',
      assetVastVersion: '4.2',
      productVastVersions: ['3.0', '4.0'],
      sellerVastVersions: seller,
    })).toMatchObject({
      code: 'VAST_VERSION_MISMATCH',
      details: {
        mismatch_reason: 'asset_outside_acceptance',
        asset_vast_version: '4.2',
        product_vast_versions: ['3.0', '4.0'],
        seller_vast_versions: [...seller],
      },
    });
  });

  it('rejects a document with no Ad', () => {
    expect(validateInlineVastDocument({
      xml: vastXml({ ad: false }),
      field: 'assets.vast_tag',
      assetVastVersion: '4.2',
      sellerVastVersions: seller,
    })).toMatchObject({ code: 'VAST_PARSE_FAILED', details: { reason: 'no_ad' } });
  });

  it('rejects an inline linear creative with no MediaFile', () => {
    expect(validateInlineVastDocument({
      xml: vastXml({ media: false }),
      field: 'assets.vast_tag',
      assetVastVersion: '4.2',
      sellerVastVersions: seller,
    })).toMatchObject({ code: 'VAST_PARSE_FAILED', details: { reason: 'no_media_file' } });
  });

  it('skips URL-delivered assets', () => {
    expect(validateCreativeVastDocuments({
      assets: {
        vast_tag: {
          asset_type: 'vast',
          delivery_type: 'url',
          url: 'https://cdn.acme.example/tag.xml',
          vast_version: '4.2',
        },
      },
      fieldPrefix: 'creatives[cr_1]',
    })).toBeNull();
  });
});

describe('training agent document-level VAST validation', () => {
  beforeEach(() => clearSessions());
  afterEach(() => clearSessions());

  it('advertises document validation and the seller VAST ceiling', async () => {
    const result = await handleGetAdcpCapabilities({}, CTX);
    const mediaBuy = result.media_buy as Record<string, any>;
    expect(mediaBuy.execution.creative_specs).toEqual({
      vast_validation: 'document',
      vast_versions: [...TRAINING_SELLER_VAST_VERSIONS],
    });
  });

  it('creates a structurally valid inline VAST creative', async () => {
    await runWithSessionContext(async () => {
      const result = await handleSyncCreatives({
        idempotency_key: 'vast-valid-0001',
        creatives: [{
          creative_id: 'cr_vast_ok',
          format_kind: 'video_vast',
          name: 'Trail 15s',
          assets: inlineVast(vastXml()),
        }],
      }, CTX) as Record<string, any>;
      expect(result.creatives).toEqual([
        expect.objectContaining({ creative_id: 'cr_vast_ok', action: 'created' }),
      ]);
    });
  });

  it('returns VAST_PARSE_FAILED for a document-invalid inline tag', async () => {
    await runWithSessionContext(async () => {
      const result = await handleSyncCreatives({
        idempotency_key: 'vast-parse-0001',
        creatives: [{
          creative_id: 'cr_vast_bad',
          format_kind: 'video_vast',
          name: 'Broken tag',
          assets: inlineVast('not xml'),
        }],
      }, CTX) as Record<string, any>;
      expect(result.creatives[0]).toMatchObject({
        creative_id: 'cr_vast_bad',
        action: 'failed',
      });
      expect(result.creatives[0].errors[0]).toMatchObject({
        code: 'VAST_PARSE_FAILED',
        details: { reason: 'not_xml' },
        field: 'creatives[cr_vast_bad].assets.vast_tag',
        recovery: 'correctable',
      });
    });
  });

  it('returns VAST_VERSION_MISMATCH when the document disagrees with the asset', async () => {
    await runWithSessionContext(async () => {
      const result = await handleSyncCreatives({
        idempotency_key: 'vast-mismatch-0001',
        creatives: [{
          creative_id: 'cr_vast_mismatch',
          format_kind: 'video_vast',
          name: 'Mismatched version',
          assets: inlineVast(vastXml({ version: '3.0' }), '4.2'),
        }],
      }, CTX) as Record<string, any>;
      expect(result.creatives[0].errors[0]).toMatchObject({
        code: 'VAST_VERSION_MISMATCH',
        details: {
          mismatch_reason: 'document_version_mismatch',
          asset_vast_version: '4.2',
          observed_document_vast_version: '3.0',
          document_role: 'submitted',
        },
      });
    });
  });

  it('still accepts video_vast creatives with no VAST document to inspect', async () => {
    await runWithSessionContext(async () => {
      const result = await handleSyncCreatives({
        idempotency_key: 'vast-empty-0001',
        creatives: [{
          creative_id: 'cr_vast_empty',
          format_kind: 'video_vast',
          name: 'Empty assets',
          assets: {},
        }],
      }, CTX) as Record<string, any>;
      expect(result.creatives).toEqual([
        expect.objectContaining({ creative_id: 'cr_vast_empty', action: 'created' }),
      ]);
    });
  });
});
