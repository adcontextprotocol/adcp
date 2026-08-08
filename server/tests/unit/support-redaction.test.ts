import { describe, expect, it } from 'vitest';
import { redactSupportSecrets } from '../../src/services/support-redaction.js';

describe('redactSupportSecrets', () => {
  it('redacts DNS TXT values from support text', () => {
    const text = [
      'Publish this DNS TXT record:',
      '- Name: `_workos.example.com`',
      '- Type: `TXT`',
      '- Value: `wos-domain-verification=abcdef1234567890abcdef`',
    ].join('\n');

    const redacted = redactSupportSecrets(text);

    expect(redacted).toContain('- Value: `[redacted-verification-token]`');
    expect(redacted).not.toContain('abcdef1234567890abcdef');
  });

  it('redacts explicit verification token assignments', () => {
    const redacted = redactSupportSecrets(
      'verification_token: super-secret-token-1234567890 should not leak',
    );

    expect(redacted).toBe(
      'verification_token: [redacted-verification-token] should not leak',
    );
  });

  it('redacts common API credentials', () => {
    const githubToken = ['ghp', 'abcdefghijklmnopqrstuvwxyz123456'].join('_');
    const bearerToken = ['abcdefgh', 'ijklmnop'].join('');
    const redacted = redactSupportSecrets(
      `GitHub token ${githubToken} and Authorization: Bearer ${bearerToken}`,
    );

    expect(redacted).toContain('[redacted-secret]');
    expect(redacted).not.toContain(githubToken);
    expect(redacted).not.toContain(bearerToken);
  });
});
