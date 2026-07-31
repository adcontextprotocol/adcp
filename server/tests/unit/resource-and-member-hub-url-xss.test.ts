import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

function readPublicFile(path: string): string {
  return readFileSync(join(process.cwd(), 'server/public', path), 'utf8');
}

function section(source: string, start: string, end: string): string {
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

describe('stored URL rendering regressions', () => {
  it('renders hostile resource URLs as inert legacy text and preserves a valid fetch URL', async () => {
    const source = readPublicFile('admin-addie.html');
    const helperSource = section(
      source,
      'function getSafeHttpUrl(value)',
      'function copyThreadId(el)',
    );
    const editResourceSource = section(
      source,
      'async function editResource(id)',
      'function closeResourceModal()',
    );
    const dom = new JSDOM(`
      <input id="resource-edit-id">
      <div id="resource-title"></div>
      <div id="resource-url"></div>
      <div id="resource-summary"></div>
      <div id="resource-insights"></div>
      <textarea id="resource-addie-notes"></textarea>
      <input id="resource-quality">
      <input id="resource-tags">
      <div id="resource-modal"></div>
    `, { url: 'https://agenticadvertising.org/admin/addie' });
    const hostileUrl = 'javascript:globalThis.__resourceXss = true';
    const hostileImportance = '"><img src=x onerror="globalThis.__resourceXss = true">';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        json: vi.fn().mockResolvedValue({
          id: 1,
          title: 'Legacy resource',
          source_url: hostileUrl,
          summary: 'Stored safely',
          key_insights: [{ importance: hostileImportance, insight: 'Safe insight' }],
        }),
      })
      .mockResolvedValueOnce({
        json: vi.fn().mockResolvedValue({
          id: 2,
          title: 'Valid resource',
          fetch_url: 'https://source.example/article?ref=admin#details',
          key_insights: [],
        }),
      });
    const editResource = new Function(
      'document',
      'fetch',
      'escapeHtml',
      'alert',
      `${helperSource}\n${editResourceSource}\nreturn editResource;`,
    )(
      dom.window.document,
      fetchMock,
      escapeHtml,
      vi.fn(),
    ) as (id: number) => Promise<void>;

    await editResource(1);

    const urlContainer = dom.window.document.getElementById('resource-url')!;
    expect(urlContainer.querySelector('a')).toBeNull();
    expect(urlContainer.textContent).toBe(hostileUrl);
    expect(dom.window.document.getElementById('resource-insights')?.querySelector('img')).toBeNull();
    expect(dom.window.document.querySelector('.badge-info')?.textContent).toBe('low');

    await editResource(2);

    const validLink = urlContainer.querySelector('a');
    expect(validLink?.href).toBe('https://source.example/article?ref=admin#details');
    expect(validLink?.target).toBe('_blank');
    expect(validLink?.rel).toBe('noopener noreferrer');
  });

  it('hides unsafe member hub URLs and preserves credential-free HTTPS controls', () => {
    const source = readPublicFile('membership/hub.html');
    const helperSource = section(
      source,
      'function getSafeHttpsUrl(value)',
      'function fmtDate(s)',
    );
    const renderSource = section(
      source,
      'function renderProfileCard(profile, profileCompleteness)',
      'function renderActivity(activity)',
    );
    const dom = new JSDOM('<body></body>', {
      url: 'https://agenticadvertising.org/membership/hub',
    });
    const renderProfileCard = new Function(
      'document',
      'config',
      'escapeHtml',
      `${helperSource}\n${renderSource}\nreturn renderProfileCard;`,
    )(
      dom.window.document,
      { user: { firstName: 'Safe', lastName: 'Member' } },
      escapeHtml,
    ) as (profile: Record<string, unknown>, completeness: number) => string;

    dom.window.document.body.innerHTML = renderProfileCard({
      avatar_url: 'data:image/svg+xml,<svg onload="globalThis.__hubXss = true"></svg>',
      linkedin_url: 'javascript:globalThis.__hubXss = true',
      twitter_url: 'https://user:secret@social.example/profile',
      expertise: [],
    }, 50);

    expect(dom.window.document.querySelector('.profile-avatar-preview img')).toBeNull();
    expect(dom.window.document.querySelector('.profile-social-link')).toBeNull();
    expect(dom.window.document.querySelector('script, [onload], [onerror]')).toBeNull();

    for (const hostileAvatarUrl of [
      'javascript:globalThis.__hubXss = true',
      '//attacker.example/avatar.png',
      'http://cdn.example/avatar.png',
      'https://user:secret@cdn.example/avatar.png',
      '/api/portraits/../../admin',
    ]) {
      dom.window.document.body.innerHTML = renderProfileCard({
        avatar_url: hostileAvatarUrl,
        expertise: [],
      }, 50);
      expect(dom.window.document.querySelector('.profile-avatar-preview img')).toBeNull();
    }

    for (const avatarUrl of [
      '/api/portraits/11111111-1111-4111-8111-111111111111.png',
      '/api/community/avatars/22222222-2222-4222-8222-222222222222.png',
    ]) {
      dom.window.document.body.innerHTML = renderProfileCard({
        avatar_url: avatarUrl,
        expertise: [],
      }, 75);
      expect(dom.window.document.querySelector('.profile-avatar-preview img')?.getAttribute('src'))
        .toBe(avatarUrl);
    }

    dom.window.document.body.innerHTML = renderProfileCard({
      avatar_url: 'https://cdn.example/avatar.png?size=small',
      linkedin_url: 'https://www.linkedin.com/in/safe-member?ref=hub',
      twitter_url: 'https://social.example/safe-member#profile',
      expertise: [],
    }, 100);

    expect(dom.window.document.querySelector('.profile-avatar-preview img')?.getAttribute('src'))
      .toBe('https://cdn.example/avatar.png?size=small');
    const socialLinks = [...dom.window.document.querySelectorAll<HTMLAnchorElement>('.profile-social-link')];
    expect(socialLinks.map(link => link.getAttribute('href'))).toEqual([
      'https://www.linkedin.com/in/safe-member?ref=hub',
      'https://social.example/safe-member#profile',
    ]);
    expect(socialLinks.every(link => link.rel === 'noopener noreferrer')).toBe(true);
  });
});
