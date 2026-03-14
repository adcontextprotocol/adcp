import { extractMarkdownImages } from '../../server/src/addie/security.js';

describe('extractMarkdownImages', () => {
  const ALLOWED_BASE = 'https://docs.adcontextprotocol.org/images/walkthrough';

  it('returns unchanged text and empty array when no images', () => {
    const result = extractMarkdownImages('Hello world, no images here.');
    expect(result.text).toBe('Hello world, no images here.');
    expect(result.images).toEqual([]);
  });

  it('extracts a single image from allowed host', () => {
    const text = `Here is an illustration:\n\n![Format anatomy](${ALLOWED_BASE}/diagram-format-manifest-render.png)\n\nAs shown above...`;
    const result = extractMarkdownImages(text);
    expect(result.images).toEqual([
      { alt: 'Format anatomy', url: `${ALLOWED_BASE}/diagram-format-manifest-render.png` },
    ]);
    expect(result.text).toBe('Here is an illustration:\n\nAs shown above...');
  });

  it('extracts multiple images in order', () => {
    const text = `Step 1:\n\n![Discovery](${ALLOWED_BASE}/diagram-01.png)\n\nStep 2:\n\n![Route](${ALLOWED_BASE}/diagram-02.png)\n\nDone.`;
    const result = extractMarkdownImages(text);
    expect(result.images).toHaveLength(2);
    expect(result.images[0].alt).toBe('Discovery');
    expect(result.images[1].alt).toBe('Route');
    expect(result.text).toContain('Step 1:');
    expect(result.text).toContain('Step 2:');
    expect(result.text).toContain('Done.');
  });

  it('leaves non-allowed host images as-is', () => {
    const text = '![Evil](https://evil.com/image.png)';
    const result = extractMarkdownImages(text);
    expect(result.images).toEqual([]);
    expect(result.text).toBe('![Evil](https://evil.com/image.png)');
  });

  it('extracts allowed and leaves non-allowed in mixed content', () => {
    const text = `![Good](${ALLOWED_BASE}/good.png) and ![Bad](https://other.com/bad.png)`;
    const result = extractMarkdownImages(text);
    expect(result.images).toEqual([
      { alt: 'Good', url: `${ALLOWED_BASE}/good.png` },
    ]);
    expect(result.text).toContain('![Bad](https://other.com/bad.png)');
  });

  it('collapses triple blank lines from image removal', () => {
    const text = `Before\n\n\n![Img](${ALLOWED_BASE}/test.png)\n\n\nAfter`;
    const result = extractMarkdownImages(text);
    expect(result.text).toBe('Before\n\nAfter');
  });

  it('defaults empty alt text to "Image"', () => {
    const text = `![](${ALLOWED_BASE}/no-alt.png)`;
    const result = extractMarkdownImages(text);
    expect(result.images).toEqual([
      { alt: 'Image', url: `${ALLOWED_BASE}/no-alt.png` },
    ]);
  });
});
