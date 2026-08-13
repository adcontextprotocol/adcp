import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const committees = readFileSync(join(root, 'server/public/committees.html'), 'utf8');
const detail = readFileSync(join(root, 'server/public/working-groups/detail.html'), 'utf8');
const markdownHelper = readFileSync(join(root, 'server/public/js/markdown-to-plain-text.js'), 'utf8');
const externalUrlHelper = readFileSync(join(root, 'server/public/external-url.js'), 'utf8');
const service = readFileSync(join(root, 'server/src/services/working-group-membership-service.ts'), 'utf8');
const route = readFileSync(join(root, 'server/src/routes/committees.ts'), 'utf8');
const addie = readFileSync(join(root, 'server/src/addie/mcp/member-tools.ts'), 'utf8');

const notice = 'Our Mastermind Councils are for paying member tiers only. AgenticAdvertising.org membership starts at $50 annually.';

function sourceSection(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  if (startIndex < 0 || endIndex < 0) {
    throw new Error(`Could not extract source section from ${start} to ${end}`);
  }
  return source.slice(startIndex, endIndex);
}

describe('Mastermind Council public and adapter surfaces', () => {
  it('uses the requested Council landing-page copy while preserving other type copy', () => {
    expect(committees).toContain('id="tab-council">Mastermind Councils</a>');
    expect(committees).toContain("title: 'Mastermind Councils'");
    expect(committees).toContain("subtitle: 'Exploring how agentic AI is impacting two outcomes that marketers care about: growth and brand value.'");
    expect(committees).toContain("sectionTitle: 'All Mastermind Councils'");
    expect(committees).toContain('Mastermind Councils are interactive peer forums where members openly exchange ideas, share success stories, and collectively develop scalable playbooks and emerging best practices to shape the future of agentic marketing.');
    expect(committees).toContain("emptyMessage: 'Mastermind Councils are being established. Check back soon!'");
    expect(committees).toContain("joinCta: 'Become an AgenticAdvertising.org member to join Mastermind Councils");

    expect(committees).toContain("title: 'Working Groups'");
    expect(committees).toContain("title: 'Regional Chapters'");
    expect(committees).toContain("title: 'Industry Gatherings'");
  });

  it('uses Council-only detail actions without changing the default working-group labels', () => {
    expect(detail).toContain("currentGroup.committee_type === 'council'");
    expect(detail).toContain("document.getElementById('backLinkText').textContent = 'Back to Councils'");
    expect(detail).toContain("document.getElementById('joinBtnLabel').textContent = 'Join Council'");
    expect(detail).toContain('<span id="backLinkText">Back to Working Groups</span>');
    expect(detail).toContain('<span id="joinBtnLabel">Join Working Group</span>');
  });

  it('renders document summaries as sanitized Markdown-derived plain text', () => {
    expect(detail).toContain('escapeHtml(markdownToPlainText(doc.document_summary))');
    expect(detail).toContain('<script src="/js/markdown-to-plain-text.js"></script>');
    expect(markdownHelper).toContain('ALLOWED_TAGS: SAFE_TAGS');
    expect(markdownHelper).toContain("ALLOWED_ATTR: ['alt']");
    expect(detail).toContain('descContent.innerHTML = DOMPurify.sanitize(renderedHtml);');
  });

  it('restores an enabled type-specific join action after success, failure, or leave', () => {
    expect(detail).toContain('function resetJoinButton()');
    expect(detail).toContain('joinBtn.disabled = false;');
    expect(detail.match(/resetJoinButton\(\);/g)).toHaveLength(4);
  });

  it('shares the denial and linked membership CTA across HTTP, browser, and Addie adapters', () => {
    expect(service).toContain(`'${notice}'`);
    expect(route).toMatch(/error\.is\('council_membership_required'\)[\s\S]*?res\.status\(403\)[\s\S]*?cta_url: MASTERMIND_COUNCIL_MEMBERSHIP_URL/);
    expect(detail).toContain('id="joinNotice" class="join-notice" role="alert" aria-atomic="true" hidden');
    expect(detail).toContain('const ctaUrl = safeExternalHttpUrl(data?.cta_url);');
    expect(detail).toContain("message.textContent = data?.message || data?.error || 'Failed to join group';");
    expect(detail).toContain("link.textContent = data.cta_label || 'Learn more';");
    expect(detail).toContain("suffix.textContent = data.cta_suffix ? ` ${data.cta_suffix}` : '';");
    expect(detail).toContain('showJoinNotice(data);');
    expect(detail).not.toContain("alert(data.message || data.error || 'Failed to join group')");
    expect(addie).toMatch(/error\.is\('council_membership_required'\)[\s\S]*?\[Sign up for membership here\]\(\$\{MASTERMIND_COUNCIL_MEMBERSHIP_URL\}\)/);
  });

  it('renders the council denial as safe inline text and an allowlisted membership link', () => {
    const dom = new JSDOM(`
      <div id="joinNotice" hidden>
        <span id="joinNoticeMessage"></span>
        <a id="joinNoticeLink" href="" hidden></a>
        <span id="joinNoticeSuffix"></span>
      </div>
    `, { url: 'https://agenticadvertising.org/working-groups/growth-council' });
    const browserGlobal: Record<string, unknown> = {};
    new Function('window', externalUrlHelper)(browserGlobal);
    const safeExternalHttpUrl = browserGlobal.safeExternalHttpUrl as (value: unknown) => string | null;
    const noticeFunctions = sourceSection(detail, 'function hideJoinNotice()', 'async function joinGroup()');
    const { showJoinNotice } = new Function(
      'document',
      'safeExternalHttpUrl',
      `${noticeFunctions}\nreturn { showJoinNotice, hideJoinNotice };`,
    )(dom.window.document, safeExternalHttpUrl) as {
      showJoinNotice: (data: Record<string, string>) => void;
    };

    showJoinNotice({
      message: '<img src=x onerror="globalThis.__councilXss = true">',
      cta_url: 'javascript:globalThis.__councilXss = true',
      cta_label: 'Unsafe link',
      cta_suffix: 'unsafe suffix',
    });

    const noticeElement = dom.window.document.getElementById('joinNotice')!;
    const link = dom.window.document.getElementById('joinNoticeLink') as HTMLAnchorElement;
    expect(noticeElement.hidden).toBe(false);
    expect(noticeElement.textContent).toContain('<img src=x onerror="globalThis.__councilXss = true">');
    expect(noticeElement.querySelector('img')).toBeNull();
    expect(link.hidden).toBe(true);
    expect(link.hasAttribute('href')).toBe(false);

    showJoinNotice({
      message: 'Our Mastermind Councils are for paying member tiers only.',
      cta_url: 'https://agenticadvertising.org/membership#:~:text=Membership%20pricing,-Explorer',
      cta_label: 'Sign up for membership here',
      cta_suffix: 'starting at $50 annually.',
    });

    expect(link.hidden).toBe(false);
    expect(link.href).toBe('https://agenticadvertising.org/membership#:~:text=Membership%20pricing,-Explorer');
    expect(link.textContent).toBe('Sign up for membership here');
    expect(noticeElement.textContent).toContain('starting at $50 annually.');
  });
});
