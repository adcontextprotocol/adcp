import { describe, it, expect } from 'vitest';
import { renderBadgeSvg } from '../../src/services/badge-svg.js';

describe('renderBadgeSvg', () => {
  it('renders a verified (Spec) media-buy badge', () => {
    const svg = renderBadgeSvg('media-buy', ['spec']);

    expect(svg).toContain('AAO Verified');
    expect(svg).toContain('Media Buy Agent (Spec)');
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('#076D63'); // AAO teal (WCAG AA compliant)
    expect(svg).not.toContain('Not Verified');
  });

  it('renders a verified (Spec + Live) badge with both qualifiers', () => {
    const svg = renderBadgeSvg('media-buy', ['spec', 'live']);

    expect(svg).toContain('Media Buy Agent (Spec + Live)');
    expect(svg).toContain('#076D63');
  });

  it('renders Spec before Live regardless of input order', () => {
    const svgA = renderBadgeSvg('media-buy', ['live', 'spec']);
    const svgB = renderBadgeSvg('media-buy', ['spec', 'live']);

    expect(svgA).toContain('Media Buy Agent (Spec + Live)');
    expect(svgB).toContain('Media Buy Agent (Spec + Live)');
  });

  it('renders a verified (Live) badge without (Spec) when only live is set', () => {
    // Theoretical edge case — live without spec — but render it correctly.
    const svg = renderBadgeSvg('media-buy', ['live']);
    expect(svg).toContain('Media Buy Agent (Live)');
  });

  it('drops unknown modes from the qualifier (defense against DB drift)', () => {
    const svg = renderBadgeSvg('media-buy', ['spec', 'platinum']);
    // Only the known mode survives.
    expect(svg).toContain('Media Buy Agent (Spec)');
    expect(svg).not.toContain('Platinum');
  });

  it('renders Not Verified when only unknown modes are present', () => {
    const svg = renderBadgeSvg('media-buy', ['platinum']);
    expect(svg).toContain('Not Verified');
  });

  it('renders a not-verified badge when modes is empty', () => {
    const svg = renderBadgeSvg('media-buy', []);

    expect(svg).toContain('AAO Verified');
    expect(svg).toContain('Not Verified');
    expect(svg).toContain('#6b7280'); // grey (WCAG AA compliant)
    expect(svg).not.toContain('Media Buy Agent');
    expect(svg).not.toContain('(Spec)');
  });

  it('defaults to not-verified when modes argument is omitted', () => {
    const svg = renderBadgeSvg('media-buy');
    expect(svg).toContain('Not Verified');
  });

  it('renders all known role labels with (Spec)', () => {
    for (const role of ['media-buy', 'creative', 'signals', 'governance', 'brand', 'sponsored-intelligence']) {
      const svg = renderBadgeSvg(role, ['spec']);
      expect(svg).toContain('AAO Verified');
      expect(svg).toContain('(Spec)');
    }
  });

  it('falls back to raw role string for unknown roles', () => {
    const svg = renderBadgeSvg('custom_role', ['spec']);
    expect(svg).toContain('custom_role');
    expect(svg).toContain('AAO Verified');
  });

  it('generates valid SVG with proper dimensions', () => {
    const svg = renderBadgeSvg('media-buy', ['spec']);

    expect(svg).toMatch(/width="\d+"/);
    expect(svg).toMatch(/height="20"/);
  });

  it('includes accessibility attributes', () => {
    const svg = renderBadgeSvg('media-buy', ['spec']);
    expect(svg).toContain('role="img"');
    expect(svg).toContain('aria-label="AAO Verified: Media Buy Agent (Spec)"');
    expect(svg).toContain('<title>AAO Verified: Media Buy Agent (Spec)</title>');
  });
});

describe('renderBadgeSvg — adcp_version segment (#3524 stage 3)', () => {
  it('embeds the version between the role and the qualifier', () => {
    const svg = renderBadgeSvg('media-buy', ['spec'], { adcpVersion: '3.0' });
    expect(svg).toContain('Media Buy Agent 3.0 (Spec)');
    expect(svg).toContain('aria-label="AAO Verified: Media Buy Agent 3.0 (Spec)"');
  });

  it('renders Media Buy Agent 3.1 (Spec + Live)', () => {
    const svg = renderBadgeSvg('media-buy', ['spec', 'live'], { adcpVersion: '3.1' });
    expect(svg).toContain('Media Buy Agent 3.1 (Spec + Live)');
  });

  it('omits the version when not provided (legacy callers)', () => {
    const svg = renderBadgeSvg('media-buy', ['spec']);
    expect(svg).toContain('Media Buy Agent (Spec)');
    expect(svg).not.toContain('Media Buy Agent 3.');
  });

  it('drops the version segment when malformed (degraded display, not failure)', () => {
    // Unlike the JWT signer (which fails closed), the badge renders
    // verified-without-version on a malformed value — a missing image
    // is worse for the buyer than a less-specific one.
    const svg = renderBadgeSvg('media-buy', ['spec'], { adcpVersion: 'evil; DROP' });
    expect(svg).toContain('Media Buy Agent (Spec)');
    expect(svg).not.toContain('evil');
    expect(svg).not.toContain('DROP');
  });

  it('drops a version with leading-zero major', () => {
    const svg = renderBadgeSvg('media-buy', ['spec'], { adcpVersion: '0.5' });
    expect(svg).toContain('Media Buy Agent (Spec)');
    expect(svg).not.toContain('0.5');
  });

  it('drops a full-semver value (use protocol_version metadata, not the badge)', () => {
    const svg = renderBadgeSvg('media-buy', ['spec'], { adcpVersion: '3.0.0' });
    expect(svg).toContain('Media Buy Agent (Spec)');
    expect(svg).not.toContain('3.0.0');
  });

  it('renders double-digit minors without truncation', () => {
    const svg = renderBadgeSvg('media-buy', ['spec'], { adcpVersion: '3.10' });
    expect(svg).toContain('Media Buy Agent 3.10 (Spec)');
  });

  it('still renders Not Verified when modes is empty even with a version provided', () => {
    const svg = renderBadgeSvg('media-buy', [], { adcpVersion: '3.0' });
    expect(svg).toContain('Not Verified');
    // Version segment should not appear in the not-verified label.
    expect(svg).not.toContain('3.0');
  });
});
