import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const committees = readFileSync(join(root, 'server/public/committees.html'), 'utf8');
const detail = readFileSync(join(root, 'server/public/working-groups/detail.html'), 'utf8');
const markdownHelper = readFileSync(join(root, 'server/public/js/markdown-to-plain-text.js'), 'utf8');
const service = readFileSync(join(root, 'server/src/services/working-group-membership-service.ts'), 'utf8');
const route = readFileSync(join(root, 'server/src/routes/committees.ts'), 'utf8');
const addie = readFileSync(join(root, 'server/src/addie/mcp/member-tools.ts'), 'utf8');

const notice = 'Our Mastermind Councils are for paying member tiers only. AgenticAdvertising.org membership starts at $50 annually.';

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

  it('shares the exact denial notice across HTTP, browser, and Addie adapters', () => {
    expect(service).toContain(`'${notice}'`);
    expect(route).toMatch(/error\.is\('council_membership_required'\)[\s\S]*?res\.status\(403\)[\s\S]*?message: MASTERMIND_COUNCIL_MEMBERSHIP_NOTICE/);
    expect(detail).toContain("alert(data.message || data.error || 'Failed to join group')");
    expect(addie).toMatch(/error\.is\('council_membership_required'\)[\s\S]*?return MASTERMIND_COUNCIL_MEMBERSHIP_NOTICE/);
  });
});
