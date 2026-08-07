import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

function readPublicFile(relativePath: string): string {
  return readFileSync(join(process.cwd(), 'server/public', relativePath), 'utf8');
}

function section(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  if (startIndex < 0 || endIndex < 0) {
    throw new Error(`Could not extract section from ${start} to ${end}`);
  }
  return source.slice(startIndex, endIndex);
}

function loadSafePerspectiveExternalUrl(): (value: unknown) => string | null {
  const source = readPublicFile('perspective-url.js');
  return new Function(`${source}\nreturn getSafePerspectiveExternalUrl;`)() as (value: unknown) => string | null;
}

describe('runtime XSS regressions', () => {
  it('renders community mirror proposal JSON and organization IDs as escaped text', () => {
    const source = readPublicFile('admin-community-mirrors.html');
    const rendererSource = section(source, 'function escapeHtml(value)', 'async function fetchJson(url)');
    const renderProposal = new Function(
      'catalogFields',
      `${rendererSource}\nreturn renderProposal;`,
    )(['formats', 'properties', 'placements', 'collections', 'signals']) as (
      entry: Record<string, any>,
    ) => string;
    const hostile = '</pre><img src=x onerror="globalThis.__mirrorXss = true"><script>bad()</script>';
    const html = renderProposal({
      proposal: {
        id: '4ec8bc86-6180-4d0e-aa72-9cbf402d3638',
        platform: 'acme_ads',
        proposed_at: new Date().toISOString(),
        proposed_by_email: hostile,
        proposed_by_organization_id: hostile,
        adagents_json: { formats: [{ display_name: hostile }] },
      },
      current: null,
    });
    const dom = new JSDOM(`<body>${html}</body>`);

    expect(dom.window.document.querySelector('img')).toBeNull();
    expect(dom.window.document.querySelector('script')).toBeNull();
    expect(dom.window.document.body.textContent).toContain(hostile);
  });

  it('keeps hostile Markdown link destinations out of executable admin transcript markup', () => {
    const source = readPublicFile('admin-addie.html');
    const renderMarkdownSource = section(
      source,
      'function linkifyBareUrls(html)',
      'function renderExecutionPlan(',
    );
    const rendererDom = new JSDOM('<body></body>');
    const renderMarkdown = new Function(
      'document',
      'currentUserNames',
      `${renderMarkdownSource}\nreturn renderMarkdown;`,
    )(rendererDom.window.document, {}) as (text: string) => string;

    const quoteBreaking = renderMarkdown(
      '[review](https://safe.example/path" onmouseover="globalThis.__xss = true)',
    );
    const quoteDom = new JSDOM(`<body>${quoteBreaking}</body>`);
    const quoteLink = quoteDom.window.document.querySelector('a');

    expect(quoteLink).not.toBeNull();
    expect(quoteLink?.hasAttribute('onmouseover')).toBe(false);
    expect(quoteLink?.getAttribute('href')).toMatch(/^https:\/\//);

    const activeScheme = renderMarkdown('[review](javascript:globalThis.__xss = true)');
    const schemeDom = new JSDOM(`<body>${activeScheme}</body>`);

    expect(schemeDom.window.document.querySelector('a')).toBeNull();
    expect(schemeDom.window.document.body.textContent).toContain('review');
  });

  it('renders stored Addie feedback notes and tags as text in the admin transcript', () => {
    const source = readPublicFile('admin-addie.html');
    const escapeHtmlSource = section(
      source,
      'function escapeHtml(text)',
      'function copyThreadId(',
    );
    const renderThreadMessageSource = section(
      source,
      'function renderThreadMessage(msg)',
      'function toggleRouterDecision(',
    );
    const helperDom = new JSDOM('<body></body>');
    const escapeHtml = new Function(
      'document',
      `${escapeHtmlSource}\nreturn escapeHtml;`,
    )(helperDom.window.document) as (text: string) => string;
    const renderThreadMessage = new Function(
      'escapeHtml',
      'renderMarkdown',
      'renderToolCalls',
      `${renderThreadMessageSource}\nreturn renderThreadMessage;`,
    )(
      escapeHtml,
      (text: string) => escapeHtml(text),
      () => '',
    ) as (message: Record<string, unknown>) => string;
    const hostileNotes = '</textarea><img src=x onerror="globalThis.__feedbackXss = true">';
    const hostileTag = '</span><script>globalThis.__feedbackXss = true</script>';

    const html = renderThreadMessage({
      message_id: '86b7df04-4c25-4627-bcee-c7c69c671ec3',
      role: 'assistant',
      content: 'Answer',
      rating: 1,
      rating_source: 'user',
      rating_notes: hostileNotes,
      feedback_tags: [hostileTag],
    });
    const dom = new JSDOM(`<body>${html}</body>`);

    expect(dom.window.document.querySelector('img')).toBeNull();
    expect(dom.window.document.querySelector('script')).toBeNull();
    expect(dom.window.document.querySelector('textarea')?.value).toBe(hostileNotes);
    expect(dom.window.document.querySelector('.existing-feedback')?.textContent).toContain(hostileTag);
  });

  it.each([
    ['admin-brands.html', 'viewBrand'],
    ['admin-properties.html', 'viewProperty'],
  ])('renders hostile registry JSON as text in %s', async (fileName, functionName) => {
    const source = readPublicFile(fileName);
    const viewFunctionSource = section(
      source,
      `async function ${functionName}(domain)`,
      'function closeViewModal()',
    );
    const dom = new JSDOM(`
      <div id="viewModal"></div>
      <div id="viewModalTitle"></div>
      <div id="viewContent"></div>
    `);
    const payload = '</pre><img src=x onerror="globalThis.__registryXss = true"><script>globalThis.__registryXss = true</script>';
    const fetchMock = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({ attackerControlled: payload }),
    });
    const viewManifest = new Function(
      'document',
      'fetch',
      `${viewFunctionSource}\nreturn ${functionName};`,
    )(dom.window.document, fetchMock) as (domain: string) => Promise<void>;

    await viewManifest('attacker.example');

    const viewContent = dom.window.document.getElementById('viewContent')!;
    expect(viewContent.querySelector('pre')?.textContent).toBe(
      JSON.stringify({ attackerControlled: payload }, null, 2),
    );
    expect(viewContent.querySelector('img')).toBeNull();
    expect(viewContent.querySelector('script')).toBeNull();
  });

  it('renders remote property validation details as text', () => {
    const source = readPublicFile('admin-properties.html');
    const displayValidationResultsSource = section(
      source,
      'function displayValidationResults(data)',
      'function showValidateError(message)',
    );
    const dom = new JSDOM(`
      <div id="validationResults"></div>
      <button id="saveValidatedBtn"></button>
      <div id="validateError"></div>
    `);
    const displayValidationResults = new Function(
      'document',
      `${displayValidationResultsSource}\nreturn displayValidationResults;`,
    )(dom.window.document) as (data: Record<string, unknown>) => void;
    const hostileUrl = '</p><img src=x onerror="globalThis.__propertyXss = true">';
    const hostileError = '</li><script>globalThis.__propertyXss = true</script><li>';
    const hostileWarning = '<img src=x onerror="globalThis.__propertyXss = true">';

    displayValidationResults({
      valid: false,
      url: hostileUrl,
      status_code: 400,
      errors: [{ message: hostileError }],
      warnings: [{ message: hostileWarning }],
    });

    const container = dom.window.document.getElementById('validationResults')!;
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain(hostileUrl);
    expect(container.textContent).toContain(hostileError);
    expect(container.textContent).toContain(hostileWarning);
    expect(dom.window.document.getElementById('saveValidatedBtn')?.style.display).toBe('inline-block');

    displayValidationResults({
      valid: true,
      url: 'https://publisher.example/.well-known/adagents.json',
      status_code: 200,
      errors: [],
      warnings: [],
      raw_data: { authorized_agents: [{ url: 'https://agent.example' }], properties: [{ id: 'site' }] },
    });

    expect(container.textContent).toContain('Authorized agents: 1');
    expect(container.textContent).toContain('Properties: 1');
    expect(dom.window.document.getElementById('saveValidatedBtn')?.style.display).toBe('none');
  });

  it('assigns only credential-free HTTPS research logos through the DOM', () => {
    const source = readPublicFile('admin-brands.html');
    const displayResearchResultsSource = section(
      source,
      'function getSafeResearchLogoUrl(value)',
      'async function saveResearchedBrand()',
    );
    const dom = new JSDOM(`
      <div id="researchContent"></div>
      <div id="researchResults"></div>
      <div id="researchError"></div>
    `, { url: 'https://agenticadvertising.org/admin/brands' });
    const escapeHtml = (value: unknown) => String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
    const displayResearchResults = new Function(
      'document',
      'escapeHtml',
      `${displayResearchResultsSource}\nreturn displayResearchResults;`,
    )(dom.window.document, escapeHtml) as (data: Record<string, any>) => void;
    const content = dom.window.document.getElementById('researchContent')!;

    displayResearchResults({
      domain: 'hostile.example',
      manifest: {
        name: 'Hostile brand',
        logos: [{ url: 'javascript:globalThis.__brandXss = true' }],
      },
    });
    expect(content.querySelector('img')).toBeNull();

    displayResearchResults({
      domain: 'quoted.example',
      manifest: {
        name: 'Quoted brand',
        logos: [{ url: 'https://cdn.example/logo.png" onerror="globalThis.__brandXss = true' }],
      },
    });
    const normalizedHostileLogo = content.querySelector('img');
    expect(normalizedHostileLogo).not.toBeNull();
    expect(normalizedHostileLogo?.hasAttribute('onerror')).toBe(false);
    expect(normalizedHostileLogo?.src).toMatch(/^https:\/\/cdn\.example\//);

    displayResearchResults({
      domain: 'safe.example',
      manifest: {
        name: 'Safe brand',
        logos: [{ url: 'https://cdn.example/logo.png?variant=dark' }],
      },
    });
    expect(content.querySelector('img')?.src).toBe('https://cdn.example/logo.png?variant=dark');
    expect(content.textContent).toContain('Safe brand');
  });

  it('does not turn member-controlled profile URLs into active card markup', () => {
    const source = readPublicFile('member-card.js');
    const renderMemberCard = new Function(
      `${source}\nreturn renderMemberCard;`,
    )() as (member: Record<string, unknown>, options?: Record<string, unknown>) => string;
    const baseMember = {
      display_name: 'Acme Builder',
      slug: 'acme-builder',
      offerings: [],
      credentials: [],
      markets: [],
      data_providers: [],
    };

    const quoteBreakingHtml = renderMemberCard({
      ...baseMember,
      linkedin_url: 'https://www.linkedin.com/in/acme" onmouseover="globalThis.__memberXss = true',
    });
    const quoteDom = new JSDOM(`<body>${quoteBreakingHtml}</body>`);
    const linkedIn = [...quoteDom.window.document.querySelectorAll('a')]
      .find((link) => link.textContent === 'LinkedIn');

    expect(linkedIn).toBeDefined();
    expect(linkedIn?.hasAttribute('onmouseover')).toBe(false);
    expect(linkedIn?.getAttribute('href')).toMatch(/^https:\/\//);

    const activeSchemeHtml = renderMemberCard({
      ...baseMember,
      linkedin_url: 'javascript:globalThis.__memberXss = true',
    });
    const schemeDom = new JSDOM(`<body>${activeSchemeHtml}</body>`);

    expect([...schemeDom.window.document.querySelectorAll('a')]
      .some((link) => link.textContent === 'LinkedIn')).toBe(false);

    const hostileWebsiteHtml = renderMemberCard({
      ...baseMember,
      contact_website: 'javascript:globalThis.__memberXss = true',
    });
    const websiteDom = new JSDOM(`<body>${hostileWebsiteHtml}</body>`);

    expect([...websiteDom.window.document.querySelectorAll('a')]
      .some((link) => link.textContent === 'Website')).toBe(false);
  });

  it('preserves valid member card URLs and the safe brand-domain website fallback', () => {
    const source = readPublicFile('member-card.js');
    const renderMemberCard = new Function(
      `${source}\nreturn renderMemberCard;`,
    )() as (member: Record<string, unknown>) => string;
    const baseMember = {
      display_name: 'Acme Builder',
      slug: 'acme-builder',
      offerings: [],
      credentials: [],
      markets: [],
      data_providers: [],
      linkedin_url: 'https://www.linkedin.com/company/acme-media',
      resolved_brand: { contact: { domain: 'acme.example' } },
    };
    const dom = new JSDOM(`<body>${renderMemberCard(baseMember)}</body>`);
    const links = [...dom.window.document.querySelectorAll('a')];

    expect(links.find((link) => link.textContent === 'LinkedIn')?.href)
      .toBe('https://www.linkedin.com/company/acme-media');
    expect(links.find((link) => link.textContent === 'Website')?.href)
      .toBe('https://acme.example/');
  });

  it('filters unsafe legacy profile URLs from the member detail view', () => {
    const membersSource = readPublicFile('members.html');
    const memberCardSource = readPublicFile('member-card.js');
    const safeUrlSource = section(
      memberCardSource,
      'function getSafeHttpsUrl(value)',
      '// ============================================\n// Publisher Card Rendering',
    );
    const renderDetailSource = section(
      membersSource,
      'function renderMemberDetail(member, perspectives, registryContributions, githubUsername)',
      'async function loadWorkingGroupsForOrg(orgId)',
    );
    const dom = new JSDOM('<body><div id="detail-content"></div></body>');
    const renderMemberDetail = new Function(
      'document',
      'escapeHtml',
      'updateShareLinks',
      `${safeUrlSource}\n${renderDetailSource}\nreturn renderMemberDetail;`,
    )(
      dom.window.document,
      (value: unknown) => String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;'),
      vi.fn(),
    ) as (member: Record<string, unknown>, perspectives: unknown[], contributions: unknown[], github: null) => void;

    renderMemberDetail({
      display_name: 'Legacy Acme',
      contact_website: 'javascript:globalThis.__memberXss = true',
      linkedin_url: 'https://user:secret@linkedin.example/company/acme',
      twitter_url: 'data:text/html,<script>globalThis.__memberXss = true</script>',
      offerings: [],
      markets: [],
      agents: [],
      publishers: [],
      data_providers: [],
      tags: [],
    }, [], [], null);

    expect(dom.window.document.querySelector('.detail-social')).toBeNull();
  });

  it('filters unsafe legacy profile URLs from the community person view', () => {
    const source = readPublicFile('community/person-profile.html');
    const safeUrlSource = section(
      source,
      'function getSafeHttpsUrl(value)',
      'function formatTier(tier)',
    );
    const renderMainColumnSource = section(
      source,
      'function renderMainColumn(data)',
      '// =========================================================================\n    // Sidebar rendering',
    );
    const dom = new JSDOM('<body><div id="main-column"></div></body>');
    const renderMainColumn = new Function(
      'document',
      'escapeHtml',
      'getSafePerspectiveExternalUrl',
      `${safeUrlSource}\n${renderMainColumnSource}\nreturn renderMainColumn;`,
    )(
      dom.window.document,
      (value: unknown) => String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;'),
      loadSafePerspectiveExternalUrl(),
    ) as (profile: Record<string, unknown>) => void;

    renderMainColumn({
      first_name: 'Legacy',
      last_name: 'Acme',
      linkedin_url: 'javascript:globalThis.__memberXss = true',
      twitter_url: 'https://user:secret@social.example/acme',
      expertise: [],
      interests: [],
      working_groups: [],
      perspectives: [],
      registry_contributions: [],
      github_activity: [],
      certifications: [],
    });

    expect(dom.window.document.querySelector('.profile-social')).toBeNull();
  });

  it('preserves valid HTTPS profile URLs in the community person view', () => {
    const source = readPublicFile('community/person-profile.html');
    const safeUrlSource = section(
      source,
      'function getSafeHttpsUrl(value)',
      'function formatTier(tier)',
    );
    const renderMainColumnSource = section(
      source,
      'function renderMainColumn(data)',
      '// =========================================================================\n    // Sidebar rendering',
    );
    const dom = new JSDOM('<body><div id="main-column"></div></body>');
    const renderMainColumn = new Function(
      'document',
      'escapeHtml',
      'getSafePerspectiveExternalUrl',
      `${safeUrlSource}\n${renderMainColumnSource}\nreturn renderMainColumn;`,
    )(
      dom.window.document,
      (value: unknown) => String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;'),
      loadSafePerspectiveExternalUrl(),
    ) as (profile: Record<string, unknown>) => void;

    renderMainColumn({
      first_name: 'Safe',
      last_name: 'Acme',
      linkedin_url: 'https://www.linkedin.com/in/acme?ref=community',
      twitter_url: 'https://social.example/acme#profile',
      expertise: [],
      interests: [],
      working_groups: [],
      perspectives: [],
      registry_contributions: [],
      github_activity: [],
      certifications: [],
    });

    const socialLinks = [...dom.window.document.querySelectorAll('.profile-social a')];
    expect(socialLinks.map(link => link.getAttribute('href'))).toEqual([
      'https://www.linkedin.com/in/acme?ref=community',
      'https://social.example/acme#profile',
    ]);
  });

  it.each([
    'javascript:globalThis.__perspectiveXss = true',
    'data:text/html,<script>globalThis.__perspectiveXss = true</script>',
  ])('does not navigate the public perspective page to an active scheme: %s', async (externalUrl) => {
    const source = readPublicFile('perspectives/article.html');
    const loadArticleSource = section(
      source,
      'async function loadArticle()',
      'function showError()',
    );
    const fakeWindow = {
      location: {
        pathname: '/perspectives/hostile-link',
        href: 'https://agenticadvertising.org/perspectives/hostile-link',
      },
    };
    const showError = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ content_type: 'link', external_url: externalUrl }),
    });
    const loadArticle = new Function(
      'window',
      'fetch',
      'showError',
      'getSafePerspectiveExternalUrl',
      `let currentArticle = null;
       ${loadArticleSource}
       return loadArticle;`,
    )(fakeWindow, fetchMock, showError, loadSafePerspectiveExternalUrl()) as () => Promise<void>;

    await loadArticle();

    expect(fakeWindow.location.href).toBe('https://agenticadvertising.org/perspectives/hostile-link');
    expect(showError).toHaveBeenCalledOnce();
  });

  it('navigates a public link perspective to a valid HTTPS destination', async () => {
    const source = readPublicFile('perspectives/article.html');
    const loadArticleSource = section(
      source,
      'async function loadArticle()',
      'function showError()',
    );
    const fakeWindow = {
      location: {
        pathname: '/perspectives/safe-link',
        href: 'https://agenticadvertising.org/perspectives/safe-link',
      },
    };
    const showError = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        content_type: 'link',
        external_url: 'https://partner.example/field-notes',
      }),
    });
    const loadArticle = new Function(
      'window',
      'fetch',
      'showError',
      'getSafePerspectiveExternalUrl',
      `let currentArticle = null;
       ${loadArticleSource}
       return loadArticle;`,
    )(fakeWindow, fetchMock, showError, loadSafePerspectiveExternalUrl()) as () => Promise<void>;

    await loadArticle();

    expect(fakeWindow.location.href).toBe('https://partner.example/field-notes');
    expect(showError).not.toHaveBeenCalled();
  });

  it('renders story cards with runtime-safe external or internal destinations', () => {
    const source = readPublicFile('stories/index.html');
    const buildPerspectiveCardSource = section(
      source,
      'function buildPerspectiveCard(item, className)',
      '// Load perspectives and split',
    );
    const dom = new JSDOM('<body></body>', {
      url: 'https://agenticadvertising.org/stories',
    });
    const buildPerspectiveCard = new Function(
      'document',
      'getSafePerspectiveExternalUrl',
      'registerTopics',
      'isNew',
      `${buildPerspectiveCardSource}\nreturn buildPerspectiveCard;`,
    )(
      dom.window.document,
      loadSafePerspectiveExternalUrl(),
      vi.fn(),
      () => false,
    ) as (item: Record<string, unknown>, className: string) => HTMLAnchorElement;

    const hostileCard = buildPerspectiveCard({
      slug: 'hostile slug/child',
      title: 'Hostile story',
      external_url: 'javascript:globalThis.__perspectiveXss = true',
      tags: [],
    }, 'card');
    expect(hostileCard.getAttribute('href')).toBe('/perspectives/hostile%20slug%2Fchild');
    expect(hostileCard.hasAttribute('target')).toBe(false);
    expect(hostileCard.hasAttribute('rel')).toBe(false);

    const safeCard = buildPerspectiveCard({
      slug: 'safe-story',
      title: 'Safe story',
      external_url: 'https://partner.example/field-notes',
      tags: [],
    }, 'card');
    expect(safeCard.href).toBe('https://partner.example/field-notes');
    expect(safeCard.target).toBe('_blank');
    expect(safeCard.rel).toBe('noopener noreferrer');
  });

  it('opens only runtime-safe working-group link destinations externally', () => {
    const source = readPublicFile('working-groups/detail.html');
    const handlePostAnchorSource = section(
      source,
      'function handlePostAnchor()',
      'function hasRequestedPostInLocation()',
    );
    const openExternal = vi.fn();
    const openArticle = vi.fn();
    const runAnchor = (externalUrl: string) => {
      const handlePostAnchor = new Function(
        'window',
        'getSafePerspectiveExternalUrl',
        'parseWorkingGroupPath',
        'safeDecodeURIComponent',
        'openArticle',
        'post',
        `const currentSlug = 'measurement'; const postsData = [post];
         ${handlePostAnchorSource}
         return handlePostAnchor;`,
      )(
        { location: { hash: '#post-field-notes' }, open: openExternal },
        loadSafePerspectiveExternalUrl(),
        () => ({ groupSlug: 'measurement', postSlug: null }),
        decodeURIComponent,
        openArticle,
        { slug: 'field-notes', content_type: 'link', external_url: externalUrl },
      ) as () => void;

      handlePostAnchor();
    };

    runAnchor('javascript:globalThis.__perspectiveXss = true');
    expect(openExternal).not.toHaveBeenCalled();
    expect(openArticle).toHaveBeenCalledWith('field-notes');

    openArticle.mockClear();
    runAnchor('https://partner.example/field-notes');
    expect(openExternal).toHaveBeenCalledWith(
      'https://partner.example/field-notes',
      '_blank',
      'noopener,noreferrer',
    );
    expect(openArticle).not.toHaveBeenCalled();
  });

  it.each([
    'javascript:globalThis.__perspectiveXss = true',
    'data:text/html,<script>globalThis.__perspectiveXss = true</script>',
    'https://attacker:secret@partner.example/article',
  ])('rejects unsafe legacy perspective destinations in every public sink: %s', (externalUrl) => {
    const getSafeUrl = loadSafePerspectiveExternalUrl();

    expect(getSafeUrl(externalUrl)).toBeNull();

    const sinkSections = [
      section(readPublicFile('working-groups/detail.html'), 'postsList.innerHTML = postsData.map(post => {', '// Check for post anchor'),
      section(readPublicFile('working-groups/detail.html'), 'function handlePostAnchor()', 'function hasRequestedPostInLocation()'),
      section(readPublicFile('stories/index.html'), 'function buildPerspectiveCard(item, className)', '// Load perspectives and split'),
      section(readPublicFile('members.html'), 'const isArticle = p.content_type === \'article\';', 'const date = new Date(p.published_at)'),
      section(readPublicFile('community/person-profile.html'), 'const isArticle = p.content_type === \'article\';', 'const date = new Date(p.published_at)'),
    ];

    for (const sinkSource of sinkSections) {
      expect(sinkSource).toContain('getSafePerspectiveExternalUrl');
    }
    expect(sinkSections[0]).not.toContain('href="${escapeHtml(post.external_url)}"');
    expect(sinkSections[1]).not.toContain('window.open(post.external_url');
    expect(sinkSections[2]).not.toContain('card.href = item.external_url');
    expect(sinkSections[3]).not.toContain('escapeHtml(p.external_url');
    expect(sinkSections[4]).not.toContain('escapeHtml(p.external_url');
  });

  it('allows valid HTTPS perspective destinations in public sinks', () => {
    expect(loadSafePerspectiveExternalUrl()('https://partner.example/field-notes?edition=1')).toBe(
      'https://partner.example/field-notes?edition=1',
    );
  });

  it('renders hostile account enrichment values as text and rejects unsafe LinkedIn links', () => {
    const source = readPublicFile('admin-account-detail.html');
    const helpersSource = section(
      source,
      'function signalRow(label, value)',
      'function formatCompanyType(type)',
    );
    const escapeHtml = (value: unknown) => String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
    const { signalRow, linkedInSignalRow, enrichmentAttribution } = new Function(
      'escapeHtml',
      'formatDate',
      `${helpersSource}\nreturn { signalRow, linkedInSignalRow, enrichmentAttribution };`,
    )(escapeHtml, () => 'Jul 29, 2026') as {
      signalRow: (label: unknown, value: unknown) => string;
      linkedInSignalRow: (value: unknown) => string;
      enrichmentAttribution: (enrichedAt: unknown, source: unknown) => string;
    };
    const hostileValue = '</span><img src=x onerror="globalThis.__enrichmentXss = true">';
    const hostileLabel = '</span><script>globalThis.__enrichmentXss = true</script>';

    const valueDom = new JSDOM(`<body>${signalRow(hostileLabel, hostileValue)}</body>`);
    expect(valueDom.window.document.querySelector('img')).toBeNull();
    expect(valueDom.window.document.querySelector('script')).toBeNull();
    expect(valueDom.window.document.querySelector('.signal-label')?.textContent).toBe(hostileLabel);
    expect(valueDom.window.document.querySelector('.signal-value')?.textContent).toBe(hostileValue);

    for (const unsafeUrl of [
      'javascript:globalThis.__enrichmentXss = true',
      'https://attacker:secret@www.linkedin.com/company/acme',
      'https://linkedin.example/company/acme',
    ]) {
      const linkDom = new JSDOM(`<body>${linkedInSignalRow(unsafeUrl)}</body>`);
      expect(linkDom.window.document.querySelector('a')).toBeNull();
      expect(linkDom.window.document.querySelector('.signal-value')?.textContent).toBe(unsafeUrl);
    }

    const sourceDom = new JSDOM(`<body>${enrichmentAttribution(
      '2026-07-29T00:00:00Z',
      '<img src=x onerror="globalThis.__enrichmentXss = true">',
    )}</body>`);
    expect(sourceDom.window.document.querySelector('img')).toBeNull();
    expect(sourceDom.window.document.body.textContent).toContain(
      'Updated Jul 29, 2026 via <img src=x onerror="globalThis.__enrichmentXss = true">',
    );
  });

  it('renders a valid credential-free HTTPS LinkedIn enrichment URL', () => {
    const source = readPublicFile('admin-account-detail.html');
    const helpersSource = section(
      source,
      'function signalRow(label, value)',
      'function formatCompanyType(type)',
    );
    const escapeHtml = (value: unknown) => String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
    const linkedInSignalRow = new Function(
      'escapeHtml',
      `${helpersSource}\nreturn linkedInSignalRow;`,
    )(escapeHtml) as (value: unknown) => string;
    const validUrl = 'https://www.linkedin.com/company/acme?trk=profile';
    const dom = new JSDOM(`<body>${linkedInSignalRow(validUrl)}</body>`);
    const link = dom.window.document.querySelector('a');

    expect(link?.getAttribute('href')).toBe(validUrl);
    expect(link?.textContent).toBe('View profile');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
  });
});
