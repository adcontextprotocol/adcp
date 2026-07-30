import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  complete: vi.fn(),
  updateFetchedResource: vi.fn(),
}));

vi.mock('../../src/utils/llm.js', () => ({
  isLLMConfigured: () => true,
  complete: (...args: unknown[]) => mocks.complete(...args),
}));

vi.mock('../../src/db/addie-db.js', () => ({
  AddieDatabase: class {
    updateFetchedResource = (...args: unknown[]) => mocks.updateFetchedResource(...args);
  },
}));

import {
  normalizeCuratorAnalysis,
  parseCuratorAnalysisResponse,
  processResource,
} from '../../src/addie/services/content-curator.js';

describe('content curator output validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('normalizes valid model output before persistence', () => {
    expect(normalizeCuratorAnalysis({
      summary: '  A useful summary.  ',
      key_insights: [{ insight: ' Ship interoperably. ', importance: 'high' }],
      addie_take: ' 🤖 Open standards win. ',
      relevance_tags: [' ADCP ', 'research', 'adcp'],
      quality_score: 5,
      notification_channels: ['C123', 'C123'],
    }, ['C123'])).toEqual({
      summary: 'A useful summary.',
      key_insights: [{ insight: 'Ship interoperably.', importance: 'high' }],
      addie_notes: '🤖 Open standards win.',
      relevance_tags: ['adcp', 'research'],
      quality_score: 5,
      notification_channels: ['C123'],
    });
  });

  it('drops hostile model-controlled fields while retaining valid analysis', () => {
    const result = normalizeCuratorAnalysis({
      summary: 'A useful summary.',
      key_insights: [
        { insight: '<img src=x onerror=alert(1)>', importance: 'critical' },
        '<script>alert(1)</script>',
        { insight: 'Use interoperable protocols.', importance: 'high' },
      ],
      addie_take: '🤖 Open standards win.',
      relevance_tags: [
        '</div><script>alert(1)</script>',
        'javascript:alert(1)',
        42,
        'ADCP',
      ],
      quality_score: 5,
      notification_channels: ['C_ATTACKER', '<script>', 'C_ALLOWED'],
    }, ['C_ALLOWED']);

    expect(result).toEqual({
      summary: 'A useful summary.',
      key_insights: [{ insight: 'Use interoperable protocols.', importance: 'high' }],
      addie_notes: '🤖 Open standards win.',
      relevance_tags: ['adcp'],
      quality_score: 5,
      notification_channels: ['C_ALLOWED'],
    });
  });

  it('throws for malformed JSON and parsed output with no valid analysis', () => {
    expect(() => parseCuratorAnalysisResponse('{"summary":')).toThrow(
      'Curator model response was not valid JSON'
    );
    expect(() => normalizeCuratorAnalysis({
      summary: 123,
      key_insights: [],
      addie_take: null,
      relevance_tags: ['javascript:alert(1)'],
      quality_score: '5',
    })).toThrow('Curator model response is missing required valid analysis fields');
  });

  it('marks the resource failed when malformed model JSON reaches a caller', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      `<html><body><article><p>${'Substantive article content. '.repeat(10)}</p></article></body></html>`,
      { status: 200, headers: { 'content-type': 'text/html' } }
    )));
    mocks.complete.mockResolvedValue({ text: '{"summary":' });
    mocks.updateFetchedResource.mockResolvedValue(undefined);

    await expect(processResource({
      id: 42,
      fetch_url: 'https://partner.example/article',
      title: 'Partner field notes',
    })).resolves.toBe(false);

    expect(mocks.updateFetchedResource).toHaveBeenCalledOnce();
    expect(mocks.updateFetchedResource).toHaveBeenCalledWith(42, expect.objectContaining({
      content: '',
      fetch_status: 'failed',
      error_message: 'Curator model response was not valid JSON',
    }));
  });

  it('persists a valid normalized analysis as successful', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      `<html><body><article><p>${'Substantive article content. '.repeat(10)}</p></article></body></html>`,
      { status: 200, headers: { 'content-type': 'text/html' } }
    )));
    mocks.complete.mockResolvedValue({
      text: JSON.stringify({
        summary: ' A useful summary. ',
        key_insights: [{ insight: ' Ship interoperably. ', importance: 'high' }],
        addie_take: ' 🤖 Open standards win. ',
        relevance_tags: ['ADCP'],
        quality_score: 5,
      }),
    });
    mocks.updateFetchedResource.mockResolvedValue(undefined);

    await expect(processResource({
      id: 43,
      fetch_url: 'https://partner.example/valid-article',
      title: 'Valid partner field notes',
    })).resolves.toBe(true);

    expect(mocks.updateFetchedResource).toHaveBeenCalledOnce();
    expect(mocks.updateFetchedResource).toHaveBeenCalledWith(43, expect.objectContaining({
      summary: 'A useful summary.',
      key_insights: [{ insight: 'Ship interoperably.', importance: 'high' }],
      addie_notes: '🤖 Open standards win.',
      relevance_tags: ['adcp'],
      quality_score: 5,
      fetch_status: 'success',
    }));
  });
});
