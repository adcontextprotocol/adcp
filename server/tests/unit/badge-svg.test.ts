import { describe, it, expect } from 'vitest';
import { renderBadgeSvg } from '../../src/services/badge-svg.js';

describe('renderBadgeSvg', () => {
  it('renders a verified media-buy badge', () => {
    const svg = renderBadgeSvg('media-buy', true);

    expect(svg).toContain('AAO Verified');
    expect(svg).toContain('Media Buy Agent');
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('#076D63'); // AAO teal (WCAG AA compliant)
    expect(svg).not.toContain('Not Verified');
  });

  it('renders a not-verified badge', () => {
    const svg = renderBadgeSvg('media-buy', false);

    expect(svg).toContain('AAO Verified');
    expect(svg).toContain('Not Verified');
    expect(svg).toContain('#6b7280'); // grey (WCAG AA compliant)
    expect(svg).not.toContain('Media Buy Agent');
  });

  it('renders all known role labels', () => {
    for (const role of ['media-buy', 'creative', 'signals', 'governance', 'brand', 'sponsored-intelligence']) {
      const svg = renderBadgeSvg(role, true);
      expect(svg).toContain('AAO Verified');
      expect(svg).toContain('Agent');
    }
  });

  it('falls back to raw role string for unknown roles', () => {
    const svg = renderBadgeSvg('custom_role', true);
    expect(svg).toContain('custom_role');
    expect(svg).toContain('AAO Verified');
  });

  it('generates valid SVG with proper dimensions', () => {
    const svg = renderBadgeSvg('media-buy', true);

    expect(svg).toMatch(/width="\d+"/);
    expect(svg).toMatch(/height="20"/);
  });

  it('includes accessibility attributes', () => {
    const svg = renderBadgeSvg('media-buy', true);
    expect(svg).toContain('role="img"');
    expect(svg).toContain('aria-label="AAO Verified: Media Buy Agent"');
    expect(svg).toContain('<title>AAO Verified: Media Buy Agent</title>');
  });
});
