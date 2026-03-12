import { describe, it, expect } from 'vitest';
import { isHighQualityResult } from '../../src/services/brandfetch.js';
import type { BrandfetchResponse } from '../../src/services/brandfetch.js';

function makeBrandfetchResponse(overrides: Partial<BrandfetchResponse> = {}): BrandfetchResponse {
  return {
    id: 'test-id',
    name: 'Acme Corp',
    domain: 'acme.com',
    claimed: true,
    verified: true,
    ...overrides,
  };
}

describe('isHighQualityResult', () => {
  it('returns true when logos and description are present', () => {
    const data = makeBrandfetchResponse({
      description: 'Acme Corp makes great products for everyone.',
      logos: [{
        type: 'logo',
        theme: null,
        formats: [{ src: 'https://cdn.example.com/logo.svg', format: 'svg' }],
      }],
      qualityScore: 0.8,
    });
    expect(isHighQualityResult(data)).toBe(true);
  });

  it('returns true with logos but no description', () => {
    const data = makeBrandfetchResponse({
      logos: [{
        type: 'logo',
        theme: null,
        formats: [{ src: 'https://cdn.example.com/logo.png', format: 'png' }],
      }],
    });
    expect(isHighQualityResult(data)).toBe(true);
  });

  it('returns true with description but no logos', () => {
    const data = makeBrandfetchResponse({
      description: 'A well-known brand with a long description.',
      logos: [],
    });
    expect(isHighQualityResult(data)).toBe(true);
  });

  it('returns false when no logos and no description', () => {
    const data = makeBrandfetchResponse({
      description: undefined,
      logos: [],
    });
    expect(isHighQualityResult(data)).toBe(false);
  });

  it('returns false when description is too short', () => {
    const data = makeBrandfetchResponse({
      description: 'Short',
      logos: [],
    });
    expect(isHighQualityResult(data)).toBe(false);
  });

  it('returns false when quality score is below threshold', () => {
    const data = makeBrandfetchResponse({
      description: 'A decent description that is long enough.',
      logos: [{
        type: 'logo',
        theme: null,
        formats: [{ src: 'https://cdn.example.com/logo.svg', format: 'svg' }],
      }],
      qualityScore: 0.1,
    });
    expect(isHighQualityResult(data)).toBe(false);
  });

  it('returns true when quality score is undefined (not provided)', () => {
    const data = makeBrandfetchResponse({
      description: 'A decent description that is long enough.',
      qualityScore: undefined,
    });
    expect(isHighQualityResult(data)).toBe(true);
  });

  it('returns false when logos have no formats', () => {
    const data = makeBrandfetchResponse({
      description: undefined,
      logos: [{
        type: 'logo',
        theme: null,
        formats: [],
      }],
    });
    expect(isHighQualityResult(data)).toBe(false);
  });

  it('returns false when brand is flagged as NSFW', () => {
    const data = makeBrandfetchResponse({
      description: 'A legitimate-looking brand with plenty of data.',
      logos: [{
        type: 'logo',
        theme: null,
        formats: [{ src: 'https://cdn.example.com/logo.svg', format: 'svg' }],
      }],
      qualityScore: 0.9,
      isNsfw: true,
    });
    expect(isHighQualityResult(data)).toBe(false);
  });

  it('allows non-NSFW brands through normally', () => {
    const data = makeBrandfetchResponse({
      description: 'A legitimate brand.',
      logos: [{
        type: 'logo',
        theme: null,
        formats: [{ src: 'https://cdn.example.com/logo.svg', format: 'svg' }],
      }],
      isNsfw: false,
    });
    expect(isHighQualityResult(data)).toBe(true);
  });
});
