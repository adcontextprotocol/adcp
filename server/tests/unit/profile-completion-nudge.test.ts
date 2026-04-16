import { describe, it, expect } from 'vitest';
import {
  composeNudgeMessage,
  extractFirstName,
  NUDGE_DAYS,
} from '../../src/addie/jobs/profile-completion-nudge.js';

describe('extractFirstName', () => {
  it('returns the first whitespace-separated token of real_name', () => {
    expect(extractFirstName('Mary Anne Smith', null)).toBe('Mary');
  });

  it('falls back to display_name when real_name is missing', () => {
    expect(extractFirstName(null, 'bokelley')).toBe('bokelley');
  });

  it('prefers real_name over display_name', () => {
    expect(extractFirstName('Brian O\'Kelley', 'bko')).toBe('Brian');
  });

  it('returns "there" when both names are null/empty', () => {
    expect(extractFirstName(null, null)).toBe('there');
    expect(extractFirstName('', '')).toBe('there');
    expect(extractFirstName('   ', '   ')).toBe('there');
  });
});

describe('composeNudgeMessage', () => {
  const base = {
    firstName: 'Mary',
    orgName: 'Acme',
    primaryBrandDomain: 'acme.com',
  };

  it('names both missing steps when nothing is done', () => {
    const msg = composeNudgeMessage({
      ...base,
      day: 3,
      hasPublicProfile: false,
      hasBrandManifest: false,
    });
    expect(msg).toContain('Hi Mary --');
    expect(msg).toContain('Publish your profile');
    expect(msg).toContain('Publish at least one agent to your brand.json');
  });

  it('asks only for the profile when brand.json is done', () => {
    const msg = composeNudgeMessage({
      ...base,
      day: 7,
      hasPublicProfile: false,
      hasBrandManifest: true,
    });
    expect(msg).toContain('brand.json is set up');
    expect(msg).toContain('publish your AAO profile');
    expect(msg).not.toContain('Publish at least one agent');
  });

  it('asks only for brand.json when profile is public', () => {
    const msg = composeNudgeMessage({
      ...base,
      day: 14,
      hasPublicProfile: true,
      hasBrandManifest: false,
    });
    expect(msg).toContain('AAO profile looks great');
    expect(msg).toContain('publish at least one agent to your brand.json for acme.com');
  });

  it('prompts to set primary domain first when it is missing', () => {
    const msg = composeNudgeMessage({
      ...base,
      primaryBrandDomain: null,
      day: 14,
      hasPublicProfile: true,
      hasBrandManifest: false,
    });
    expect(msg).toContain('set your primary brand domain first');
  });

  it('adds the "final nudge" opt-out prompt only on day 30', () => {
    const final = composeNudgeMessage({
      ...base,
      day: 30,
      hasPublicProfile: false,
      hasBrandManifest: false,
    });
    expect(final).toContain('last nudge');

    const midway = composeNudgeMessage({
      ...base,
      day: 7,
      hasPublicProfile: false,
      hasBrandManifest: false,
    });
    expect(midway).not.toContain('last nudge');
  });

  it('links to the profile editor in every variant', () => {
    for (const day of NUDGE_DAYS) {
      for (const hasProfile of [true, false]) {
        for (const hasManifest of [true, false]) {
          // Skip the announce-ready state — the job wouldn't nudge here.
          if (hasProfile && hasManifest) continue;
          const msg = composeNudgeMessage({
            ...base,
            day,
            hasPublicProfile: hasProfile,
            hasBrandManifest: hasManifest,
          });
          expect(msg).toContain('/me/profile');
        }
      }
    }
  });
});
