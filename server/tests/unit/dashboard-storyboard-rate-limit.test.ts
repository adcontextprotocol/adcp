import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const dashboardSource = readFileSync(
  new URL('../../public/dashboard-agents.html', import.meta.url),
  'utf8',
);

const helperStart = dashboardSource.indexOf('function parseCapabilityProbeRetrySeconds');
const helperEnd = dashboardSource.indexOf('// Shared: render the storyboard map', helperStart);
if (helperStart < 0 || helperEnd < 0) {
  throw new Error('capability probe rate-limit helpers not found');
}
const context = vm.createContext({});
vm.runInContext(dashboardSource.slice(helperStart, helperEnd), context);
const buildCapabilityProbeRateLimitPanel = context.buildCapabilityProbeRateLimitPanel as (
  body: { retryAfter?: unknown },
  retryAfterHeader: string | null,
  savedStatusSummary: string,
) => string;

async function renderRateLimitedStoryboardPicker(options: {
  retryAfter?: unknown;
  retryAfterHeader?: string | null;
  statusSummary?: string;
} = {}) {
  const renderStart = dashboardSource.indexOf('function parseCapabilityProbeRetrySeconds');
  const renderEnd = dashboardSource.indexOf('// Storyboard "Test your agent" button', renderStart);
  if (renderStart < 0 || renderEnd < 0) {
    throw new Error('storyboard picker implementation not found');
  }

  const renderContext = vm.createContext({
    pageState: { orgId: 'org_test' },
    loadStoryboardStatusMap: async () => new Map([['saved', { status: 'fail' }]]),
    buildStoryboardStatusSummary: () => options.statusSummary ?? '<div class="saved-summary">Saved status</div>',
    fetch: async () => ({
      ok: false,
      status: 429,
      json: async () => ({ retryAfter: options.retryAfter }),
      headers: { get: () => options.retryAfterHeader ?? null },
    }),
    console,
  });
  vm.runInContext(dashboardSource.slice(renderStart, renderEnd), renderContext);
  const renderStoryboardPicker = renderContext.renderStoryboardPicker as (
    panel: { style: Record<string, string>; innerHTML: string; dataset: Record<string, string> },
    agentUrl: string,
    cardId: string,
    agentTracks?: unknown,
  ) => Promise<void>;
  const panel = { style: {}, innerHTML: '', dataset: {} };

  await renderStoryboardPicker(panel, 'https://agent.example', 'card-1');
  return panel.innerHTML;
}

describe('dashboard capability probe rate-limit guidance', () => {
  it('routes a real picker 429 through the warning and retains saved status', async () => {
    const html = await renderRateLimitedStoryboardPicker({
      retryAfter: 944,
      retryAfterHeader: '120',
    });

    expect(html).toContain('Capability check paused.');
    expect(html).toContain('Try again in 2 minutes.');
    expect(html).toContain('class="saved-summary"');
    expect(html).not.toContain('Could not probe agent capabilities');
  });

  it('shows the rounded retry time without blaming the agent', () => {
    const html = buildCapabilityProbeRateLimitPanel(
      { retryAfter: 944 },
      null,
      '<div class="saved-summary">Needs attention: 2 storyboards.</div>',
    );

    expect(html).toContain('Capability check paused.');
    expect(html).toContain('Your agent was not contacted.');
    expect(html).toContain('Try again in 16 minutes.');
    expect(html).toContain('class="saved-summary"');
    expect(html).not.toContain('Could not probe agent capabilities');
    expect(html).not.toContain('Agent is reachable');
    expect(html).not.toContain('storyboard eval budget');
  });

  it('uses the Retry-After header when present', () => {
    const html = buildCapabilityProbeRateLimitPanel({}, '120', '');
    expect(html).toContain('Try again in 2 minutes.');
  });

  it('treats the Retry-After header as authoritative', () => {
    const html = buildCapabilityProbeRateLimitPanel({ retryAfter: 944 }, '60', '');
    expect(html).toContain('Try again in 1 minute.');
    expect(html).not.toContain('16 minutes');
  });

  it('uses a safe generic retry when hints are missing or malformed', () => {
    for (const [body, header] of [
      [{}, null],
      [{ retryAfter: Number.NaN }, 'soon'],
      [{ retryAfter: -1 }, '0'],
    ] as const) {
      const html = buildCapabilityProbeRateLimitPanel(body, header, '');
      expect(html).toContain('Try again later.');
      expect(html).not.toContain('NaN');
    }
  });
});
