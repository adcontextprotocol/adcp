import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const dashboardSource = readFileSync(
  new URL('../../public/dashboard-agents.html', import.meta.url),
  'utf8',
);

const helperStart = dashboardSource.indexOf('function buildTrackCoverageGapNote');
const helperEnd = dashboardSource.indexOf('// Track pill click', helperStart);
if (helperStart < 0 || helperEnd < 0) {
  throw new Error('buildTrackCoverageGapNote helper not found');
}
const context = vm.createContext({});
vm.runInContext(dashboardSource.slice(helperStart, helperEnd), context);
const buildTrackCoverageGapNote = context.buildTrackCoverageGapNote as (
  trackData: { has_coverage_gap_skip?: boolean; status?: string },
) => string;

describe('dashboard track coverage-gap guidance', () => {
  it('explains partial tracks when coverage-gap skips block storyboard eligibility', () => {
    const html = buildTrackCoverageGapNote({
      has_coverage_gap_skip: true,
      status: 'partial',
    });

    expect(html).toContain('class="track-coverage-gap-note"');
    expect(html).toContain('Badge eligibility is storyboard-level.');
    expect(html).toContain('do not count as passing');
  });

  it.each([
    { has_coverage_gap_skip: false, status: 'partial' },
    { has_coverage_gap_skip: true, status: 'pass' },
    { has_coverage_gap_skip: true, status: 'fail' },
  ])('omits the note for $status without a partial coverage gap', (trackData) => {
    expect(buildTrackCoverageGapNote(trackData)).toBe('');
  });

  it('renders numeric scenario counts without string parsing', () => {
    expect(dashboardSource).toContain('Number(trackData.passed_count)');
    expect(dashboardSource).toContain('Number(trackData.scenario_count)');
  });
});
