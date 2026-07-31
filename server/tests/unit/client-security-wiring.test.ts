import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

async function publicSource(file: string): Promise<string> {
  return readFile(new URL(`../../public/${file}`, import.meta.url), 'utf8');
}

function extractFunction(source: string, name: string): (value: unknown) => string {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`Missing ${name}`);
  const brace = source.indexOf('{', start);
  let depth = 0;
  let end = brace;
  for (; end < source.length; end += 1) {
    if (source[end] === '{') depth += 1;
    else if (source[end] === '}' && --depth === 0) { end += 1; break; }
  }
  return new Function(`${source.slice(start, end)}; return ${name};`)() as (value: unknown) => string;
}

describe('browser external URL defenses', () => {
  it('behaviorally rejects executable and credentialed member links', async () => {
    const source = await publicSource('member-card.js');
    const safeUrl = extractFunction(source, 'getSafeHttpsUrl');
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(safeUrl('https://user:pass@example.com')).toBeNull();
    expect(safeUrl(' https://example.com/path ')).toBe('https://example.com/path');
    expect(source).toContain('getSafeHttpsUrl(member.linkedin_url)');
    expect(source).toContain('rel="noopener noreferrer"');
  });

  it('behaviorally rejects executable article redirects', async () => {
    const helperSource = await publicSource('perspective-url.js');
    const source = await publicSource('perspectives/article.html');
    const safeUrl = extractFunction(helperSource, 'getSafePerspectiveExternalUrl');
    expect(safeUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(safeUrl('https://example.com/story')).toBe('https://example.com/story');
    expect(source).toMatch(/getSafePerspectiveExternalUrl\(article\.external_url\)[\s\S]{0,200}window\.location\.href = externalUrl/);
  });

  it('wires the shared member sanitizer into every detail link', async () => {
    const source = await publicSource('members.html');
    expect(source).toContain('getSafeHttpsUrl(member.contact_website)');
    expect(source).toContain('getSafeHttpsUrl(member.linkedin_url)');
    expect(source).toContain('getSafeHttpsUrl(member.twitter_url)');
  });

  it('attaches and clears the SI capability without logging the token', async () => {
    const source = await publicSource('chat.html');
    expect(source).toMatch(/headers\['X-SI-Session-Capability'\] = siSessionCapability/);
    expect(source).toMatch(/siSessionCapability = sessionData\.anonymous_access_token \|\| null/);
    expect(source.match(/siSessionCapability = null/g)?.length).toBeGreaterThanOrEqual(2);
    expect(source).not.toMatch(/console\.log\([^\n]*anonymous_access_token/);
  });
});

describe('server URL validation branch wiring', () => {
  it('covers profile create, self-update, and admin-update branches', async () => {
    const source = await readFile(new URL('../../src/routes/member-profiles.ts', import.meta.url), 'utf8');
    expect(source.match(/validateMemberProfileUrlFields\(/g)?.length).toBeGreaterThanOrEqual(3);
    expect(source).toMatch(/router\.post\('\/'[\s\S]*?validateMemberProfileUrlFields/);
    expect(source).toMatch(/router\.put\('\/'[\s\S]*?validateMemberProfileUrlFields/);
    expect(source).toMatch(/adminRouter|createAdminMemberProfileRouter/);
  });

  it('covers content propose/update and committee create/update branches', async () => {
    const content = await readFile(new URL('../../src/routes/content.ts', import.meta.url), 'utf8');
    const committees = await readFile(new URL('../../src/routes/committees.ts', import.meta.url), 'utf8');
    const service = await readFile(new URL('../../src/services/working-group-content-service.ts', import.meta.url), 'utf8');
    expect(content.match(/normalizePerspectiveExternalUrl\(/g)?.length).toBeGreaterThanOrEqual(3);
    expect(committees.match(/normalizePerspectiveExternalUrl\(/g)?.length).toBeGreaterThanOrEqual(5);
    expect(service).toContain('normalizePerspectiveExternalUrl(externalUrl)');
    expect(committees.match(/Invalid external URL/g)?.length).toBeGreaterThanOrEqual(3);
  });
});
