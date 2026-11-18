import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ generateIllustration: vi.fn() }));

vi.mock('../../src/services/illustration-generator.js', () => ({
  generateIllustration: mocks.generateIllustration,
}));
vi.mock('../../src/utils/llm.js', () => ({ isLLMConfigured: () => false, complete: vi.fn() }));

import {
  buildCoverImageUrl,
  coverCacheControl,
  coverVersion,
  generateCoverForEdition,
} from '../../src/newsletters/cover.js';
import type { NewsletterConfig } from '../../src/newsletters/config.js';

const config = {
  id: 'the_prompt',
  perspectiveCategory: 'The Prompt',
  coverRoutePrefix: '/digest',
  db: { setCoverImage: vi.fn(async () => true) },
} as unknown as NewsletterConfig;

describe('cover image URL versioning', () => {
  it('a regenerated cover gets a new URL', async () => {
    mocks.generateIllustration
      .mockResolvedValueOnce({ imageBuffer: Buffer.from('first image'), promptUsed: 'p1' })
      .mockResolvedValueOnce({ imageBuffer: Buffer.from('second image'), promptUsed: 'p2' });

    const first = await generateCoverForEdition(config, 1, 'Subject', 'Excerpt', '2026-11-17');
    const second = await generateCoverForEdition(config, 1, 'Subject', 'Excerpt', '2026-11-17');

    expect(first?.coverImageUrl).toMatch(/\/digest\/2026-11-17\/cover\.png\?v=[0-9a-f]{16}$/);
    expect(second?.coverImageUrl).not.toBe(first?.coverImageUrl);
  });

  it('the same image always gets the same URL', () => {
    const image = Buffer.from('stable');
    expect(buildCoverImageUrl(config, '2026-11-17', image)).toBe(buildCoverImageUrl(config, '2026-11-17', image));
    expect(buildCoverImageUrl({ id: 'the_build' }, '2026-11-17', image)).toContain('/build/2026-11-17/cover.png?v=');
  });

  it('caches a matching versioned URL as immutable and anything else briefly', () => {
    const image = Buffer.from('current');
    expect(coverCacheControl(image, coverVersion(image))).toBe('public, max-age=31536000, immutable');
    expect(coverCacheControl(image, undefined)).toBe('public, max-age=300');
    expect(coverCacheControl(image, 'stale-version')).toBe('public, max-age=300');
    expect(coverCacheControl(image, ['array'])).toBe('public, max-age=300');
  });
});
