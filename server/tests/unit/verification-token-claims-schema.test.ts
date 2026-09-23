import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';

const schema = JSON.parse(readFileSync(
  resolve(__dirname, '../../../static/schemas/source/core/verification-token-claims.json'),
  'utf8',
));
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);

function claims(overrides: Record<string, unknown> = {}) {
  return {
    iss: 'https://aao.org',
    sub: 'https://seller.example.test/mcp',
    aud: 'aao-verification',
    jti: 'token-id',
    iat: 1_700_000_000,
    exp: 1_702_592_000,
    agent_url: 'https://seller.example.test/mcp',
    role: 'media-buy',
    verified_specialisms: ['sales-non-guaranteed'],
    verification_modes: ['spec'],
    adcp_version: '3.1',
    ...overrides,
  };
}

describe('AgenticAdvertising.org verification token claims source schema', () => {
  it('accepts current Strict Spec claims and historical claim-less Legacy tokens', () => {
    expect(validate(claims({ grading_profile: 'spec' }))).toBe(true);
    expect(validate(claims({
      grading_profile: 'legacy',
      first_failing_spec_at: '2026-09-16T10:00:00.000Z',
    }))).toBe(true);
    expect(validate(claims())).toBe(true);
  });

  it('rejects Sandbox grading and malformed badge releases', () => {
    expect(validate(claims({ grading_profile: 'sandbox' }))).toBe(false);
    expect(validate(claims({ grading_profile: 'legacy', adcp_version: '3.1.0' }))).toBe(false);
    expect(validate(claims({ grading_profile: 'legacy', first_failing_spec_at: 'yesterday-ish' }))).toBe(false);
  });
});
