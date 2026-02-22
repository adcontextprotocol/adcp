import { describe, it, expect } from 'vitest';
import { isWorkOSApiKeyFormat } from '../../src/middleware/api-key-format.js';

describe('isWorkOSApiKeyFormat', () => {
  it('accepts current sk_ prefix keys', () => {
    expect(isWorkOSApiKeyFormat('sk_fake_example_key_for_testing_only')).toBe(true);
    expect(isWorkOSApiKeyFormat('sk_test_abc123')).toBe(true);
    expect(isWorkOSApiKeyFormat('sk_')).toBe(true);
  });

  it('accepts legacy wos_api_key_ prefix keys', () => {
    expect(isWorkOSApiKeyFormat('wos_api_key_abc123def456')).toBe(true);
    expect(isWorkOSApiKeyFormat('wos_api_key_')).toBe(true);
  });

  it('rejects tokens that are not WorkOS API keys', () => {
    expect(isWorkOSApiKeyFormat('some-random-token')).toBe(false);
    expect(isWorkOSApiKeyFormat('admin_key_123')).toBe(false);
    expect(isWorkOSApiKeyFormat('')).toBe(false);
    expect(isWorkOSApiKeyFormat('bearer_token_xyz')).toBe(false);
  });

  it('rejects tokens with similar but incorrect prefixes', () => {
    expect(isWorkOSApiKeyFormat('wos_api_')).toBe(false);
    expect(isWorkOSApiKeyFormat('wos_')).toBe(false);
    expect(isWorkOSApiKeyFormat('s_key')).toBe(false);
    expect(isWorkOSApiKeyFormat('SK_uppercase')).toBe(false);
  });

  it('does not match sealed session tokens', () => {
    expect(isWorkOSApiKeyFormat('eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0')).toBe(false);
  });
});
