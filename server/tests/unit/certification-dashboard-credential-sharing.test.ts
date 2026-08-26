import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';

const certificationHtml = readFileSync(
  join(process.cwd(), 'server/public/certification.html'),
  'utf8',
);

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Certification dashboard did not finish rendering');
}

describe('certification dashboard credential sharing', () => {
  it('shows an earned alternate Level 1 credential and its LinkedIn action', async () => {
    const dom = new JSDOM(certificationHtml, {
      url: 'https://example.test/certification.html',
      runScripts: 'dangerously',
      beforeParse(window) {
        window.fetch = (async (input: RequestInfo | URL) => {
          const path = typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.pathname
              : new URL(input.url).pathname;

          if (path === '/api/config') {
            return jsonResponse({ user: { id: 'user_test', isMember: false } });
          }
          if (path === '/api/certification/tracks') return jsonResponse({ tracks: [] });
          if (path === '/api/certification/credentials') {
            return jsonResponse({
              credentials: [
                {
                  id: 'basics',
                  tier: 1,
                  name: 'AdCP Basics',
                  description: 'Foundational credential',
                  required_modules: ['A1', 'A2'],
                  sort_order: 1,
                },
                {
                  id: 'decision_makers',
                  tier: 1,
                  name: 'AdCP for Decision-Makers',
                  description: 'Strategic credential',
                  required_modules: ['L1', 'L2', 'L3'],
                  sort_order: 8,
                },
              ],
            });
          }
          if (path === '/api/me/certification/progress') {
            return jsonResponse({ progress: [], trackProgress: [], certifications: [] });
          }
          if (path === '/api/me/certification/credentials') {
            return jsonResponse({
              credentials: [{
                credential_id: 'decision_makers',
                awarded_at: '2026-08-26T00:00:00.000Z',
                certifier_public_id: null,
                certifier_badge_url: null,
              }],
            });
          }
          if (path === '/api/me/certification/contributions') {
            return jsonResponse({ contributions: [] });
          }
          if (path === '/api/me/certification/expectation') return jsonResponse({});
          if (path === '/api/certification/stats') {
            return jsonResponse({ totalCertified: 0, totalOrgs: 0 });
          }
          return jsonResponse({});
        }) as typeof fetch;
      },
    });

    await waitFor(() => dom.window.document.querySelector('.tier-share-panel') !== null);

    const levelOneCard = dom.window.document.querySelector('[data-tier="1"]');
    expect(levelOneCard?.querySelector('.tier-name')?.textContent).toBe('AdCP for Decision-Makers');
    expect(levelOneCard?.classList.contains('tier-card-earned')).toBe(true);
    expect(levelOneCard?.querySelector('.credential-pending-note')?.textContent).toBe(
      'External verification is not currently available.',
    );

    const linkedInAction = Array.from(levelOneCard?.querySelectorAll('a') ?? [])
      .find(link => link.textContent?.trim() === 'Add to LinkedIn profile');
    expect(linkedInAction?.getAttribute('href')).toContain(
      'https://www.linkedin.com/profile/add?startTask=CERTIFICATION_NAME',
    );
    expect(linkedInAction?.getAttribute('href')).toContain('name=AdCP%20for%20Decision-Makers');

    dom.window.close();
  });
});
