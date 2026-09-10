import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  join(process.cwd(), 'server/public/member-profile.html'),
  'utf8',
);

function extractFunction(name: string): (value: unknown) => string {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`Missing ${name}`);
  const brace = source.indexOf('{', start);
  let depth = 0;
  let end = brace;
  for (; end < source.length; end += 1) {
    if (source[end] === '{') depth += 1;
    else if (source[end] === '}' && --depth === 0) {
      end += 1;
      break;
    }
  }
  return new Function(`${source.slice(start, end)}; return ${name};`)() as (value: unknown) => string;
}

describe('member profile domain verification guidance', () => {
  it('renders a copy-ready WorkOS TXT value with the required prefix', () => {
    const formatValue = extractFunction('formatWorkosVerificationValue');

    expect(formatValue('token-123')).toBe('verification_token=token-123');
    expect(formatValue(' verification_token=token-123 ')).toBe('verification_token=token-123');
    expect(formatValue(null)).toBe('');
    expect(source).toContain('including the required <code>verification_token=</code> prefix');
  });

  it('maps pending domains back to their challenge and WorkOS manager', () => {
    expect(source).toContain('id="add-domain-challenge-domain"');
    expect(source).toContain('>Show DNS record</button>');
    expect(source).toContain('data-domain-action="show-record"');
    expect(source).toContain("btn.addEventListener('click'");
    expect(source).not.toContain("onclick=\"addLinkedDomain(\\'");
    expect(source).toContain('id="manage-domains-link"');
    expect(source).toContain("manageDomainsLink.href = '/team?org='");
    expect(source).toContain("manageDomainsLink.addEventListener('click', openWorkosDomainManager)");
    expect(source).toContain("'/domain-verification-link'");
    expect(source).toContain("portalUrl.protocol !== 'https:'");
  });

  it('shows privileged domain actions only to organization admins', () => {
    expect(source).toContain("const canManageDomains = currentOrgRole === 'owner' || currentOrgRole === 'admin'");
    expect(source).toContain('if (!d.verified && canManageDomains)');
    expect(source).toContain('d.verified && !d.is_primary && canManageDomains');
  });
});
