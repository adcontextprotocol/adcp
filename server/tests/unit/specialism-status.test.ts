import { describe, it, expect } from 'vitest';
import { computeSpecialismStatus } from '../../src/addie/services/compliance-testing.js';

describe('computeSpecialismStatus', () => {
  it('returns passing for specialisms whose storyboard passed', () => {
    const result = computeSpecialismStatus(
      ['sales-broadcast-tv'],
      [{ storyboard_id: 'sales_broadcast_tv', status: 'passing', steps_passed: 5, steps_total: 5 }],
    );
    expect(result).toEqual({ 'sales-broadcast-tv': 'passing' });
  });

  it('returns failing for specialisms whose storyboard failed', () => {
    const result = computeSpecialismStatus(
      ['sales-broadcast-tv'],
      [{ storyboard_id: 'sales_broadcast_tv', status: 'failing', steps_passed: 2, steps_total: 5 }],
    );
    expect(result).toEqual({ 'sales-broadcast-tv': 'failing' });
  });

  it('treats partial as failing — partial means at least one step did not pass', () => {
    const result = computeSpecialismStatus(
      ['sales-broadcast-tv'],
      [{ storyboard_id: 'sales_broadcast_tv', status: 'partial', steps_passed: 4, steps_total: 5 }],
    );
    expect(result).toEqual({ 'sales-broadcast-tv': 'failing' });
  });

  it('returns untested when the matching storyboard has no status row', () => {
    const result = computeSpecialismStatus(['sales-broadcast-tv'], []);
    expect(result).toEqual({ 'sales-broadcast-tv': 'untested' });
  });

  it('returns untested when storyboard status is "untested"', () => {
    const result = computeSpecialismStatus(
      ['sales-broadcast-tv'],
      [{ storyboard_id: 'sales_broadcast_tv', status: 'untested', steps_passed: 0, steps_total: 5 }],
    );
    expect(result).toEqual({ 'sales-broadcast-tv': 'untested' });
  });

  it('returns unknown for specialisms not in SPECIALISM_CATALOG', () => {
    const result = computeSpecialismStatus(
      ['some-future-specialism'],
      [{ storyboard_id: 'sales_broadcast_tv', status: 'passing', steps_passed: 5, steps_total: 5 }],
    );
    expect(result).toEqual({ 'some-future-specialism': 'unknown' });
  });

  it('handles a mixed declaration — passing, failing, untested, unknown', () => {
    const result = computeSpecialismStatus(
      ['sales-broadcast-tv', 'sales-non-guaranteed', 'creative-ad-server', 'made-up-specialism'],
      [
        { storyboard_id: 'sales_broadcast_tv', status: 'passing', steps_passed: 5, steps_total: 5 },
        { storyboard_id: 'sales_non_guaranteed', status: 'failing', steps_passed: 1, steps_total: 5 },
        // creative_ad_server not in storyboardStatuses → untested
      ],
    );
    expect(result).toEqual({
      'sales-broadcast-tv': 'passing',
      'sales-non-guaranteed': 'failing',
      'creative-ad-server': 'untested',
      'made-up-specialism': 'unknown',
    });
  });

  it('returns an empty object when no specialisms are declared', () => {
    expect(computeSpecialismStatus([], [])).toEqual({});
  });
});
