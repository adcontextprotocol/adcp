import { describe, expect, it } from 'vitest';
import { parseArgs } from '../../src/scripts/reconcile-registry-organization.js';

describe('reconcile-registry-organization argument parsing', () => {
  it('defaults to a dry run and captures only exact existing identifiers', () => {
    expect(parseArgs([
      '--org-id', 'org_existing',
      '--domain', 'Example.COM',
      '--api-key-id', 'api_key_existing',
      '--api-key-name', 'Registry Automation',
    ])).toMatchObject({
      orgId: 'org_existing',
      domain: 'example.com',
      apiKeyId: 'api_key_existing',
      apiKeyName: 'Registry Automation',
      makePrimary: false,
      apply: false,
    });
  });

  it('requires all duplicate-prevention identifiers', () => {
    expect(() => parseArgs(['--org-id', 'org_existing', '--domain', 'example.com']))
      .toThrow('--org-id, --domain, and --api-key-id are required');
  });

  it('enables writes only with the explicit --apply flag', () => {
    const parsed = parseArgs([
      '--org-id', 'org_existing',
      '--domain', 'example.com',
      '--api-key-id', 'api_key_existing',
      '--make-primary',
      '--apply',
    ]);
    expect(parsed.apply).toBe(true);
    expect(parsed.makePrimary).toBe(true);
  });
});
