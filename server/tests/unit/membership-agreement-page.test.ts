import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { renderLegalMarkdown } from '../../src/legal-markdown.js';

const root = process.cwd();
const httpSource = readFileSync(join(root, 'server/src/http.ts'), 'utf8');
const pageSource = readFileSync(join(root, 'server/public/agreement.html'), 'utf8');
const dashboardLegacySource = readFileSync(join(root, 'server/public/dashboard.html'), 'utf8');
const dashboardSource = readFileSync(join(root, 'server/public/dashboard-membership.html'), 'utf8');
const inviteSource = readFileSync(join(root, 'server/public/invite.html'), 'utf8');
const governanceSource = readFileSync(join(root, 'server/public/governance.html'), 'utf8');
const navSource = readFileSync(join(root, 'server/public/nav.js'), 'utf8');
const addieUrls = readFileSync(join(root, 'server/src/addie/rules/urls.md'), 'utf8');

describe('public membership agreement page', () => {
  it('serves the shared agreement shell at the canonical path and redirects the legacy path', () => {
    expect(httpSource).toContain("this.app.get('/legal/membership-agreement'");
    expect(httpSource).toContain("this.serveHtmlWithConfig(req, res, 'agreement.html')");
    expect(httpSource).toContain(
      "this.app.get('/membership-agreement', (_req, res) => res.redirect(301, '/legal/membership-agreement'))",
    );
  });

  it('loads the current membership agreement when opened at the canonical path', () => {
    expect(pageSource).toContain("isCanonicalMembership ? 'membership' : params.get('type')");
    expect(pageSource).toContain("isCanonicalMembership ? null : params.get('version')");
    expect(pageSource).toContain("new URLSearchParams({ type, format: 'json' })");
    expect(pageSource).toContain("fetch(`/api/agreement?${query.toString()}`)");
  });

  it('uses the canonical path from membership UI and the global footer', () => {
    expect(dashboardSource).toContain('href="/legal/membership-agreement"');
    expect(dashboardSource).toContain("type === 'membership'");
    expect(navSource).toContain('<a href="/legal/membership-agreement">Membership agreement</a>');
    expect(inviteSource).toContain('href="/legal/membership-agreement"');
    expect(governanceSource).toContain('href="/legal/membership-agreement" class="doc-card"');
    expect(dashboardLegacySource).toContain("`${baseUrl}/legal/membership-agreement`");
  });

  it('prevents caches from serving stale legal text', () => {
    const agreementApiStart = httpSource.indexOf("this.app.get('/api/agreement/current'");
    const agreementApiEnd = httpSource.indexOf('// NOTE: Organization routes', agreementApiStart);
    const agreementApiSource = httpSource.slice(agreementApiStart, agreementApiEnd);
    expect(agreementApiSource.match(/res\.setHeader\('Cache-Control', 'no-store'\)/g)).toHaveLength(2);
  });

  it('sanitizes rendered agreement Markdown before returning public HTML', () => {
    const agreementApiStart = httpSource.indexOf("this.app.get('/api/agreement/current'");
    const agreementApiEnd = httpSource.indexOf('// NOTE: Organization routes', agreementApiStart);
    const agreementApiSource = httpSource.slice(agreementApiStart, agreementApiEnd);
    expect(agreementApiSource).toContain('renderLegalMarkdown(agreement.text)');

    const rendered = renderLegalMarkdown(`
# Membership Agreement

<script>alert('script')</script>

<img src="https://tracker.example/pixel" onerror="alert('event')">

[Unsafe](javascript:alert('link'))

[Safe](https://agenticadvertising.org/legal/terms "Terms")
`);

    expect(rendered).toContain('<h1>Membership Agreement</h1>');
    expect(rendered).toContain('href="https://agenticadvertising.org/legal/terms"');
    expect(rendered).not.toMatch(/<script|<img|onerror|javascript:/i);
  });

  it('registers the canonical path for Addie and marks the legacy path redirect-only', () => {
    expect(addieUrls).toContain(
      'https://agenticadvertising.org/legal/membership-agreement — Current AgenticAdvertising.org membership agreement',
    );
    expect(addieUrls).toContain(
      '`agenticadvertising.org/membership-agreement` | Redirect only — always cite the canonical `/legal/membership-agreement`',
    );
  });
});
