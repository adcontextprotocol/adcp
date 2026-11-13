import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';

const PAGE_URL = 'https://example.test/member-profile';
const PROFILE_API = '/api/me/member-profile';
const ACCOUNT_REDIRECT_NOTICE = 'This page is for organization profiles.';
// jsdom cannot observe a cross-document navigation, so the redirect target is
// checked in the page source the redirect timer runs.
const ACCOUNT_REDIRECT_TARGET = "window.location.href = '/account?org=' + encodeURIComponent(currentOrgId);";
const SETTLE_TIMEOUT_MS = 5000;
const SETTLE_POLL_MS = 10;
const PERSONAL_ORG = { id: 'org_personal', name: 'Pat Lee', role: 'owner', status: 'active', is_personal: true };
const SOLO_COMPANY_ORG = { id: 'org_pinnacle', name: 'Pinnacle Media', role: 'owner', status: 'active', is_personal: false };
const MEMBER_COMPANY_ORG = { id: 'org_nova', name: 'Nova Brands', role: 'member', status: 'active', is_personal: false };

type MeOrganization = typeof PERSONAL_ORG;
type PageWindow = JSDOM['window'] & { pickDefaultListingOrgId?: (organizations: unknown) => string | null };

const html = readFileSync(new URL('../../public/member-profile.html', import.meta.url), 'utf8');

let dom: JSDOM | null = null;
afterEach(() => {
  dom?.window.close();
  dom = null;
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

async function waitFor(isSettled: () => boolean): Promise<void> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  while (!isSettled()) {
    if (Date.now() > deadline) throw new Error('member-profile page never settled');
    await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
  }
}

/**
 * Loads the real page with /api/me returning `organizations` and waits until it
 * either shows the listing form or the account-profile redirect notice. The
 * member-profile request names the organization the page chose to open.
 */
async function openMemberProfile(organizations: MeOrganization[], query = '') {
  const profileRequests: string[] = [];

  dom = new JSDOM(html, {
    url: `${PAGE_URL}${query}`,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: new VirtualConsole(),
    beforeParse(window) {
      window.fetch = (async (url: string) => {
        if (url === '/api/me') {
          return json({ user: { id: 'user_pat', isAdmin: false }, organizations });
        }
        if (url.startsWith(PROFILE_API)) {
          profileRequests.push(url);
          const orgId = new URL(url, PAGE_URL).searchParams.get('org');
          const org = organizations.find((candidate) => candidate.id === orgId);
          return json({
            profile: null,
            organization_id: orgId,
            organization_name: org?.name ?? null,
            has_api_access: false,
          });
        }
        return json({}, 404);
      }) as typeof fetch;
    },
  });

  const window = dom.window as PageWindow;
  const errorText = () => window.document.getElementById('error-container')?.textContent ?? '';
  const formVisible = () => window.document.getElementById('profile-form')?.style.display === 'block';
  await waitFor(() => formVisible() || errorText().length > 0);

  return { window, profileRequests, pageUrl: window.location.href, errorText: errorText(), formVisible: formVisible() };
}

describe('member profile default listing organization (#8926)', () => {
  it('opens the solo owner company listing when the personal workspace is listed first', async () => {
    const page = await openMemberProfile([PERSONAL_ORG, SOLO_COMPANY_ORG]);

    expect(page.profileRequests).toEqual([`${PROFILE_API}?org=${SOLO_COMPANY_ORG.id}`]);
    expect(page.pageUrl).toBe(`${PAGE_URL}?org=${SOLO_COMPANY_ORG.id}`);
    expect(page.errorText).not.toContain(ACCOUNT_REDIRECT_NOTICE);
    expect(page.formVisible).toBe(true);
  });

  it('prefers a company workspace the user can publish and otherwise keeps the first organization', async () => {
    const page = await openMemberProfile([PERSONAL_ORG, MEMBER_COMPANY_ORG, SOLO_COMPANY_ORG]);
    const pickDefaultListingOrgId = page.window.pickDefaultListingOrgId!;

    expect(page.profileRequests).toEqual([`${PROFILE_API}?org=${SOLO_COMPANY_ORG.id}`]);
    expect(pickDefaultListingOrgId([PERSONAL_ORG, MEMBER_COMPANY_ORG, SOLO_COMPANY_ORG])).toBe(SOLO_COMPANY_ORG.id);
    expect(pickDefaultListingOrgId([PERSONAL_ORG, MEMBER_COMPANY_ORG])).toBe(PERSONAL_ORG.id);
    expect(pickDefaultListingOrgId([MEMBER_COMPANY_ORG, PERSONAL_ORG])).toBe(MEMBER_COMPANY_ORG.id);
    expect(pickDefaultListingOrgId([PERSONAL_ORG])).toBe(PERSONAL_ORG.id);
    expect(pickDefaultListingOrgId([])).toBeNull();
  });

  it('still sends a user with only a personal workspace to the account profile', async () => {
    const page = await openMemberProfile([PERSONAL_ORG]);

    expect(page.profileRequests).toEqual([`${PROFILE_API}?org=${PERSONAL_ORG.id}`]);
    expect(page.errorText).toContain(ACCOUNT_REDIRECT_NOTICE);
    expect(page.formVisible).toBe(false);
  });

  it('still sends an explicitly requested personal workspace to the account profile', async () => {
    const page = await openMemberProfile([PERSONAL_ORG, SOLO_COMPANY_ORG], `?org=${PERSONAL_ORG.id}`);

    expect(page.profileRequests).toEqual([`${PROFILE_API}?org=${PERSONAL_ORG.id}`]);
    expect(page.errorText).toContain(ACCOUNT_REDIRECT_NOTICE);
    expect(page.formVisible).toBe(false);
  });

  it('keeps the personal workspace selected when redirecting to the account profile', () => {
    expect(html).toContain(ACCOUNT_REDIRECT_TARGET);
    expect(html).not.toContain("window.location.href = '/account';");
  });
});
