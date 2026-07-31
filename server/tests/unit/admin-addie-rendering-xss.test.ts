import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(join(process.cwd(), 'server/public/admin-addie.html'), 'utf8');

function section(start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  if (startIndex < 0 || endIndex < 0) throw new Error(`Missing section: ${start}`);
  return source.slice(startIndex, endIndex);
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function loadMarkdownRenderer(dom: JSDOM): (text: string) => string {
  const rendererSource = section(
    'function linkifyBareUrls(html)',
    'function renderExecutionPlan(',
  );
  return new Function(
    'document',
    'currentUserNames',
    `${rendererSource}\nreturn renderMarkdown;`,
  )(dom.window.document, {}) as (text: string) => string;
}

describe('admin Addie rendering XSS regressions', () => {
  it('does not reprocess generated Markdown anchors during bare URL linkification', () => {
    const dom = new JSDOM('<body></body>', {
      runScripts: 'dangerously',
      url: 'https://agenticadvertising.org/admin/addie',
    });
    const renderMarkdown = loadMarkdownRenderer(dom);
    const payload = '[x](https://safe.example/https://evil.example/onmouseover=globalThis.__xss=1;//)';

    (dom.window as any).__xss = 0;
    dom.window.document.body.innerHTML = renderMarkdown(payload);
    dom.window.document.querySelectorAll('*').forEach(element => {
      element.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true }));
    });

    const links = [...dom.window.document.querySelectorAll('a')];
    expect(links).toHaveLength(1);
    expect(links[0].textContent).toBe('x');
    expect(links[0].hasAttribute('onmouseover')).toBe(false);
    expect((dom.window as any).__xss).toBe(0);
  });

  it('preserves Markdown links, bare links, and literal code', () => {
    const dom = new JSDOM('<body></body>');
    const renderMarkdown = loadMarkdownRenderer(dom);
    dom.window.document.body.innerHTML = renderMarkdown(
      '**Guide:** [docs](https://docs.example/guide) https://bare.example/path `https://code.example/literal`',
    );

    const links = [...dom.window.document.querySelectorAll('a')];
    expect(links.map(link => link.textContent)).toEqual([
      'docs',
      'https://bare.example/path',
    ]);
    expect(dom.window.document.querySelector('strong')?.textContent).toBe('Guide:');
    expect(dom.window.document.querySelector('code')?.textContent).toBe('https://code.example/literal');
    expect(dom.window.document.querySelector('code a')).toBeNull();
  });

  it.each([
    {
      name: 'hostile legacy values',
      channel: '<img src=x onerror="globalThis.__slackXss=1">',
      username: '</span><script>globalThis.__slackXss=1</script>',
    },
    { name: 'valid values', channel: 'general', username: 'alice' },
  ])('renders Slack display fields as text for $name', async ({ channel, username }) => {
    const dom = new JSDOM(`
      <select id="source-type-filter"><option value="slack" selected>Slack</option></select>
      <select id="category-filter"><option value="" selected>All</option></select>
      <select id="fetch-status-filter"><option value="" selected>All</option></select>
      <div id="knowledge-stats"></div>
      <div id="knowledge-list"></div>
    `);
    const loadKnowledgeSource = section(
      'async function loadKnowledge(page)',
      '// Legacy alias for loadResources',
    );
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue({ total: 1 }) })
      .mockResolvedValueOnce({
        json: vi.fn().mockResolvedValue({
          total: 1,
          documents: [{
            id: 1,
            source_type: 'slack',
            title: 'Slack message',
            category: 'community',
            slack_channel_name: channel,
            slack_username: username,
            content: 'Safe preview',
          }],
        }),
      });
    const loadKnowledge = new Function(
      'document',
      'fetch',
      'escapeHtml',
      'renderSafeHttpLink',
      `let knowledgePage = 0; const knowledgePageSize = 100;\n${loadKnowledgeSource}\nreturn loadKnowledge;`,
    )(
      dom.window.document,
      fetchMock,
      escapeHtml,
      () => '',
    ) as (page?: number) => Promise<void>;

    await loadKnowledge();

    const list = dom.window.document.getElementById('knowledge-list')!;
    expect(list.querySelector('img')).toBeNull();
    expect(list.querySelector('script')).toBeNull();
    expect(list.textContent).toContain(`#${channel}`);
    expect(list.textContent).toContain(`@${username}`);
  });

  it.each([
    {
      name: 'hostile legacy values',
      tag: '</span><img src=x onerror="globalThis.__feedbackXss=1">',
      count: '</span><script>globalThis.__feedbackXss=1</script>',
    },
    { name: 'valid values', tag: 'wrong_source', count: 12 },
  ])('renders aggregate feedback fields as text for $name', async ({ tag, count }) => {
    const dom = new JSDOM(`
      <select id="eval-days-filter"><option value="30" selected>30</option></select>
      <div id="eval-total"></div><div id="eval-rated"></div>
      <div id="eval-avg-rating"></div><div id="eval-positive"></div>
      <div id="eval-negative"></div><div id="eval-flagged"></div>
      <div id="eval-tags"></div><div id="eval-low-rated"></div>
    `);
    const loadEvaluationSource = section(
      'async function loadEvaluationData()',
      '// Knowledge modal functions',
    );
    const fetchMock = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        summary: {},
        tags: [{ tag, count }],
        low_rated: [],
      }),
    });
    const loadEvaluationData = new Function(
      'document',
      'fetch',
      'escapeHtml',
      `${loadEvaluationSource}\nreturn loadEvaluationData;`,
    )(dom.window.document, fetchMock, escapeHtml) as () => Promise<void>;

    await loadEvaluationData();

    const tags = dom.window.document.getElementById('eval-tags')!;
    expect(tags.querySelector('img')).toBeNull();
    expect(tags.querySelector('script')).toBeNull();
    expect(tags.querySelector('.tag-stat > span')?.textContent).toBe(String(tag).replace('_', ' '));
    expect(tags.querySelector('.tag-stat-count')?.textContent).toBe(String(count));
  });
});
